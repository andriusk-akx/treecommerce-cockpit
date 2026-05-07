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
import {
  chooseTelemetrySources,
  normaliseValue,
  type Category,
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
type CategoryEx = Category | "other";
const ALLOWED_CATEGORIES = new Set<CategoryEx>(["retellect", "scoApp", "db", "system", "other"]);

export async function GET(req: NextRequest) {
  const hostId = req.nextUrl.searchParams.get("hostId");
  const daysParam = parseInt(req.nextUrl.searchParams.get("days") || "14", 10);
  const days = Number.isFinite(daysParam) ? Math.max(1, Math.min(14, daysParam)) : 14;
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
  const cacheKey = `rt:procTrend:${hostId}:${days}:${category}:${threshold}`;
  return NextResponse.json(
    await cached(cacheKey, () => buildTrendResponse(hostId, days, category, threshold), 120_000),
  );
}

interface TrendResponse {
  days: Array<{ date: string; avg: number; peak: number; minutesAbove: number; totalSamples: number; retellectOn: boolean }>;
  summary: ReturnType<typeof compareOnOff>;
  category: CategoryEx;
  threshold: number;
  daysWindow: number;
  hasData: boolean;
}

async function buildTrendResponse(
  hostId: string,
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
  const numCpuItem = allItems.find((it) => it.key_ === "system.cpu.num");
  const cores = Math.max(1, parseInt(numCpuItem?.lastvalue || "1") || 1);

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

  const itemIdsByCategory: Record<Category, Set<string>> = {
    retellect: new Set<string>(),
    scoApp: new Set<string>(),
    db: new Set<string>(),
    system: new Set<string>(),
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

  // Date window: cover the last `days` days starting at midnight UTC of the
  // earliest day so we capture the full first-day window in Vilnius local.
  // Adding +12h slack on both sides handles DST + clock-drift without risking
  // missing samples at the day boundary.
  const now = Math.floor(Date.now() / 1000);
  const timeFrom = now - days * 86400 - 12 * 3600;
  const timeTill = now;

  const datesInWindow = listDateRange(days);

  // What items do we actually need to hit Zabbix for?
  //   - "Other" needs ALL category items (to subtract their sum) PLUS sysCpu
  //   - Other categories need just that category's items
  //   - Retellect items always (classifier)
  const itemsToFetch = new Set<string>(itemIdsByCategory.retellect);
  if (category === "other") {
    for (const cat of ["retellect", "scoApp", "db", "system"] as Category[]) {
      for (const id of itemIdsByCategory[cat]) itemsToFetch.add(id);
    }
    if (sysCpuItem) itemsToFetch.add(sysCpuItem.itemid);
  } else {
    for (const id of itemIdsByCategory[category]) itemsToFetch.add(id);
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

  // Per-ITEM history.get, parallelised at concurrency 24 — same pattern as
  // ZabbixClient.getCpuHistoryDaily. Why per-item rather than batched:
  //   - 14 days × 1440 1-min samples = ~20160 per item
  //   - With 7 items in one batch, total 140k samples → silently clipped by
  //     a 50000 limit, losing the older days
  //   - Per-item with 25000 limit covers a comfortable 17 days, no truncation
  //
  // sortorder: DESC + ample limit also matches getCpuHistoryDaily, so the
  // older edge of the window is the part that gets dropped first if anything
  // does — protecting freshness over depth.
  const PER_ITEM_LIMIT = 25000;
  const CONCURRENCY = 24;
  const itemIds = Array.from(itemsToFetch);
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
  const batchResults: Array<Array<{ itemid: string; clock: string; value: string }>> = [];
  for (let i = 0; i < itemIds.length; i += CONCURRENCY) {
    const slice = itemIds.slice(i, i + CONCURRENCY);
    const results = await Promise.all(slice.map(fetchOne));
    for (const r of results) batchResults.push(r);
  }

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
  const perCatByMin: Record<Category, MinSum> = {
    retellect: new Map(),
    scoApp: new Map(),
    db: new Map(),
    system: new Map(),
  };
  const sysCpuByMin: MinSum = new Map();

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
  const chosenSamples: RawSample[] = [];
  if (category === "other") {
    for (const [min, sysVal] of sysCpuByMin) {
      const rt = perCatByMin.retellect.get(min) ?? 0;
      const sa = perCatByMin.scoApp.get(min) ?? 0;
      const db = perCatByMin.db.get(min) ?? 0;
      const sys = perCatByMin.system.get(min) ?? 0;
      const other = Math.max(0, sysVal - rt - sa - db - sys);
      chosenSamples.push({ clock: min * 60, value: other });
    }
  } else {
    for (const [min, value] of perCatByMin[category]) {
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

  // Drop the now-redundant per-minute maps so the GC reclaims them while we
  // assemble the per-day output (large hosts can hold 14 d × 1440 min entries).
  for (const cat of ["retellect", "scoApp", "db", "system"] as Category[]) {
    perCatByMin[cat].clear();
  }
  sysCpuByMin.clear();

  const dayResults = datesInWindow.map((date) => {
    const dayChosen = chosenByDay.get(date) ?? [];
    const dayPython = retellectByDay.get(date) ?? [];
    const agg = aggregateDay(dayChosen, threshold);
    const retellectOn = isRetellectOnDay(dayPython);
    return {
      date,
      avg: agg.avg,
      peak: agg.peak,
      minutesAbove: agg.minutesAbove,
      totalSamples: agg.totalSamples,
      retellectOn,
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
    hasData: chosenSamples.length > 0,
  };
}
