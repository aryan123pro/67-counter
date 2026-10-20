/* 67 Counter leaderboard storage — lives entirely in the player's own browser (IndexedDB),
   so the game is a plain static site (deploys to Vercel / any static host as-is).
   Each run: { id, name, score, secs, input ("cam" | "kbd"), rate, peak, rank, photo (animated GIF data URL of their fastest 2.5s — older runs may hold a JPEG — or null), at (ISO time) }.
   Photos never leave the device unless the player exports a backup themselves. */

const DB_NAME = "67-leaderboard";
const STORE = "runs";
let memory = null; // fallback when IndexedDB is unavailable (some private windows): this tab only

function openDb() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) return reject(new Error("no IndexedDB"));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const result = fn(tx.objectStore(STORE));
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

/** Every run stored on this device. */
export async function allRuns() {
  if (memory) return [...memory];
  try {
    return (await withStore("readonly", (s) => s.getAll())) || [];
  } catch (err) {
    console.warn("leaderboard storage unavailable, keeping runs for this tab only:", err);
    memory = [];
    return [];
  }
}

/** Save one finished round; returns the stored run (with id + timestamp filled in). */
export async function addRun(run) {
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

/** Merge runs from a backup file (or an older leaderboard). Runs with an existing id are skipped. */
export async function importRuns(runs) {
  const existing = new Set((await allRuns()).map((r) => r.id));
  let added = 0;
  for (const r of runs) {
    if (!r || typeof r.name !== "string" || !Number.isFinite(+r.score)) continue;
    if (r.id && existing.has(r.id)) continue;
    await addRun({
      id: r.id, name: r.name.slice(0, 14), score: +r.score, secs: +r.secs, input: r.input === "kbd" ? "kbd" : "cam",
      rate: +r.rate || 0, peak: +r.peak || 0, rank: String(r.rank || "").slice(0, 60),
      photo: typeof r.photo === "string" && r.photo.startsWith("data:image/") ? r.photo : null, at: r.at,
    });
    added++;
  }
  return added;
}

/** A backup file the player can keep or move to another device (photos included). */
export async function exportBackup() {
  const data = { app: "67-counter", version: 1, exportedAt: new Date().toISOString(), runs: await allRuns() };
  return new Blob([JSON.stringify(data)], { type: "application/json" });
}

/** Permanently delete specific runs (e.g. every run of one player). */
export async function deleteRuns(ids) {
  const doomed = new Set(ids);
  if (memory) { memory = memory.filter((r) => !doomed.has(r.id)); return; }
  await withStore("readwrite", (s) => { for (const id of doomed) s.delete(id); });
}

/** Permanently wipe this device's whole leaderboard. */
export async function clearAll() {
  if (memory) { memory = []; return; }
  await withStore("readwrite", (s) => { s.clear(); });
}
