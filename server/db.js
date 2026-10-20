/* Leaderboard storage in Postgres (Neon in production).
   Connection string comes from DATABASE_URL (a Fly secret) — never hard-code it.
   Tables are created on startup if they don't exist, so a fresh Neon database just works. */
import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Add your Neon connection string: fly secrets set DATABASE_URL='postgresql://…'");
  process.exit(1);
}

// Neon needs TLS; a plain local Postgres (for development) doesn't.
let host = "";
try { host = new URL(process.env.DATABASE_URL).hostname; } catch {}
const local = ["localhost", "127.0.0.1", "::1", ""].includes(host) || process.env.PGSSL === "off";
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: local ? false : { rejectUnauthorized: true },
  max: Number(process.env.PG_POOL_MAX || 8),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});
pool.on("error", (err) => console.error("postgres pool error:", err.message));

export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS runs (
      id          text PRIMARY KEY,
      name        text NOT NULL,
      score       integer NOT NULL,
      secs        integer NOT NULL,
      input       text NOT NULL,
      rate        real NOT NULL DEFAULT 0,
      peak        real NOT NULL DEFAULT 0,
      rank        text NOT NULL DEFAULT '',
      at          timestamptz NOT NULL DEFAULT now(),
      edit_key    text NOT NULL,
      has_gif     boolean NOT NULL DEFAULT false,
      gif_branded integer NOT NULL DEFAULT 0,
      gif_v       integer NOT NULL DEFAULT 0,
      edited_at   timestamptz
    );
    CREATE INDEX IF NOT EXISTS runs_at_idx ON runs (at DESC);
    CREATE TABLE IF NOT EXISTS gifs (
      run_id text PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      type   text NOT NULL,
      data   bytea NOT NULL
    );
  `);
}

const toRun = (r) => r && ({
  id: r.id, name: r.name, score: r.score, secs: r.secs, input: r.input, rate: r.rate, peak: r.peak, rank: r.rank,
  at: new Date(r.at).toISOString(), editKey: r.edit_key, hasGif: r.has_gif, gifBranded: r.gif_branded, gifV: r.gif_v,
  editedAt: r.edited_at ? new Date(r.edited_at).toISOString() : null,
});

export async function listRuns(limit = 2000) {
  const { rows } = await pool.query("SELECT * FROM runs ORDER BY at DESC LIMIT $1", [limit]);
  return rows.map(toRun);
}

export async function getRun(id) {
  const { rows } = await pool.query("SELECT * FROM runs WHERE id = $1", [id]);
  return toRun(rows[0]);
}

export async function addRun(r) {
  await pool.query(
    `INSERT INTO runs (id, name, score, secs, input, rate, peak, rank, at, edit_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [r.id, r.name, r.score, r.secs, r.input, r.rate, r.peak, r.rank, r.at, r.editKey],
  );
}

export async function setScore(id, { score, rate, rank }) {
  const { rows } = await pool.query(
    "UPDATE runs SET score = $2, rate = $3, rank = $4, edited_at = now() WHERE id = $1 RETURNING *",
    [id, score, rate, rank],
  );
  return toRun(rows[0]);
}

// store/replace a round's GIF and bump its version (so cached copies are never served)
export async function putGif(id, type, data, branded) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO gifs (run_id, type, data) VALUES ($1, $2, $3)
       ON CONFLICT (run_id) DO UPDATE SET type = EXCLUDED.type, data = EXCLUDED.data`,
      [id, type, data],
    );
    const { rows } = await client.query(
      "UPDATE runs SET has_gif = true, gif_branded = $2, gif_v = gif_v + 1 WHERE id = $1 RETURNING *",
      [id, branded],
    );
    await client.query("COMMIT");
    return toRun(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function getGif(id) {
  const { rows } = await pool.query("SELECT type, data FROM gifs WHERE run_id = $1", [id]);
  return rows[0] ? { type: rows[0].type, data: Buffer.from(rows[0].data) } : null;
}

export async function deleteRuns(ids) {
  if (!ids.length) return;
  await pool.query("DELETE FROM runs WHERE id = ANY($1::text[])", [ids]); // GIFs go with them (ON DELETE CASCADE)
}

export async function clearAll() {
  await pool.query("TRUNCATE gifs, runs");
}

export async function ping() {
  await pool.query("SELECT 1");
}
