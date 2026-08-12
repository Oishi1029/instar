-- INSTAR make-or-break spike.
-- Purpose: prove, on the REAL free Basic cluster, the three things the whole concept rests on.
-- Run:  cockroach-sql --url "$INSTAR_DB_URL" -f spike.sql
-- Every check prints a line starting with 'SPIKE' so results are greppable.

SELECT 'SPIKE 0  version' AS check, version() AS result;

----------------------------------------------------------------------------
-- CHECK 1 — does the VECTOR type + CREATE VECTOR INDEX work on Basic?
-- VERIFIED-FACTS says feature.vector_index.enabled defaults true on Basic in
-- v25.4+, and that the docs page telling you to SET CLUSTER SETTING is stale.
-- This proves it rather than trusting it.
----------------------------------------------------------------------------

DROP TABLE IF EXISTS spike_lesson;

CREATE TABLE spike_lesson (
  lesson_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  INT    NOT NULL,
  status     STRING NOT NULL,
  body       STRING NOT NULL,
  embedding  VECTOR(3) NOT NULL,
  -- ⭐ the differentiator: relational prefix columns, vector column LAST
  VECTOR INDEX lesson_vec (tenant_id, status, embedding vector_cosine_ops)
);

SELECT 'SPIKE 1  vector index created' AS check, 'PASS' AS result;

----------------------------------------------------------------------------
-- CHECK 2 — seed. NOTE: docs say DO NOT batch-insert vectors. Row at a time.
-- Unit-normalised on purpose: sim = 1 - d^2/2 only holds for unit vectors.
----------------------------------------------------------------------------

INSERT INTO spike_lesson (tenant_id, status, body, embedding) VALUES (1,'canonical','tenant1 canonical A','[1.0,0.0,0.0]');
INSERT INTO spike_lesson (tenant_id, status, body, embedding) VALUES (1,'canonical','tenant1 canonical B','[0.9701,0.2425,0.0]');
INSERT INTO spike_lesson (tenant_id, status, body, embedding) VALUES (1,'dormant',  'tenant1 dormant',    '[1.0,0.0,0.0]');
INSERT INTO spike_lesson (tenant_id, status, body, embedding) VALUES (2,'canonical','tenant2 canonical',  '[1.0,0.0,0.0]');
INSERT INTO spike_lesson (tenant_id, status, body, embedding) VALUES (1,'canonical','tenant1 orthogonal', '[0.0,1.0,0.0]');

SELECT 'SPIKE 2  rows seeded' AS check, count(*)::STRING AS result FROM spike_lesson;

----------------------------------------------------------------------------
-- CHECK 3 — THE MONEY QUERY. Filtered ANN.
-- If the prefix columns work, tenant 2 and dormant rows are pruned INSIDE the
-- index, and we get back only tenant1+canonical rows, nearest first.
----------------------------------------------------------------------------

SELECT 'SPIKE 3  filtered ANN' AS check, body, round((1 - (embedding <=> '[1.0,0.0,0.0]')::FLOAT)::NUMERIC, 4)::STRING AS cosine_sim
FROM spike_lesson
WHERE tenant_id = 1 AND status = 'canonical'
ORDER BY embedding <=> '[1.0,0.0,0.0]'
LIMIT 3;

----------------------------------------------------------------------------
-- CHECK 4 — PROVE THE INDEX IS ACTUALLY USED.
-- Expect a '• vector search' node and 'prefix spans'. A full scan + sort here
-- means the index is NOT being used and the whole pgvector argument weakens.
-- CockroachDB generates NO index recommendations for vector indexes, so this
-- manual check is the only signal.
----------------------------------------------------------------------------

EXPLAIN
SELECT body FROM spike_lesson
WHERE tenant_id = 1 AND status = 'canonical'
ORDER BY embedding <=> '[1.0,0.0,0.0]'
LIMIT 3;

----------------------------------------------------------------------------
-- CHECK 5 — 🔴 THE CENTREPIECE. Is READ COMMITTED selectable on Basic?
-- The entire isolation demo dies if this errors. Tested before any app code.
----------------------------------------------------------------------------

SHOW default_transaction_isolation;

BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED;
  SELECT 'SPIKE 5  READ COMMITTED accepted' AS check, current_setting('transaction_isolation') AS result;
COMMIT;

BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;
  SELECT 'SPIKE 5b SERIALIZABLE accepted' AS check, current_setting('transaction_isolation') AS result;
COMMIT;

----------------------------------------------------------------------------
-- CHECK 6 — AS OF SYSTEM TIME (the supporting provenance beat) + GC window.
----------------------------------------------------------------------------

SELECT 'SPIKE 6  as of system time' AS check, count(*)::STRING AS result
FROM spike_lesson AS OF SYSTEM TIME '-10s';

----------------------------------------------------------------------------
-- CHECK 7 — the set-predicate invariant this whole project is about.
-- There is NO unique index that can express "no (tenant,slot) may hold both
-- an active +1 and an active -1 without an open conflict". Prove it is a
-- legal query, so the write path can evaluate it inside a transaction.
----------------------------------------------------------------------------

SELECT 'SPIKE 7  set predicate is expressible as a query, not a constraint' AS check,
       count(*)::STRING AS conflicting_slots
FROM (
  SELECT tenant_id
  FROM spike_lesson
  WHERE status = 'canonical'
  GROUP BY tenant_id
  HAVING count(*) FILTER (WHERE body LIKE '%A%') > 0
     AND count(*) FILTER (WHERE body LIKE '%orthogonal%') > 0
);

DROP TABLE spike_lesson;
SELECT 'SPIKE    done' AS check, 'cleaned up' AS result;
