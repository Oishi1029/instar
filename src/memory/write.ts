/**
 * The INSTAR write path — where correctness depends on transaction isolation.
 *
 * ── THE INVARIANT ─────────────────────────────────────────────────────────
 *
 *   For any (tenant_id, slot), the set of ACTIVE lessons must not contain both
 *   a "do" (polarity +1) and a "don't" (polarity -1) without an open conflict
 *   record.
 *
 * This is deliberately a PREDICATE OVER A SET, not a property of any row. No
 * UNIQUE index, no CHECK constraint and no exclusion constraint can express it,
 * because none of them can range over other rows. **Only isolation protects it.**
 *
 * The write path below is a genuine read-then-write:
 *
 *   1. read the slot's active lessons        <-- the read
 *   2. decide: reinforce / insert / conflict
 *   3. write                                  <-- the write
 *
 * Under READ COMMITTED (PostgreSQL's default) two agents learning opposite
 * rules about the same slot each read a clean slot, each see no conflict, and
 * both commit. The library is then permanently self-contradictory and every
 * later recall returns a do AND a don't for the same situation.
 *
 * Under SERIALIZABLE (CockroachDB's default) the second transaction aborts with
 * 40001, the retry loop re-runs it, it now SEES the first insert, and takes the
 * arbitration path instead.
 *
 * Same cluster. Same code. One knob. That is the demonstration.
 *
 * NOTE ON THE ARGUMENT: the claim is NOT "CockroachDB has SERIALIZABLE" —
 * PostgreSQL has it too. The claim is that correctness here depends entirely on
 * isolation, CockroachDB makes the safe choice the DEFAULT, and no constraint
 * will ever warn you that you needed it.
 */
import type { Pool, PoolClient } from "pg";
import { uuidv5 } from "../ingest/db";

export type Isolation = "SERIALIZABLE" | "READ COMMITTED";

/** Cosine distance below which two lessons in a slot are "the same lesson". */
export const NEAR_DUP_DISTANCE = 0.15;

export interface WriteRequest {
  tenantId: string;
  slot: string;
  polarity: -1 | 1;
  body: string;
  triggerText: string;
  /** '[0.1,-0.2,...]' — unit vector, 256 dims */
  embedding: string;
  contentHash: string;
  episodeId?: string;
  agentId: string;
  sessionId: string;
  holdEligible?: boolean;
}

export type WriteOutcome =
  | { kind: "reinforced"; lessonId: string }
  | { kind: "inserted"; lessonId: string }
  | { kind: "conflict"; lessonId: string; conflictId: string; against: string };

/**
 * Execute one memory write at the given isolation level.
 *
 * `retries` is reported so the demo can show what SERIALIZABLE actually costs:
 * the aborts are not failures, they are the mechanism working.
 */
export async function writeLesson(
  pool: Pool,
  req: WriteRequest,
  isolation: Isolation,
  maxRetries = 10,
): Promise<{ outcome: WriteOutcome; retries: number }> {
  let retries = 0;
  for (;;) {
    const client: PoolClient = await pool.connect();
    try {
      await client.query("BEGIN");
      // CockroachDB supports both levels, so the comparison runs on ONE cluster
      // and there is no straw man to argue with.
      await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
      const outcome = await writeBody(client, req);
      await client.query("COMMIT");
      return { outcome, retries };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      const code = (err as { code?: string }).code;
      if (code === "40001" && retries < maxRetries) {
        retries++;
        // Full jitter: identical backoff would resynchronise the writers and
        // reproduce the same conflict immediately.
        await new Promise((r) => setTimeout(r, Math.random() * Math.min(20 * 2 ** retries, 500)));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

async function writeBody(c: PoolClient, req: WriteRequest): Promise<WriteOutcome> {
  const {
    tenantId, slot, polarity, body, triggerText, embedding,
    contentHash, episodeId, agentId, sessionId, holdEligible = true,
  } = req;

  // ── STAGE 1: READ the slot's active lessons ────────────────────────────
  // This read is the whole point. Under READ COMMITTED it can be stale by the
  // time we write, and nothing tells you.
  const { rows: active } = await c.query(
    `SELECT lesson_id, polarity, support_count,
            (embedding <=> $3) AS dist
       FROM lesson
      WHERE tenant_id = $1
        AND slot = $2
        AND status IN ('candidate','canonical','contested')
      ORDER BY embedding <=> $3`,
    [tenantId, slot, embedding],
  );

  // ── STAGE 2a: near-duplicate -> reinforce rather than fragment ──────────
  // Without this, concurrent agents each insert their own near-identical row
  // and support_count -- which drives confidence and promotion -- is spread
  // across fragments and means nothing.
  // NOTE the explicit null guard. `dist` is NULL whenever the candidate row has
  // no embedding yet (the spend gate's deferred path stores rows with a NULL
  // vector). `Number(null)` is 0, and 0 < 0.15, so without this guard an
  // un-embedded row would be treated as a PERFECT near-duplicate of whatever
  // arrives next — silently swallowing a genuinely new lesson into an unrelated
  // one. Wrong answer, no error.
  const dup = active.find(
    (r) =>
      r.dist !== null &&
      Number.isFinite(Number(r.dist)) &&
      Number(r.dist) < NEAR_DUP_DISTANCE &&
      Number(r.polarity) === polarity,
  );
  if (dup) {
    await c.query(
      `INSERT INTO lesson_evidence (evidence_id, lesson_id, episode_id, kind, observer_agent_id)
       VALUES ($1,$2,$3,'support',$4) ON CONFLICT (evidence_id) DO NOTHING`,
      [uuidv5(`ev/${dup.lesson_id}/${sessionId}/${contentHash}`), dup.lesson_id, episodeId ?? null, agentId],
    );
    // support_count is a denormalisation of the evidence ledger. INVARIANT 1
    // says they must agree; a lost update here is what breaks it.
    await c.query(
      `UPDATE lesson
          SET support_count = (SELECT count(*) FROM lesson_evidence
                                WHERE lesson_id = $1 AND kind = 'support'),
              last_recalled_at = now()
        WHERE lesson_id = $1`,
      [dup.lesson_id],
    );
    return { kind: "reinforced", lessonId: String(dup.lesson_id) };
  }

  // ── STAGE 2b: THE SET PREDICATE ────────────────────────────────────────
  // Is there an active lesson of OPPOSITE polarity in this slot? No constraint
  // can ask this question; only a transaction can.
  const opposite = active.find((r) => Number(r.polarity) === -polarity);

  const lessonId = uuidv5(`lesson/${tenantId}/${contentHash}`);
  await c.query(
    `INSERT INTO lesson
       (lesson_id, tenant_id, slot, polarity, body, trigger_text, embedding,
        status, source_ref, is_synthetic, hold_eligible, content_hash, author_agent_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,$10,$11,$12)
     ON CONFLICT (tenant_id, content_hash) DO NOTHING`,
    [lessonId, tenantId, slot, polarity, body, triggerText, embedding,
     opposite ? "contested" : "candidate", `agent:${agentId}`, holdEligible, contentHash, agentId],
  );
  await c.query(
    `INSERT INTO lesson_evidence (evidence_id, lesson_id, episode_id, kind, observer_agent_id)
     VALUES ($1,$2,$3,'support',$4) ON CONFLICT (evidence_id) DO NOTHING`,
    [uuidv5(`ev/${lessonId}/${sessionId}/${contentHash}`), lessonId, episodeId ?? null, agentId],
  );

  if (opposite) {
    // Arbitration, not silent averaging. Both sides are marked contested and a
    // conflict record is opened so a human (or a later adjudicator) can decide.
    const conflictId = uuidv5(`conflict/${tenantId}/${slot}/${lessonId}/${opposite.lesson_id}`);
    await c.query(
      `INSERT INTO conflict (conflict_id, tenant_id, slot, lesson_a, lesson_b, rationale)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (conflict_id) DO NOTHING`,
      [conflictId, tenantId, slot, lessonId, opposite.lesson_id,
       // Provenance token: 'emergent:' means the system found this itself.
       // Hand-seeded conflicts are labelled 'curated:' and rendered differently.
       `emergent: opposite polarity written to an occupied slot`],
    );
    await c.query(
      `UPDATE lesson SET status='contested' WHERE lesson_id = ANY($1::UUID[])`,
      [[lessonId, opposite.lesson_id]],
    );
    return { kind: "conflict", lessonId, conflictId, against: String(opposite.lesson_id) };
  }

  return { kind: "inserted", lessonId };
}

/**
 * Integrity audit — the numbers the demo puts on screen.
 *
 * Both checks are queries a judge can run themselves against the same database.
 */
export interface Integrity {
  /** slots holding BOTH an active +1 and an active -1 with NO open conflict */
  undetectedContradictions: number;
  /** lessons whose support_count disagrees with the evidence ledger */
  ledgerDrift: number;
  totalLessons: number;
  openConflicts: number;
}

export async function auditIntegrity(pool: Pool, tenantId: string): Promise<Integrity> {
  const { rows: [r] } = await pool.query(
    `WITH slot_polarity AS (
       SELECT slot,
              bool_or(polarity = 1)  AS has_do,
              bool_or(polarity = -1) AS has_dont
         FROM lesson
        WHERE tenant_id = $1 AND status IN ('candidate','canonical','contested')
        GROUP BY slot
     ),
     unguarded AS (
       SELECT sp.slot FROM slot_polarity sp
        WHERE sp.has_do AND sp.has_dont
          AND NOT EXISTS (
            SELECT 1 FROM conflict c
             WHERE c.tenant_id = $1 AND c.slot = sp.slot AND c.resolved_at IS NULL)
     ),
     drift AS (
       SELECT l.lesson_id
         FROM lesson l
        WHERE l.tenant_id = $1
          AND l.support_count <> (
            SELECT count(*) FROM lesson_evidence e
             WHERE e.lesson_id = l.lesson_id AND e.kind = 'support')
     )
     SELECT (SELECT count(*) FROM unguarded)                                   AS undetected,
            (SELECT count(*) FROM drift)                                       AS drift,
            (SELECT count(*) FROM lesson WHERE tenant_id = $1)                 AS total,
            (SELECT count(*) FROM conflict
              WHERE tenant_id = $1 AND resolved_at IS NULL)                    AS open_conflicts`,
    [tenantId],
  );
  return {
    undetectedContradictions: Number(r.undetected),
    ledgerDrift: Number(r.drift),
    totalLessons: Number(r.total),
    openConflicts: Number(r.open_conflicts),
  };
}
