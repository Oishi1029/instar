# Measurements

Every number here was produced by running something against the live cluster, with the conditions
stated. Nothing is extrapolated from documentation. Reproduce with the scripts named.

**Cluster under test:** `agentic-memory` · CockroachDB **v26.2.5** · Cloud **Basic** (free tier) ·
AWS `ap-southeast-1` · hard limit `50M RU / 10 GiB` · single region, 3 replicas.

---

## 1. Request Unit cost of a vector-indexed insert

**Why measured:** CockroachDB documents ~10–25 RU for a typical `INSERT`, but that band is for an
*ordinary* insert. A vector insert additionally performs a partition search and can trigger
partition splits that rewrite existing index entries. Sizing an ingest off the documented figure is
guesswork.

**Method** (`scripts/calibrate_ru.py`): read the billing meter, insert 500 rows **one statement at a
time** into a table carrying a C-SPANN vector index (CockroachDB's docs state explicitly that vector
inserts must not be batched), delete them, wait for the meter to settle, divide.

| | RU |
|---|---|
| Baseline before | 70,061 |
| Settled after | 89,775 |
| **Delta** | **19,714** |

**Upper bound: ≤ 39.4 RU per row.**

Stated as an upper bound deliberately — the delta also contains 500 `DELETE`s, several meter reads
and a few `count(*)` queries. The insert-only cost is lower; an intermediate reading taken before
the deletes gave **26.1 RU/row**, which is the better estimate of insert cost alone.

Against the auditor's pre-measurement band of *25 optimistic / 60 likely / 150 with split
amplification*, the measured figure sits at the **optimistic-to-likely** end.

### What this implies for the budget

| Scenario | RU | % of 50M cap |
|---|---|---|
| Full real corpus (2,164 rows) | ~85,000 | **0.17%** |
| 20 re-ingests during build week | ~1.71M | 3.4% |
| 50 re-ingests (careless worst case) | ~4.27M | 8.5% |

**Conclusion: the RU budget is not a risk at the corrected corpus size.** The pre-measurement
worst case of a 65% burn assumed ~9,000 synthetic episodes plus ~27,000 injection rows — a plan that
was cut for independent reasons (it would have broken `episode_vec`; see `CONCEPT.md` §8b).

Deterministic UUIDv5 ids are still being implemented, but the justification has changed: **not for
budget, for correctness.** Duplicate `lesson_evidence` rows would inflate `support_count`, which
feeds `confidence`, which decides promotion to `canonical` — the set retrieval actually reads.

**Caveat:** measured at 500 rows into a young index. Partition-split amplification may grow with
corpus size. At 2,164 rows the extrapolation is short; it should not be trusted at 100,000.

**Throughput note:** 4.1 rows/s, but that is an artefact of the calibration harness spawning one
`cockroach-sql` subprocess per row to isolate the per-insert cost. The real ingest uses a pooled
`pg` connection with concurrent writers.

---

## 2. Bedrock Titan Text Embeddings V2

Request `{"inputText": …, "dimensions": 256, "normalize": true}` → `amazon.titan-embed-text-v2:0`,
`us-east-1`.

| Property | Measured |
|---|---|
| Dimensions returned | 256 |
| **L2 norm** | **1.000000005** |
| `inputTextTokenCount` (one-sentence trigger) | 25 |
| Model access | `AVAILABLE` + `AUTHORIZED` — **no access request, no wait** |

Titan genuinely returns unit vectors, which is what makes `sim = 1 − d²/2` exact and keeps the
ranking maths from producing negative similarities in the tail. `assertUnit()` enforces this on
every embedding before it can reach the database.

At **$0.02 / 1M input tokens**, the full corpus costs a fraction of one US cent.

---

## 3. Query plan — the relational filter runs inside the vector index

```
• vector search
    table: lesson@lesson_vec
    target count: 5
    prefix spans: [/'ed01fe73-7396-4807-a105-047b4805bf81'/'canonical'
                 - /'ed01fe73-7396-4807-a105-047b4805bf81'/'canonical']
```

Both predicates (`tenant_id = …` and `status = 'canonical'`) are evaluated **inside** the ANN scan.

### Two ways this silently breaks

1. **A covering index cannibalises it.** CockroachDB's optimizer recommends
   `CREATE INDEX ON lesson (tenant_id, status) STORING (body, embedding)`. Create it and the plan
   becomes a plain scan + sort — the ANN path never runs. Results stay correct, so nothing appears
   broken, and CockroachDB does not warn that a vector index went unused.
2. **A subquery in the prefix predicate.** `WHERE tenant_id = (SELECT … FROM tenant WHERE slug=$1)`
   produces lookup joins and **no prefix spans at all**. The tenant id must be resolved in
   application code and passed as `$1`.

---

## 4. NULL vectors

A vector-**indexed** column accepts `NULL` once `NOT NULL` is dropped (migration 002). Rows with a
NULL vector are simply absent from the index, and the ANN plan above is unchanged.

This is what makes the spend gate's degradation path real: when the Bedrock budget is exhausted the
row is stored immediately with a NULL embedding and backfilled later, rather than the write being
aborted. Do **not** add `AND embedding IS NOT NULL` to retrieval queries — NULL rows are excluded
from the index for free, and the extra predicate is an unverified change to the one query the
submission rests on.
