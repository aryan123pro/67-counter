/* Shared leaderboard storage (Upstash Redis). Files starting with "_" in /api aren't deployed as endpoints.

   Keys:
     runs        list of run ids, newest first
     run:<id>    one round as JSON (name, score, mode, stats, editKey, hasGif, at)
     gif:<id>    "<gif|jpeg>:<base64>" — the round's highlight clip, only if the player chose to post it

   Connect it in Vercel → Storage → Marketplace → Upstash Redis; that adds KV_REST_API_URL / KV_REST_API_TOKEN.
   A database made directly at upstash.com works too (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).
   MEMORY_STORE=1 swaps in a throwaway in-memory store for local testing. */
import { Redis } from "@upstash/redis";

const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

function memoryRedis() {
  const kv = new Map(), lists = new Map();
  return {
    async lrange(k, a, b) { return (lists.get(k) || []).slice(a, b === -1 ? undefined : b + 1); },
    async mget(...ks) { return ks.map((x) => kv.get(x) ?? null); },
    async get(k) { return kv.get(k) ?? null; },
    async set(k, v, opts) { if (opts?.nx && kv.has(k)) return null; kv.set(k, v); return "OK"; },
    async del(...ks) { let n = 0; for (const x of ks) n += kv.delete(x) + lists.delete(x); return n; },
    async lpush(k, ...vs) { const l = lists.get(k) || []; l.unshift(...vs.reverse()); lists.set(k, l); return l.length; },
    async lrem(k, _count, v) { const l = lists.get(k) || []; lists.set(k, l.filter((x) => x !== v)); return l.length; },
  };
}

const redis =
  url && token ? new Redis({ url, token, automaticDeserialization: false })
  : process.env.MEMORY_STORE === "1" ? (globalThis.__67mem ??= memoryRedis())
  : null;

export const connected = Boolean(redis);

const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

export async function listRuns(limit = 1000) {
  const ids = await redis.lrange("runs", 0, limit - 1);
  if (!ids.length) return [];
  const raw = await redis.mget(...ids.map((id) => `run:${id}`));
  return raw.map(parse).filter(Boolean);
}

// A retried save carries the same client id (cid). The first save claims it; later ones get the
// original round back instead of creating a duplicate. Claims expire after 2 days.
export async function claimCid(cid, runId) {
  const ok = await redis.set(`cid:${cid}`, runId, { nx: true, ex: 172800 });
  return ok === "OK" ? null : await redis.get(`cid:${cid}`);
}

export async function getRun(id) {
  return parse(await redis.get(`run:${id}`));
}

export async function putRun(run) {
  await redis.set(`run:${run.id}`, JSON.stringify(run));
}

export async function addRun(run) {
  await putRun(run);
  await redis.lpush("runs", run.id);
}

export async function putGif(id, stored) {
  await redis.set(`gif:${id}`, stored);
}

export async function getGif(id) {
  return redis.get(`gif:${id}`);
}

export async function deleteRuns(ids) {
  if (!ids.length) return;
  await redis.del(...ids.flatMap((id) => [`run:${id}`, `gif:${id}`]));
  for (const id of ids) await redis.lrem("runs", 0, id);
}

export async function clearAll() {
  const ids = await redis.lrange("runs", 0, -1);
  if (ids.length) await redis.del(...ids.flatMap((id) => [`run:${id}`, `gif:${id}`]));
  await redis.del("runs");
}
