/**
 * Cache pre-warm endpoint.
 *
 * Why this exists: the CPU Timeline / CPU Matrix server-side data fetch
 * has a 30–60 s cold-start cost when the disk cache under `.cache/` is
 * empty — which happens on every Railway redeploy (Docker image is
 * ephemeral). Users hit "30d" and wait the full minute the first time
 * after a deploy. This endpoint lets an external scheduler (Cowork
 * scheduled task, Railway cron, GitHub Actions) trigger the warm-up
 * proactively so the user's first request lands on warm cache.
 *
 * Mechanism: for each ACTIVE Retellect pilot, fire an HTTP request to
 * `/retellect/{id}?period={p}` with `x-warm-cache-secret` set. The page
 * has a bypass branch that detects the secret, skips auth, runs
 * `loadZabbixDataPayload` (which populates the disk cache), and returns
 * a minimal response. The body is thrown away here — only the side
 * effect matters.
 *
 * Auth: requires `WARM_CACHE_SECRET` env var to match `?secret=...`. Not
 * a hard security boundary (no destructive operation, and the bypass
 * itself is constrained to running the data fetch), but keeps stray
 * internet traffic from triggering Zabbix load.
 */

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { headers } from "next/headers";

export const dynamic = "force-dynamic";

// Period presets to pre-warm. 14d + 30d cover the two main heatmap
// presets users land on; 7d is the CPU Matrix default. 90d is omitted
// from the default set because it's the slowest path AND rarely the
// first-load period — pass `?periods=14,30,90` to include it explicitly.
const DEFAULT_PERIODS = [7, 14, 30];

export async function GET(req: NextRequest) {
  const expectedSecret = process.env.WARM_CACHE_SECRET;
  if (!expectedSecret) {
    return Response.json(
      { error: "WARM_CACHE_SECRET not configured on this deployment" },
      { status: 503 },
    );
  }
  const givenSecret = req.nextUrl.searchParams.get("secret");
  if (givenSecret !== expectedSecret) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Allow callers to override the period list, e.g. `?periods=14,30,90`.
  const periodsParam = req.nextUrl.searchParams.get("periods");
  const periods = periodsParam
    ? periodsParam
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0 && n <= 365)
    : DEFAULT_PERIODS;

  const pilots = await prisma.pilot.findMany({
    where: { productType: "RETELLECT", status: "ACTIVE" },
    select: { id: true, name: true },
  });

  // Derive our own origin so the fetch hits the live deployment, not a
  // hardcoded localhost. On Railway the public host arrives via the
  // x-forwarded-host header; locally we fall back to req.nextUrl.host.
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "https";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? req.nextUrl.host;
  const origin = `${proto}://${host}`;

  const started = Date.now();
  const results: Array<{
    pilot: string;
    pilotId: string;
    period: number;
    ms: number;
    ok: boolean;
    status?: number;
    error?: string;
  }> = [];

  // Sequential — we'd rather not flood Zabbix with N×periods parallel
  // fetchers. Total wall is ~1–3 min for the typical 2–3 Retellect
  // pilots × 3 periods on a cold cache.
  for (const pilot of pilots) {
    for (const period of periods) {
      const t0 = Date.now();
      const url = `${origin}/retellect/${pilot.id}?period=${period}d`;
      try {
        const res = await fetch(url, {
          headers: { "x-warm-cache-secret": expectedSecret },
          redirect: "manual",
          cache: "no-store",
        });
        // Consume body so the connection releases; throw it away.
        await res.text();
        results.push({
          pilot: pilot.name,
          pilotId: pilot.id,
          period,
          ms: Date.now() - t0,
          ok: res.status >= 200 && res.status < 400,
          status: res.status,
        });
      } catch (e: unknown) {
        results.push({
          pilot: pilot.name,
          pilotId: pilot.id,
          period,
          ms: Date.now() - t0,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  return Response.json({
    pilots: pilots.length,
    periods,
    totalMs: Date.now() - started,
    results,
  });
}
