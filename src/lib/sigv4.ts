/**
 * Minimal AWS SigV4 request signing, built on Web Crypto.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 * `@aws-sdk/client-bedrock-runtime` works fine in Node but is a poor fit for a
 * Cloudflare Worker: it drags in a credential-provider chain, a middleware
 * stack, retry strategies and region resolvers, none of which we use. In
 * production it made roughly half of all fresh-embedding requests fail with
 * Cloudflare error 1101 (uncaught exception, "code had hung"), while requests
 * served from the embedding cache — which never touch the SDK — were reliable
 * at ~35 ms.
 *
 * The whole of what we need is: sign one POST with a static key pair and send
 * it. That is this file. No SDK, no cold-start cost, nothing to hang.
 *
 * Reference: AWS Signature Version 4 signing process.
 */

const enc = new TextEncoder();

async function hmac(key: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", k, enc.encode(msg));
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

export interface SigV4Options {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  service: string;
  method: string;
  /** e.g. "/model/amazon.titan-embed-text-v2:0/invoke" — already URI-encoded */
  path: string;
  host: string;
  body: string;
  headers?: Record<string, string>;
}

/**
 * Returns the headers for a signed request, including `Authorization`.
 *
 * Only the header set we actually send is signed, and they are signed in the
 * lowercase-sorted order SigV4 requires — get that wrong and AWS returns a
 * SignatureDoesNotMatch that tells you nothing about which header was at fault.
 */
export async function signRequest(o: SigV4Options): Promise<Record<string, string>> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // 20260817T101530Z
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = {
    host: o.host,
    "x-amz-date": amzDate,
    ...(o.sessionToken ? { "x-amz-security-token": o.sessionToken } : {}),
    ...Object.fromEntries(
      Object.entries(o.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    ),
  };

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders =
    signedHeaderNames.map((h) => `${h}:${headers[h]!.trim()}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");

  const payloadHash = await sha256Hex(o.body);

  // ── THE DOUBLE-ENCODING RULE ─────────────────────────────────────────────
  // For every service EXCEPT S3, SigV4 requires each path segment to be
  // URI-encoded TWICE in the canonical request, while the request itself is
  // sent with the path encoded once.
  //
  // Our path contains a model id with a colon:
  //   sent      /model/amazon.titan-embed-text-v2%3A0/invoke
  //   signed    /model/amazon.titan-embed-text-v2%253A0/invoke
  //
  // Get this wrong and AWS returns SignatureDoesNotMatch — but helpfully it
  // echoes the canonical string it expected, which is how this was found.
  const canonicalPath = o.path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");

  const canonicalRequest = [
    o.method,
    canonicalPath,
    "", // no query string
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${o.region}/${o.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  // Derive the signing key: HMAC chain over date -> region -> service -> aws4_request
  let key: ArrayBuffer | Uint8Array = enc.encode(`AWS4${o.secretAccessKey}`);
  for (const part of [dateStamp, o.region, o.service, "aws4_request"]) {
    key = await hmac(key, part);
  }
  const signature = hex(await hmac(key, stringToSign));

  return {
    ...headers,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
