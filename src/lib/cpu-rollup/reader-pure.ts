/**
 * Pure (testable) reader helpers. Reader's hot path queries Prisma + Zabbix
 * which need mocks; everything in here is deterministic given inputs.
 */

const HISTORY_GRAIN_DAYS = 14;

/** Compute the Unix-second timestamp of today's Vilnius local midnight.
 *  Takes `now` as a parameter so tests can pin a deterministic clock. */
export function todayMidnightVilniusUnix(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Vilnius",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  let y = "", m = "", d = "";
  for (const p of parts) {
    if (p.type === "year") y = p.value;
    else if (p.type === "month") m = p.value;
    else if (p.type === "day") d = p.value;
  }
  const guessUtc = Date.UTC(Number(y), Number(m) - 1, Number(d));
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

/** Compute the DB-vs-Zabbix split point. Same logic as `computeCutoffSec`
 *  but accepts an injected `now` for tests. */
export function computeCutoffSec(now: Date = new Date()): number {
  return todayMidnightVilniusUnix(now) - HISTORY_GRAIN_DAYS * 86_400;
}

/** Decide which window slices apply to a hybrid read.
 *  Returns the boundaries used in `readCpuHistoryHybrid`. */
export function splitHybridWindow(
  fromSec: number,
  toSec: number,
  now: Date = new Date(),
): { dbFromSec: number; dbToSec: number; zabbixFromSec: number; zabbixToSec: number } {
  const cutoff = computeCutoffSec(now);
  return {
    dbFromSec: fromSec,
    dbToSec: Math.min(toSec, cutoff),
    zabbixFromSec: Math.max(fromSec, cutoff),
    zabbixToSec: toSec,
  };
}

/** Classify dataQuality from a sourceBreakdown. Matches the logic in
 *  `inferDataQuality` over in the Compare API. */
export type DataQuality = "full" | "trend-only" | "partial-missing";

export function dataQualityFromBreakdown(bd: {
  zabbix: number;
  rollupHistory: number;
  rollupTrend: number;
}): DataQuality {
  const total = bd.zabbix + bd.rollupHistory + bd.rollupTrend;
  if (total === 0) return "partial-missing";
  if (bd.zabbix > 0 || bd.rollupHistory > 0) return "full";
  return "trend-only";
}
