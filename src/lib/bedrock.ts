/**
 * Amazon Bedrock Titan Text Embeddings V2 client.
 *
 * Verified against the live service 2026-08-12 (us-east-1, profile `instar`):
 *   request  {"inputText": "...", "dimensions": 256, "normalize": true}
 *   response {"embedding": [...256 floats...], "inputTextTokenCount": 25}
 *   measured L2 norm = 1.000000005  -> Titan really does return unit vectors
 *
 * Price: $0.02 per 1M input tokens.
 */
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { assertUnit, type EmbedIdentity } from "./hash";

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

export class Embedder {
  private client: BedrockRuntimeClient;
  /**
   * Bedrock auto-subscribes a model on first invocation, and the docs warn a
   * first call may return AccessDeniedException for up to 15 minutes while the
   * subscription settles. We tolerate that ONLY until the first success —
   * after that, AccessDenied is a real permissions problem and must fail loudly
   * rather than being retried for a quarter of an hour.
   */
  private hasSucceeded = false;

  constructor(region = process.env.AWS_REGION ?? "us-east-1") {
    const keyId = process.env.AWS_ACCESS_KEY_ID;
    const secret = process.env.AWS_SECRET_ACCESS_KEY;

    if (keyId && secret) {
      // Production (Cloudflare Workers): explicit credentials from wrangler
      // secrets. There is no ~/.aws to read and no instance metadata endpoint
      // to fall back on, so the default provider chain would simply fail.
      this.client = new BedrockRuntimeClient({
        region,
        credentials: { accessKeyId: keyId, secretAccessKey: secret },
      });
      return;
    }

    // Local development: a NAMED profile (`instar`), never the default one, so
    // this project's least-privilege Bedrock-only key is not picked up
    // implicitly by unrelated AWS tooling on the same machine.
    process.env.AWS_PROFILE ??= process.env.INSTAR_AWS_PROFILE ?? "instar";
    this.client = new BedrockRuntimeClient({ region });
  }

  async embed(text: string, maxAttempts = 6): Promise<EmbedResult> {
    if (!text.trim()) throw new Error("embed: refusing to embed empty text");

    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const res = await this.client.send(
          new InvokeModelCommand({
            modelId: TITAN_V2,
            contentType: "application/json",
            accept: "application/json",
            body: JSON.stringify({
              inputText: text,
              dimensions: EMBED_IDENTITY.dims,
              normalize: EMBED_IDENTITY.normalize,
            }),
          }),
        );
        const parsed = JSON.parse(new TextDecoder().decode(res.body));
        const embedding: number[] = parsed.embedding;

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
          name === "ThrottlingException" ||
          name === "TooManyRequestsException" ||
          name === "ServiceUnavailableException" ||
          name === "ModelNotReadyException";

        if (!isWarmup && !isThrottle) throw err;

        // Full jitter: sleep uniformly in [0, base*2^attempt), capped.
        // Equal backoff across parallel workers would resynchronise them into
        // a thundering herd and re-trigger the same throttle.
        const base = isWarmup ? 5000 : 400;
        const wait = Math.random() * Math.min(base * 2 ** attempt, 30_000);
        if (isWarmup && attempt === 0) {
          console.warn(
            "Bedrock AccessDenied on first call — model subscription can take " +
              "up to 15 minutes to settle. Retrying with backoff.",
          );
        }
        await sleep(wait);
      }
    }
    throw new Error(
      `Bedrock embed failed after ${maxAttempts} attempts: ${String(lastErr)}`,
    );
  }
}
