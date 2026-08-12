-- INSTAR schema — migration 001
--
-- Design decisions encoded here, and why (see work/CONCEPT.md §4):
--   * VECTOR(256), not 1024. Titan Text Embeddings V2 Matryoshka output.
--     1/4 the storage and 1/4 the RU cost per index write. On a 50M-RU hard
--     cap that is the highest-leverage line in this file.
--   * Every embedding is UNIT-NORMALISED at write time. For unit vectors
--     ||a-b||^2 = 2 - 2*cos(a,b), so similarity is recoverable exactly.
--     Writing `1 - (v <-> q)` and calling it cosine yields NEGATIVE
--     similarities in the tail and silently corrupts ranking.
--   * Index opclass is vector_cosine_ops and every query uses <=>.
--     Mismatched opclass/operator = silent full scan, not an error.
--   * Vector indexes carry RELATIONAL PREFIX COLUMNS, vector column last.
--     Verified on v26.2.5: plan shows `prefix spans: [/1/'canonical' - ...]`.
--     Prefix columns filter on = and IN only; a range predicate kills it.
--   * Covering STORING indexes: CockroachDB's own optimizer recommended these
--     to remove the lookup join back to the primary key. Taking the advice.
--
-- Apply:  cockroach-sql --url "$INSTAR_DB_URL" -f migrations/001_init.sql

CREATE DATABASE IF NOT EXISTS instar;
SET database = instar;

-- ─────────────────────────────────────────────────────────────────────────
-- 0. TENANCY. Exists so vector indexes have a prefix column to filter on.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant (
  tenant_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       STRING NOT NULL UNIQUE,
  label      STRING NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────
-- 1. SKILL IDENTITY. The compare-and-swap target for promotion.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skill (
  skill_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenant(tenant_id),
  name           STRING NOT NULL,
  source         STRING NOT NULL
                   CHECK (source IN ('benchflow','cockroachdb-skills','generated')),
  active_instar  INT NOT NULL DEFAULT 1,   -- the molt counter
  archived_at    TIMESTAMPTZ,
  UNIQUE (tenant_id, name)
);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. IMMUTABLE SKILL VERSIONS = procedural memory. Never edited in place.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skill_version (
  skill_id       UUID NOT NULL REFERENCES skill(skill_id),
  instar         INT  NOT NULL,
  tenant_id      UUID NOT NULL REFERENCES tenant(tenant_id),
  skill_md       STRING NOT NULL,
  frontmatter    JSONB NOT NULL,
  -- the `description:` frontmatter field: already written in retrieval form
  -- ("Use when a task involves X, Y, Z"), which is exactly what ANN wants
  trigger_text   STRING NOT NULL,
  embedding      VECTOR(256) NOT NULL,
  body_sha256    STRING NOT NULL,
  tokens         INT NOT NULL DEFAULT 0,      -- context-window rent
  derived_from   UUID[],                      -- lesson_ids justifying this molt
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, instar),
  VECTOR INDEX skill_version_vec (tenant_id, embedding vector_cosine_ops)
);

-- ─────────────────────────────────────────────────────────────────────────
-- 3. EPISODIC MEMORY. What actually happened when a skill was used.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS episode (
  episode_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenant(tenant_id),
  agent_id       UUID NOT NULL,
  -- promotion requires >=2 supporting episodes from DISTINCT sessions, so a
  -- single looping agent cannot bootstrap a false belief into the library
  session_id     UUID NOT NULL,
  task_text      STRING NOT NULL,
  task_embedding VECTOR(256) NOT NULL,
  skill_id       UUID REFERENCES skill(skill_id),
  instar         INT,
  outcome        STRING NOT NULL CHECK (outcome IN ('success','partial','failure')),
  detail         JSONB,
  -- provenance: generated episodes are labelled, never passed off as observed
  is_synthetic   BOOL NOT NULL DEFAULT false,
  ended_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX episode_recent (tenant_id, ended_at DESC),
  VECTOR INDEX episode_vec (tenant_id, task_embedding vector_cosine_ops)
);

-- ─────────────────────────────────────────────────────────────────────────
-- 4. THE LESSON. Semantic/procedural memory — the contested resource.
--    This table is where the set-predicate invariant lives.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lesson (
  lesson_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenant(tenant_id),
  -- canonical topic key, e.g. 'skill:pdf-extract-fill-redact/checkbox-truthy'
  slot             STRING NOT NULL,
  -- +1 = do, -1 = don't. Negative memory is first class: "this did not work"
  -- must be retrievable alongside "this worked".
  polarity         SMALLINT NOT NULL CHECK (polarity IN (-1, 1)),
  body             STRING NOT NULL,
  trigger_text     STRING NOT NULL,
  embedding        VECTOR(256) NOT NULL,
  status           STRING NOT NULL DEFAULT 'candidate'
                     CHECK (status IN ('candidate','canonical','contested',
                                       'superseded','dormant')),
  confidence       FLOAT NOT NULL DEFAULT 0.20,
  -- INVARIANT 1: support_count == COUNT(*) of its 'support' evidence rows.
  -- This is what a lost update under READ COMMITTED breaks.
  support_count    INT NOT NULL DEFAULT 0,
  contradict_count INT NOT NULL DEFAULT 0,
  half_life_days   INT NOT NULL DEFAULT 180,
  -- safety-critical lessons are never withheld by the holdout arm
  hold_eligible    BOOL NOT NULL DEFAULT true,
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_recalled_at TIMESTAMPTZ,
  recall_count     INT NOT NULL DEFAULT 0,
  superseded_by    UUID REFERENCES lesson(lesson_id),
  author_agent_id  UUID,
  source_ref       STRING,           -- e.g. 'reviews/A7-safety.md#FIX-2'
  is_synthetic     BOOL NOT NULL DEFAULT false,
  content_hash     STRING NOT NULL,
  -- cheap exact dedupe; NEAR-duplicate detection is a vector op in the write path
  UNIQUE (tenant_id, content_hash),
  INDEX lesson_slot (tenant_id, slot, status),
  -- ⭐ the differentiator: both relational predicates push INTO the ANN scan
  VECTOR INDEX lesson_vec (tenant_id, status, embedding vector_cosine_ops)
);

-- ─────────────────────────────────────────────────────────────────────────
-- 5. APPEND-ONLY EVIDENCE LEDGER. The single source of truth for confidence.
--    confidence is always RECOMPUTABLE from these rows, never authoritative
--    in the lesson row itself.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lesson_evidence (
  evidence_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id         UUID NOT NULL REFERENCES lesson(lesson_id),
  episode_id        UUID REFERENCES episode(episode_id),
  kind              STRING NOT NULL
                      CHECK (kind IN ('support','contradict','review','human')),
  weight            FLOAT NOT NULL DEFAULT 1.0,
  source_ref        STRING,
  observer_agent_id UUID,
  observed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX evidence_by_lesson (lesson_id, observed_at DESC)
);

-- ─────────────────────────────────────────────────────────────────────────
-- 6. ARBITRATION. What SERIALIZABLE buys us.
--
--    INVARIANT 2 (the centrepiece): for any (tenant_id, slot), the set of
--    rows with status IN ('canonical','contested') must not contain BOTH
--    polarity=+1 and polarity=-1 without an open conflict row.
--
--    This is a PREDICATE OVER A SET. It is deliberately NOT expressible as a
--    UNIQUE constraint, a CHECK, or an exclusion constraint -- none of those
--    can range over other rows. Only transaction isolation can protect it.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conflict (
  conflict_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenant(tenant_id),
  slot        STRING NOT NULL,
  lesson_a    UUID NOT NULL REFERENCES lesson(lesson_id),
  lesson_b    UUID NOT NULL REFERENCES lesson(lesson_id),
  opened_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolution  STRING,
  rationale   STRING,
  INDEX conflict_open (tenant_id, slot, opened_at DESC)
);

-- ─────────────────────────────────────────────────────────────────────────
-- 7. THE HOLDOUT ARM. Utility measured against ABSENCE, not correlated with it.
--    Every other submission measures "memories retrieved before successful
--    runs look useful", which is unfalsifiable. On each retrieval a lesson
--    has a 15% chance of being deliberately WITHHELD and recorded as such,
--    turning utility into a continuous self-administered A/B test.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS injection (
  episode_id      UUID NOT NULL REFERENCES episode(episode_id) ON DELETE CASCADE,
  lesson_id       UUID NOT NULL REFERENCES lesson(lesson_id),
  rank            INT NOT NULL,
  sim             FLOAT NOT NULL,
  tokens          INT NOT NULL DEFAULT 0,
  arm             STRING NOT NULL CHECK (arm IN ('treatment','holdout')),
  withheld_reason STRING,
  PRIMARY KEY (episode_id, lesson_id),
  INDEX injection_by_lesson (lesson_id, arm)
);

-- ─────────────────────────────────────────────────────────────────────────
-- 8. EMBEDDING CACHE + SPEND LEDGER.
--    The Bedrock cap is a PRE-FLIGHT GATE checked before the API call --
--    never a CHECK constraint on the write path. Budget exhaustion must
--    degrade to "store the lesson, embed it later", never abort an episode
--    write. A memory system that loses memory when it is busiest is backwards.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS embed_cache (
  content_hash STRING PRIMARY KEY,
  model        STRING NOT NULL,
  dims         INT NOT NULL,
  embedding    VECTOR(256) NOT NULL,
  hits         INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS spend_ledger (
  day             DATE PRIMARY KEY,
  bedrock_calls   INT NOT NULL DEFAULT 0,
  input_tokens    INT NOT NULL DEFAULT 0,
  est_usd_micros  INT NOT NULL DEFAULT 0,   -- Titan V2 = $0.02 / 1M tokens
  hard_cap_tokens INT NOT NULL DEFAULT 2000000
);

-- ─────────────────────────────────────────────────────────────────────────
-- ⚠️ DO NOT ADD A COVERING INDEX ON (tenant_id, status).
--
-- CockroachDB's optimizer recommends one -- it emits, verbatim:
--   CREATE INDEX ON lesson (tenant_id, status) STORING (body, embedding)
-- to remove the lookup join back to the primary key. Taking that advice
-- BREAKS THE VECTOR SEARCH. Measured on v26.2.5, 26 rows:
--
--   with lesson_cover present -> `• scan  table: lesson@lesson_cover`
--                                (full scan + sort; ANN never runs)
--   with lesson_cover hidden  -> `• vector search  table: lesson@lesson_vec`
--                                `prefix spans: [/<tenant>/'canonical' - ...]`
--
-- The covering index exactly matches the filter, so the optimizer prefers it
-- and silently abandons the ANN path. Because CockroachDB does not warn when
-- a vector index goes unused, this fails SILENTLY -- correct results, wrong
-- plan, and the entire "filter runs inside the index" claim evaporates.
--
-- If a covering index is ever needed for a non-vector query path, create it
-- NOT VISIBLE and make the ANN query the default.
--
-- Verify after ANY schema change:
--   EXPLAIN SELECT ... WHERE tenant_id = '<literal>' AND status = 'canonical'
--     ORDER BY embedding <=> '<vec>' LIMIT k;
--   -- must show `• vector search` and `prefix spans`
--
-- ⚠️ ALSO: prefix-column values must be LITERALS or PLACEHOLDERS.
-- `WHERE tenant_id = (SELECT tenant_id FROM tenant WHERE slug='demo')`
-- produces lookup joins and no prefix spans. Resolve the tenant id in the
-- application, then pass it as $1.
