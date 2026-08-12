import { defineCloudflareConfig } from "@opennextjs/cloudflare";

/**
 * OpenNext → Cloudflare Workers.
 *
 * No incremental cache is configured: every route that matters here is
 * `dynamic = "force-dynamic"` and reads live cluster state. Caching the
 * integrity audit would defeat its purpose — the whole point is that a judge
 * sees the database as it is right now, not a snapshot we baked at build time.
 */
export default defineCloudflareConfig();
