-- INSTAR migration 002 — make embeddings nullable
--
-- WHY: 001 declared every embedding column NOT NULL, which directly contradicts
-- the documented spend-gate behaviour ("budget exhaustion degrades to: store the
-- row now, embed it later; never abort a write"). Both could not be true.
--
-- PROBED on the live v26.2.5 Basic cluster before writing this file:
--   1. INSERT ... embedding = NULL  -> rejected by the NOT NULL constraint (23502)
--   2. ALTER COLUMN ... DROP NOT NULL, then the same INSERT -> succeeded
--   3. Re-ran the ANN query afterwards. Plan STILL shows:
--        • vector search
--            table: lesson@lesson_vec
--            prefix spans: [/'<tenant>'/'canonical' - /'<tenant>'/'canonical']
--
-- So a vector-INDEXED column tolerates NULL, and rows with a NULL vector are
-- simply absent from the index. The degradation path is real, not aspirational.
--
-- NOTE: do NOT add `AND embedding IS NOT NULL` to retrieval queries. NULL rows
-- are excluded from the index for free, and adding the predicate is an
-- unverified plan change on the one query the whole submission rests on.

SET database = instar;

ALTER TABLE lesson        ALTER COLUMN embedding      DROP NOT NULL;
ALTER TABLE episode       ALTER COLUMN task_embedding DROP NOT NULL;
ALTER TABLE skill_version ALTER COLUMN embedding      DROP NOT NULL;

-- Backfill worklist indexes: find rows still awaiting an embedding.
-- Partial indexes, so they cannot compete with the vector indexes for the
-- main retrieval query (see the covering-index warning in 001).
CREATE INDEX IF NOT EXISTS lesson_needs_embed
  ON lesson (tenant_id) WHERE embedding IS NULL;
CREATE INDEX IF NOT EXISTS episode_needs_embed
  ON episode (tenant_id) WHERE task_embedding IS NULL;
CREATE INDEX IF NOT EXISTS skill_version_needs_embed
  ON skill_version (tenant_id) WHERE embedding IS NULL;

-- ── REGRESSION ASSERTION ──────────────────────────────────────────────────
-- Re-run after EVERY migration. The plan below MUST contain
-- `• vector search` and `prefix spans`. If it shows a plain scan, a new index
-- has cannibalised lesson_vec (this already happened once — see 001).
--
--   EXPLAIN SELECT lesson_id FROM lesson
--   WHERE tenant_id = '<literal uuid>' AND status = 'canonical'
--   ORDER BY embedding <=> '<256-dim unit vector literal>' LIMIT 5;
