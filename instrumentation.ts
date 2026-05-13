/**
 * Next.js instrumentation hook — runs ONCE per server process at boot,
 * before any route handler executes. Used here as the canonical place
 * to pin the process timezone.
 *
 * Why both here and in next.config.ts:
 *   - next.config.ts runs at config-load time, which on production builds
 *     is BUILD time, not server-start time. The TZ assignment there
 *     guarantees the BUILD reads Europe/Vilnius. But the running server
 *     container picks up its own env, and Railway containers default to
 *     UTC — without this instrumentation hook, the running server would
 *     still tick in UTC even after a clean rebuild.
 *   - This file runs at server-start, BEFORE the first Date object is
 *     created by a route, so getHours / getMinutes / etc. return Vilnius
 *     local time for the rest of the process lifetime.
 *
 * Allow operator override via the standard TZ env var so future multi-
 * region deployments can pin a different zone without code change.
 */
export async function register() {
  process.env.TZ = process.env.TZ ?? "Europe/Vilnius";
}
