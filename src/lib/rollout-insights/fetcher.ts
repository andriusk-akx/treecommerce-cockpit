/**
 * Server-side Zabbix fetcher for Rollout Insights Phase 1.
 *
 * Pulls minute-level history (last ~14 d Zabbix retention) plus hourly
 * trend (older days, up to 90 d window) for three signals per host:
 *
 *   • `spss.cpu` — SCO main app, used to classify active vs idle.
 *   • `python*.cpu` — Retellect helpers, summed per bucket. Drives the
 *     ON/OFF per-bucket classification.
 *   • `system.cpu.util[,,avg1]` (or `system.cpu.util`) — total host CPU.
 *
 * Time alignment:
 *   - history samples are rounded down to the minute (`floor(clock/60)*60`).
 *     Multiple python items share the same minute → summed.
 *   - trend samples are rounded down to the hour (`floor(clock/3600)*3600`).
 *     Multiple python items share the same hour → summed value_avg.
 *
 * For days where BOTH history and trend exist (typically last 14 d), we
 * keep the history bucket and drop the overlapping trend bucket. trend
 * is only used as a fallback for older days where history.get has aged
 * out. Bucket emission rule: per hour, if any history minute exists for
 * that hour, drop the trend hour bucket; otherwise keep it. This avoids
 * double-counting on the boundary between trend and history coverage.
 *
 * Layered caching:
 *   • Raw buckets are cached by (hostIds, periodDays) for 5 min, mirroring
 *     the other Zabbix fetch helpers. This is the heavy call (~10–20 s
 *     cold for the Rimi pilot).
 *   • Aggregation is pure, runs per request. Threshold-slider changes
 *     hit the raw cache and re-aggregate in ~50 ms — no Zabbix round-trips.
 */

import type { ZabbixClient } from "../zabbix/client";
import { cached } from "../zabbix/cache";
import type { HostBucket } from "./aggregate";
import { aggregateHost } from "./aggregate";
import type { RolloutPerHostPayload } from "./types";

// Zabbix item key patterns we care about. spss is sometimes registered
// as `sp.sss.cpu` on older templates — we accept both.
const SPSS_KEYS = new Set(["spss.cpu", "sp.sss.cpu"]);
const SYSTEM_KEYS = new Set(["system.cpu.util[,,avg1]", "system.cpu.util"]);
function isPythonKey(key: string): boolean {
  // python.cpu, python1.cpu, python7.cpu …
  return /^python\d*\.cpu$/.test(key);
}

interface ItemReg {
  itemid: string;
  hostid: string;
  key_: string;
}

interface HistoryRow {
  itemid: string;
  clock: string;
  value: string;
}

interface TrendRow {
  itemid: string;
  clock: string;
  value_avg: string;
  value_max: string;
}

const PER_ITEM_HISTORY_LIMIT = 25000; // 14 d × 1440 min = 20 160 — fits
const HISTORY_CONCURRENCY = 24;
const TREND_BATCH = 40; // same as getRetellectActiveInPeriodHostIds to avoid silent truncation

/** Convert clock seconds to a wall-clock minute-aligned ms timestamp. */
function alignToMinuteMs(clockSec: number): number {
  return Math.floor(clockSec / 60) * 60 * 1000;
}
/** Convert clock seconds to a wall-clock hour-aligned ms timestamp. */
function alignToHourMs(clockSec: number): number {
  return Math.floor(clockSec / 3600) * 3600 * 1000;
}

/**
 * Raw per-host bucket arrays — the heavy-to-compute payload that gets
 * cached. Aggregation is a separate, threshold-aware pass on top.
 */
export interface RawRolloutBuckets {
  /** Window length in days that produced these buckets (1..90). */
  periodDays: number;
  /** Aligned per-host bucket arrays — feed straight into aggregateHost(). */
  perHostBuckets: Array<{ hostId: string; buckets: HostBucket[] }>;
  /** ISO timestamp when the raw fetch resolved. */
  generatedAt: string;
}

/**
 * Heavy path: query Zabbix for history+trend, align into per-host bucket
 * lists. Cached by (hostIds, periodDays) — does NOT depend on threshold,
 * so threshold-slider changes re-use this result and skip the round-trip.
 */
export async function fetchRolloutRawBuckets(
  client: ZabbixClient,
  matchedHostIds: string[],
  periodDays: number,
): Promise<RawRolloutBuckets> {
  const safeDays = Math.max(1, Math.min(periodDays, 90));
  if (matchedHostIds.length === 0) {
    return { periodDays: safeDays, perHostBuckets: [], generatedAt: new Date().toISOString() };
  }
  const cacheKey = `rolloutInsights:rawBuckets:v1:${safeDays}d:${matchedHostIds.slice().sort().join(",")}`;
  // 5-min TTL — same cadence as getRetellectActiveInPeriodHostIds. Reflects
  // how often the underlying minute samples can meaningfully shift: <5 min
  // means we're paying Zabbix round-trips faster than the data changes.
  return cached(cacheKey, () => _fetchRolloutRawBucketsUncached(client, matchedHostIds, safeDays), 5 * 60_000);
}

async function _fetchRolloutRawBucketsUncached(
  client: ZabbixClient,
  matchedHostIds: string[],
  safeDays: number,
): Promise<RawRolloutBuckets> {
  // Step 1: discover the three item families across all hosts in parallel.
  // Zabbix's `search` filter doesn't accept comma-separated terms, so we
  // need separate calls.
  const [allCpuItems, sysItems] = await Promise.all([
    client.request("item.get", {
      output: ["itemid", "hostid", "key_"],
      hostids: matchedHostIds,
      search: { key_: ".cpu" },
      filter: { status: 0 },
    }) as Promise<ItemReg[]>,
    client.request("item.get", {
      output: ["itemid", "hostid", "key_"],
      hostids: matchedHostIds,
      search: { key_: "system.cpu.util" },
      filter: { status: 0 },
    }) as Promise<ItemReg[]>,
  ]);

  const spssItems = allCpuItems.filter((it) => SPSS_KEYS.has(it.key_));
  const pythonItems = allCpuItems.filter((it) => isPythonKey(it.key_));
  // Prefer system.cpu.util[,,avg1] when present; fall back to system.cpu.util.
  // Per host, keep only the first matching variant (Zabbix usually
  // configures exactly one).
  const sysItemByHost = new Map<string, ItemReg>();
  for (const it of sysItems) {
    if (!SYSTEM_KEYS.has(it.key_)) continue;
    const existing = sysItemByHost.get(it.hostid);
    if (!existing) {
      sysItemByHost.set(it.hostid, it);
    } else if (existing.key_ === "system.cpu.util" && it.key_ === "system.cpu.util[,,avg1]") {
      sysItemByHost.set(it.hostid, it); // upgrade to the preferred variant
    }
  }
  const systemItems = Array.from(sysItemByHost.values());

  // Reverse lookup itemId → (hostId, kind) for both fetch passes.
  type ItemKind = "spss" | "python" | "system";
  const itemMeta = new Map<string, { hostId: string; kind: ItemKind }>();
  for (const it of spssItems) itemMeta.set(it.itemid, { hostId: it.hostid, kind: "spss" });
  for (const it of pythonItems) itemMeta.set(it.itemid, { hostId: it.hostid, kind: "python" });
  for (const it of systemItems) itemMeta.set(it.itemid, { hostId: it.hostid, kind: "system" });

  const allItemIds = Array.from(itemMeta.keys());
  if (allItemIds.length === 0) {
    return { periodDays: safeDays, perHostBuckets: [], generatedAt: new Date().toISOString() };
  }

  // Per-host minute accumulators (history) and hour accumulators (trend).
  type MinAcc = {
    spssCpu: number | null;
    retellectCpu: number; // running sum of python.cpu samples in this minute
    sawPython: boolean;   // distinguish "0 % retellect" from "no python signal at all"
    totalCpu: number | null;
  };
  type HourAcc = MinAcc & { /** Set when any of the three signals contributed a value_avg. */ hasData: boolean };

  const minuteBucketsByHost = new Map<string, Map<number, MinAcc>>();
  const hourBucketsByHost = new Map<string, Map<number, HourAcc>>();

  // Step 2: history.get for last 14 days. Zabbix trend.get retention is
  // longer than history.get (~47 d vs 14 d) on this deployment, so for
  // windows beyond 14 d we splice trend on top of history. The dedup pass
  // below drops trend hours that overlap any history minute.
  const historyTimeFrom = Math.floor(Date.now() / 1000) - Math.min(safeDays, 14) * 24 * 3600;
  const fetchOneHistory = async (itemId: string): Promise<HistoryRow[]> => {
    try {
      return (await client.request("history.get", {
        output: ["itemid", "clock", "value"],
        itemids: [itemId],
        history: 0, // float
        time_from: String(historyTimeFrom),
        sortfield: "clock",
        sortorder: "DESC",
        limit: PER_ITEM_HISTORY_LIMIT,
      })) as HistoryRow[];
    } catch (e) {
      // Swallow per-item failures (e.g. item.state=1 broken). They'd
      // otherwise cancel the whole pilot's history fetch.
      console.warn(`[rollout-insights] history.get item ${itemId} failed:`, e);
      return [];
    }
  };
  for (let i = 0; i < allItemIds.length; i += HISTORY_CONCURRENCY) {
    const slice = allItemIds.slice(i, i + HISTORY_CONCURRENCY);
    const results = await Promise.all(slice.map(fetchOneHistory));
    for (const rows of results) {
      for (const r of rows) {
        const meta = itemMeta.get(r.itemid);
        if (!meta) continue;
        const tsMs = alignToMinuteMs(parseInt(r.clock, 10));
        let perHost = minuteBucketsByHost.get(meta.hostId);
        if (!perHost) { perHost = new Map(); minuteBucketsByHost.set(meta.hostId, perHost); }
        let bkt = perHost.get(tsMs);
        if (!bkt) {
          bkt = { spssCpu: null, retellectCpu: 0, sawPython: false, totalCpu: null };
          perHost.set(tsMs, bkt);
        }
        const v = parseFloat(r.value);
        if (!Number.isFinite(v)) continue;
        if (meta.kind === "spss") bkt.spssCpu = v;
        else if (meta.kind === "python") { bkt.retellectCpu += Math.max(0, v); bkt.sawPython = true; }
        else if (meta.kind === "system") bkt.totalCpu = v;
      }
    }
  }

  // Step 3: trend.get over the full window. Batched to avoid silent
  // truncation (40-item batches; see getRetellectActiveInPeriodHostIds
  // for the canonical incident).
  if (safeDays > 0) {
    const trendTimeFrom = Math.floor(Date.now() / 1000) - safeDays * 24 * 3600;
    const batches: string[][] = [];
    for (let i = 0; i < allItemIds.length; i += TREND_BATCH) {
      batches.push(allItemIds.slice(i, i + TREND_BATCH));
    }
    for (const batch of batches) {
      let trendRows: TrendRow[];
      try {
        trendRows = (await client.request("trend.get", {
          output: ["itemid", "clock", "value_avg", "value_max"],
          itemids: batch,
          time_from: String(trendTimeFrom),
          // 40 items × 90 d × 24 h = 86 400 max — well under 200 k cap.
          limit: 200000,
        })) as TrendRow[];
      } catch (e) {
        console.warn("[rollout-insights] trend.get batch failed:", e);
        continue;
      }
      for (const r of trendRows) {
        const meta = itemMeta.get(r.itemid);
        if (!meta) continue;
        const tsMs = alignToHourMs(parseInt(r.clock, 10));
        let perHost = hourBucketsByHost.get(meta.hostId);
        if (!perHost) { perHost = new Map(); hourBucketsByHost.set(meta.hostId, perHost); }
        let bkt = perHost.get(tsMs);
        if (!bkt) {
          bkt = { spssCpu: null, retellectCpu: 0, sawPython: false, totalCpu: null, hasData: false };
          perHost.set(tsMs, bkt);
        }
        const v = parseFloat(r.value_avg);
        if (!Number.isFinite(v)) continue;
        bkt.hasData = true;
        if (meta.kind === "spss") bkt.spssCpu = v;
        else if (meta.kind === "python") { bkt.retellectCpu += Math.max(0, v); bkt.sawPython = true; }
        else if (meta.kind === "system") bkt.totalCpu = v;
      }
    }
  }

  // Step 4: dedup hour buckets against history minute coverage, then
  // emit unified HostBucket arrays per host.
  const allHostIdsTouched = new Set<string>([
    ...minuteBucketsByHost.keys(),
    ...hourBucketsByHost.keys(),
  ]);
  const perHostBuckets: RawRolloutBuckets["perHostBuckets"] = [];
  for (const hostId of allHostIdsTouched) {
    const minutes = minuteBucketsByHost.get(hostId) ?? new Map<number, MinAcc>();
    const hours = hourBucketsByHost.get(hostId) ?? new Map<number, HourAcc>();
    const coveredHours = new Set<number>();
    for (const tsMs of minutes.keys()) {
      coveredHours.add(alignToHourMs(Math.floor(tsMs / 1000)));
    }
    const buckets: HostBucket[] = [];
    for (const [tsMs, acc] of minutes) {
      buckets.push({
        tsMs,
        weightMinutes: 1,
        source: "history",
        spssCpu: acc.spssCpu,
        retellectCpu: acc.sawPython ? acc.retellectCpu : null,
        totalCpu: acc.totalCpu,
      });
    }
    for (const [tsMs, acc] of hours) {
      if (coveredHours.has(tsMs)) continue;
      if (!acc.hasData) continue;
      buckets.push({
        tsMs,
        weightMinutes: 60,
        source: "trend",
        spssCpu: acc.spssCpu,
        retellectCpu: acc.sawPython ? acc.retellectCpu : null,
        totalCpu: acc.totalCpu,
      });
    }
    perHostBuckets.push({ hostId, buckets });
  }
  return {
    periodDays: safeDays,
    perHostBuckets,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Thin wrapper: pulls cached raw buckets, runs aggregateHost per host
 * at the given threshold, returns the wire-ready payload.
 */
export async function fetchRolloutPerHost(
  client: ZabbixClient,
  matchedHostIds: string[],
  periodDays: number,
  thresholdPp: number,
): Promise<RolloutPerHostPayload> {
  const raw = await fetchRolloutRawBuckets(client, matchedHostIds, periodDays);
  return aggregateRawBuckets(raw, thresholdPp);
}

/**
 * Pure: turn the cached raw payload into a per-host aggregate at the
 * specified threshold. Cheap (~50 ms on a 111-host pilot), so slider
 * changes can call this without re-hitting Zabbix.
 */
export function aggregateRawBuckets(
  raw: RawRolloutBuckets,
  thresholdPp: number,
): RolloutPerHostPayload {
  const perHost = raw.perHostBuckets.map(({ hostId, buckets }) =>
    aggregateHost(hostId, buckets, thresholdPp),
  );
  return {
    activeThresholdPp: thresholdPp,
    periodDays: raw.periodDays,
    generatedAt: raw.generatedAt,
    perHost,
  };
}
