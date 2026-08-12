/**
 * Bedrock spend gate.
 *
 * THE RULE: the cap is a PRE-FLIGHT GATE checked before the API call. It is
 * never a CHECK constraint on the write path.
 *
 * Why it matters: if budget exhaustion could abort a memory write, then the
 * system would lose memories precisely when it is busiest — the exact opposite
 * of what a memory system is for. When the budget is gone we store the row with
 * a NULL embedding and backfill later. (Verified on the live cluster: a
 * vector-INDEXED column accepts NULL, rows with NULL vectors are simply absent
 * from the index, and the ANN query plan is unaffected — see migration 002.)
 */
import type { Pool } from "pg";
import { USD_MICROS_PER_TOKEN } from "./bedrock.js";

/** Stop calling Bedrock at 90% of cap, leaving headroom for in-flight work. */
export const GATE_FRACTION = 0.9;

export interface SpendStatus {
  day: string;
  inputTokens: number;
  hardCapTokens: number;
  bedrockCalls: number;
  estUsdMicros: number;
  /** false => store rows with NULL embeddings and backfill later */
  mayEmbed: boolean;
  remainingTokens: number;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function getSpend(pool: Pool): Promise<SpendStatus> {
  const day = today();
  // Idempotent upsert-then-read. `ON CONFLICT DO NOTHING ... RETURNING` returns
  // ZERO rows when the row already exists, which would silently yield undefined
  // on every run after the first — so read unconditionally afterwards.
  await pool.query(
    `INSERT INTO spend_ledger (day) VALUES ($1) ON CONFLICT (day) DO NOTHING`,
    [day],
  );
  const { rows } = await pool.query(
    `SELECT day, bedrock_calls, input_tokens, est_usd_micros, hard_cap_tokens
       FROM spend_ledger WHERE day = $1`,
    [day],
  );
  const r = rows[0];
  const used = Number(r.input_tokens);
  const cap = Number(r.hard_cap_tokens);
  return {
    day,
    inputTokens: used,
    hardCapTokens: cap,
    bedrockCalls: Number(r.bedrock_calls),
    estUsdMicros: Number(r.est_usd_micros),
    mayEmbed: used < cap * GATE_FRACTION,
    remainingTokens: Math.max(0, Math.floor(cap * GATE_FRACTION) - used),
  };
}

/**
 * Record actual spend AFTER a successful Bedrock call, using the token count
 * Titan itself returned rather than a local estimate.
 *
 * est_usd_micros is recomputed as a SET from the authoritative token total, not
 * incremented — an incremented column drifts permanently after any partial
 * failure, and a money figure that drifts is worse than no figure.
 */
export async function recordSpend(
  pool: Pool,
  inputTokens: number,
): Promise<void> {
  await pool.query(
    `UPDATE spend_ledger
        SET bedrock_calls  = bedrock_calls + 1,
            input_tokens   = input_tokens + $2,
            est_usd_micros = (input_tokens + $2) * $3
      WHERE day = $1`,
    [today(), inputTokens, USD_MICROS_PER_TOKEN],
  );
}
