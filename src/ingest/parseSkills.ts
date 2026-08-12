/**
 * Parse Agent Skill bundles into skill_version rows and documentation chunks.
 *
 * Two corpora, both real, neither synthetic:
 *   - BenchFlow portfolio  : 15 skills + skill-creator  (authored by us)
 *   - cockroachlabs/cockroachdb-skills : 34 skills, Apache-2.0 (the sponsor's)
 */
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative } from "node:path";

export interface SkillBundle {
  name: string;
  source: "benchflow" | "cockroachdb-skills";
  skillMdPath: string;
  frontmatter: Record<string, string>;
  /** the `description` field — already written in retrieval form ("Use when…") */
  triggerText: string;
  body: string;
  /** every .md under the bundle, deduped by realpath AND content hash */
  refFiles: string[];
}

/**
 * Line-oriented frontmatter parser.
 *
 * Deliberately NOT a YAML library. Verified against all 50 SKILL.md files:
 * exactly 3 descriptions contain an unquoted `": "` —
 *   messy-record-reconciliation, pdf-extract-fill-redact, ci-build-repair-and-migration
 * — which makes them ambiguous YAML mappings and crashes a strict parser.
 * Splitting on the FIRST colon is the correct reading of this format, not a
 * shortcut: these files are a fixed-shape header, not arbitrary YAML.
 *
 * Also tolerates the sponsor repo's non-standard `compatibility:` and nested
 * `metadata:` keys, and folded/quoted multi-line values.
 */
export function parseFrontmatter(text: string): { fm: Record<string, string>; body: string } {
  const norm = text.replace(/\r\n?/g, "\n");
  const m = norm.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { fm: {}, body: norm };

  const fm: Record<string, string> = {};
  let key: string | null = null;
  for (const rawLine of m[1]!.split("\n")) {
    if (!rawLine.trim()) continue;
    const indented = /^\s/.test(rawLine);
    const line = rawLine.trim();

    // A continuation line: indented, or the previous key's value is still open.
    // Nested mappings (metadata:\n  author: x) are flattened to metadata.author.
    const colon = line.indexOf(":");
    const looksLikeKey = colon > 0 && /^[A-Za-z_][\w.-]*$/.test(line.slice(0, colon));

    if (looksLikeKey && !indented) {
      key = line.slice(0, colon);
      fm[key] = stripQuotes(line.slice(colon + 1).trim());
    } else if (looksLikeKey && indented && key) {
      fm[`${key}.${line.slice(0, colon)}`] = stripQuotes(line.slice(colon + 1).trim());
    } else if (key) {
      fm[key] = `${fm[key] ?? ""} ${stripQuotes(line)}`.trim();
    }
  }
  return { fm, body: norm.slice(m[0].length) };
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Collect every markdown file under a bundle, deduped two ways.
 *
 * The sponsor repo symlinks `permissions.md`. Walking without resolving embeds
 * it twice, and the twins sit at cosine ~1.0 — occupying ranks 1 and 2 of every
 * permissions query forever. realpath catches the symlink; the content hash
 * additionally catches plain copy-paste duplicates that realpath cannot see.
 */
function collectMarkdown(root: string, seenReal: Set<string>, seenHash: Set<string>): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { walk(p); continue; }
      if (!e.endsWith(".md") || e === "SKILL.md") continue;

      const real = realpathSync(p);
      if (seenReal.has(real)) continue;
      const h = createHash("sha256").update(readFileSync(real)).digest("hex");
      if (seenHash.has(h)) continue;

      seenReal.add(real);
      seenHash.add(h);
      out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

export function loadSkillBundles(
  root: string,
  source: SkillBundle["source"],
): SkillBundle[] {
  const bundles: SkillBundle[] = [];
  const seenReal = new Set<string>();
  const seenHash = new Set<string>();

  const walk = (dir: string) => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    if (entries.includes("SKILL.md")) {
      const skillMdPath = join(dir, "SKILL.md");
      const { fm, body } = parseFrontmatter(readFileSync(skillMdPath, "utf8"));
      const dirName = basename(dir);
      const name = fm.name ?? dirName;

      // The spec requires name == directory. Holds 50/50 today; assert rather
      // than silently accept drift, because `name` becomes the natural key.
      if (fm.name && fm.name !== dirName) {
        throw new Error(
          `frontmatter name "${fm.name}" != directory "${dirName}" at ${skillMdPath}`,
        );
      }
      bundles.push({
        name,
        source,
        skillMdPath,
        frontmatter: fm,
        triggerText: fm.description ?? name,
        body,
        refFiles: collectMarkdown(dir, seenReal, seenHash),
      });
      return; // a bundle does not nest another bundle
    }
    for (const e of entries) {
      const p = join(dir, e);
      try { if (statSync(p).isDirectory()) walk(p); } catch { /* ignore */ }
    }
  };
  walk(root);
  return bundles.sort((a, b) => a.name.localeCompare(b.name));
}

export interface Chunk {
  /** 'doc:<skill>/<relative path>#<n>' — the `doc:` prefix is load-bearing */
  slot: string;
  /** heading breadcrumb, so a chunk carries its context into the embedding */
  breadcrumb: string;
  text: string;
  sourceRef: string;
}

/**
 * Fence-aware heading chunker.
 *
 * Splits on headings, never inside a fenced code block — a naive splitter cuts
 * examples in half and embeds syntactically broken fragments. Oversized
 * sections are split on blank lines rather than mid-paragraph.
 */
export function chunkMarkdown(
  text: string,
  skillName: string,
  relPath: string,
  targetChars = 1600,
): Chunk[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const chunks: Chunk[] = [];
  const trail: string[] = [];
  let buf: string[] = [];
  let fenced = false;
  let n = 0;

  const emit = () => {
    const body = buf.join("\n").trim();
    buf = [];
    if (body.length < 40) return; // headings with no prose carry no signal
    const breadcrumb = trail.filter(Boolean).join(" › ");
    for (const piece of splitLong(body, targetChars)) {
      chunks.push({
        slot: `doc:${skillName}/${relPath}#${n++}`,
        breadcrumb,
        text: piece,
        sourceRef: `seed:${relPath}`,
      });
    }
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const h = !fenced ? line.match(/^(#{1,6})\s+(.*)$/) : null;
    if (h) {
      emit();
      const depth = h[1]!.length;
      trail.length = Math.max(0, depth - 1);
      trail[depth - 1] = h[2]!.trim();
    } else {
      buf.push(line);
    }
  }
  emit();
  return chunks;
}

function splitLong(body: string, target: number): string[] {
  if (body.length <= target) return [body];
  const parts: string[] = [];
  let cur: string[] = [];
  let len = 0;
  for (const para of body.split(/\n{2,}/)) {
    if (len + para.length > target && cur.length) {
      parts.push(cur.join("\n\n"));
      cur = [];
      len = 0;
    }
    cur.push(para);
    len += para.length + 2;
  }
  if (cur.length) parts.push(cur.join("\n\n"));
  return parts;
}

export function relPathOf(bundleDir: string, file: string): string {
  return relative(dirname(bundleDir), file) || basename(file);
}
