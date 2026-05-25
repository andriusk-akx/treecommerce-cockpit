/**
 * Next.js instrumentation hook — runs ONCE per server process at boot,
 * before any route handler executes. Used here to (a) pin the process
 * timezone and (b) fire a background cache pre-warm so the first real
 * user after a Railway redeploy doesn't pay the 30-60 s cold-fetch tax.
 *
 * Timezone — why both here and in next.config.ts:
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
 *
 * Boot-time cache warm:
 *   Railway redeploys wipe the on-disk `.cache/` so the first user load
 *   after deploy pays the full cold Zabbix fetch (~30-60 s on the
 *   heatmap window). The scheduled 5 AM warm task closes the gap during
 *   the day, but deploys outside that window leave the next visitor
 *   waiting. Firing the warm from `register()` means every fresh
 *   container has a populated cache within a couple of minutes of
 *   becoming ready, well before the first business-hours visit.
 *
 *   The call is fire-and-forget on a 10 s delay (gives the HTTP server
 *   time to start listening), uses the same `WARM_CACHE_SECRET` the
 *   external scheduler uses, and warms 14/30 d periods only — 90 d is
 *   slow enough that we leave it to lazy on-demand fetch. Failure is
 *   swallowed; nothing the user does is blocked by it.
 *
 *   Skips entirely when WARM_CACHE_SECRET is unset (local dev) or when
 *   we can't determine our own origin (no PORT / RAILWAY_PUBLIC_DOMAIN).
 */
export async function register() {
  process.env.TZ = process.env.TZ ?? "Europe/Vilnius";

  // Boot-time warm — Node.js runtime only (not the Edge runtime, which
  // doesn't have `fetch` to an internal URL anyway).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const secret = process.env.WARM_CACHE_SECRET;
  if (!secret) return;

  // Prefer the public Railway URL when set so we exercise the same
  // network path real users do (including any edge middleware); fall
  // back to localhost for self-hosted / dev-prod parity setups.
  const publicDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  const port = process.env.PORT ?? "3000";
  const origin = publicDomain ? `https://${publicDomain}` : `http://127.0.0.1:${port}`;

  // 3 s delay so the HTTP server is accepting connections by the time
  // we fire — register() runs before the listener is ready. Node's
  // listen() typically resolves within 1-2 s of process start on
  // Railway containers; 3 s gives a small buffer without leaving an
  // unnecessarily wide window where users could hit a cold cache.
  // (Was 10 s before 2026-05-25; tightening because the warm-cache
  // request itself takes 30-60 s and the sooner we start, the sooner
  // post-deploy visitors land on warm data.)
  setTimeout(() => {
    const url = `${origin}/api/internal/warm-cache?secret=${encodeURIComponent(secret)}&periods=14,30`;
    // Detach from the boot promise so a stuck warm doesn't hold up
    // anything else; errors are intentionally swallowed.
    void fetch(url, { method: "GET" }).then(
      (res) => {
        // eslint-disable-next-line no-console
        console.log(`[warm-cache] boot warm fired, status=${res.status}`);
      },
      (err) => {
        // eslint-disable-next-line no-console
        console.warn("[warm-cache] boot warm failed:", err?.message ?? err);
      },
    );
  }, 10_000);
}
