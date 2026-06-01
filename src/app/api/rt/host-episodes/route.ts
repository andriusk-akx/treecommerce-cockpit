/**
 * GET /api/rt/host-episodes?hostId=...&periodDays=14&threshold=80
 *
 * Returns the per-minute list of threshold-crossing samples for a single
 * host across the requested window, plus a roll-up summary so the UI can
 * render counts without iterating the array.
 *
 * Drives the Level 3 drilldown in the CPU Matrix: the operator picks a
 * host from the inventory, we surface every minute the host was above
 * the chosen CPU threshold, and clicking a minute hands off to
 * /api/rt/process-history at granularity=1 for the exact-minute process
 * breakdown. Per-minute granularity means the breakdown sums directly
 * to the minute's host-CPU value — no slot-average distortion.
 *
 * Performance budget:
 *   • One Zabbix history.get round-trip per call (cached 120 s by
 *     getCpuHistoryForRange).
 *   • A single filter+sort pass over the minute samples.
 *   • Hard-cap of 500 minutes returned. A host pinning >500 minutes
 *     above threshold over a single period is too sprawling to scan
 *     row-by-row anyway; we return the most recent 500 and surface
 *     `truncated: true` so the UI can hint at narrowing the period.
 *
 * Auth: session-required (same pattern as other /api/rt routes).
 *
 * Response shape:
 *   {
 *     hostId, periodDays, threshold,
 *     sampleCount,         // raw samples scanned (above + below)
 *     minutes: [ { clockSec, cpu } ],
 *     truncated: boolean,
 *   }
 */

import { NextRequest, NextResponse } from "next/server";
import { getZabbixClient } from "@/lib/zabbix/client";

export const dynamic = "force-dynamic";

interface MinuteSample {
  clockSec: number;
  cpu: number;
}

/** Filter Zabbix minute samples to the ones strictly above `threshold`,
 *  sort newest-first, and cap. Strict `>` (not `>=`) matches the rest
 *  of the dashboard's threshold semantics. */
function filterMinutesAbove(
  samples: { clockSec: number; value: number }[],
  threshold: number,
  maxCount: number,
): { minutes: MinuteSample[]; truncated: boolean } {
  const above: MinuteSample[] = [];
  for (const s of samples) {
    if (s.value > threshold) above.push({ clockSec: s.clockSec, cpu: s.value });
  }
  // Newest first — operators care about recent breaches.
  above.sort((a, b) => b.clockSec - a.clockSec);
  if (above.length > maxCount) {
    return { minutes: above.slice(0, maxCount), truncated: true };
  }
  return { minutes: above, truncated: false };
}

export async function GET(req: NextRequest) {
  const hostId = req.nextUrl.searchParams.get("hostId");
  const parseInt0 = (raw: string | null, def: number, min: number, max: number) => {
    if (raw === null) return def;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return def;
    return Math.max(min, Math.min(max, n));
  };
  const periodDays = parseInt0(req.nextUrl.searchParams.get("periodDays"), 14, 1, 90);
  const threshold = parseInt0(req.nextUrl.searchParams.get("threshold"), 80, 20, 99);

  if (!hostId) {
    return NextResponse.json({ error: "hostId required" }, { status: 400 });
  }

  const client = getZabbixClient();

  // Fetch the host's overall CPU item — must be `system.cpu.util[,,avg1]`
  // (or the bare `system.cpu.util` fallback). Bug fix (2026-06-01): the
  // earlier version matched any item whose key contained "avg1" and so
  // could pick `system.cpu.util[,user,avg1]` or `[,system,avg1]` (user-
  // mode or system-mode CPU instead of total). The rest of the codebase
  // resolves the same item with an exact key match (see writer.ts,
  // compare/resolve.ts, rollout-insights/fetcher.ts) — match that.
  type ZbxItem = { itemid: string; key_: string };
  const items = (await client.request("item.get", {
    output: ["itemid", "key_"],
    hostids: [hostId],
    filter: { status: 0 },
    search: { key_: "system.cpu.util" },
  })) as ZbxItem[];
  const cpuItem =
    items.find((it) => it.key_ === "system.cpu.util[,,avg1]") ??
    items.find((it) => it.key_ === "system.cpu.util") ??
    null;
  if (!cpuItem) {
    return NextResponse.json({
      hostId,
      periodDays,
      threshold,
      minutes: [],
      truncated: false,
      note: "No system.cpu.util item found for this host.",
    });
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const fromSec = nowSec - periodDays * 86400;
  const itemMap = new Map<string, string>([[cpuItem.itemid, hostId]]);
  const { samples } = await client.getCpuHistoryForRange(
    [cpuItem.itemid],
    itemMap,
    fromSec,
    nowSec,
  );

  // Minute hard cap. A host pinning >500 minutes above threshold over
  // a single period is too sprawling to scan row-by-row anyway; we
  // surface `truncated` so the UI can prompt the operator to narrow
  // the window via the Period dropdown.
  const MAX_MINUTES = 500;
  const { minutes, truncated } = filterMinutesAbove(samples, threshold, MAX_MINUTES);

  return NextResponse.json({
    hostId,
    periodDays,
    threshold,
    sampleCount: samples.length,
    minutes,
    truncated,
  });
}
