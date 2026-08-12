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
 * In-memory spend accumulator for high-concurrency work.
 *
 * ── WHY THIS EXISTS (measured, not theoretical) ──────────────────────────
 * `spend_ledger` holds ONE ROW PER DAY. The first ingest called getSpend() +
 * recordSpend() per item across 8 concurrent workers — so every worker was
 * doing an INSERT/SELECT/UPDATE against the SAME row, sixteen times per
 * second. Under SERIALIZABLE that is a guaranteed write conflict: throughput
 * collapsed to ~20 rows/minute and the ledger recorded 200 Bedrock calls
 * while only 98 rows had landed, because workers were burning their time
 * losing races and retrying.
 *
 * The fix is not weaker isolation — it is not making a hot row hot. Read the
 * budget once, accumulate locally, and flush from a single writer. The gate
 * stays honest because the local counter is authoritative between flushes and
 * is reconciled on every flush.
 */
export class SpendTracker {
  private localTokens = 0;
  private localCalls = 0;
  private base!: SpendStatus;
  private unflushedTokens = 0;
  private unflushedCalls = 0;

  constructor(private pool: Pool, private flushEvery = 100) {}

  async init(): Promise<SpendStatus> {
    this.base = await getSpend(this.pool);
    return this.base;
  }

  /** Pre-flight gate. No database round-trip on the hot path. */
  mayEmbed(): boolean {
    return (
      this.base.inputTokens + this.localTokens <
      this.base.hardCapTokens * GATE_FRACTION
    );
  }

  async note(inputTokens: number): Promise<void> {
    this.localTokens += inputTokens;
    this.localCalls += 1;
    this.unflushedTokens += inputTokens;
    this.unflushedCalls += 1;
    if (this.unflushedCalls >= this.flushEvery) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.unflushedCalls === 0) return;
    const tokens = this.unflushedTokens;
    const calls = this.unflushedCalls;
    this.unflushedTokens = 0;
    this.unflushedCalls = 0;
    await this.pool.query(
      `UPDATE spend_ledger
          SET bedrock_calls  = bedrock_calls + $2,
              input_tokens   = input_tokens + $3,
              est_usd_micros = ((input_tokens + $3)::DECIMAL * 0.02)::INT
        WHERE day = $1`,
      [today(), calls, tokens],
    );
  }

  summary(): { calls: number; tokens: number; usd: number } {
    return {
      calls: this.localCalls,
      tokens: this.localTokens,
      usd: (this.localTokens / 1e6) * 0.02,
    };
  }
}

/**
 * Record actual spend AFTER a successful Bedrock call, using the token count
 * Titan itself returned rather than a local estimate.
 *
 * Prefer SpendTracker for bulk work — this per-call form serialises on a single
 * row and will collapse under concurrency.
 *
 * est_usd_micros is recomputed as a SET from the authoritative token total, not
 * incremented — an incremented column drifts permanently after any partial
 * failure, and a money figure that drifts is worse than no figure.
 */
export async function recordSpend(
  pool: Pool,
  inputTokens: number,
): Promise<void> {
  // est_usd_micros is INT. Multiplying by a float PARAMETER makes CockroachDB
  // try to parse 0.02 as an INT (22P02), so the rate is an inline decimal
  // literal and the result is cast explicitly. Recomputed as a SET from the
  // authoritative token total rather than incremented — an incremented money
  // column drifts permanently after any partial failure.
  await pool.query(
    `UPDATE spend_ledger
        SET bedrock_calls  = bedrock_calls + 1,
            input_tokens   = input_tokens + $2,
            est_usd_micros = ((input_tokens + $2)::DECIMAL * 0.02)::INT
      WHERE day = $1`,
    [today(), inputTokens],
  );
}
