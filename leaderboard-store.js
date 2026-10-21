/* 67 Counter leaderboard storage.

   SHARED mode (deployed on Vercel with Upstash Redis connected): every device reads and writes the
   same online leaderboard through /api/runs. Scores post automatically; a round's GIF is only
   uploaded if the player chooses to post it (attachGif). Deleting needs the admin password.

   LOCAL mode (no /api — e.g. served by a plain static server, or the database isn't connected):
   everything stays in this browser's IndexedDB, exactly like before, and survives reloads.

   Run: { id, name, score, secs, input ("cam" | "kbd"), rate, peak, rank, photo (GIF URL or data URL | null), at } */

const API = "/api/runs";
// Version of the Taqneeq watermark baked into GIFs (gif-tools.js stampBrand). Bump it when the
// design changes; the leaderboard's admin "re-brand" tool updates GIFs with an older version.
export const BRAND_VERSION = 3; // 3 = logo only
const ADMIN_KEY = "67-admin-key";

/* ---------------- mode detection ---------------- */
// "shared" (online board) or "local" (no server, e.g. a plain static file server) once known for sure.
// Stays null while the server just can't be reached right now (offline, timeout, 5xx) — so one bad
// moment never locks a device into saving only locally; the next call checks again.
let mode = null;
let adminEnabled = false;
let lastShared = [];
let shared = false; // kept for isShared()

async function fetchJson(url, opts = {}, timeout = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status });
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function probe() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(API, { cache: "no-store", signal: ctrl.signal }).finally(() => clearTimeout(timer));
    if (r.status === 404 || r.status === 405) return "local"; // no API on this host
    const data = await r.json().catch(() => null);
    if (r.ok && data?.shared) { adminEnabled = Boolean(data.adminEnabled); lastShared = data.runs || []; return "shared"; }
    if (r.status === 503 && data && data.shared === false) return "local"; // API without a database
    return null;
  } catch {
    return null; // offline / timed out — unknown, try again next time
  }
}

/** true when the shared online leaderboard is available. */
export async function detect() {
  if (!mode) mode = await probe();
  shared = mode === "shared";
  return shared;
}
export const isShared = () => shared === true;
export const isAdminEnabled = () => adminEnabled;

/* ---------------- admin (shared mode) ---------------- */
export function getAdminKey() { try { return localStorage.getItem(ADMIN_KEY) || ""; } catch { return ""; } }
export function setAdminKey(key) { try { key ? localStorage.setItem(ADMIN_KEY, key) : localStorage.removeItem(ADMIN_KEY); } catch {} }
/** checks a password against the server's ADMIN_KEY */
export async function checkAdmin(key) {
  if (!(await detect()) || !key) return false;
  try { return (await fetchJson(`${API}?admin=1`, { cache: "no-store", headers: { "x-admin-key": key } })).admin === true; }
  catch { return false; }
}

/* ---------------- public API ---------------- */
/** Every run: the shared board when online, otherwise this device's. */
export async function allRuns() {
  if (await detect()) {
    try { lastShared = (await fetchJson(API, { cache: "no-store" })).runs || []; } catch {}
    return [...lastShared];
  }
  return localAll();
}

/** Save a finished round. In shared mode the GIF is NOT uploaded here (see attachGif). */
export async function addRun(run) {
  if (await detect()) {
    try {
      const { name, score, secs, input, rate, peak, rank } = run;
      const data = await fetchJson(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, score, secs, input, rate, peak, rank }) });
      lastShared.unshift(data.run);
      return { ...data.run, editKey: data.editKey, shared: true };
    } catch (err) {
      console.warn("couldn't reach the shared leaderboard, saving on this device instead:", err);
    }
  }
  return { ...(await localAdd(run)), shared: false };
}

/* ---------------- saving a round, with retries + an upload queue ----------------
   submitRun(run, gif) saves the score and then its GIF. Each step is retried; if the server still
   can't be reached, whatever is left is queued on this device and uploaded automatically later
   (every 20s, when the connection comes back, and on the next page load) until it lands.
   A per-round client id (cid) means a retry can never create a duplicate round.
   Returns { state: "saved" | "queued" | "local", run, gifSaved }. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newCid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);
const retryable = (err) => !err?.status || err.status >= 500 || err.status === 429 || err.status === 408;

async function withRetries(fn, retries) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (err) {
      if (!retryable(err) || i >= retries) throw err;
      await sleep(1500 * (i + 1));
    }
  }
}

// one step at a time: post the score (if not yet), then the GIF (if any). Updates `item` as it goes.
async function syncItem(item, retries) {
  if (!item.serverId) {
    const data = await withRetries(() => fetchJson(API, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...item.run, cid: item.cid }),
    }, 15000), retries);
    mode = "shared"; shared = true;
    item.serverId = data.run.id; item.editKey = data.editKey; item.saved = data.run;
    if (!lastShared.some((r) => r.id === data.run.id)) lastShared.unshift(data.run);
  }
  if (item.gif) {
    try {
      const data = await withRetries(() => fetchJson(`${API}?id=${encodeURIComponent(item.serverId)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ editKey: item.editKey, gif: item.gif, branded: BRAND_VERSION }),
      }, 30000), retries);
      item.saved = data.run; item.gifSaved = true;
      const i = lastShared.findIndex((r) => r.id === data.run.id);
      if (i >= 0) lastShared[i] = data.run;
    } catch (err) {
      if (retryable(err)) throw err;
      console.warn("GIF rejected by the server, keeping the score without it:", err); // e.g. too big
    }
    item.gif = null;
  }
  return item.saved;
}

export async function submitRun(run, gif) {
  const item = {
    cid: newCid(), queuedAt: Date.now(), gif: gif || null, serverId: null, editKey: null,
    run: { name: run.name, score: run.score, secs: run.secs, input: run.input, rate: run.rate, peak: run.peak, rank: run.rank },
  };
  await detect();
  if (mode === "local") return { state: "local", run: await localAdd(run) };
  try {
    const saved = await syncItem(item, 2);
    return { state: "saved", run: saved, gifSaved: Boolean(item.gifSaved) };
  } catch (err) {
    if (!retryable(err)) { console.warn("server refused this round:", err); return { state: "rejected", run, error: err.message }; }
    console.warn("server unreachable — queued this round to upload automatically:", err);
    await pendingPut(item);
    scheduleFlush();
    return { state: "queued", run: item.saved || run };
  }
}

let flushing = false;
/** Upload everything waiting in the queue (oldest first). Returns how many are still waiting. */
export async function flushPending() {
  if (flushing) return pendingCount();
  flushing = true;
  try {
    const items = (await pendingAll()).sort((a, b) => a.queuedAt - b.queuedAt);
    for (const item of items) {
      try {
        await syncItem(item, 0);
        await pendingDelete(item.cid);
      } catch (err) {
        if (!retryable(err)) { console.warn("dropping a queued round the server refused:", err); await pendingDelete(item.cid); continue; }
        await pendingPut(item); // keep partial progress (e.g. score saved, GIF still to go)
        break; // still offline — try again later
      }
    }
  } finally {
    flushing = false;
    notify();
  }
  return pendingCount();
}

const listeners = new Set();
/** Call fn(count) whenever the number of rounds waiting to upload changes. */
export function onPendingChange(fn) { listeners.add(fn); pendingCount().then(fn); return () => listeners.delete(fn); }
async function notify() { const n = await pendingCount(); listeners.forEach((fn) => fn(n)); }
export async function pendingCount() { return (await pendingAll()).length; }

let flushTimer = 0;
function scheduleFlush() { notify(); clearTimeout(flushTimer); flushTimer = setTimeout(flushPending, 5000); }
if (typeof window !== "undefined") {
  setInterval(async () => { if ((await pendingCount()) > 0) flushPending(); }, 20000);
  addEventListener("online", () => flushPending());
  setTimeout(async () => { if ((await pendingCount()) > 0) flushPending(); }, 3000);
}

/** Shared mode: upload the round's (Taqneeq-branded) GIF after the player agrees to post it.
    With { admin: true } it uses the admin password instead of the round's edit key (re-brand tool). */
export async function attachGif(run, dataUrl, { admin = false } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (admin) headers["x-admin-key"] = getAdminKey();
  const data = await fetchJson(`${API}?id=${encodeURIComponent(run.id)}`, {
    method: "PATCH", headers, body: JSON.stringify({ editKey: run.editKey, gif: dataUrl, branded: BRAND_VERSION }),
  }, 30000);
  const i = lastShared.findIndex((r) => r.id === run.id);
  if (i >= 0) lastShared[i] = data.run;
  return data.run;
}

/** Admin: correct a round's score (shared mode needs the admin password). Returns the updated run. */
export async function setScore(run, score) {
  if (await detect()) {
    const data = await fetchJson(`${API}?id=${encodeURIComponent(run.id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json", "x-admin-key": getAdminKey() }, body: JSON.stringify({ score }),
    });
    const i = lastShared.findIndex((r) => r.id === run.id);
    if (i >= 0) lastShared[i] = data.run;
    return data.run;
  }
  const updated = { ...run, score, rate: Math.round((score / run.secs) * 100) / 100, edited: true };
  if (memory) { memory = memory.map((r) => (r.id === run.id ? updated : r)); return updated; }
  await withStore("readwrite", (s) => s.put(updated));
  return updated;
}

/** Permanently delete specific runs (shared mode needs the admin password). */
export async function deleteRuns(ids) {
  if (await detect()) {
    await fetchJson(`${API}?ids=${encodeURIComponent(ids.join(","))}`, { method: "DELETE", headers: { "x-admin-key": getAdminKey() } });
    lastShared = lastShared.filter((r) => !ids.includes(r.id));
    return;
  }
  return localDelete(ids);
}

/** Permanently wipe the whole leaderboard (shared mode needs the admin password). */
export async function clearAll() {
  if (await detect()) {
    await fetchJson(`${API}?all=1`, { method: "DELETE", headers: { "x-admin-key": getAdminKey() } });
    lastShared = [];
    return;
  }
  return localClear();
}

/** A backup file of whatever leaderboard is showing (shared GIFs are links, local ones are embedded). */
export async function exportBackup() {
  const data = { app: "67-counter", version: 1, mode: isShared() ? "shared" : "local", exportedAt: new Date().toISOString(), runs: await allRuns() };
  return new Blob([JSON.stringify(data)], { type: "application/json" });
}

/** Merge runs from a backup file into this device's leaderboard (local mode only). */
export async function importRuns(runs) {
  const existing = new Set((await localAll()).map((r) => r.id));
  let added = 0;
  for (const r of runs) {
    if (!r || typeof r.name !== "string" || !Number.isFinite(+r.score)) continue;
    if (r.id && existing.has(r.id)) continue;
    await localAdd({
      id: r.id, name: r.name.slice(0, 14), score: +r.score, secs: +r.secs, input: r.input === "kbd" ? "kbd" : "cam",
      rate: +r.rate || 0, peak: +r.peak || 0, rank: String(r.rank || "").slice(0, 60),
      photo: typeof r.photo === "string" && r.photo.startsWith("data:image/") ? r.photo : null, at: r.at,
    });
    added++;
  }
  return added;
}

/* ---------------- local (IndexedDB) ---------------- */
const DB_NAME = "67-leaderboard";
const STORE = "runs";
const PENDING = "pending";
let memory = null; // fallback when IndexedDB is unavailable (some private windows): this tab only

function openDb() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) return reject(new Error("no IndexedDB"));
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(PENDING)) db.createObjectStore(PENDING, { keyPath: "cid" }); // rounds waiting to upload
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn, store = STORE) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const result = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(result && "result" in result ? result.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

// ask the browser to keep this data even under storage pressure (survives reloads either way)
let persistAsked = false;
function askPersist() {
  if (persistAsked) return;
  persistAsked = true;
  try { navigator.storage?.persist?.().catch(() => {}); } catch {}
}

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

async function localAll() {
  if (memory) return [...memory];
  try {
    return (await withStore("readonly", (s) => s.getAll())) || [];
  } catch (err) {
    console.warn("leaderboard storage unavailable, keeping runs for this tab only:", err);
    memory = [];
    return [];
  }
}

async function localAdd(run) {
  const stored = { ...run, id: run.id || newId(), at: run.at || new Date().toISOString() };
  if (memory) { memory.push(stored); return stored; }
  askPersist();
  try {
    await withStore("readwrite", (s) => s.put(stored));
  } catch (err) {
    console.warn("could not save run to IndexedDB, keeping it for this tab only:", err);
    memory = [...(memory || []), stored];
  }
  return stored;
}

async function localDelete(ids) {
  const doomed = new Set(ids);
  if (memory) { memory = memory.filter((r) => !doomed.has(r.id)); return; }
  await withStore("readwrite", (s) => { for (const id of doomed) s.delete(id); });
}

async function localClear() {
  if (memory) { memory = []; return; }
  await withStore("readwrite", (s) => { s.clear(); });
}

/* ---------------- upload queue (IndexedDB "pending" store) ---------------- */
let pendingMem = null; // fallback when IndexedDB is unavailable: this tab only
async function pendingAll() {
  if (pendingMem) return [...pendingMem.values()];
  try { return (await withStore("readonly", (s) => s.getAll(), PENDING)) || []; }
  catch { pendingMem = new Map(); return []; }
}
async function pendingPut(item) {
  askPersist();
  if (pendingMem) { pendingMem.set(item.cid, item); return; }
  try { await withStore("readwrite", (s) => s.put(item), PENDING); }
  catch { pendingMem = new Map([[item.cid, item]]); }
}
async function pendingDelete(cid) {
  if (pendingMem) { pendingMem.delete(cid); return; }
  try { await withStore("readwrite", (s) => s.delete(cid), PENDING); } catch {}
}
