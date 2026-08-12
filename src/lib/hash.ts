/**
 * Content hashing and vector literal encoding.
 *
 * This module is deliberately shared between the one-off ingest and the live
 * app. It must NEVER be forked into a second language: if the ingest and the
 * runtime canonicalise text even slightly differently, they compute different
 * content hashes, the embed_cache silently misses on every lookup, and we pay
 * Bedrock twice for identical text while believing the cache works.
 */
import { createHash } from "node:crypto";

/** Bump when the canonicalisation rules below change; invalidates the cache. */
export const HASH_VERSION = "instar/v1";

/**
 * Canonicalise text before hashing.
 *
 * Without this, a file that gains a trailing space or gets checked out with
 * CRLF endings produces a different hash for identical semantic content, and
 * a re-run re-embeds the whole corpus.
 */
export function canonicalise(text: string): string {
  return text
    .normalize("NFC")           // combining marks -> single code points
    .replace(/\r\n?/g, "\n")    // CRLF / CR -> LF
    .replace(/[ \t]+$/gm, "")   // trailing whitespace per line
    .replace(/\n{3,}/g, "\n\n") // collapse blank-line runs
    .trim();
}

export interface EmbedIdentity {
  model: string;
  dims: number;
  normalize: boolean;
}

/**
 * Hash preimage INCLUDES the model identity.
 *
 * embed_cache's primary key is content_hash alone, with model/dims as ordinary
 * columns. If the preimage omitted them, switching to 512 dimensions later
 * would serve stale 256-dimension vectors forever — with no error, no warning,
 * and a silently broken index.
 */
export function contentHash(text: string, id: EmbedIdentity): string {
  const preimage = [
    HASH_VERSION,
    id.model,
    String(id.dims),
    String(id.normalize),
    canonicalise(text),
  ].join("\n");
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}

/**
 * The single embedding convention for every `lesson` row.
 *
 * Why one convention: Titan places short strings and long passages in
 * systematically different regions of vector space. Embedding 15-token finding
 * titles and 240-token documentation chunks into the SAME index makes recall
 * quietly length-biased — a short query preferentially retrieves short rows and
 * rarely surfaces chunks, or the reverse. Results still look plausible, which
 * is what makes it dangerous.
 */
export function lessonEmbedText(
  slot: string,
  triggerText: string,
  body: string,
): string {
  return `${slot}\n${triggerText}\n${body.slice(0, 600)}`;
}

/** Encode a vector for CockroachDB's VECTOR type: '[0.1,-0.2,...]'. */
export function toVectorLiteral(v: readonly number[]): string {
  return `[${v.map((x) => x.toFixed(8)).join(",")}]`;
}

/**
 * Guard against a degenerate embedding reaching the database.
 *
 * The ranking math depends on `sim = 1 - d^2/2`, which only holds for unit
 * vectors. A zero or non-unit vector would not error — it would just rank
 * wrongly, everywhere, forever.
 */
export function assertUnit(v: readonly number[], where: string): void {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (!Number.isFinite(norm) || Math.abs(norm - 1) > 1e-4) {
    throw new Error(
      `${where}: embedding is not a unit vector (norm=${norm}). ` +
        `Titan must be called with {"normalize": true}.`,
    );
  }
}
