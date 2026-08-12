/**
 * Semantic recall against the real corpus.
 *
 * The tenant id is resolved here, in application code, and passed as a bound
 * parameter — a correlated subquery in the prefix predicate silently defeats
 * prefix spans and turns the ANN scan into lookup joins.
 */
import { Embedder } from "../lib/bedrock.js";
import { toVectorLiteral } from "../lib/hash.js";
import { makePool } from "../ingest/db.js";

async function main(): Promise<void> {
  const pool = makePool();
  const emb = new Embedder();
  const { rows: [t] } = await pool.query("SELECT tenant_id FROM tenant WHERE slug='demo'");
  const tenantId = t.tenant_id as string;

  const queries = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const asked = queries.length ? queries : [
    "how do I fill a PDF form checkbox without it silently failing?",
    "my CockroachDB queries are slow, how do I find the hot ranges?",
    "the agent deleted files it was not asked to touch",
  ];

  for (const q of asked) {
    const { embedding } = await emb.embed(q);
    const vec = toVectorLiteral(embedding);
    const t0 = Date.now();
    const { rows } = await pool.query(
      `SELECT slot, substring(body,1,100) AS body, source_ref,
              round((1 - (embedding <=> $2))::NUMERIC, 4) AS sim
         FROM lesson
        WHERE tenant_id = $1 AND status = 'candidate'
        ORDER BY embedding <=> $2
        LIMIT 4`,
      [tenantId, vec],
    );
    console.log(`\nQ: ${q}   (${Date.now() - t0}ms)`);
    for (const r of rows) {
      console.log(`  ${r.sim}  ${r.slot}`);
      console.log(`         ${String(r.body).replace(/\s+/g, " ").slice(0, 96)}`);
    }
  }
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
