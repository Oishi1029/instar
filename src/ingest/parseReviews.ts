/**
 * Parse the BenchFlow review corpus into lesson candidates.
 *
 * The corpus: 42 independent review documents (4,483 lines) written across
 * three lenses — compliance, safety, regression — over 14 skill codes. Each
 * document declares a verdict tuple and then enumerates findings.
 *
 * Shape (verified against the real files):
 *
 *   **Verdict: 0 BLOCK, 1 FIX, 2 NIT.**
 *   ### FIX-1 — attack vocabulary ("injected") where a neutral synonym exists
 *   - **File/line:** `references/contract-review.md` lines 44-46.
 *   - **Exact quote:** "..."
 *   - **Why:** ...
 *   - **Suggested rewrite:** "..."
 *
 * ── THE GATE ──────────────────────────────────────────────────────────────
 * A naive validator asserts parsed-tuple == declared-tuple for all 42 files.
 * That is wrong: **7 files contain no Verdict line at all** —
 *   A6-regression, A7-regression, B2-regression, B4-regression,
 *   B5-safety, META-regression, META-safety
 * A strict gate quarantines those 7 and silently drops ~50 findings, which is
 * precisely the class of bug the gate exists to prevent. Hence two tiers.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export type Severity = "BLOCK" | "FIX" | "NIT";

export interface Finding {
  file: string;          // 'A4-safety.md'
  skillCode: string;     // 'A4'
  lens: Lens;            // 'safety'
  severity: Severity;
  ordinal: number;       // the 1 in FIX-1
  title: string;
  fileLine?: string;     // where in the skill the finding points
  exactQuote?: string;
  why?: string;
  suggestedRewrite?: string;
  raw: string;
}

export type Lens = "compliance" | "safety" | "regression";

export interface ReviewDoc {
  file: string;
  skillCode: string;
  lens: Lens;
  declared?: Record<Severity, number>;  // absent for the 7 no-verdict files
  findings: Finding[];
  gate: "MATCHED" | "MISMATCH" | "NO_VERDICT";
}

/**
 * FOUR DIALECTS. The corpus was written across three review lenses over
 * several sessions and the finding syntax drifted. A parser handling only the
 * dialect you happen to open first silently loses whole files — my first pass
 * found 92 of 276 and reported eleven files as "declared 6 findings, parsed 0",
 * which is the only reason the drift was caught.
 *
 *  D1  ## FIX-1 — title            (also ###)  ......... 226 findings
 *  D2  ## BLOCK  section, then  ### B1. title  ......... severity from section
 *  D3  ### F1 — FIX — title                    ......... severity inline, 2nd field
 *  D4  ### N1 — title  under a  ## NIT  section ........ letter prefix + section
 *
 * D3 must be tried BEFORE D2/D4, because `### F1 — FIX — …` also matches the
 * looser letter-prefix pattern and would otherwise be mis-severitied.
 */
const D1 = /^#{2,4}\s+(BLOCK|FIX|NIT)-(\d+)\s*(?:[—–-]\s*)?(.*?)\s*$/i;
const D3 = /^#{2,4}\s+([BFN])(\d+)\s*[—–-]\s*(BLOCK|FIX|NIT)\s*[—–-]\s*(.*?)\s*$/i;
/** D5 — `### 1. BLOCK — title` : ordinal first, severity second. */
const D5 = /^#{2,4}\s+(\d+)[.:]?\s*(?:[—–-]\s*)?(BLOCK|FIX|NIT)\s*[—–-]\s*(.*?)\s*$/i;
const D2 = /^#{2,4}\s+([BFN])(\d+)[.:]?\s*(?:[—–-]\s*)?(.*?)\s*$/i;
/** A severity section header that scopes the letter-prefixed items beneath it. */
const SECTION = /^#{2,3}\s+(BLOCK|FIX|NIT)S?\s*(?:\(.*\))?\s*$/i;

const LETTER: Record<string, Severity> = { B: "BLOCK", F: "FIX", N: "NIT" };

/** `**Verdict: 1 BLOCK, 6 FIX, 5 NIT.**` and `**Tally: 0 BLOCK / 2 FIX / 3 NIT**` */
const VERDICT_LINE = /\*\*\s*(?:Verdict|Tally)\b[^*]*/i;
const COUNT = /(\d+)\s*(BLOCK|FIX|NIT)/gi;

function field(block: string, label: string): string | undefined {
  // '- **Exact quote:** "..."' possibly spanning lines until the next '- **'
  const re = new RegExp(
    `^-\\s*\\*\\*${label}:?\\*\\*\\s*([\\s\\S]*?)(?=\\n-\\s*\\*\\*|\\n###|\\n---|$)`,
    "im",
  );
  const m = block.match(re);
  return m?.[1]?.trim().replace(/\s+/g, " ") || undefined;
}

export function parseReviewFile(path: string): ReviewDoc {
  const file = basename(path);
  const text = readFileSync(path, "utf8").replace(/\r\n?/g, "\n");

  const [codePart, lensPart] = file.replace(/\.md$/, "").split("-");
  const skillCode = codePart ?? "?";
  const lens = (lensPart ?? "compliance") as Lens;

  // ── declared verdict tuple ──────────────────────────────────────────────
  // Prefer an explicit `**Verdict:`/`**Tally:` line. 14 of 42 files declare
  // their counts in ordinary prose instead ("Two BLOCK-class..." / a summary
  // sentence), so fall back to the FIRST line carrying at least two distinct
  // severity counts. Taking the first such line keeps a later prose mention of
  // counts from hijacking the tuple — and the gate below catches it if it does.
  let declared: Record<Severity, number> | undefined;
  const tupleFrom = (s: string): Record<Severity, number> | undefined => {
    const d: Record<Severity, number> = { BLOCK: 0, FIX: 0, NIT: 0 };
    const seen = new Set<Severity>();
    for (const m of s.matchAll(COUNT)) {
      const sev = m[2]!.toUpperCase() as Severity;
      d[sev] = Number(m[1]);
      seen.add(sev);
    }
    return seen.size >= 2 ? d : undefined;
  };

  const vm = text.match(VERDICT_LINE);
  if (vm?.[0]) declared = tupleFrom(vm[0]);
  if (!declared) {
    for (const line of text.split("\n")) {
      const t = tupleFrom(line);
      if (t) { declared = t; break; }
    }
  }

  // ── findings ────────────────────────────────────────────────────────────
  const lines = text.split("\n");
  const findings: Finding[] = [];
  let cur: { sev: Severity; ord: number; title: string; start: number } | null = null;

  const flush = (endExclusive: number) => {
    if (!cur) return;
    const raw = lines.slice(cur.start, endExclusive).join("\n").trim();
    findings.push({
      file, skillCode, lens,
      severity: cur.sev,
      ordinal: cur.ord,
      title: cur.title,
      fileLine: field(raw, "File/line"),
      exactQuote: field(raw, "Exact quote"),
      why: field(raw, "Why"),
      suggestedRewrite: field(raw, "Suggested rewrite"),
      raw,
    });
    cur = null;
  };

  // `## BLOCK` / `## FIX` / `## NIT` scopes the letter-prefixed items below it
  let section: Severity | null = null;

  lines.forEach((line, i) => {
    const sec = line.match(SECTION);
    if (sec) {
      flush(i);
      section = sec[1]!.toUpperCase() as Severity;
      return;
    }

    // D1 — explicit `SEVERITY-n`
    const m1 = line.match(D1);
    if (m1) {
      flush(i);
      cur = {
        sev: m1[1]!.toUpperCase() as Severity,
        ord: Number(m1[2]),
        title: m1[3] || "(untitled)",
        start: i,
      };
      return;
    }

    // D3 — `Ln — SEVERITY — title` (must precede D2: it also matches D2's shape)
    const m3 = line.match(D3);
    if (m3) {
      flush(i);
      cur = {
        sev: m3[3]!.toUpperCase() as Severity,
        ord: Number(m3[2]),
        title: m3[4] || "(untitled)",
        start: i,
      };
      return;
    }

    // D5 — `n. SEVERITY — title`
    const m5 = line.match(D5);
    if (m5) {
      flush(i);
      cur = {
        sev: m5[2]!.toUpperCase() as Severity,
        ord: Number(m5[1]),
        title: m5[3] || "(untitled)",
        start: i,
      };
      return;
    }

    // D2/D4 — `Ln.` letter prefix; severity from the letter, or the section
    const m2 = line.match(D2);
    if (m2) {
      const sev = LETTER[m2[1]!.toUpperCase()] ?? section;
      if (sev) {
        flush(i);
        cur = { sev, ord: Number(m2[2]), title: m2[3] || "(untitled)", start: i };
        return;
      }
    }

    // any other H2 (e.g. "## Adversarial probes run") closes the current finding
    if (cur && /^##\s/.test(line)) flush(i);
  });
  flush(lines.length);

  // ── two-tier gate ───────────────────────────────────────────────────────
  let gate: ReviewDoc["gate"];
  if (!declared) {
    gate = "NO_VERDICT";
  } else {
    const parsed: Record<Severity, number> = { BLOCK: 0, FIX: 0, NIT: 0 };
    for (const f of findings) parsed[f.severity]++;
    gate = (["BLOCK", "FIX", "NIT"] as Severity[])
      .every((s) => parsed[s] === declared![s]) ? "MATCHED" : "MISMATCH";
  }

  return { file, skillCode, lens, declared, findings, gate };
}

export function parseAllReviews(dir: string): ReviewDoc[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => parseReviewFile(join(dir, f)));
}

/**
 * Slot: the canonical topic key a lesson competes on.
 *
 * Two lessons sharing a slot are talking about the same thing, which is what
 * makes the set-predicate invariant (no +1 and -1 both active without an open
 * conflict) meaningful. Derived from the skill code and a slug of the finding
 * title, so the SAME issue found by two different review lenses lands in the
 * SAME slot — which is exactly how genuine contradictions surface.
 */
export function deriveSlot(f: Finding): string {
  const slug = f.title
    .toLowerCase()
    .replace(/`[^`]*`/g, " ")        // drop code spans; they carry file paths
    .replace(/\([^)]*\)/g, " ")      // drop parentheticals
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-").filter(Boolean).slice(0, 6).join("-");
  return `skill:${f.skillCode}/${slug || "unspecified"}`;
}

/**
 * Polarity: +1 = "do this", -1 = "do not do this".
 *
 * A review FINDING is by construction a report of something wrong, so the
 * lesson it yields is negative: "do not do X". The corrective lives in
 * `suggestedRewrite` and is carried in the body rather than minted as a
 * separate +1 row — inventing a second lesson per finding would double the
 * corpus count without adding an independent observation.
 *
 * This is a heuristic, not a proof. `derivation` is surfaced in the UI so a
 * reader can see WHY a row was labelled, and an overrides file can correct it.
 */
export function derivePolarity(f: Finding): { polarity: -1 | 1; derivation: string } {
  return { polarity: -1, derivation: `finding:${f.severity}` };
}

/** BLOCK findings and everything from the safety lens are never withheld. */
export function isHoldEligible(f: Finding): boolean {
  return !(f.severity === "BLOCK" || f.lens === "safety");
}
