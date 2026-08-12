# INSTAR

**Agent skills that learn from their own failures — in a database where two agents cannot teach them opposite things.**

An **instar** is the stage of a cockroach's life between two moults. Submission to the
[CockroachDB × AWS Hackathon: Build with Agentic Memory](https://cockroachdb-ai.devpost.com/).
Solo build by Bong Bin Yong ([@Oishi1029](https://github.com/Oishi1029)).

---

## Required technology

**CockroachDB tools used: 4 of 4** (the rules require ≥ 2). Detail — including what the code actually
does with each — is in [*What the agent did with each tool*](#what-the-agent-did-with-each-tool).

| Tool | Used for | Evidence in this repo |
|---|---|---|
| **Distributed Vector Indexing** | 3 vector indexes, `VECTOR(256)`, `vector_cosine_ops`, with **relational prefix columns** so `tenant_id` and `status` are evaluated *inside* the ANN scan | `migrations/001_init.sql`; verified plan below; `/api/recall` returns the live `EXPLAIN` with every response |
| **ccloud CLI** | Cluster provisioning, SQL user creation, connection string, and **reading the RU meter** — there is no working SQL meter on a Basic cluster | `scripts/ru_meter.sh` (parses `ccloud billing invoice list -o json`), consumed by `scripts/calibrate_ru.py` |
| **Cloud Managed MCP Server** | Registered, OAuth'd, **read-only**, pinned to one cluster via `mcp-cluster-id: ab077df5-2917-45a6-b20d-e32aa611b879`. Used as the human audit surface during the build — schema inspection, row counts, plan checks — deliberately **not** the application's data plane | Every schema/plan claim below was cross-checked through it; the app connects over `pg` instead, for the reasons in the tool section |
| **Agent Skills Repo** | All **34** skills from `cockroachlabs/cockroachdb-skills` (Apache-2.0) are ingested as live corpus — parsed, chunked, embedded and retrievable, alongside 16 skills authored by the same developer | `src/ingest/parseSkills.ts`; 50 `skill_version` rows and 2,027 documentation chunks in the database |

**AWS services used: 1** (the rules require ≥ 1).

| Service | Used for | Measured |
|---|---|---|
| **Amazon Bedrock** — `amazon.titan-embed-text-v2:0`, `us-east-1` | Every embedding in the system: 256-dim Matryoshka output, `{"dimensions":256,"normalize":true}`, content-hash cached, behind a pre-flight spend gate | Returned L2 norm **1.000000005**; **1,569 calls / 193,630 input tokens / $0.0039** for the full corpus load |

AWS Lambda, S3 and Secrets Manager were designed into the architecture and **are not built** — the
shipped system uses Bedrock only. See [*Not built*](#not-built).

**Infrastructure under test, stated once and applying to every number below:** CockroachDB Cloud
**Basic** (free tier), cluster `agentic-memory`, **v26.2.5**, AWS **ap-southeast-1**, single region,
`num_replicas = 3`, hard limit **50M RU / 10 GiB**, `gc.ttlseconds = 4500`. AWS account on the Free
plan; IAM user `instar-dev` scoped to Bedrock only.

---

## The problem

Agent skill libraries are written once and then rot. An agent fails a task, a human writes a review
finding, and the finding goes into a document nobody reads again. The skill stays wrong. The next
agent makes the same mistake.

INSTAR treats a skill library as memory that accumulates evidence:

- **procedural memory** — immutable, versioned skill bodies (`skill_version`, one row per *instar*)
- **semantic memory** — atomic lessons in a **slot** (a canonical topic key), each with a
  **polarity**: `+1` = "do this", `-1` = "don't do this". Negative memory is first class; "this did
  not work" must be retrievable next to "this worked".
- **an append-only evidence ledger** — `confidence` is always recomputable from `lesson_evidence`
  rows, never authoritative in the lesson row itself
- **arbitration** — when two agents write opposite polarities into the same slot, the system opens a
  `conflict` record rather than silently averaging or last-writer-wins

The corpus is real. 2,353 rows, zero synthetic:

| Source | Rows |
|---|---|
| `skill_version` — 15 BenchFlow skills + `skill-creator` + 34 from `cockroachlabs/cockroachdb-skills` | 50 |
| documentation chunks (slot `doc:*`, permanently `candidate`, never promotable) | 2,027 |
| lessons derived from real review findings | 276 |

Final line of the load, verbatim:

```
── post-load assertions ───────────────────────────────────
  lessons      : 2303
  skills       : 50
  unembedded   : 0
  synthetic    : 0   (must be 0)
  promoted docs: 0   (must be 0)

INGEST: OK
```

### Where the 276 lessons came from, and the bug that nearly hid 184 of them

The lessons are parsed from **42 independent review documents (4,483 lines)** written across three
lenses (compliance, safety, regression) over 14 skill codes: **276 findings — 13 BLOCK / 129 FIX /
134 NIT — across 274 distinct slots**.

The corpus uses **five different finding syntaxes**, because it was written over many sessions and
the format drifted. A parser handling only the first one found **92 of 276 while looking perfectly
healthy** — no exception, no empty output, just a plausible-looking number.

It was caught because the reviews declare their own verdict tuple (`**Verdict: 0 BLOCK, 1 FIX, 2
NIT.**`), so the parser can be checked against the corpus rather than against itself. Eleven files
declared six findings and parsed zero. `src/ingest/tally.ts` is that gate, and it runs today:

```
review documents : 42
gate             : MATCHED=40 MISMATCH=0 NO_VERDICT=2
findings         : 276  (BLOCK 13 / FIX 129 / NIT 134)
distinct slots   : 274
slots contested across >1 review lens : 2
hold-ineligible (BLOCK or safety lens) : 64
  NO_VERDICT A7-safety.md (2 findings, uncheckable)
  NO_VERDICT B2-regression.md (10 findings, uncheckable)

GATE: PASSED — 276 findings, 0 mismatches
```

Two files declare no tuple at all. They are **logged, not quarantined** — a strict gate would have
dropped 12 real findings, which is exactly the class of bug the gate exists to catch. `src/ingest/run.ts`
refuses to run if the total is not 276 or if any file mismatches.

---

## The one property Postgres cannot provide

The invariant INSTAR is built around:

> For any `(tenant, slot)`, the set of **active** lessons must not contain both a "do" (`polarity =
> +1`) and a "don't" (`polarity = -1`) without an **open conflict record**.

This is deliberately a **predicate over a set**, not a property of a row. No `UNIQUE` index, no
`CHECK`, no exclusion constraint can express it, because none of them can range over other rows.
**Only transaction isolation protects it.**

The write path (`src/memory/write.ts`) is a genuine read-then-write:

1. read the slot's active lessons
2. decide: reinforce a near-duplicate / insert / open a conflict
3. write

Under **`READ COMMITTED`** — PostgreSQL's default — two agents learning opposite rules each read a
clean slot, each see no conflict, and both commit. The library is now permanently
self-contradictory, and every later recall returns a *do* and a *don't* for the same situation.

Under **`SERIALIZABLE`** — CockroachDB's default — the second transaction aborts with `40001`, the
retry loop re-runs it, it now *sees* the first insert, and takes the arbitration path.

**The claim is not "CockroachDB has SERIALIZABLE"** — PostgreSQL has it too. The claim is that
correctness here depends *entirely* on isolation, CockroachDB makes the safe choice the **default**,
and no constraint will ever warn you that you needed it.

---

## The storm: falsifying that claim on one cluster

`src/demo/storm.ts` runs 16 agents concurrently learning contradictory rules about 6 contested
slots. **Same cluster, same code, same workload, same 16 agents.** The only difference between the
two arms is one `SET TRANSACTION ISOLATION LEVEL`. Each arm gets its own tenant so they cannot
contaminate each other.

| | `READ COMMITTED` (PG default) | `SERIALIZABLE` (CRDB default) |
|---|---|---|
| **undetected contradictions** | **5 of 6 slots** | **0** |
| **ledger drift** (`support_count` ≠ evidence ledger) | **92 lessons** | **0** |
| lessons stored | 94 | 12 |
| open conflicts | 1 | 6 |
| retries absorbed | 1 | **405** |
| **failed writes** | **0** | **0** |
| elapsed | 2.0s | 19.3s |
| integrity | CORRUPTED | CLEAN |

Run log committed verbatim at [`docs/storm-run-2026-08-12.txt`](docs/storm-run-2026-08-12.txt):

```
━━━ ARM: READ COMMITTED ━━━ 16 agents, 6 contested slots
  writes    : inserted=93 reinforced=2 conflict=1 failed=0
  retries   : 1   (aborts absorbed by the retry loop)
  elapsed   : 2.0s
  lessons   : 94
  open conflicts            : 1
  ⚠ UNDETECTED CONTRADICTIONS: 5
  ⚠ LEDGER DRIFT             : 92
  INTEGRITY : ❌ CORRUPTED

━━━ ARM: SERIALIZABLE ━━━ 16 agents, 6 contested slots
  writes    : inserted=6 reinforced=84 conflict=6 failed=0
  retries   : 405   (aborts absorbed by the retry loop)
  elapsed   : 19.3s
  lessons   : 12
  open conflicts            : 6
  ⚠ UNDETECTED CONTRADICTIONS: 0
  ⚠ LEDGER DRIFT             : 0
  INTEGRITY : ✅ CLEAN
```

**94 versus 12 lessons is the tell.** Under `READ COMMITTED` every agent read an empty slot, saw no
conflict, and inserted its own row — 94 fragmented beliefs, 92 of them with support counts that
disagree with the evidence ledger, and five of six topics where the library simultaneously believes
"do X" and "never do X" with no record that they disagree. Under `SERIALIZABLE` the aborts forced
each writer to re-read, so 84 writes became reinforcement of an existing lesson and all six genuine
contradictions opened arbitration.

**The cost is real and is not hidden: 19.3s versus 2.0s, and 405 aborted transactions.** Zero writes
were lost in either arm — the retries are the mechanism working, not failures.

Two implementation notes that matter for anyone reproducing this:

- **Contention structure, not agent count, drives the signal.** The first version looped
  agent-outer/slot-inner, letting agents drift out of phase; it produced **1** undetected
  contradiction. The committed version is **slot-outer/agent-inner**: every agent is released onto
  the same slot simultaneously, which is the race a real fleet actually experiences.
- The audit is plain SQL (`auditIntegrity` in `src/memory/write.ts`) that a judge can run
  themselves. The web console re-runs it **live against the cluster** rather than displaying the
  numbers above from a log.

```bash
npx tsx src/demo/storm.ts --agents 16          # both arms
npx tsx src/demo/storm.ts --only "READ COMMITTED"
```

---

## The verified query plan

The other central claim. `EXPLAIN` output from the live Basic cluster on v26.2.5:

```
• vector search
    table: lesson@lesson_vec
    target count: 5
    prefix spans: [/'ed01fe73-7396-4807-a105-047b4805bf81'/'canonical'
                 - /'ed01fe73-7396-4807-a105-047b4805bf81'/'canonical']
```

Both relational predicates — `tenant_id = $1` **and** `status = $3` — are evaluated **inside** the
ANN scan. pgvector's HNSW has no equivalent: you either post-filter (ask for `LIMIT 8` and get fewer
usable rows) or maintain one partial index per filter value.

`/api/recall` returns the plan with every response and sets `usesVectorIndex` by testing the plan
text for `vector search` **and** `prefix spans`, so a regression is visible in the UI rather than
buried. Measured recall latency: **136 ms end-to-end through the API** (Next.js route → Bedrock cache
lookup → ANN query, client in Malaysia, cluster in ap-southeast-1); **~45 ms** for the SQL alone.

### Two ways this breaks silently

1. **A covering index cannibalises it.** CockroachDB's own optimizer recommends, verbatim,
   `CREATE INDEX ON lesson (tenant_id, status) STORING (body, embedding)` to remove the lookup join.
   Take the advice and the plan becomes a plain scan plus sort — **the ANN path never runs**. Results
   stay correct, nothing warns you, and CockroachDB emits no index recommendations for vector indexes
   to tell you one went unused. The warning is written into `migrations/001_init.sql` where the next
   person will see it.
2. **A subquery in a prefix predicate.** `WHERE tenant_id = (SELECT tenant_id FROM tenant WHERE
   slug = $1)` produces lookup joins and **no prefix spans at all**. The tenant id must be resolved
   in application code and passed as a placeholder — which is why `src/query/recall.ts` and
   `app/api/recall/route.ts` both do exactly that, with a comment saying why.

---

## The memory model

Abridged from [`migrations/001_init.sql`](migrations/001_init.sql) **with `002`'s `DROP NOT NULL`
already applied** (`001` declares `embedding … NOT NULL`; `002` removes it so the spend gate can
defer embedding) — comments and seven supporting
tables removed; the full file carries the reasoning.

```sql
CREATE TABLE lesson (
  lesson_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenant(tenant_id),
  -- canonical topic key, e.g. 'skill:pdf-extract-fill-redact/checkbox-truthy'
  slot             STRING NOT NULL,
  -- +1 = do, -1 = don't. Negative memory is first class.
  polarity         SMALLINT NOT NULL CHECK (polarity IN (-1, 1)),
  body             STRING NOT NULL,
  trigger_text     STRING NOT NULL,
  embedding        VECTOR(256),
  status           STRING NOT NULL DEFAULT 'candidate'
                     CHECK (status IN ('candidate','canonical','contested',
                                       'superseded','dormant')),
  confidence       FLOAT NOT NULL DEFAULT 0.20,
  -- denormalisation of the evidence ledger; a lost update here is what
  -- READ COMMITTED breaks (92 rows drifted in the storm)
  support_count    INT NOT NULL DEFAULT 0,
  contradict_count INT NOT NULL DEFAULT 0,
  half_life_days   INT NOT NULL DEFAULT 180,
  hold_eligible    BOOL NOT NULL DEFAULT true,
  superseded_by    UUID REFERENCES lesson(lesson_id),
  source_ref       STRING,           -- e.g. 'reviews/A7-safety.md#FIX-2'
  is_synthetic     BOOL NOT NULL DEFAULT false,
  content_hash     STRING NOT NULL,
  UNIQUE (tenant_id, content_hash),          -- cheap exact dedupe
  INDEX lesson_slot (tenant_id, slot, status),
  -- relational prefix columns, vector column LAST
  VECTOR INDEX lesson_vec (tenant_id, status, embedding vector_cosine_ops)
);

-- append-only. confidence is always RECOMPUTABLE from these rows.
CREATE TABLE lesson_evidence (
  evidence_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id         UUID NOT NULL REFERENCES lesson(lesson_id),
  episode_id        UUID REFERENCES episode(episode_id),
  kind              STRING NOT NULL
                      CHECK (kind IN ('support','contradict','review','human')),
  weight            FLOAT NOT NULL DEFAULT 1.0,
  observer_agent_id UUID,
  observed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX evidence_by_lesson (lesson_id, observed_at DESC)
);

-- arbitration: what SERIALIZABLE buys. Opened, never resolved automatically.
CREATE TABLE conflict (
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
```

Design decisions worth defending:

- **`VECTOR(256)`, not 1024.** Titan V2's Matryoshka output means 256 dims cost a quarter of the
  storage and a quarter of the RU per index write. Against a 50M RU hard cap this is the
  highest-leverage constant in the codebase.
- **Every embedding is unit-normalised at write time**, and `assertUnit()` (`src/lib/hash.ts`)
  rejects any vector with `|‖v‖ − 1| > 1e-4` before it can reach the database. For unit vectors
  `‖a−b‖² = 2 − 2·cos(a,b)`, so `sim = 1 − d²/2` is exact. Skip this and the ranking maths produces
  negative similarities in the tail — wrong, not broken, which is worse.
- **One embedding convention for every `lesson` row** (`lessonEmbedText`). Titan places short strings
  and long passages in systematically different regions of the space; mixing 15-token finding titles
  and 240-token doc chunks in one index makes recall quietly length-biased, and the results still
  look plausible.
- **Embeddings are nullable** (`migrations/002_nullable_embeddings.sql`). The spend gate degrades to
  "store the row now, embed it later" and must never abort a memory write — a memory system that
  loses memories when it is busiest is backwards. This was **probed on the live cluster** before the
  migration was written: a vector-*indexed* column accepts NULL once `NOT NULL` is dropped, rows with
  NULL vectors are simply absent from the index, and the ANN plan is unchanged.
- **Deterministic UUIDv5 ids** for lessons, evidence and conflicts (`src/ingest/db.ts`). Not for
  budget — for correctness. `gen_random_uuid()` defaults mean a re-run inserts duplicate evidence,
  which inflates `support_count`, which feeds `confidence`, which decides promotion to `canonical` —
  the set that retrieval actually reads.
- **`INSERT … ON CONFLICT DO NOTHING RETURNING id` returns zero rows when the row already exists.**
  On a second run that yields `undefined` for every id and every dependent write silently no-ops,
  producing an ingest that reports success having written nothing. `upsertReturningId()` closes it
  with a `UNION ALL` fallback.

---

## What the agent did with each tool

The rules ask which CockroachDB tools were used **and what the agent actually did with them**.

### 1. Distributed Vector Indexing — the retrieval path, not a checkbox

Three vector indexes exist: `lesson_vec (tenant_id, status, embedding)`,
`skill_version_vec (tenant_id, embedding)`, `episode_vec (tenant_id, task_embedding)`.

`lesson_vec` carries the **relational prefix columns** that make the whole design work. Retrieval
(`app/api/recall/route.ts`) is:

```sql
SELECT lesson_id, slot, polarity, status, source_ref,
       substring(body, 1, 400) AS body,
       round((1 - (embedding <=> $2))::NUMERIC, 4) AS similarity
  FROM lesson
 WHERE tenant_id = $1
   AND status = $3
 ORDER BY embedding <=> $2
 LIMIT $4
```

with the tenant id resolved in application code first. The route runs `EXPLAIN` on the same statement
and returns the plan in the response body, so the central claim is checkable per request rather than
asserted in a README. The index was also **dropped and rebuilt** as part of the corpus load — see
finding 4 below, which is a measured consequence of putting `status` in the prefix.

### 2. ccloud CLI — provisioning, and the only working RU meter

Used to provision the cluster's SQL user and connection string, and — the non-obvious part — to
**measure spend**. `crdb_internal.tenant_usage_details` exists on Basic but returns **zero rows**
(verified 2026-08-12), and reading it at all requires `SET allow_unsafe_internals = true`. The
usable meter is the billing invoice:

```bash
scripts/ru_meter.sh          # total RU consumed
scripts/ru_meter.sh --json   # the raw REQUEST_UNITS line items
```

It parses `ccloud billing invoice list -o json`, which emits several concatenated JSON objects rather
than one array, and strips ANSI escapes the CLI writes into its own JSON output.
`scripts/calibrate_ru.py` calls it before and after a controlled 500-row insert to produce the RU
figure in finding 1.

### 3. Cloud Managed MCP Server — the audit surface, deliberately not the data plane

Registered and OAuth'd **read-only**, pinned to a single cluster with
`mcp-cluster-id: ab077df5-2917-45a6-b20d-e32aa611b879`. During the build it was used to inspect
schema, check row counts, and confirm plans and index state independently of the application's own
connection.

It is **not** the application's data path, and that is a decision rather than an omission: the
managed server caps responses at 10 KiB and exposes no `update_rows` / `delete_rows`. Routing a
write path that depends on `SET TRANSACTION ISOLATION LEVEL` and a `40001` retry loop through a
read-only, response-capped tool would be architecturally wrong. The app uses `pg` over the standard
SQL port; the MCP server is the operator console. Both point at the same cluster, so anything the
app claims can be checked through the other channel.

### 4. Agent Skills Repo — ingested as corpus

All **34** skills from `cockroachlabs/cockroachdb-skills` (Apache-2.0) are parsed by
`src/ingest/parseSkills.ts` together with 16 skills authored by the same developer: frontmatter
extracted, `description` used as the trigger text (it is already written in retrieval form — "Use
when a task involves X"), reference `.md` files chunked, everything embedded and stored. That is 50
`skill_version` rows and 2,027 documentation chunks, all queryable through the same ANN path.

The frontmatter parser is line-oriented and **deliberately not a YAML library**: verified against all
50 `SKILL.md` files, exactly three descriptions contain an unquoted `": "`, which makes them
ambiguous YAML mappings and crashes a strict parser. It also tolerates the sponsor repo's
non-standard `compatibility:` and nested `metadata:` keys.

### AWS: Amazon Bedrock

`src/lib/bedrock.ts`. Titan Text Embeddings V2, `us-east-1`, `{"dimensions":256,"normalize":true}`.
Three things the client does that a bare `InvokeModel` call does not:

- **Distinguishes warm-up from a real permissions failure.** Bedrock auto-subscribes a model on
  first invocation and may return `AccessDeniedException` for up to 15 minutes while that settles.
  The client tolerates it **only until the first success**; after that, `AccessDenied` is a genuine
  IAM problem and fails loudly instead of being retried for a quarter of an hour.
- **Full jitter on every retry.** Equal backoff across parallel workers resynchronises them into a
  thundering herd that re-triggers the same throttle.
- **Refuses to hand a non-unit vector to the database.**

Credentials come from a **named profile** (`instar`), never the default one, so this project's
least-privilege Bedrock-only key is not picked up implicitly by unrelated AWS tooling on the same
machine.

---

## Running it

### Prerequisites

- Node ≥ 20
- `cockroach-sql` (or any Postgres client) for the migrations; `ccloud` only if you want the RU meter
- AWS credentials with `bedrock:InvokeModel` for `amazon.titan-embed-text-v2:0` in `us-east-1`,
  in a profile named `instar` (or set `INSTAR_AWS_PROFILE` / `AWS_PROFILE`)
- A CockroachDB cluster. **This is the part that is not reproducible from a script** — see below.

### 1. Connection string

Never in the repo. Either:

```bash
export INSTAR_DB_URL='postgresql://…'
# or
mkdir -p ~/.instar && chmod 700 ~/.instar
printf '%s' 'postgresql://…' > ~/.instar/dburl_instar && chmod 600 ~/.instar/dburl_instar
```

`.gitignore` blocks `*dburl*`, `.instar/`, `**/connection-string*` and `.env*`.

### 2. Schema

```bash
cockroach-sql --url "$INSTAR_DB_URL" -f migrations/001_init.sql
cockroach-sql --url "$INSTAR_DB_URL" -f migrations/002_nullable_embeddings.sql
```

Then re-run the regression assertion at the bottom of `002` after **any** future schema change: the
plan must still contain `• vector search` and `prefix spans`.

### 3. Verify the cluster does what this design needs

```bash
cockroach-sql --url "$INSTAR_DB_URL" -f scripts/spike.sql
```

Every check prints a line beginning `SPIKE`, so the output is greppable. It proves, on your own
cluster, that `VECTOR INDEX` works on Basic, that filtered ANN returns only matching rows, and that
the plan shows prefix spans.

### 4. The storm — reproducible by anyone

This is the demonstration, and it needs only the schema and Bedrock credentials:

```bash
npx tsx src/demo/storm.ts --agents 16
```

It creates its own tenants (`storm-rc`, `storm-ser`), clears them, and prints the table above.

### 5. The corpus ingest — **not** reproducible by a third party

```bash
npm run ingest:dry     # plan only: counts, token estimate, RU estimate. No writes, no Bedrock.
npm run ingest         # idempotent, resumable
```

Be aware of two things before running it:

- The two source corpora live **outside this repository** and their paths are hardcoded at the top of
  `src/ingest/run.ts` (a Google Drive folder of BenchFlow review documents, and a local checkout of
  `cockroachlabs/cockroachdb-skills`). Nobody else has the first one. The ingest is committed as
  evidence of how the corpus was built, not as a turnkey script.
- **Drop `lesson_vec` before the bulk load and recreate it afterwards.** This is the documented
  CockroachDB bulk pattern and it is worth roughly 10× here; the measurement is finding 4 below.
  `INSTAR_CONCURRENCY` defaults to 4 and should not be raised while the index exists.

### 6. The console

```bash
npm run dev     # http://localhost:3000
```

Three panels: a live corpus census read from the cluster, semantic recall with the **SQL and the
`EXPLAIN` plan shown for every query**, and the two storm arms **re-audited live** against the same
database (only `retries` and `elapsed` are replayed from the run, because they are properties of an
execution rather than of stored state).

`/api/recall` performs no writes on the read path — not even `UPDATE embed_cache SET hits = hits + 1`,
which would turn a ~2 RU read into a ~10 RU write on a judge-facing endpoint with unbounded traffic.
Repeated questions are served from the content-hash embedding cache and cost zero Bedrock calls, so
the demo can be left open "without any restriction" as the rules require.

**Public deployment: not live as of this commit.** The console runs locally against the same cluster.

---

## Measured findings

Full detail, method and caveats in [`docs/MEASUREMENTS.md`](docs/MEASUREMENTS.md). Every number below
was produced against the live cluster described at the top of this file.

**1. A vector-indexed insert costs ≤ 39.4 RU.** Method: read the billing meter, insert 500 rows one
statement at a time into a table carrying a C-SPANN index, delete them, let the meter settle, divide
(70,061 → 89,775 RU, delta 19,714). Stated as an upper bound deliberately — the delta also contains
500 `DELETE`s and several meter reads; an intermediate reading before the deletes gives **26.1
RU/row** for insert alone. At that bound the full 2,353-row corpus is under **0.2%** of the 50M cap,
and 50 careless re-ingests would be ~9.3%. **Caveat:** measured at 500 rows into a young index;
partition-split amplification may grow with corpus size and this should not be trusted at 100,000
rows.

**2. A covering index cannibalises the vector index.** Detailed above. The optimizer recommends it;
taking the advice silently removes the ANN path.

**3. Prefix-column values must be literals or placeholders.** A correlated subquery for `tenant_id`
produces lookup joins and no prefix spans.

**4. Vector-insert concurrency: less is more.**

| Configuration | Throughput |
|---|---|
| index present, 16 writers | ~38 rows/min |
| index present, 4 writers | ~123 rows/min, **decaying to ~18** as the table grew |
| **index dropped, 12 writers** | **~381 rows/min** |

Two limits, the first masking the second: C-SPANN partition contention (during ingest every row
shares one prefix — one tenant, `status = 'candidate'` — so all 2,353 vectors land in the same
partition tree), and then Bedrock throttling (~40 fresh embeddings/min on a new AWS account).

Recording how this was found matters more than the answer. Two wrong diagnoses came first: "Bedrock
is throttling" (plausible — the client retries throttles silently) and "the connection pool is too
small" (a genuine bug: pool max 6 against 16 workers, so ten were parked — but raising it to 24
changed almost nothing). The answer came from asking the cluster instead of reasoning about it:

```sql
SELECT substring(query,1,90), count(*), max(now()-start)
FROM [SHOW QUERIES] WHERE application_name='instar-ingest' GROUP BY 1;
-- INSERT INTO lesson…  ·  n = 16  ·  longest 43 seconds
```

All sixteen workers were on the same statement, blocked on the database. A prefix chosen for **query**
speed concentrates **writes** during bulk load. That trade is correct here — queries run for the life
of the system, the bulk load happens once — but it must be handled with the documented pattern: seed,
then index.

**5. `spend_ledger` was a hot row.** One row per day, hit twice per item by every worker. Throughput
collapsed to ~20 rows/min and the ledger logged 200 Bedrock calls while only 98 rows had landed —
workers were burning their time losing races. Fixed by reading the budget once, accumulating in
memory, and flushing from a single writer (`SpendTracker`). **In both this case and finding 4, the
fix was never weaker isolation; it was not creating a hot row.**

**6. Titan V2 returns genuine unit vectors** — measured L2 norm **1.000000005** at 256 dimensions;
model access `AVAILABLE` + `AUTHORIZED` with no access request and no wait. $0.02 / 1M input tokens.

**7. A vector-indexed column accepts NULL** once `NOT NULL` is dropped; such rows are absent from the
index and the ANN plan is unchanged.

**8. `gc.ttlseconds = 4500`** (75 minutes) on this cluster — the bound on any `AS OF SYSTEM TIME`
query.

---

## Not built

Stated explicitly so nothing here has to be inferred.

- **AWS Lambda, S3 and Secrets Manager.** Designed into the architecture; not used by the shipped
  system. Bedrock is the only AWS service INSTAR actually calls.
- **`scripts/bootstrap.sh`.** Does not exist. The cluster was provisioned through the Cloud Console
  and `ccloud` interactively; the migrations are the reproducible part.
- **A public demo URL.** Not deployed as of this commit.
- **The holdout arm.** The `injection` table (with its `arm IN ('treatment','holdout')` column) is in
  the schema, and the design is a continuous self-administered A/B test of whether a recalled lesson
  helps. **No code writes it.** No utility measurement exists, and none is claimed.
- **The `episode` table.** Present in the schema and referenced as an optional foreign key by the
  write path; nothing inserts episodes yet. Every lesson currently in the database is derived from a
  review document, not from an observed agent run.
- **Promotion / molting.** `skill_version.instar` exists and every row is at instar 1. The
  compare-and-swap promotion path from accumulated lessons to a new skill version is designed and
  **not implemented**. `status` transitions in `lesson` are exercised only for
  `candidate → contested` by the conflict path.
- **Confidence and decay.** `confidence`, `half_life_days` and `contradict_count` are columns with
  defaults; no scheduler recomputes them.
- **Contributing skills back to `cockroachlabs/cockroachdb-skills`.** Intended, not submitted.

---

## Honesty

These rules are binding on this repository, not decoration.

- **No claim of measured performance lift.** An earlier corpus of benchmark results exists, but its
  95% confidence interval straddles zero (n of 1–3 per task) and the raw per-rollout results no
  longer exist. It is cited as **provenance for the seed data only** — never as evidence that this
  memory system improves agent outcomes. INSTAR demonstrates a **correctness** property, not a
  performance one.
- **Documentation chunks are retrievable context, not learned lessons.** All 2,027 of them carry a
  `doc:` slot and are pinned to `status = 'candidate'` permanently. A post-load assertion fails the
  ingest if any has been promoted to `canonical`, and `/api/integrity` reports the count live.
- **Zero synthetic rows.** Every row derives from a real document. `is_synthetic` exists as a column
  precisely so that generated data, if it were ever added, would be labelled rather than passed off
  as observed. The ingest fails if the count is non-zero.
- **The free cluster is not reproducible from a script.** CockroachDB's no-card free Basic cluster is
  Console-UI-only and limited to one per organisation. Anyone reproducing this needs their own
  cluster; the migrations and `scripts/spike.sql` will tell them within a minute whether it behaves
  the same way.
- **Every measurement carries its conditions** — cluster version, plan tier, region, row count, and
  whether it came from the managed cloud cluster or a local run. Where a figure is an upper bound, it
  says so.
- Two review documents in the source corpus declare no verdict tuple, so their 12 findings are
  **unchecked** by the parser gate. They are ingested anyway and logged as `NO_VERDICT`.

---

## Repository map

```
migrations/001_init.sql          schema; the design rationale lives in its comments
migrations/002_nullable_embeddings.sql
                                 nullable vectors + backfill worklist + regression assertion
src/lib/hash.ts                  canonicalisation, content hashing, vector literals, assertUnit
src/lib/bedrock.ts               Titan V2 client: warm-up vs AccessDenied, jitter, unit-vector guard
src/lib/spend.ts                 pre-flight spend gate + SpendTracker (the hot-row fix)
src/ingest/parseSkills.ts        50 SKILL.md bundles -> skill rows + doc chunks
src/ingest/parseReviews.ts       five finding dialects, self-validating verdict gate
src/ingest/tally.ts              the gate, standalone: asserts 276 findings
src/ingest/db.ts                 UUIDv5, idempotent upserts, 40001 retry with jitter
src/ingest/run.ts                the corpus load + post-load assertions
src/memory/write.ts              THE WRITE PATH: the set predicate, arbitration, integrity audit
src/query/recall.ts              CLI recall against the real corpus
src/demo/storm.ts                THE STORM: two isolation levels, one cluster
app/                             Next.js console: live recall, live plan, live integrity audit
scripts/spike.sql                proves vector index + filtered ANN + prefix spans on your cluster
scripts/ru_meter.sh              RU from the billing API (the SQL meter is empty on Basic)
scripts/calibrate_ru.py          the 500-row RU calibration
docs/MEASUREMENTS.md             every measurement, with method and caveats
docs/storm-run-2026-08-12.txt    the storm run log, verbatim
```

---

## Pre-existing work and disclosure

Per the hackathon's disclosure requirement:

- A **15-skill Claude Code Agent Skill library** plus `skill-creator` and `lint_library.py`, authored
  by the same developer for a prior hackathon, together with the 42 review documents written against
  it. Used here as the seed corpus.
- **[`cockroachlabs/cockroachdb-skills`](https://github.com/cockroachlabs/cockroachdb-skills)**
  (Apache-2.0), 34 skills, ingested as additional corpus.
- Third-party libraries are listed in `package.json`: `pg`, `@aws-sdk/client-bedrock-runtime`,
  `next`, `react`, `tsx`, `typescript`.

Built solo during the submission period with Claude (Anthropic) as an AI coding assistant for code
generation, debugging and documentation; all pre-existing code and third-party libraries used are
listed in the repository README.

## License

[MIT](LICENSE)
