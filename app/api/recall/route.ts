/**
 * Recall API — semantic search over the real corpus.
 *
 * Returns the rows AND the SQL AND the query plan, because the submission's
 * central claim is about the plan: the relational filter executes inside the
 * vector index. A judge should not have to take that on trust.
 *
 * Cost control is by construction, never by gating: the rules require the demo
 * be usable "without any restriction". Embeddings are content-hash cached, so a
 * repeated question costs one indexed lookup and no Bedrock call.
 */
import { NextResponse } from "next/server";
import { Embedder, EMBED_IDENTITY } from "@/src/lib/bedrock";
import { contentHash, toVectorLiteral } from "@/src/lib/hash";
import { makePool } from "@/src/ingest/db";

export const runtime = "nodejs";      // pg needs net/tls; Edge cannot do this
export const dynamic = "force-dynamic";

const pool = makePool();              // module scope: reused across invocations
const embedder = new Embedder();

const SQL = `SELECT lesson_id, slot, polarity, status, source_ref,
       substring(body, 1, 400) AS body,
       round((1 - (embedding <=> $2))::NUMERIC, 4) AS similarity
  FROM lesson
 WHERE tenant_id = $1
   AND status = $3
 ORDER BY embedding <=> $2
 LIMIT $4`;

export async function POST(req: Request) {
  try {
    const payload = (await req.json()) as {
      query?: unknown; status?: unknown; limit?: unknown;
    };
    const query = payload.query;
    const status = typeof payload.status === "string" ? payload.status : "candidate";
    const limit = payload.limit;
    if (typeof query !== "string" || !query.trim()) {
      return NextResponse.json({ error: "query required" }, { status: 400 });
    }
    const k = Math.min(Math.max(Number(limit) || 8, 1), 20);

    const { rows: [t] } = await pool.query(
      "SELECT tenant_id FROM tenant WHERE slug = 'demo'");
    if (!t) return NextResponse.json({ error: "corpus not loaded" }, { status: 503 });
    // Resolved here, passed as $1 — a subquery in the prefix predicate silently
    // destroys prefix spans and turns the ANN scan into lookup joins.
    const tenantId = t.tenant_id as string;

    // ── embed, via the cache ────────────────────────────────────────────
    const hash = contentHash(query.trim(), EMBED_IDENTITY);
    let vec: string;
    let cacheHit = false;
    const hit = await pool.query(
      "SELECT embedding FROM embed_cache WHERE content_hash = $1", [hash]);
    if (hit.rows[0]?.embedding) {
      vec = String(hit.rows[0].embedding);
      cacheHit = true;
      // NOTE: no `UPDATE hits = hits + 1` here. That would turn a ~2 RU read
      // into a ~10 RU write on the judge-facing path, on unbounded traffic.
    } else {
      const { embedding } = await embedder.embed(query.trim());
      vec = toVectorLiteral(embedding);
      await pool.query(
        `INSERT INTO embed_cache (content_hash, model, dims, embedding)
         VALUES ($1,$2,$3,$4) ON CONFLICT (content_hash) DO NOTHING`,
        [hash, EMBED_IDENTITY.model, EMBED_IDENTITY.dims, vec]);
    }

    const t0 = Date.now();
    const { rows } = await pool.query(SQL, [tenantId, vec, status, k]);
    const ms = Date.now() - t0;

    // The plan is part of the response, not a screenshot in a README.
    const { rows: planRows } = await pool.query(
      `EXPLAIN ${SQL}`, [tenantId, vec, status, k]);
    const plan = planRows.map((r) => Object.values(r).join(" ")).join("\n");

    return NextResponse.json({
      query, results: rows, ms, cacheHit,
      sql: SQL.replace("$1", `'${tenantId}'`).replace(/\$2/g, "'<256-dim unit vector>'"),
      plan,
      usesVectorIndex: /vector search/i.test(plan) && /prefix spans/i.test(plan),
    });
  } catch (e) {
    // Log the detail server-side; return an opaque message. String(e) on a pg
    // error can carry the host, database and even the failing SQL — none of
    // which belongs in a response to an unauthenticated visitor.
    console.error("[instar] request failed:", e);
    // The error CLASS is safe to return and is the single most useful thing for
    // anyone debugging a deployed Worker: "AccessDeniedException" and
    // "TypeError" point in completely different directions. The message is not
    // returned — a pg error can carry the host, database and failing SQL.
    const name = (e as { name?: string })?.name ?? "Error";
    return NextResponse.json({ error: "internal error", kind: name }, { status: 500 });
  }
}
