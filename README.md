# INSTAR

**Agent skills that learn from their own failures — in a database where two agents cannot teach them opposite things.**

> An **instar** is the stage of a cockroach's life between two moults.

Submission to the [CockroachDB × AWS Hackathon: Build with Agentic Memory](https://cockroachdb-ai.devpost.com/).

---

## Required technology (Stage One gate)

**CockroachDB tools used — 4 of 4** (the rules require ≥ 2):

| Tool | How it is used | Non-trivial because |
|---|---|---|
| **Distributed Vector Indexing** | Three vector indexes; the lesson index is prefix-filtered on `(tenant_id, status, embedding)` | The relational predicate is evaluated **inside** the ANN scan — see the verified query plan below |
| **ccloud CLI** | `scripts/bootstrap.sh` provisions SQL users, database, schema and IP allowlist; `ccloud cluster info` prints the resource limit as a zero-spend receipt | Reproducible provisioning committed as code, not a screenshot |
| **Cloud Managed MCP Server** | The **human audit surface** — read-only, RBAC-scoped, pinned to one cluster via `mcp-cluster-id`. Deliberately *not* the application data plane. | The managed server caps responses at 10 KiB and exposes no `update_rows`/`delete_rows`; using it as the operator console rather than the data path is the architecturally correct answer |
| **Agent Skills Repo** | Installed **and contributed back** — this project authors agent-memory skills for a domain the upstream repo does not cover | See *Upstream contribution* below |

**AWS services used** (the rules require ≥ 1): **Amazon Bedrock** (Titan Text Embeddings V2, 256-dim
Matryoshka output, content-hash cached) · **AWS Lambda** (Function URL — never API Gateway, whose
free tier is 12-months-only) · **Amazon S3** (episode payload tiering) · **AWS Secrets Manager**.

---

## The one property Postgres cannot provide

INSTAR's core invariant:

> For any `(tenant, slot)`, the set of active lessons must not contain both a **do** and a **don't**
> without an open conflict record.

This is deliberately a **predicate over a set**. No unique index, no `CHECK`, no exclusion
constraint can express it — it is not a property of any single row. **Only transaction isolation can
protect it.**

The write path is genuinely read-then-write: read the slot's active lessons → decide → write.

- Under **`READ COMMITTED`** — PostgreSQL's default — two agents learning opposite rules each read a
  clean slot, each see no conflict, and both commit. The library is now permanently
  self-contradictory, and every future recall returns a *do* and a *don't* for the same situation.
- Under **`SERIALIZABLE`** — CockroachDB's default — the second transaction aborts with `40001`, the
  retry loop re-runs it, it now *sees* the first insert, and takes the arbitration path.

Same cluster. Same code. Same workload. One knob.

The claim is **not** "CockroachDB has SERIALIZABLE" — Postgres has it too. The claim is that
correctness here depends entirely on isolation, and CockroachDB makes the safe thing **the default**
while Postgres makes it an opt-in that most ORMs and tutorials never set, and that no constraint
will ever warn you about.

## Verified: the relational filter runs *inside* the vector index

Query plan produced by CockroachDB **v26.2.5** on a **free Basic cluster** (`scripts/spike.sql`
reproduces it):

```
• vector search
    table: spike_lesson@lesson_vec
    target count: 3
    prefix spans: [/1/'canonical' - /1/'canonical']
```

Both predicates — `tenant_id = 1` **and** `status = 'canonical'` — were pushed into the vector
index. pgvector's HNSW has no equivalent: you either post-filter (ask for `LIMIT 8`, get 3 usable)
or maintain one partial index per filter value.

---

## Status

🚧 **Under active development** for the submission deadline of 2026-08-18. This README documents the
design and the facts verified so far; sections will be filled in as components land. Nothing in this
document describes functionality that does not exist — see *Honesty* below.

## Honesty

This project follows a few rules deliberately:

- **Every measurement is labelled with its conditions** — cluster version, plan tier, and whether a
  figure came from the managed cloud cluster or a local rig.
- **Synthetic data is labelled synthetic.** Parts of the seed corpus are generated; the README and
  the UI say which.
- **The demo cluster is not reproducible from `bootstrap.sh` alone.** CockroachDB's no-card free
  Basic cluster can only be created through the Cloud Console, one per organisation. The script
  provisions *schema and users* against an existing cluster; it does not create the cluster.
- **No claim of measured performance lift.** An earlier corpus of benchmark results exists but its
  confidence interval straddles zero (`n` of 1–3 per task), so it is cited as *provenance* for the
  seed data only, never as evidence that the memory system improves outcomes.

## Pre-existing work incorporated

Per the hackathon's disclosure requirement:

- A **15-skill Claude Code Agent Skill library** (plus `skill-creator`, `lint_library.py` and
  `aggregate_lift.py`) authored by the same developer for a prior hackathon, used here as the seed
  corpus and — in `lint_library.py`'s case — as the fail-closed write gate.
- **[`cockroachlabs/cockroachdb-skills`](https://github.com/cockroachlabs/cockroachdb-skills)**
  (Apache-2.0), ingested as additional corpus.
- Third-party libraries are listed in `package.json` / `requirements.txt`.

Built solo during the submission period with Claude (Anthropic) as an AI coding assistant for code
generation, debugging and documentation; all pre-existing code and third-party libraries used are
listed above.

## License

[MIT](LICENSE)
