/**
 * INSTAR corpus ingest.
 *
 *   npx tsx src/ingest/run.ts --dry-run     plan only, no writes, no Bedrock
 *   npx tsx src/ingest/run.ts               real ingest (idempotent, resumable)
 *
 * Everything written here is REAL. Nothing is generated, nothing is padded.
 * The corpus is ~2,350 rows and that is the number the README states.
 */
import { readFileSync } from "node:fs";
import { Embedder, EMBED_IDENTITY } from "../lib/bedrock";
import { contentHash, lessonEmbedText, toVectorLiteral } from "../lib/hash";
import { SpendTracker } from "../lib/spend";
import {
  ensureTenant, makePool, upsertReturningId, uuidv5, withRetry,
} from "./db";
import {
  chunkMarkdown, loadSkillBundles, relPathOf, type SkillBundle,
} from "./parseSkills";
import {
  deriveSlot, derivePolarity, isHoldEligible, parseAllReviews, type Finding,
} from "./parseReviews";

const BF =
  "/Users/binyong/Library/CloudStorage/GoogleDrive-binyongbong1029@gmail.com/" +
  "My Drive/HACKATHONS/BenchFlow Agent Skill Lift/work";
const SPONSOR = "/Users/binyong/dev/crdb-ref/cockroachdb-skills/skills";
const TENANT_SLUG = "demo";
const EXPECTED_FINDINGS = 276;

const DRY = process.argv.includes("--dry-run");

interface Row {
  kind: "skill" | "chunk" | "lesson";
  slot: string;
  triggerText: string;
  body: string;
  sourceRef: string;
  skillName?: string;
  source?: SkillBundle["source"];
  polarity?: -1 | 1;
  holdEligible?: boolean;
  derivation?: string;
}

function collect(): { rows: Row[]; bundles: SkillBundle[] } {
  const bundles = [
    ...loadSkillBundles(`${BF}/portfolio/skills`, "benchflow"),
    ...loadSkillBundles(`${BF}/portfolio-meta/skills`, "benchflow"),
    ...loadSkillBundles(SPONSOR, "cockroachdb-skills"),
  ];

  const rows: Row[] = [];

  // ── skills ──────────────────────────────────────────────────────────────
  for (const b of bundles) {
    rows.push({
      kind: "skill", skillName: b.name, source: b.source,
      slot: `skill:${b.name}`,
      triggerText: b.triggerText,
      body: b.body,
      sourceRef: `seed:${b.skillMdPath.split("/").slice(-3).join("/")}`,
    });

    // ── documentation chunks ─────────────────────────────────────────────
    // These are NOT learned lessons. They are retrievable context, marked with
    // a `doc:` slot and pinned to status='candidate' forever so they can never
    // be promoted to canonical. A post-load assertion enforces it.
    const own = chunkMarkdown(b.body, b.name, "SKILL.md");
    const refs = b.refFiles.flatMap((f) =>
      chunkMarkdown(readFileSync(f, "utf8"), b.name, relPathOf(b.skillMdPath, f)),
    );
    for (const c of [...own, ...refs]) {
      rows.push({
        kind: "chunk", skillName: b.name, source: b.source,
        slot: c.slot,
        triggerText: c.breadcrumb || b.triggerText,
        body: c.text,
        sourceRef: c.sourceRef,
      });
    }
  }

  // ── lessons from review findings ────────────────────────────────────────
  const docs = parseAllReviews(`${BF}/portfolio/reviews`);
  const findings: Finding[] = docs.flatMap((d) => d.findings);
  if (findings.length !== EXPECTED_FINDINGS) {
    throw new Error(
      `review parser regression: expected ${EXPECTED_FINDINGS} findings, got ${findings.length}. ` +
      `A dialect has broken — run src/ingest/tally.ts.`,
    );
  }
  const mismatches = docs.filter((d) => d.gate === "MISMATCH");
  if (mismatches.length) {
    throw new Error(`review gate MISMATCH in: ${mismatches.map((d) => d.file).join(", ")}`);
  }

  for (const f of findings) {
    const { polarity, derivation } = derivePolarity(f);
    const body = [
      f.title,
      f.exactQuote ? `Quote: ${f.exactQuote}` : "",
      f.why ? `Why: ${f.why}` : "",
      f.suggestedRewrite ? `Correction: ${f.suggestedRewrite}` : "",
    ].filter(Boolean).join("\n");
    rows.push({
      kind: "lesson",
      slot: deriveSlot(f),
      triggerText: f.title,
      body,
      sourceRef: `reviews/${f.file}#${f.severity}-${f.ordinal}`,
      polarity, derivation,
      holdEligible: isHoldEligible(f),
    });
  }

  return { rows, bundles };
}

async function main(): Promise<number> {
  const t0 = Date.now();
  const { rows, bundles } = collect();

  const counts = rows.reduce<Record<string, number>>((a, r) => {
    a[r.kind] = (a[r.kind] ?? 0) + 1; return a;
  }, {});
  const chars = rows.reduce((a, r) => a + r.body.length, 0);
  const estTokens = Math.round(chars / 4);

  console.log("── INSTAR ingest plan ─────────────────────────────────────");
  console.log(`  skill bundles      : ${bundles.length}`);
  console.log(`  skill_version rows : ${counts.skill ?? 0}`);
  console.log(`  doc chunks         : ${counts.chunk ?? 0}   (slot 'doc:*', never promotable)`);
  console.log(`  lessons (findings) : ${counts.lesson ?? 0}`);
  console.log(`  TOTAL EMBEDDED     : ${rows.length}   ALL REAL, ZERO SYNTHETIC`);
  console.log(`  est. embed tokens  : ${estTokens.toLocaleString()}  ≈ $${(estTokens / 1e6 * 0.02).toFixed(4)}`);
  console.log(`  est. RU @39.4/row  : ${Math.round(rows.length * 39.4).toLocaleString()} ` +
              `(${(rows.length * 39.4 / 50e6 * 100).toFixed(2)}% of the 50M cap)`);
  console.log("───────────────────────────────────────────────────────────");

  if (DRY) {
    console.log("\n--dry-run: nothing written, no Bedrock calls made.");
    return 0;
  }

  const pool = makePool();
  const embedder = new Embedder();
  const spend = new SpendTracker(pool);
  const spend0 = await spend.init();
  console.log(`budget: ${spend0.inputTokens.toLocaleString()}/${spend0.hardCapTokens.toLocaleString()} tokens used`);
  const tenantId = await ensureTenant(pool, TENANT_SLUG, "Demo tenant");
  console.log(`tenant: ${tenantId}`);

  let embedded = 0, cached = 0, deferred = 0, retries = 0, done = 0;

  const worker = async (r: Row): Promise<void> => {
    const embedText = lessonEmbedText(r.slot, r.triggerText, r.body);
    const hash = contentHash(embedText, EMBED_IDENTITY);

    // ── embedding, via cache, behind the pre-flight spend gate ────────────
    let vec: string | null = null;
    const hit = await pool.query(
      `SELECT embedding FROM embed_cache WHERE content_hash = $1`, [hash],
    );
    if (hit.rows[0]?.embedding) {
      vec = String(hit.rows[0].embedding);
      cached++;
    } else {
      if (spend.mayEmbed()) {
        const { embedding, inputTokens } = await embedder.embed(embedText);
        vec = toVectorLiteral(embedding);
        await spend.note(inputTokens);
        await pool.query(
          `INSERT INTO embed_cache (content_hash, model, dims, embedding)
             VALUES ($1,$2,$3,$4) ON CONFLICT (content_hash) DO NOTHING`,
          [hash, EMBED_IDENTITY.model, EMBED_IDENTITY.dims, vec],
        );
        embedded++;
      } else {
        // Budget exhausted: store the row NOW with a NULL vector and backfill
        // later. Never abort the write — a memory system that loses memories
        // when it is busiest is backwards.
        deferred++;
      }
    }

    await withRetry(async () => {
      if (r.kind === "skill") {
        const skillId = await upsertReturningId(
          pool,
          `INSERT INTO skill (skill_id, tenant_id, name, source)
             VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, name) DO NOTHING
             RETURNING skill_id AS id`,
          [uuidv5(`skill/${TENANT_SLUG}/${r.skillName}`), tenantId, r.skillName, r.source],
          `SELECT skill_id AS id FROM skill WHERE tenant_id = $5 AND name = $6`,
          [tenantId, r.skillName],
        );
        await pool.query(
          `INSERT INTO skill_version
             (skill_id, instar, tenant_id, skill_md, frontmatter, trigger_text,
              embedding, body_sha256, tokens)
           VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (skill_id, instar) DO UPDATE SET embedding = COALESCE(EXCLUDED.embedding, skill_version.embedding)`,
          [skillId, tenantId, r.body, JSON.stringify({ source: r.source }),
           r.triggerText.slice(0, 2000), vec, hash, Math.round(r.body.length / 4)],
        );
      } else {
        const isDoc = r.kind === "chunk";
        await pool.query(
          `INSERT INTO lesson
             (lesson_id, tenant_id, slot, polarity, body, trigger_text, embedding,
              status, source_ref, is_synthetic, hold_eligible, content_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'candidate',$8,false,$9,$10)
           ON CONFLICT (tenant_id, content_hash)
             DO UPDATE SET embedding = COALESCE(EXCLUDED.embedding, lesson.embedding)`,
          [uuidv5(`lesson/${TENANT_SLUG}/${hash}`), tenantId, r.slot,
           isDoc ? 1 : (r.polarity ?? -1), r.body, r.triggerText.slice(0, 2000), vec,
           r.sourceRef, isDoc ? true : (r.holdEligible ?? true), hash],
        );
      }
    }, r.slot, 8, () => { retries++; });

    if (++done % 200 === 0) {
      console.log(`  ${done}/${rows.length}  embedded=${embedded} cached=${cached} ` +
                  `deferred=${deferred} retries=${retries}`);
    }
  };

  // Row at a time, bounded concurrency. CockroachDB's docs are explicit that
  // vector inserts must not be batched.
  const CONCURRENCY = Number(process.env.INSTAR_CONCURRENCY ?? 4);
  const queue = [...rows];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const r = queue.shift();
        if (!r) return;
        await worker(r);
      }
    }),
  );

  await spend.flush();
  const sp = spend.summary();
  console.log(`bedrock: ${sp.calls} calls, ${sp.tokens.toLocaleString()} tokens, $${sp.usd.toFixed(4)}`);

  // ── post-load assertions ────────────────────────────────────────────────
  const { rows: [chk] } = await pool.query(`
    SELECT
      (SELECT count(*) FROM lesson  WHERE tenant_id=$1) AS lessons,
      (SELECT count(*) FROM skill   WHERE tenant_id=$1) AS skills,
      (SELECT count(*) FROM lesson  WHERE tenant_id=$1 AND embedding IS NULL) AS unembedded,
      (SELECT count(*) FROM lesson  WHERE tenant_id=$1 AND status='canonical' AND slot LIKE 'doc:%') AS promoted_docs,
      (SELECT count(*) FROM lesson  WHERE tenant_id=$1 AND is_synthetic) AS synthetic
  `, [tenantId]);

  console.log("\n── post-load assertions ───────────────────────────────────");
  console.log(`  lessons      : ${chk.lessons}`);
  console.log(`  skills       : ${chk.skills}`);
  console.log(`  unembedded   : ${chk.unembedded}`);
  console.log(`  synthetic    : ${chk.synthetic}   (must be 0)`);
  console.log(`  promoted docs: ${chk.promoted_docs}   (must be 0)`);
  console.log(`  embedded=${embedded} cached=${cached} deferred=${deferred} retries=${retries}`);
  console.log(`  elapsed: ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  let bad = false;
  if (Number(chk.synthetic) !== 0) { console.error("FAIL: synthetic rows present"); bad = true; }
  if (Number(chk.promoted_docs) !== 0) { console.error("FAIL: doc chunk promoted to canonical"); bad = true; }

  await pool.end();
  console.log(bad ? "\nINGEST: FAILED" : "\nINGEST: OK");
  return bad ? 1 : 0;
}

main().then((c) => process.exit(c)).catch((e) => {
  console.error(e);
  process.exit(1);
});
