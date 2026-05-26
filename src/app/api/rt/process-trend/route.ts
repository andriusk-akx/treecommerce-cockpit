/**
 * GET /api/rt/process-trend?hostId=...&days=14&category=scoApp&threshold=70
 *
 * Returns per-DAY CPU aggregates for one host across a 1–14 day window, plus
 * a per-day Retellect ON/OFF classification derived from python.cpu sample
 * coverage. Sister endpoint to /api/rt/process-history (which returns intra-
 * day slots for ONE date) — same telemetry-source selection logic, different
 * aggregation grain.
 *
 * Used exclusively by the "Process trend" card under the CPU Timeline
 * heatmap. Lazy: only called when the card is open and a host is drilled.
 *
 * Request:
 *   - hostId (required)         Zabbix host id
 *   - days   (default 14)       1..14 days back from today
 *   - category (default scoApp) one of "retellect" | "scoApp" | "db" | "system"
 *   - threshold (default 70)    minutesAbove threshold (% of host CPU)
 *
 * Response:
 *   {
 *     days: [{ date, avg, peak, minutesAbove, totalSamples, retellectOn }, ...],
 *     summary: { onCount, offCount, onAvg, onPeak, offAvg, offPeak, deltaPp, deltaRel },
 *     category, days_window, threshold
 *   }
 *
 * Days with zero samples are still returned (totalSamples: 0, retellectOn:
 * false) so the chart's x-axis stays on a fixed 14-cell grid even when a
 * host has gaps. The component renders gap days as a dashed cell.
 */
import { NextRequest, NextResponse } from "next/server";
import { getZabbixClient } from "@/lib/zabbix/client";
import { cached } from "@/lib/zabbix/cache";
import { resolveCoresForHost } from "@/lib/zabbix/cores";
import { prisma } from "@/lib/db";
import {
  chooseTelemetrySources,
  normaliseValue,
  type Category,
  type HistoryProcessCategory,
} from "../process-history/math";
import {
  bucketSamplesByDay,
  aggregateDay,
  isRetellectOnDay,
  compareOnOff,
  listDateRange,
  type RawSample,
} from "@/components/rt/tabs/rt-process-trend-helpers";

export const dynamic = "force-dynamic";

/**
 * Local extension of Category. "other" is computed by the route itself
 * (host CPU − sum of monitored processes) so it never appears in the
 * shared `chooseTelemetrySources` taxonomy. Keep the math module's
 * Category union unchanged — other modules read it as the canonical
 * "what kinds of processes do we track" set.
 */
type CategoryEx = Category | "other" | "totalCpu";
const ALLOWED_CATEGORIES = new Set<CategoryEx>([
  "retellect", "scoApp", "db", "system",
  "besclient", "elastic", "osCore",
  "other", "totalCpu",
]);

/** Process-backed categories — used to build itemIdsByCategory and to enumerate
 *  what "other" subtracts from the host CPU. Excludes osCore (kernel-CPU
 *  signal sourced from system.cpu.util[,system], not from a process item)
 *  even though osCore is a member of the broader Category union. */
const PROCESS_CATEGORIES: HistoryProcessCategory[] = [
  "retellect", "scoApp", "db", "system", "besclient", "elastic",
];

// Hard upper bound on the trend window. trend.get retention on a typical
// Zabbix server is ~365 days; beyond that the response is empty regardless
// of what we ask. Anything past the practical retention is wasted load on
// the Zabbix proxy, so we clamp here. The CPU Timeline filter UI also lets
// the user pick "custom days" up to 365 — we mirror that bound exactly.
const MAX_DAYS = 365;

export async function GET(req: NextRequest) {
  const hostId = req.nextUrl.searchParams.get("hostId");
  // Zabbix display name — passed through so resolveCoresForHost can find
  // the Device row (sourceHostKey stores the display name). Optional for
  // backward compat; older clients that omit it get coresKnown=false
  // whenever live Zabbix system.cpu.num is missing.
  const hostName = req.nextUrl.searchParams.get("hostName") ?? undefined;
  const daysParam = parseInt(req.nextUrl.searchParams.get("days") || "14", 10);
  const days = Number.isFinite(daysParam) ? Math.max(1, Math.min(MAX_DAYS, daysParam)) : 14;
  const categoryParam = req.nextUrl.searchParams.get("category") || "scoApp";
  const thresholdParam = parseFloat(req.nextUrl.searchParams.get("threshold") || "70");
  const threshold = Number.isFinite(thresholdParam) ? thresholdParam : 70;

  if (!hostId) {
    return NextResponse.json({ error: "hostId required" }, { status: 400 });
  }
  if (!ALLOWED_CATEGORIES.has(categoryParam as CategoryEx)) {
    return NextResponse.json(
      { error: `category must be one of ${Array.from(ALLOWED_CATEGORIES).join(", ")}` },
      { status: 400 },
    );
  }
  const category = categoryParam as CategoryEx;

  // Cache the entire response shape for 120 s so the same (host, category,
  // threshold) doesn't re-hit Zabbix when the user toggles the card open/closed
  // or comparators in the same minute. 120 s mirrors getCpuHistoryDaily — the
  // freshest day still updates within the heatmap's existing refresh cadence.
  // hostName is intentionally NOT in the cache key — it's a lookup hint, not
  // part of the response shape; the response is determined by hostId.
  const cacheKey = `rt:procTrend:${hostId}:${days}:${category}:${threshold}`;
  return NextResponse.json(
    await cached(cacheKey, () => buildTrendResponse(hostId, hostName, days, category, threshold), 120_000),
  );
}

interface TrendResponse {
  days: Array<{
    date: string;
    avg: number;
    peak: number;
    minutesAbove: number;
    totalSamples: number;
    retellectOn: boolean;
    /**
     * Where the day's data came from:
     *   "history" — raw 1-min samples (full accuracy, supports minutesAbove).
     *   "trend"   — hourly aggregates (avg/peak only; minutesAbove is 0).
     *   "none"    — no data for this day.
     * The UI uses this to dim/disable the Min-≥-threshold metric on trend-
     * sourced days and to surface a tooltip explaining the source.
     */
    source: "history" | "trend" | "none";
  }>;
  summary: ReturnType<typeof compareOnOff>;
  category: CategoryEx;
  threshold: number;
  daysWindow: number;
  hasData: boolean;
}

async function buildTrendResponse(
  hostId: string,
  hostName: string | undefined,
  days: number,
  category: CategoryEx,
  threshold: number,
): Promise<TrendResponse> {
  const client = getZabbixClient();

  // Discover this host's items. Same pattern as /api/rt/process-history:
  // filter ONLY by status=0 (administratively enabled) — do NOT filter by
  // state, which would exclude items currently ZBX_NOTSUPPORTED but still
  // holding valid history from when they were healthy.
  //
  // 60s cache on the item list is shared with the drill-down endpoint
  // (zabbix:procHistItems:${hostId}) so the two endpoints don't double-fetch
  // when the user has a card open AND drills.
  const allItems = (await cached(
    `zabbix:procHistItems:${hostId}`,
    () => client.request("item.get", {
      output: ["itemid", "key_", "lastvalue"],
      hostids: [hostId],
      filter: { status: 0 },
    }) as Promise<Array<{ itemid: string; key_: string; lastvalue: string }>>,
    60_000,
  )) as Array<{ itemid: string; key_: string; lastvalue: string }>;

  // Cores — needed for perf_counter normalisation.
  // Uses resolveCoresForHost so hosts whose `system.cpu.num` is missing or
  // ZBX_NOTSUPPORTED still get the right divisor from Device.cpuCores
  // (backfilled by scripts/backfill-device-cpu-cores.mjs) or, as a last
  // resort, from a CPU-model lookup. The previous `parseInt(... || "1")`
  // path silently default'd to cores=1, leaving perf_counter values raw
  // — the root cause of the >100% drill-down stacks.
  const numCpuItem = allItems.find((it) => it.key_ === "system.cpu.num");
  const coresResolved = await resolveCoresForHost({
    hostId,
    hostName,
    zabbixItem: numCpuItem,
    prisma,
  });
  const cores = coresResolved.value;

  // chooseTelemetrySources gives us:
  //   - categoryById: itemId → Category for ALL recognised processes
  //   - needsCoresDivision: which itemIds are perf_counter (need /cores)
  // We need three subsets, all derivable from the same map:
  //   - chosen-category items (when the chart category is one of the four)
  //   - retellect items (always — used to classify Retellect ON/OFF per day)
  //   - sysCpu item (only when category === "other", to compute the
  //     `host − monitored` derivation; also fetched whenever it's available
  //     because it's a single tiny extra item)
  const { categoryById, needsCoresDivision } = chooseTelemetrySources(
    allItems.map((it) => ({ itemid: it.itemid, key_: it.key_ })),
  );

  const itemIdsByCategory: Record<HistoryProcessCategory, Set<string>> = {
    retellect: new Set<string>(),
    scoApp: new Set<string>(),
    db: new Set<string>(),
    system: new Set<string>(),
    besclient: new Set<string>(),
    elastic: new Set<string>(),
  };
  for (const [itemid, cat] of categoryById) {
    itemIdsByCategory[cat].add(itemid);
  }

  // sysCpu item — only meaningful when category === "other" (to derive
  // host − sum), but cheap to fetch unconditionally so we always have it
  // available for future "show host CPU as reference line" features.
  const sysCpuItem = allItems.find(
    (it) => it.key_ === "system.cpu.util[,,avg1]" || it.key_ === "system.cpu.util",
  );
  // Kernel-CPU item (host-scope system-mode utilisation). 2026-05-12: SP
  // admin deployed this on testlab_SPUB-P-SCO150 so the "osCore" bucket has
  // a real signal source. Hosts without this item just get an empty osCore
  // series — the chart renders an empty line, which is honest.
  // Same two-source kernel detection as process-history: prefer the host-scope
  // metric (matches the system.cpu.util[,system,*] family — SP admin's testlab
  // item shipped with the avg1 variant 2026-05-15, but other hosts may end up
  // with avg5/avg15 depending on template), fall back to the Process(System)
  // perf_counter. See process-history/route.ts for the full rationale.
  // `sysKernelNeedsCoresDiv` flips on for the fallback path so per-core
  // values get /cores before bucketing.
  const sysKernelHostItem = allItems.find((it) => /^system\.cpu\.util\[,system(,|\])/.test(it.key_));
  const sysKernelProcItem = !sysKernelHostItem
    ? allItems.find((it) => /^perf_counter\["?\\Process\(System\)\\% Processor Time/.test(it.key_))
    : null;
  const sysKernelItem = sysKernelHostItem ?? sysKernelProcItem;
  const sysKernelNeedsCoresDiv = !!sysKernelProcItem;

  // Date window: cover the last `days` days starting at midnight UTC of the
  // earliest day so we capture the full first-day window in Vilnius local.
  // Adding +12h slack on both sides handles DST + clock-drift without risking
  // missing samples at the day boundary.
  const now = Math.floor(Date.now() / 1000);
  const timeFrom = now - days * 86400 - 12 * 3600;
  const timeTill = now;

  const datesInWindow = listDateRange(days);

  // What items do we actually need to hit Zabbix for?
  //   - "Other"    — ALL process-category items (to subtract their sum) PLUS
  //                  sysCpu and the kernel-CPU item (sysKernel feeds osCore).
  //   - "Total CPU" — just sysCpu (host-level CPU utilisation).
  //   - "osCore"   — just the kernel-CPU item.
  //   - Specific process category — just that category's items.
  //   - Retellect items always come along (the ON/OFF classifier needs them
  //     regardless of which series is being charted).
  const itemsToFetch = new Set<string>(itemIdsByCategory.retellect);
  if (category === "other") {
    for (const cat of PROCESS_CATEGORIES) {
      for (const id of itemIdsByCategory[cat]) itemsToFetch.add(id);
    }
    if (sysCpuItem) itemsToFetch.add(sysCpuItem.itemid);
    if (sysKernelItem) itemsToFetch.add(sysKernelItem.itemid);
  } else if (category === "totalCpu") {
    if (sysCpuItem) itemsToFetch.add(sysCpuItem.itemid);
  } else if (category === "osCore") {
    if (sysKernelItem) itemsToFetch.add(sysKernelItem.itemid);
  } else {
    // category is one of the process-backed categories at this point.
    const procCat = category as HistoryProcessCategory;
    for (const id of itemIdsByCategory[procCat]) itemsToFetch.add(id);
  }

  // If we have nothing to fetch we can short-circuit to a fully empty response.
  // The chart will still render the date axis (datesInWindow) but with all
  // zeros and no ON-bands.
  if (itemsToFetch.size === 0) {
    const emptyDays = datesInWindow.map((date) => ({
      date,
      avg: 0,
      peak: 0,
      minutesAbove: 0,
      totalSamples: 0,
      retellectOn: false,
      source: "none" as const,
    }));
    return {
      days: emptyDays,
      summary: compareOnOff([]),
      category,
      threshold,
      daysWindow: days,
      hasData: false,
    };
  }

  // Two parallel data sources, mirroring ZabbixClient.getCpuHistoryDaily:
  //
  //   trend.get — hourly aggregates, retention ~months. ONE batched call
  //     covers all items × all hours. Cheap. Coverage extends past Zabbix's
  //     ~14 d raw-history window, which is the whole point of this fallback.
  //
  //   history.get — raw 1-min samples, retention ~14 d. Per-item, parallelised
  //     at concurrency 24 (per-item rather than batched because a single
  //     batched call's 50k limit clips the older days when 7+ items share it).
  //
  // We merge both sources by day: history takes precedence (sample-level
  // accuracy + supports `minutesAbove` threshold counts); trend fills in
  // for older days that history can't reach.
  const PER_ITEM_LIMIT = 25000;
  const CONCURRENCY = 24;
  const itemIds = Array.from(itemsToFetch);

  // trend.get for ALL items in one call.
  const trendPromise = (async (): Promise<Array<{ itemid: string; clock: string; value_avg: string; value_max: string; value_min: string }>> => {
    try {
      return (await client.request("trend.get", {
        output: ["itemid", "clock", "value_min", "value_avg", "value_max"],
        itemids: itemIds,
        time_from: String(timeFrom),
        time_till: String(timeTill),
        // 100k caps at ~4000 hourly buckets per item × 25 items, more than
        // we'll ever need (365 d × 24 h × 7 items ≈ 60k records).
        limit: 100000,
      })) as Array<{ itemid: string; clock: string; value_avg: string; value_max: string; value_min: string }>;
    } catch (e) {
      console.warn("[rt-process-trend] trend.get failed, will rely on history only:", e);
      return [];
    }
  })();

  // history.get per-item, parallel.
  const fetchOne = async (itemId: string): Promise<Array<{ itemid: string; clock: string; value: string }>> => {
    try {
      return (await client.request("history.get", {
        output: ["itemid", "clock", "value"],
        itemids: [itemId],
        history: 0,
        time_from: String(timeFrom),
        time_till: String(timeTill),
        sortfield: "clock",
        sortorder: "DESC",
        limit: PER_ITEM_LIMIT,
      })) as Array<{ itemid: string; clock: string; value: string }>;
    } catch (e) {
      console.warn(`[rt-process-trend] history.get item ${itemId} failed:`, e);
      return [];
    }
  };
  const historyPromise = (async () => {
    const allResults: Array<Array<{ itemid: string; clock: string; value: string }>> = [];
    for (let i = 0; i < itemIds.length; i += CONCURRENCY) {
      const slice = itemIds.slice(i, i + CONCURRENCY);
      const results = await Promise.all(slice.map(fetchOne));
      for (const r of results) allResults.push(r);
    }
    return allResults;
  })();

  const [trendRecords, batchResults] = await Promise.all([trendPromise, historyPromise]);

  // Bucket by 1-minute window (`clock div 60`) and SUM per-item values inside
  // the same minute. Retellect typically has 3–4 concurrent python workers,
  // each emitting at 1-min cadence on slightly offset seconds. Treating each
  // as an independent sample (and dividing by record count later) would
  // *average* the workers' contributions instead of summing them — making a
  // host where 4 pythons are pinned at 25% each look like 25% retellect when
  // it's actually 100%. Summing-by-minute then averaging across minutes of
  // the day gives the user-meaningful "average total category CPU".
  //
  // For SCO App / DB / System categories there's typically one item per host,
  // so the sum is a no-op — same number you'd get from the existing drill-
  // down endpoint. The semantics only diverge for retellect with multiple
  // python workers, which is the correct direction to diverge.
  //
  // For category === "other", we keep four parallel per-category maps and a
  // sysCpu map. Other = max(0, sysCpu - rt - sa - db - sys) per minute.
  type MinSum = Map<number, number>;
  const perCatByMin: Record<HistoryProcessCategory, MinSum> = {
    retellect: new Map(),
    scoApp: new Map(),
    db: new Map(),
    system: new Map(),
    besclient: new Map(),
    elastic: new Map(),
  };
  const sysCpuByMin: MinSum = new Map();
  const sysKernelByMin: MinSum = new Map();

  for (const records of batchResults) {
    for (const r of records) {
      const itemid = r.itemid;
      const clockSec = parseInt(r.clock);
      const minBucket = Math.floor(clockSec / 60);
      const raw = parseFloat(r.value) || 0;
      // sysCpu is "% of host" already; never needs /cores division.
      if (sysCpuItem && itemid === sysCpuItem.itemid) {
        sysCpuByMin.set(minBucket, raw);
        continue;
      }
      // Kernel CPU (osCore) — host-scope variant is already "% of host",
      // Process(System) variant is "% of one core" → /cores. Stored
      // separately so the "other" derivation can subtract it alongside
      // the process buckets.
      if (sysKernelItem && itemid === sysKernelItem.itemid) {
        const v = sysKernelNeedsCoresDiv ? raw / Math.max(1, cores) : raw;
        sysKernelByMin.set(minBucket, v);
        continue;
      }
      const cat = categoryById.get(itemid);
      if (!cat) continue;
      const v = normaliseValue(raw, needsCoresDivision.has(itemid), cores);
      const map = perCatByMin[cat];
      map.set(minBucket, (map.get(minBucket) ?? 0) + v);
    }
  }

  // Build the chart series.
  //   - Standard categories: read perCatByMin[category].
  //   - "Other": for each minute we have sysCpu for, value =
  //       max(0, sysCpu - sum(perCatByMin[*][min])). Minutes without a
  //       sysCpu sample are dropped (we can't compute "other" without it).
  //   - "Total CPU": sysCpu samples directly (host-level utilisation,
  //       independent of monitored process breakdown).
  const chosenSamples: RawSample[] = [];
  if (category === "other") {
    for (const [min, sysVal] of sysCpuByMin) {
      const rt = perCatByMin.retellect.get(min) ?? 0;
      const sa = perCatByMin.scoApp.get(min) ?? 0;
      const db = perCatByMin.db.get(min) ?? 0;
      const sys = perCatByMin.system.get(min) ?? 0;
      const bes = perCatByMin.besclient.get(min) ?? 0;
      const ela = perCatByMin.elastic.get(min) ?? 0;
      const osc = sysKernelByMin.get(min) ?? 0;
      const other = Math.max(0, sysVal - rt - sa - db - sys - bes - ela - osc);
      chosenSamples.push({ clock: min * 60, value: other });
    }
  } else if (category === "totalCpu") {
    for (const [min, value] of sysCpuByMin) {
      chosenSamples.push({ clock: min * 60, value });
    }
  } else if (category === "osCore") {
    for (const [min, value] of sysKernelByMin) {
      chosenSamples.push({ clock: min * 60, value });
    }
  } else {
    for (const [min, value] of perCatByMin[category as HistoryProcessCategory]) {
      chosenSamples.push({ clock: min * 60, value });
    }
  }

  // Retellect series for ON/OFF classification — always read from python
  // workers regardless of which chart category is active.
  const retellectSamples: RawSample[] = [];
  for (const [min, value] of perCatByMin.retellect) {
    retellectSamples.push({ clock: min * 60, value });
  }

  const chosenByDay = bucketSamplesByDay(chosenSamples);
  const retellectByDay = bucketSamplesByDay(retellectSamples);

  // ── Trend-derived per-day aggregation ─────────────────────────────────
  //
  // history.get only retains ~14 d on this Zabbix. For windows longer than
  // that (timeline period set to 30 d, 60 d, etc.) we fall back to trend.get
  // hourly aggregates. Per (item, hour) we get value_avg + value_max; we
  // then bucket those into per-(category, day) sums and compute daily
  // avg/peak the same way as history-based aggregation, just at hour grain.
  //
  // The merge rule below prefers history when present: on any day where
  // history has samples, we ignore trend (history gives both avg/peak AND
  // the minute-level minutesAbove counter). Trend fills the gap on older
  // days where history is gone.
  //
  // Note: minutesAbove from trend is intentionally NOT computed — the
  // metric is "raw 1-min samples ≥ threshold", which an hourly aggregate
  // can't honestly answer (a 70 % hourly avg might mean any of: 70 % flat
  // for 60 min, or 100 % for 30 min + 40 % for 30 min). We surface
  // null/0 there and the UI shows "—" or skips the metric for those days.
  const fmtVilnius = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Vilnius" });
  // For each (category, day), we accumulate per-hour SUMS across items.
  // perCatTrend[cat][date] = Map<hour-of-period, { avgSum, maxSum }>.
  type HourBucket = { avgSum: number; maxSum: number };
  const perCatTrend: Record<HistoryProcessCategory, Map<string, Map<number, HourBucket>>> = {
    retellect: new Map(),
    scoApp: new Map(),
    db: new Map(),
    system: new Map(),
    besclient: new Map(),
    elastic: new Map(),
  };
  const sysCpuTrend = new Map<string, Map<number, HourBucket>>();
  const sysKernelTrend = new Map<string, Map<number, HourBucket>>();
  for (const t of trendRecords) {
    const itemid = t.itemid;
    const clockSec = parseInt(t.clock);
    const date = fmtVilnius.format(new Date(clockSec * 1000));
    const hourBucket = Math.floor(clockSec / 3600);
    const vAvg = parseFloat(t.value_avg) || 0;
    const vMax = parseFloat(t.value_max) || 0;
    const acc = (target: Map<string, Map<number, HourBucket>>, vA: number, vM: number) => {
      let dayMap = target.get(date);
      if (!dayMap) { dayMap = new Map(); target.set(date, dayMap); }
      const existing = dayMap.get(hourBucket);
      if (existing) { existing.avgSum += vA; existing.maxSum += vM; }
      else { dayMap.set(hourBucket, { avgSum: vA, maxSum: vM }); }
    };
    if (sysCpuItem && itemid === sysCpuItem.itemid) {
      acc(sysCpuTrend, vAvg, vMax);
      continue;
    }
    if (sysKernelItem && itemid === sysKernelItem.itemid) {
      // Process(System) variant needs /cores like other perf_counter items.
      const vA = sysKernelNeedsCoresDiv ? vAvg / Math.max(1, cores) : vAvg;
      const vM = sysKernelNeedsCoresDiv ? vMax / Math.max(1, cores) : vMax;
      acc(sysKernelTrend, vA, vM);
      continue;
    }
    const cat = categoryById.get(itemid);
    if (!cat) continue;
    const vA = normaliseValue(vAvg, needsCoresDivision.has(itemid), cores);
    const vM = normaliseValue(vMax, needsCoresDivision.has(itemid), cores);
    acc(perCatTrend[cat], vA, vM);
  }

  // Pull the per-day {avg, peak} from the trend-bucketed map for the
  // chosen category. For "other" we synthesize per-hour Other = max(0,
  // sysCpu_avg - rt_avg - sa_avg - db_avg - sys_avg) hour-by-hour, then
  // average across hours of the day.
  const trendDayAggregate = (date: string): { avg: number; peak: number; hourCount: number } | null => {
    if (category === "other") {
      const sysDay = sysCpuTrend.get(date);
      if (!sysDay) return null;
      let sumOfHourTotals = 0;
      let peakOfHourMax = 0;
      let hourCount = 0;
      for (const [hour, sysB] of sysDay) {
        const rt  = perCatTrend.retellect.get(date)?.get(hour)?.avgSum ?? 0;
        const sa  = perCatTrend.scoApp.get(date)?.get(hour)?.avgSum ?? 0;
        const db  = perCatTrend.db.get(date)?.get(hour)?.avgSum ?? 0;
        const sys = perCatTrend.system.get(date)?.get(hour)?.avgSum ?? 0;
        const bes = perCatTrend.besclient.get(date)?.get(hour)?.avgSum ?? 0;
        const ela = perCatTrend.elastic.get(date)?.get(hour)?.avgSum ?? 0;
        const osc = sysKernelTrend.get(date)?.get(hour)?.avgSum ?? 0;
        const otherAvg = Math.max(0, sysB.avgSum - rt - sa - db - sys - bes - ela - osc);
        // Peak: hour-max sysCpu minus hour-avg of the rest (we don't have
        // hour-max for category sums, only hour-avg sums; using avg here
        // slightly under-reports peak but never over-reports — safe).
        const otherPeak = Math.max(0, sysB.maxSum - rt - sa - db - sys - bes - ela - osc);
        sumOfHourTotals += otherAvg;
        if (otherPeak > peakOfHourMax) peakOfHourMax = otherPeak;
        hourCount += 1;
      }
      if (hourCount === 0) return null;
      return {
        avg: Math.round((sumOfHourTotals / hourCount) * 10) / 10,
        peak: Math.round(peakOfHourMax * 10) / 10,
        hourCount,
      };
    }
    if (category === "totalCpu") {
      const dayMap = sysCpuTrend.get(date);
      if (!dayMap || dayMap.size === 0) return null;
      let sumOfHourAvgs = 0;
      let peakOfHourMax = 0;
      for (const b of dayMap.values()) {
        sumOfHourAvgs += b.avgSum;
        if (b.maxSum > peakOfHourMax) peakOfHourMax = b.maxSum;
      }
      return {
        avg: Math.round((sumOfHourAvgs / dayMap.size) * 10) / 10,
        peak: Math.round(peakOfHourMax * 10) / 10,
        hourCount: dayMap.size,
      };
    }
    if (category === "osCore") {
      const dayMap = sysKernelTrend.get(date);
      if (!dayMap || dayMap.size === 0) return null;
      let sumOfHourAvgs = 0;
      let peakOfHourMax = 0;
      for (const b of dayMap.values()) {
        sumOfHourAvgs += b.avgSum;
        if (b.maxSum > peakOfHourMax) peakOfHourMax = b.maxSum;
      }
      return {
        avg: Math.round((sumOfHourAvgs / dayMap.size) * 10) / 10,
        peak: Math.round(peakOfHourMax * 10) / 10,
        hourCount: dayMap.size,
      };
    }
    const dayMap = perCatTrend[category as HistoryProcessCategory].get(date);
    if (!dayMap || dayMap.size === 0) return null;
    let sumOfHourTotals = 0;
    let peakOfHourMax = 0;
    for (const b of dayMap.values()) {
      sumOfHourTotals += b.avgSum;
      if (b.maxSum > peakOfHourMax) peakOfHourMax = b.maxSum;
    }
    return {
      avg: Math.round((sumOfHourTotals / dayMap.size) * 10) / 10,
      peak: Math.round(peakOfHourMax * 10) / 10,
      hourCount: dayMap.size,
    };
  };
  const trendIsRetellectOnDay = (date: string): boolean => {
    // Retellect ON when ≥10 % of day-hours have meaningful python activity.
    // Mirrors the helpers' minute-based rule but at hourly grain (≥10 % of
    // 24 hours = at least 3 hours of python activity averaging ≥0.5 %).
    const dayMap = perCatTrend.retellect.get(date);
    if (!dayMap) return false;
    let active = 0;
    for (const b of dayMap.values()) {
      if (b.avgSum >= 0.5) active += 1;
    }
    return (active / 24) * 100 >= 10;
  };

  // Drop the now-redundant per-minute maps so the GC reclaims them while we
  // assemble the per-day output (large hosts can hold 14 d × 1440 min entries).
  for (const cat of PROCESS_CATEGORIES) {
    perCatByMin[cat].clear();
  }
  sysCpuByMin.clear();
  sysKernelByMin.clear();

  const dayResults = datesInWindow.map((date) => {
    // Prefer history (sample-level) when this day has any samples.
    const dayChosen = chosenByDay.get(date) ?? [];
    const dayPython = retellectByDay.get(date) ?? [];
    const histAgg = aggregateDay(dayChosen, threshold);
    if (histAgg.totalSamples > 0) {
      return {
        date,
        avg: histAgg.avg,
        peak: histAgg.peak,
        minutesAbove: histAgg.minutesAbove,
        totalSamples: histAgg.totalSamples,
        retellectOn: isRetellectOnDay(dayPython),
        source: "history" as const,
      };
    }
    // Fall back to trend hourly aggregates for older days.
    const trendAgg = trendDayAggregate(date);
    if (trendAgg) {
      return {
        date,
        avg: trendAgg.avg,
        peak: trendAgg.peak,
        // minutesAbove can't be honestly derived from hourly aggregates —
        // surface 0 and let the UI hide the metric for trend-source days.
        minutesAbove: 0,
        // totalSamples == hourCount so compareOnOff() still includes the day
        // (its filter rule is "totalSamples > 0").
        totalSamples: trendAgg.hourCount,
        retellectOn: trendIsRetellectOnDay(date),
        source: "trend" as const,
      };
    }
    return {
      date,
      avg: 0,
      peak: 0,
      minutesAbove: 0,
      totalSamples: 0,
      retellectOn: false,
      source: "none" as const,
    };
  });

  const summary = compareOnOff(
    dayResults.map((d) => ({
      agg: { date: d.date, avg: d.avg, peak: d.peak, minutesAbove: d.minutesAbove, totalSamples: d.totalSamples },
      retellectOn: d.retellectOn,
    })),
  );

  return {
    days: dayResults,
    summary,
    category,
    threshold,
    daysWindow: days,
    hasData: dayResults.some((d) => d.source !== "none"),
  };
}
