/**
 * Amazon Bedrock Titan Text Embeddings V2 — via a direct signed fetch.
 *
 * Verified against the live service (us-east-1):
 *   request  {"inputText": "...", "dimensions": 256, "normalize": true}
 *   response {"embedding": [...256 floats...], "inputTextTokenCount": 25}
 *   measured L2 norm = 1.000000005  -> Titan really does return unit vectors
 *
 * Price: $0.02 per 1M input tokens.
 *
 * ── WHY NO AWS SDK ────────────────────────────────────────────────────────
 * This used `@aws-sdk/client-bedrock-runtime`, which works in Node and failed
 * in production on Cloudflare Workers: roughly half of all requests needing a
 * fresh embedding returned Cloudflare error 1101 (uncaught exception), while
 * cache-served requests — which never touch the client — were reliable.
 *
 * The tell was the timing. Failures returned in ~0.06s and successes took
 * ~1.4s. A hang is slow; a fast 1101 means the isolate threw BEFORE the request
 * handler ran, i.e. at module evaluation — where a try/catch inside the handler
 * can never see it. The client was being constructed at module scope.
 *
 * Two changes fix it, and both are worth keeping:
 *   1. No SDK. We need to sign one POST with a static key pair; that is
 *      `src/lib/sigv4.ts` and Web Crypto, with no credential-provider chain,
 *      middleware stack or region resolver to fail at import time.
 *   2. Nothing heavy at module scope. Credentials are read per call.
 */
import { assertUnit, type EmbedIdentity } from "./hash";
import { signRequest } from "./sigv4";

export const TITAN_V2 = "amazon.titan-embed-text-v2:0";

/**
 * 256 dimensions, not 1024.
 *
 * Titan V2 supports Matryoshka output. At 256 we get a quarter of the storage
 * and a quarter of the RU cost per vector-index write, with negligible recall
 * loss at our corpus size. Against a 50M-RU hard cap this is the highest-
 * leverage constant in the codebase.
 */
export const EMBED_IDENTITY: EmbedIdentity = {
  model: TITAN_V2,
  dims: 256,
  normalize: true,
};

/** $0.02 per 1M tokens, in micro-USD, for the spend ledger. */
export const USD_MICROS_PER_TOKEN = 0.02;

export interface EmbedResult {
  embedding: number[];
  inputTokens: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Creds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * Read credentials at CALL time, never at import time.
 *
 * In a Worker these come from wrangler secrets. Locally they come from the
 * environment; the ingest scripts export them from the named `instar` profile
 * so this project's least-privilege key is never picked up implicitly by other
 * AWS tooling on the machine.
 */
function credentials(): Creds {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "No AWS credentials. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY " +
        "(wrangler secrets in production; `aws configure export-credentials " +
        "--profile instar` locally).",
    );
  }
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  };
}

export class Embedder {
  private region: string;
  /**
   * Bedrock auto-subscribes a model on first invocation, and the docs warn a
   * first call may return AccessDenied for up to 15 minutes while the
   * subscription settles. We tolerate that ONLY until the first success —
   * afterwards AccessDenied is a real permissions problem and must fail loudly
   * rather than being retried for a quarter of an hour.
   */
  private hasSucceeded = false;

  constructor(region = process.env.AWS_REGION ?? "us-east-1") {
    // Deliberately trivial: no network, no credential resolution, nothing that
    // can throw. This object is safe to construct at module scope.
    this.region = region;
  }

  async embed(text: string, maxAttempts = 5): Promise<EmbedResult> {
    if (!text.trim()) throw new Error("embed: refusing to embed empty text");

    const host = `bedrock-runtime.${this.region}.amazonaws.com`;
    // The model id contains ':' and must be percent-encoded in the path.
    const path = `/model/${encodeURIComponent(TITAN_V2)}/invoke`;
    const body = JSON.stringify({
      inputText: text,
      dimensions: EMBED_IDENTITY.dims,
      normalize: EMBED_IDENTITY.normalize,
    });

    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const { accessKeyId, secretAccessKey, sessionToken } = credentials();
        const headers = await signRequest({
          accessKeyId, secretAccessKey, sessionToken,
          region: this.region,
          service: "bedrock",
          method: "POST",
          path, host, body,
          headers: { "content-type": "application/json", accept: "application/json" },
        });

        const res = await fetch(`https://${host}${path}`, {
          method: "POST",
          headers,
          body,
        });

        if (!res.ok) {
          const detail = (await res.text()).slice(0, 300);
          const err = new Error(`Bedrock ${res.status}: ${detail}`);
          // Preserve the class so retry logic and the API's `kind` field stay
          // meaningful without the SDK's error hierarchy.
          err.name =
            res.status === 403 ? "AccessDeniedException"
            : res.status === 429 ? "ThrottlingException"
            : res.status >= 500 ? "ServiceUnavailableException"
            : "BedrockError";
          throw err;
        }

        const parsed = (await res.json()) as {
          embedding?: number[];
          inputTextTokenCount?: number;
        };
        const embedding = parsed.embedding;
        if (!Array.isArray(embedding) || embedding.length !== EMBED_IDENTITY.dims) {
          throw new Error(
            `Bedrock returned ${embedding?.length ?? "no"} dims, expected ${EMBED_IDENTITY.dims}`,
          );
        }
        // A non-unit vector must never reach the database: the ranking maths
        // assumes unit vectors and would be silently wrong, not broken.
        assertUnit(embedding, "Embedder.embed");

        this.hasSucceeded = true;
        return { embedding, inputTokens: parsed.inputTextTokenCount ?? 0 };
      } catch (err) {
        lastErr = err;
        const name = (err as { name?: string })?.name ?? "";
        const isWarmup = name === "AccessDeniedException" && !this.hasSucceeded;
        const isThrottle =
          name === "ThrottlingException" || name === "ServiceUnavailableException";
        if (!isWarmup && !isThrottle) throw err;

        // Full jitter: equal backoff across parallel callers would resynchronise
        // them into a thundering herd and re-trigger the same throttle.
        const base = isWarmup ? 5000 : 400;
        await sleep(Math.random() * Math.min(base * 2 ** attempt, 20_000));
      }
    }
    throw new Error(`Bedrock embed failed after ${maxAttempts} attempts: ${String(lastErr)}`);
  }
}
