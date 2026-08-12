/**
 * Database access for the ingest: deterministic ids and idempotent writes.
 *
 * The ingest will be run many times during the build week. Two rules make that
 * safe, and both are here rather than sprinkled through call sites.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pg from "pg";

/**
 * CockroachDB returns VECTOR as a string like '[0.1,-0.2,...]'. node-postgres
 * has no type parser for the oid, which is fine — we only ever read it back for
 * verification, and comparing the literal is exactly what we want.
 */
export function connectionString(): string {
  const envUrl = process.env.INSTAR_DB_URL;
  if (envUrl) return envUrl;
  const p = join(homedir(), ".instar", "dburl_instar");
  try {
    return readFileSync(p, "utf8").trim();
  } catch {
    throw new Error(
      `No database URL. Set INSTAR_DB_URL or create ${p} (mode 0600, never in the repo).`,
    );
  }
}

export function makePool(): pg.Pool {
  const pool = new pg.Pool({
    connectionString: connectionString(),
    // Must be >= the ingest's worker count, or workers block waiting for a
    // connection and the concurrency setting is a lie. Measured: with max=6
    // and 16 workers, throughput was ~35 rows/min; ten workers were parked.
    // The round trip to ap-southeast-1 dominates, so connections are the
    // resource to spend, not to conserve.
    max: Number(process.env.INSTAR_POOL_MAX ?? 24),
    idleTimeoutMillis: 10_000,
    application_name: "instar-ingest",
  });
  // Without this, an idle client erroring (CockroachDB Basic recycles idle
  // connections) emits an 'error' event with no listener, which in Node is an
  // uncaught exception that kills the process. On a judge-facing demo that
  // means the site is simply down, with no clue why.
  pool.on("error", (err) => {
    console.error("[instar] idle pg client error:", err.message);
  });
  return pool;
}

/**
 * UUIDv5 — deterministic ids from a stable name.
 *
 * `episode`, `lesson_evidence` and `conflict` default to gen_random_uuid(),
 * so a re-run would insert a fresh duplicate of every row. That is not merely
 * wasteful: duplicate evidence rows inflate `support_count`, which feeds
 * `confidence`, which decides promotion to `canonical` — the set that
 * retrieval actually reads. Non-determinism here silently corrupts what the
 * system believes.
 *
 * RFC 4122 §4.3, SHA-1 based, with a namespace checked into the repo so the
 * ids are reproducible by anyone.
 */
export const INSTAR_NAMESPACE = "6f9619ff-8b86-d011-b42d-00c04fc964ff";

export function uuidv5(name: string, namespace = INSTAR_NAMESPACE): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1")
    .update(nsBytes)
    .update(Buffer.from(name, "utf8"))
    .digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50; // version 5
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Idempotent insert that ALWAYS returns the row's id.
 *
 * `INSERT … ON CONFLICT DO NOTHING RETURNING id` returns ZERO rows when the row
 * already exists. On a second run that yields `undefined` for every id, and
 * every dependent write downstream silently no-ops — producing an ingest that
 * reports success having written nothing. The UNION ALL fallback closes it.
 */
export async function upsertReturningId(
  pool: pg.Pool,
  insertSql: string,
  insertParams: unknown[],
  selectSql: string,
  selectParams: unknown[],
): Promise<string> {
  const sql = `WITH ins AS (${insertSql})
               SELECT id FROM ins
               UNION ALL
               (${selectSql})
               LIMIT 1`;
  const { rows } = await pool.query(sql, [...insertParams, ...selectParams]);
  const id = rows[0]?.id;
  if (!id) throw new Error(`upsertReturningId produced no id for: ${insertSql.slice(0, 80)}`);
  return String(id);
}

/** Retry a transaction on CockroachDB's serialization failure (SQLSTATE 40001). */
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  max = 8,
  onRetry?: (attempt: number) => void,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "40001" || attempt >= max) throw err;
      onRetry?.(attempt + 1);
      // Exponential backoff with full jitter; equal waits would resynchronise
      // the writers and reproduce the same conflict immediately.
      await new Promise((r) => setTimeout(r, Math.random() * Math.min(50 * 2 ** attempt, 2000)));
    }
  }
}

/** Resolve a tenant id ONCE, in application code. */
export async function ensureTenant(
  pool: pg.Pool,
  slug: string,
  label: string,
): Promise<string> {
  return upsertReturningId(
    pool,
    `INSERT INTO tenant (slug, label) VALUES ($1, $2)
       ON CONFLICT (slug) DO NOTHING RETURNING tenant_id AS id`,
    [slug, label],
    `SELECT tenant_id AS id FROM tenant WHERE slug = $3`,
    [slug],
  );
}
