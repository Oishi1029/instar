/**
 * Corpus tally — the honest count, reproducible on demand.
 *
 * Run:  npx tsx src/ingest/tally.ts
 *
 * This exists because the review corpus turned out to use FIVE finding
 * dialects. A parser that handles only the first one silently reports 92 of
 * 276 findings while looking perfectly healthy. The per-file gate below is what
 * caught that: eleven files declared six findings and parsed zero.
 */
import { parseAllReviews, deriveSlot, isHoldEligible, type Severity } from "./parseReviews";

const DIR =
  "/Users/binyong/Library/CloudStorage/GoogleDrive-binyongbong1029@gmail.com/" +
  "My Drive/HACKATHONS/BenchFlow Agent Skill Lift/work/portfolio/reviews";

/** The number the README commits to. A regression here is a build failure. */
const EXPECTED_TOTAL = 276;

function main(): number {
  const docs = parseAllReviews(DIR);
  const tally: Record<Severity, number> = { BLOCK: 0, FIX: 0, NIT: 0 };
  const gates: Record<string, number> = { MATCHED: 0, MISMATCH: 0, NO_VERDICT: 0 };
  const slots = new Map<string, string[]>();

  for (const d of docs) {
    gates[d.gate] = (gates[d.gate] ?? 0) + 1;
    for (const f of d.findings) {
      tally[f.severity]++;
      const s = deriveSlot(f);
      const list = slots.get(s) ?? [];
      list.push(`${d.file}:${f.severity}-${f.ordinal}`);
      slots.set(s, list);
    }
  }

  const total = tally.BLOCK + tally.FIX + tally.NIT;
  const contested = [...slots.entries()].filter(
    ([, v]) => new Set(v.map((x) => x.split(":")[0]?.split("-")[1])).size > 1,
  );

  console.log(`review documents : ${docs.length}`);
  console.log(
    `gate             : MATCHED=${gates.MATCHED} MISMATCH=${gates.MISMATCH} NO_VERDICT=${gates.NO_VERDICT}`,
  );
  console.log(
    `findings         : ${total}  (BLOCK ${tally.BLOCK} / FIX ${tally.FIX} / NIT ${tally.NIT})`,
  );
  console.log(`distinct slots   : ${slots.size}`);
  console.log(`slots contested across >1 review lens : ${contested.length}`);
  console.log(
    `hold-ineligible (BLOCK or safety lens) : ${docs.flatMap((d) => d.findings).filter((f) => !isHoldEligible(f)).length}`,
  );

  // ── the gate ────────────────────────────────────────────────────────────
  let failed = false;
  for (const d of docs) {
    if (d.gate === "MISMATCH") {
      const p: Record<Severity, number> = { BLOCK: 0, FIX: 0, NIT: 0 };
      for (const f of d.findings) p[f.severity]++;
      console.error(
        `  MISMATCH ${d.file}: declared ${JSON.stringify(d.declared)} parsed ${JSON.stringify(p)}`,
      );
      failed = true;
    }
  }
  // Files with no declarable tuple are logged, never quarantined: 2 of 42 have
  // no verdict line at all, and dropping them would lose real findings.
  for (const d of docs) {
    if (d.gate === "NO_VERDICT") {
      console.log(`  NO_VERDICT ${d.file} (${d.findings.length} findings, uncheckable)`);
    }
  }

  if (total !== EXPECTED_TOTAL) {
    console.error(
      `\nFAIL: expected ${EXPECTED_TOTAL} findings, parsed ${total}. ` +
        `A dialect has regressed or the corpus changed.`,
    );
    failed = true;
  }

  console.log(
    failed ? "\nGATE: FAILED" : `\nGATE: PASSED — ${total} findings, ${gates.MISMATCH} mismatches`,
  );
  return failed ? 1 : 0;
}

process.exit(main());
