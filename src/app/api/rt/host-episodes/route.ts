/**
 * GET /api/rt/host-episodes?hostId=...&periodDays=14&threshold=80
 *
 * Returns clustered threshold-crossing episodes for a single host across
 * the requested window. Drives the Level 3 drilldown in the CPU Matrix:
 * the operator picks a host from the inventory and we surface the bursts
 * of high CPU rather than every offending minute.
 *
 * Why episodes, not minutes:
 *   A host with 458 minutes above 80% over 14 days clusters into ~12–15
 *   bursts of 5–40 min each. The decision question — "how often does
 *   this host spike, and how long?" — is answered at the burst level,
 *   not at the minute level. Cuts the payload to <100 rows even on the
 *   busiest hosts and makes the list scannable.
 *
 * Performance budget:
 *   • One Zabbix history.get round-trip per call (already cached for
 *     120s by getCpuHistoryForRange).
 *   • Cluster computation is a single linear pass over minute samples.
 *   • Hard-cap of 100 episodes per response — if the host has more
 *     threshold-crossing bursts than that, return the 100 most recent
 *     and surface `truncated: true` so the UI can hint at it.
 *
 * Auth: session-required (same pattern as other /api/rt routes).
 */

import { NextRequest, NextResponse } from "next/server";
import { getZabbixClient } from "@/lib/zabbix/client";

export const dynamic = "force-dynamic";

interface Episode {
  /** ISO 8601 start timestamp of the first minute above threshold. */
  startSec: number;
  endSec: number;
  durationMin: number;
  /** Highest CPU value seen during the burst (already > threshold). */
  peakCpu: number;
  /** Unix-seconds of the peak — granular handle for the Level 4
   *  process-breakdown drill so we can land on the right minute slot. */
  peakSec: number;
}

/** Cluster consecutive minute samples above `threshold` into episodes.
 *  Gap rule: any minute without a >threshold sample, or any sample
 *  more than 90 s after the previous one, ends the current burst.
 *  Returns episodes sorted newest first. */
function clusterEpisodes(
  samples: { clockSec: number; value: number }[],
  threshold: number,
  maxCount: number,
): { episodes: Episode[]; truncated: boolean } {
  if (samples.length === 0) return { episodes: [], truncated: false };

  // Ensure chronological order — getCpuHistoryForRange returns
  // ascending already, but be defensive.
  const sorted = samples.slice().sort((a, b) => a.clockSec - b.clockSec);

  const all: Episode[] = [];
  // Gap break threshold: 90 s. Zabbix `system.cpu.util[,,avg1]` polls
  // every 60 s; a 90 s window allows for one missed sample (slightly
  // late agent push) without breaking a real burst.
  const GAP_S = 90;

  let curStart = -1;
  let curEnd = -1;
  let curPeak = 0;
  let curPeakSec = 0;
  let lastSec = -Infinity;
  let lastWasAbove = false;

  const flush = () => {
    if (curStart < 0) return;
    all.push({
      startSec: curStart,
      endSec: curEnd,
      durationMin: Math.max(1, Math.round((curEnd - curStart) / 60) + 1),
      peakCpu: curPeak,
      peakSec: curPeakSec,
    });
    curStart = -1;
    curEnd = -1;
    curPeak = 0;
    curPeakSec = 0;
  };

  for (const s of sorted) {
    const above = s.value > threshold;
    const gapTooBig = lastSec >= 0 && s.clockSec - lastSec > GAP_S;
    lastSec = s.clockSec;

    if (above) {
      if (!lastWasAbove || gapTooBig) {
        // Boundary: either we just emerged from below, or we crossed
        // a gap inside an above-threshold streak. In both cases, close
        // the previous burst (if any) and start fresh.
        flush();
        curStart = s.clockSec;
      }
      curEnd = s.clockSec;
      if (s.value > curPeak) {
        curPeak = s.value;
        curPeakSec = s.clockSec;
      }
      lastWasAbove = true;
    } else {
      lastWasAbove = false;
      flush();
    }
  }
  flush();

  // Newest-first ordering — operators care about recent bursts first.
  all.sort((a, b) => b.startSec - a.startSec);
  if (all.length > maxCount) {
    return { episodes: all.slice(0, maxCount), truncated: true };
  }
  return { episodes: all, truncated: false };
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

  // Fetch the host's overall CPU item (system.cpu.util[,,avg1]) so
  // clustering speaks to 'host CPU above threshold', not 'one process
  // above threshold'.
  type ZbxItem = { itemid: string; key_: string };
  const items = (await client.request("item.get", {
    output: ["itemid", "key_"],
    hostids: [hostId],
    filter: { status: 0 },
    search: { key_: "system.cpu.util" },
  })) as ZbxItem[];
  // Prefer the avg1 flavour — same item the rest of the dashboard reads.
  const cpuItem =
    items.find((it) => it.key_.includes("avg1")) ??
    items.find((it) => it.key_.startsWith("system.cpu.util")) ??
    null;
  if (!cpuItem) {
    return NextResponse.json({
      hostId,
      periodDays,
      threshold,
      episodes: [],
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

  // Episode hard cap. Anything beyond 100 is too many for the UI list
  // anyway; we surface `truncated` so the operator can narrow the
  // window (Period dropdown) if they want a fuller picture.
  const MAX_EPISODES = 100;
  const { episodes, truncated } = clusterEpisodes(samples, threshold, MAX_EPISODES);

  return NextResponse.json({
    hostId,
    periodDays,
    threshold,
    sampleCount: samples.length,
    episodes,
    truncated,
  });
}
