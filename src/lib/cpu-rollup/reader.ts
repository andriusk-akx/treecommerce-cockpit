/**
 * Hybrid CPU history reader. Phase 4 of AKpilot spec v2.1.
 *
 * Picks where each day's data lives:
 *   - Recent dates (≤ HISTORY_GRAIN_DAYS): fetch live from Zabbix
 *     because the rollup may not have run yet for today and Zabbix
 *     still has minute-resolution samples.
 *   - Older dates (> HISTORY_GRAIN_DAYS): read from the DB rollup
 *     tables, which retain data beyond Zabbix's own window.
 *
 * Cross-boundary windows split into two fetches and merge the results.
 * Same return shape as `client.getCpuHistoryForRange()` so existing
 * callers (Compare, Timeline, Rollout Insights) need only swap the
 * import and pass an extra `pilotId` for the DB query.
 */
import { prisma } from "@/lib/db";
import { getZabbixClient } from "@/lib/zabbix/client";

/** How recent a date has to be to prefer the live Zabbix path. Matches
 *  the Zabbix history.get retention floor; above that, the rollup is the
 *  source of truth. */
const HISTORY_GRAIN_DAYS = 14;

/** Same shape as getCpuHistoryForRange's `daily` entries. */
export interface DailyAggregate {
  hostId: string;
  date: string;
  max: number;
  avg: number;
  min: number;
  minutesAbove: { 20: number; 30: number; 40: number; 50: number; 60: number; 70: number; 80: number; 90: number };
  totalSamples: number;
}

/** Raw sample shape. From Zabbix for recent dates; reconstructed from
 *  hourly rollup rows for older dates (synthesised — see assembleSamples). */
export interface RawSample {
  hostId: string;
  clockSec: number;
  value: number;
}

export interface ReaderResult {
  daily: DailyAggregate[];
  samples: RawSample[];
  /** Where each daily row came from — useful for diagnostics + dataQuality. */
  sourceBreakdown: { zabbix: number; rollupHistory: number; rollupTrend: number };
}

interface ReadOptions {
  pilotId: string;
  itemIds: string[];
  itemHostMap: Map<string, string>;
  fromSec: number;
  toSec: number;
  /** Optional Zabbix host id allowlist. When set, DB queries only return
   *  rows for these hosts — wastes less IO when the caller already
   *  narrowed the fleet (e.g. via CPU model filter). When omitted,
   *  returns all the pilot's rows in the window (matches the live
   *  Zabbix path's "you asked for X items, you get X items" semantics). */
  hostIdAllowlist?: Set<string>;
}

function todayMidnightVilniusUnix(): number {
  const today = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Vilnius",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(today);
  let y = "", m = "", d = "";
  for (const p of parts) {
    if (p.type === "year") y = p.value;
    else if (p.type === "month") m = p.value;
    else if (p.type === "day") d = p.value;
  }
  // Convert to unix at midnight Vilnius local.
  const guessUtc = Date.UTC(Number(y), Number(m) - 1, Number(d));
  // Vilnius is UTC+2/+3 → midnight Vilnius is 21:00 or 22:00 the previous UTC day.
  for (const off of [-3, -2]) {
    const candidate = guessUtc + off * 3600 * 1000;
    const check = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Vilnius",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", hour12: false,
    }).formatToParts(new Date(candidate));
    let cy = "", cm = "", cd = "", ch = "";
    for (const p of check) {
      if (p.type === "year") cy = p.value;
      else if (p.type === "month") cm = p.value;
      else if (p.type === "day") cd = p.value;
      else if (p.type === "hour") ch = p.value;
    }
    if (cy === y && cm === m && cd === d && (ch === "00" || ch === "24")) {
      return Math.floor(candidate / 1000);
    }
  }
  return Math.floor(guessUtc / 1000);
}

/**
 * Decide split point. Anything before `cutoffSec` reads from rollup;
 * after reads from Zabbix. The cutoff is HISTORY_GRAIN_DAYS days before
 * today's Vilnius midnight.
 */
function computeCutoffSec(): number {
  return todayMidnightVilniusUnix() - HISTORY_GRAIN_DAYS * 86_400;
}

/**
 * Hybrid read.
 */
export async function readCpuHistoryHybrid(opts: ReadOptions): Promise<ReaderResult> {
  const { pilotId, itemIds, itemHostMap, fromSec, toSec, hostIdAllowlist } = opts;
  const cutoffSec = computeCutoffSec();

  // Three windows:
  //   [fromSec, oldEnd) → DB rollup
  //   [oldEnd, toSec)   → Zabbix
  // where oldEnd = min(toSec, cutoffSec).
  const oldEnd = Math.min(toSec, cutoffSec);
  const newStart = Math.max(fromSec, cutoffSec);

  const breakdown = { zabbix: 0, rollupHistory: 0, rollupTrend: 0 };
  const daily: DailyAggregate[] = [];
  const samples: RawSample[] = [];

  // ── DB rollup portion ────────────────────────────────────────────
  if (fromSec < oldEnd) {
    // Fix #1: derive Vilnius local date strings for the bounds. The
    // writer stores each Vilnius local day as `new Date("YYYY-MM-DD"
    // + "T00:00:00Z")` — i.e. UTC midnight that shares the date string.
    // If we read by `dateOnly(new Date(fromSec * 1000))` instead, we
    // get the UTC date of a Vilnius-midnight unix timestamp, which is
    // the PREVIOUS day. Result: query returns rows for the day before
    // fromIso and Compare KPI totals over-count one extra day per host.
    const fromVilniusDate = vilniusDateString(fromSec);
    const toVilniusDate = vilniusDateString(oldEnd - 1);
    const dailyWhere: {
      pilotId: string;
      date: { gte: Date; lte: Date };
      zHostId?: { in: string[] };
    } = {
      pilotId,
      date: {
        gte: new Date(`${fromVilniusDate}T00:00:00Z`),
        lte: new Date(`${toVilniusDate}T00:00:00Z`),
      },
    };
    // Fix #8: narrow to the caller's host allowlist when supplied.
    if (hostIdAllowlist && hostIdAllowlist.size > 0) {
      dailyWhere.zHostId = { in: Array.from(hostIdAllowlist) };
    }
    const dailyRows = await prisma.cpuMetricDaily.findMany({
      where: dailyWhere,
      orderBy: { date: "asc" },
    });
    for (const r of dailyRows) {
      daily.push({
        hostId: r.zHostId,
        date: isoDate(r.date),
        max: r.cpuMax,
        avg: r.cpuAvg,
        min: r.cpuMin,
        minutesAbove: {
          20: r.minutesAbove20,
          30: r.minutesAbove30,
          40: r.minutesAbove40,
          50: r.minutesAbove50,
          60: r.minutesAbove60,
          70: r.minutesAbove70,
          80: r.minutesAbove80,
          90: r.minutesAbove90,
        },
        totalSamples: r.totalSamples,
      });
      if (r.source === "trend") breakdown.rollupTrend += 1;
      else breakdown.rollupHistory += 1;
    }

    // Reconstruct raw-ish samples from hourly rollup so the overlay
    // chart still has something to plot for old dates. We can't
    // recover minute-level data, so emit one synthetic sample per
    // hour at hourStart + 30min carrying the hour-mean CPU value.
    const hourlyWhere: {
      pilotId: string;
      hourStart: { gte: Date; lt: Date };
      zHostId?: { in: string[] };
    } = {
      pilotId,
      hourStart: { gte: new Date(fromSec * 1000), lt: new Date(oldEnd * 1000) },
    };
    // Fix #9: same host narrowing for hourly query.
    if (hostIdAllowlist && hostIdAllowlist.size > 0) {
      hourlyWhere.zHostId = { in: Array.from(hostIdAllowlist) };
    }
    const hourlyRows = await prisma.cpuMetricHourly.findMany({
      where: hourlyWhere,
      orderBy: { hourStart: "asc" },
    });
    for (const h of hourlyRows) {
      samples.push({
        hostId: h.zHostId,
        clockSec: Math.floor(h.hourStart.getTime() / 1000) + 30 * 60,
        value: h.cpuAvg,
      });
    }
  }

  // ── Live Zabbix portion ──────────────────────────────────────────
  if (newStart < toSec && itemIds.length > 0) {
    const client = getZabbixClient();
    const live = await client.getCpuHistoryForRange(itemIds, itemHostMap, newStart, toSec);
    daily.push(...live.daily);
    samples.push(...live.samples);
    breakdown.zabbix += live.daily.length;
  }

  return { daily, samples, sourceBreakdown: breakdown };
}

/** Return the Vilnius local YYYY-MM-DD date for a Unix-second timestamp.
 *  Mirrors the writer's `localDate` so reader bounds round-trip exactly. */
function vilniusDateString(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleDateString("en-CA", { timeZone: "Europe/Vilnius" });
}

/** Format YYYY-MM-DD from a Date that already represents a calendar day. */
function isoDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
