/* Shared leaderboard API.

   GET    /api/runs                 → { shared, adminEnabled, runs }   (cached a few seconds at the edge)
   GET    /api/runs?admin=1         → same, plus { admin } — send the admin password in the x-admin-key header
   POST   /api/runs                 → save a finished round (no GIF yet) → { run, editKey }
   PATCH  /api/runs?id=<id>         → attach the round's GIF once the player taps "post it" (needs that round's editKey)
   DELETE /api/runs?ids=a,b | ?all=1 → admin only: delete players' rounds or wipe the board

   Admin password: set ADMIN_KEY in Vercel → Settings → Environment Variables. Without it, nothing can be deleted. */
import crypto from "node:crypto";
import * as db from "./_db.js";

const VALID_SECS = new Set([15, 30, 60]);
const MAX_GIF_BYTES = 800 * 1024; // the game shrinks clips to ~550 KB before posting; keeps each Redis write under 1 MB

const clean = (v, n) => String(v ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, n);
const num = (v, lo, hi) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo; };
const body = (req) => (typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {});

function sameSecret(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const isAdmin = (req) => Boolean(process.env.ADMIN_KEY && req.headers["x-admin-key"] && sameSecret(process.env.ADMIN_KEY, req.headers["x-admin-key"]));

// what everyone gets to see (never the edit key)
const publicRun = (r) => ({
  id: r.id, name: r.name, score: r.score, secs: r.secs, input: r.input, rate: r.rate, peak: r.peak, rank: r.rank, at: r.at,
  photo: r.hasGif ? `/api/gif?id=${r.id}` : null,
});

// "data:image/gif;base64,..." → "gif:<base64>" (or null if it isn't a reasonable GIF/JPEG)
function parseClip(dataUrl) {
  const m = /^data:image\/(gif|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m || (m[2].length * 3) / 4 > MAX_GIF_BYTES) return null;
  return `${m[1]}:${m[2]}`;
}

export default async function handler(req, res) {
  if (!db.connected) return res.status(503).json({ shared: false, error: "Leaderboard storage isn't connected (add Upstash Redis in Vercel)." });
  try {
    if (req.method === "GET") {
      const runs = (await db.listRuns()).map(publicRun);
      const payload = { shared: true, adminEnabled: Boolean(process.env.ADMIN_KEY), runs };
      if (req.query.admin) {
        res.setHeader("Cache-Control", "private, no-store");
        return res.status(200).json({ ...payload, admin: isAdmin(req) });
      }
      res.setHeader("Cache-Control", "public, s-maxage=4, stale-while-revalidate=20");
      return res.status(200).json(payload);
    }

    if (req.method === "POST") {
      const b = body(req);
      const secs = Number(b.secs);
      const input = b.input === "kbd" ? "kbd" : b.input === "cam" ? "cam" : null;
      if (!VALID_SECS.has(secs) || !input) return res.status(400).json({ error: "bad mode" });
      const run = {
        id: `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`,
        name: clean(b.name, 14) || "anon",
        score: Math.round(num(b.score, 0, secs * 20)), // nobody does 20 swaps a second
        secs, input,
        rate: Math.round(num(b.rate, 0, 20) * 100) / 100,
        peak: Math.round(num(b.peak, 0, 40) * 100) / 100,
        rank: clean(b.rank, 60),
        at: new Date().toISOString(),
        hasGif: false,
        editKey: crypto.randomBytes(12).toString("hex"),
      };
      if (run.score <= 0) return res.status(400).json({ error: "score must be above 0" });
      await db.addRun(run);
      return res.status(201).json({ run: publicRun(run), editKey: run.editKey });
    }

    if (req.method === "PATCH") {
      const id = String(req.query.id || "");
      const b = body(req);
      const run = await db.getRun(id);
      if (!run) return res.status(404).json({ error: "no such round" });
      if (!b.editKey || !sameSecret(run.editKey, b.editKey)) return res.status(403).json({ error: "not your round" });
      const clip = parseClip(b.gif);
      if (!clip) return res.status(400).json({ error: String(b.gif || "").length > 100 ? "GIF too big" : "GIF missing" });
      await db.putGif(id, clip);
      run.hasGif = true;
      await db.putRun(run);
      return res.status(200).json({ run: publicRun(run) });
    }

    if (req.method === "DELETE") {
      if (!isAdmin(req)) return res.status(401).json({ error: "admin password needed" });
      if (req.query.all) await db.clearAll();
      else await db.deleteRuns(String(req.query.ids || "").split(",").filter(Boolean).slice(0, 500));
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ error: "method not allowed" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "server error" });
  }
}
