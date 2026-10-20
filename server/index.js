/* 67 Counter server (hosted on Fly.io, data in Neon Postgres).

   Serves the game + leaderboard from /public and the API:
     GET    /api/runs                 → { shared, adminEnabled, runs }
     GET    /api/runs?admin=1         → same + { admin }   (admin password in the x-admin-key header)
     POST   /api/runs                 → save a finished round → { run, editKey }
     PATCH  /api/runs?id=<id>         → attach the round's GIF (needs that round's editKey, or admin)
     PATCH  /api/runs?id=<id> {score} → admin only: correct a round's score
     DELETE /api/runs?ids=a,b | ?all=1 → admin only: delete rounds / wipe the board
     GET    /api/gif?id=<id>          → a round's GIF
     GET    /s/<id>                   → share page for a round's GIF
     GET    /healthz                  → health check (also checks the database)

   Environment (set with `fly secrets set …`):
     DATABASE_URL  Neon connection string (required)
     ADMIN_KEY     password for /admin (optional; without it nothing can be deleted or edited)
     PUBLIC_URL    the site's public address, e.g. https://67-counter.fly.dev (optional)
     CORS_ORIGINS  comma-separated sites allowed to call the API from another domain (optional,
                   only needed if the frontend is hosted somewhere else, e.g. Vercel) */
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import * as db from "./db.js";
import { sharePage } from "./share-page.js";

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const VALID_SECS = new Set([30]); // the event runs 30-second camera rounds only
const MAX_GIF_BYTES = 800 * 1024; // the game shrinks clips to ~550 KB before posting
const CORS = new Set(String(process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean));

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

/* ---------------- helpers ---------------- */
const clean = (v, n) => String(v ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, n);
const num = (v, lo, hi) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo; };
function sameSecret(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const isAdmin = (req) => Boolean(process.env.ADMIN_KEY && req.get("x-admin-key") && sameSecret(process.env.ADMIN_KEY, req.get("x-admin-key")));
const origin = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");

// same rank titles as the game's results screen (public/index.html rankFor)
function rankFor(score, dur) {
  if (score === 67) return "PERFECT 67 ✨ (the prophecy)";
  const r = score / dur;
  if (score === 0) return "did you even move? 💀";
  if (r < 1) return "NPC ENERGY 🧍";
  if (r < 2) return "MID. JUST MID. 😐";
  if (r < 3) return "KINDA COOKIN 🍳";
  if (r < 4) return "AURA FARMER 🌾";
  if (r < 5) return "SIGMA 67ER 🗿";
  return "THE 67 GOD 👑";
}

// what everyone gets to see (never the edit key)
const publicRun = (r, base) => ({
  id: r.id, name: r.name, score: r.score, secs: r.secs, input: r.input, rate: r.rate, peak: r.peak, rank: r.rank, at: r.at,
  edited: Boolean(r.editedAt),
  // ?v= changes whenever the GIF is replaced, so caches never serve an old copy
  photo: r.hasGif ? `${base}/api/gif?id=${r.id}&v=${r.gifV || 1}` : null,
  branded: Number(r.gifBranded) || 0,
});

// "data:image/gif;base64,..." → { type, data } (or null if it isn't a reasonable GIF/JPEG)
function parseClip(dataUrl) {
  const m = /^data:image\/(gif|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) return null;
  const data = Buffer.from(m[2], "base64");
  if (!data.length || data.length > MAX_GIF_BYTES) return null;
  return { type: m[1] === "jpeg" ? "image/jpeg" : "image/gif", data };
}

// light per-IP limit on writes, so nobody can flood the board
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const ip = req.get("fly-client-ip") || req.ip;
    const now = Date.now(), list = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) return res.status(429).json({ error: "slow down a little" });
    list.push(now); hits.set(ip, list);
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [ip, l] of hits) if (!l.some((t) => now - t < 120_000)) hits.delete(ip); }, 60_000).unref();

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch((err) => { console.error(err); res.status(500).json({ error: "server error" }); });

/* ---------------- CORS (only for a frontend on another domain) ---------------- */
app.use(["/api", "/s"], (req, res, next) => {
  const o = req.get("origin");
  if (o && CORS.has(o)) {
    res.set({ "Access-Control-Allow-Origin": o, Vary: "Origin", "Access-Control-Allow-Headers": "content-type, x-admin-key", "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE" });
    if (req.method === "OPTIONS") return res.sendStatus(204);
  }
  next();
});

/* ---------------- API ---------------- */
const json = express.json({ limit: "2mb" });

app.get("/api/runs", wrap(async (req, res) => {
  const runs = (await db.listRuns()).map((r) => publicRun(r, origin(req)));
  const payload = { shared: true, adminEnabled: Boolean(process.env.ADMIN_KEY), runs };
  if (req.query.admin) { res.set("Cache-Control", "private, no-store"); return res.json({ ...payload, admin: isAdmin(req) }); }
  res.set("Cache-Control", "no-store");
  res.json(payload);
}));

app.post("/api/runs", rateLimit(20, 60_000), json, wrap(async (req, res) => {
  const b = req.body || {};
  const secs = Number(b.secs);
  if (!VALID_SECS.has(secs) || b.input !== "cam") return res.status(400).json({ error: "bad mode" });
  const name = clean(b.name, 14);
  if (!name) return res.status(400).json({ error: "name required" });
  const run = {
    id: `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`,
    name, secs, input: "cam",
    score: Math.round(num(b.score, 0, secs * 20)), // nobody does 20 swaps a second
    rate: Math.round(num(b.rate, 0, 20) * 100) / 100,
    peak: Math.round(num(b.peak, 0, 40) * 100) / 100,
    rank: clean(b.rank, 60),
    at: new Date().toISOString(),
    editKey: crypto.randomBytes(12).toString("hex"),
  };
  if (run.score <= 0) return res.status(400).json({ error: "score must be above 0" });
  await db.addRun(run);
  res.status(201).json({ run: publicRun({ ...run, hasGif: false }, origin(req)), editKey: run.editKey });
}));

app.patch("/api/runs", rateLimit(30, 60_000), json, wrap(async (req, res) => {
  const id = String(req.query.id || "");
  const b = req.body || {};
  const run = await db.getRun(id);
  if (!run) return res.status(404).json({ error: "no such round" });

  // admin score correction
  if (b.score !== undefined) {
    if (!isAdmin(req)) return res.status(401).json({ error: "admin password needed" });
    const score = Number(b.score);
    if (!Number.isInteger(score) || score < 0 || score > run.secs * 20) return res.status(400).json({ error: `score must be a whole number from 0 to ${run.secs * 20}` });
    const updated = await db.setScore(id, { score, rate: Math.round((score / run.secs) * 100) / 100, rank: rankFor(score, run.secs) });
    return res.json({ run: publicRun(updated, origin(req)) });
  }

  // attach / replace the GIF
  if (!isAdmin(req) && (!b.editKey || !sameSecret(run.editKey, b.editKey))) return res.status(403).json({ error: "not your round" });
  const clip = parseClip(b.gif);
  if (!clip) return res.status(400).json({ error: String(b.gif || "").length > 100 ? "GIF too big" : "GIF missing" });
  const branded = b.branded === true ? 1 : Math.max(0, Math.min(99, Math.round(Number(b.branded) || 0)));
  const updated = await db.putGif(id, clip.type, clip.data, branded);
  res.json({ run: publicRun(updated, origin(req)) });
}));

app.delete("/api/runs", wrap(async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: "admin password needed" });
  if (req.query.all) await db.clearAll();
  else await db.deleteRuns(String(req.query.ids || "").split(",").filter(Boolean).slice(0, 500));
  res.json({ ok: true });
}));

app.get("/api/gif", wrap(async (req, res) => {
  const id = String(req.query.id || "");
  if (!/^[a-z0-9-]{6,40}$/i.test(id)) return res.status(400).end();
  const gif = await db.getGif(id);
  if (!gif) return res.status(404).end();
  // the URL carries a version (?v=), so the content behind it never changes
  res.set({ "Content-Type": gif.type, "Cache-Control": "public, max-age=31536000, immutable", "Access-Control-Allow-Origin": "*" });
  res.send(gif.data);
}));

app.get("/s/:id", wrap(async (req, res) => {
  const id = String(req.params.id);
  const run = /^[a-z0-9-]{6,40}$/i.test(id) ? await db.getRun(id) : null;
  const { status, html } = sharePage(run, origin(req));
  res.set({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" });
  res.status(status).send(html);
}));

app.get("/healthz", wrap(async (_req, res) => { await db.ping(); res.json({ ok: true }); }));

/* ---------------- frontend ---------------- */
app.get("/admin", (_req, res, next) => { res.set("X-Robots-Tag", "noindex, nofollow"); next(); });
app.use(express.static(PUBLIC_DIR, {
  extensions: ["html"], // /admin → admin.html, /leaderboard → leaderboard.html
  setHeaders(res, file) {
    // pages + code always fresh (it changes during the event); images cached for a day
    res.set("Cache-Control", /\.(jpg|jpeg|png|gif|webp)$/i.test(file) ? "public, max-age=86400" : "no-cache");
  },
}));
app.use((_req, res) => res.status(404).send("Not found"));

/* ---------------- start ---------------- */
await db.migrate();
const server = app.listen(PORT, "0.0.0.0", () => console.log(`67 Counter listening on :${PORT}`));
const stop = () => { server.close(() => db.pool.end().then(() => process.exit(0))); setTimeout(() => process.exit(0), 8000).unref(); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
