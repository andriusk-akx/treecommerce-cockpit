/**
 * Pure helpers for the per-host "Process trend" card under the CPU Timeline
 * heatmap. Extracted so the math is unit-testable without spinning up Next.js
 * or mocking Zabbix.
 *
 * The card answers a single question: "for this host, what did the chosen
 * process's daily CPU look like across the last 14 days, and how does that
 * compare with whether Retellect was running on the same days?"
 *
 * Three pieces of logic live here:
 *
 *   1. `bucketSamplesByDay` — group raw 1-min samples by Europe/Vilnius
 *      calendar date (the cockpit's working timezone, same convention as
 *      `getCpuHistoryDaily` in the Zabbix client).
 *   2. `aggregateDay` — produce avg / peak / minutes-above-threshold for
 *      one day's samples.
 *   3. `isRetellectOnDay` — classify the day as Retellect ON when ≥10% of
 *      the day's expected sample windows have python.cpu samples present.
 *      The threshold is the gap-tolerance the spec landed on after a
 *      design pass (memory: project_rt_process_trend.md).
 *
 * The component layers `compareOnOff` on top to derive the A/B summary
 * (avg ON · avg OFF · Δ pp).
 */

export interface RawSample {
  /** Unix epoch seconds. */
  clock: number;
  /** % of host CPU at this sample. */
  value: number;
}

export interface DayAggregate {
  /** YYYY-MM-DD in Europe/Vilnius. */
  date: string;
  /** Mean of the day's samples (one decimal). */
  avg: number;
  /** Max sample seen that day (one decimal). */
  peak: number;
  /** Count of samples ≥ threshold. */
  minutesAbove: number;
  /** Total raw samples for the day. Drives ON/OFF coverage check. */
  totalSamples: number;
}

/**
 * Group samples into a Map keyed by local-date (Europe/Vilnius). Same date
 * convention as `ZabbixClient.getCpuHistoryDaily` so the card's day-axis
 * lines up exactly with the heatmap's columns.
 *
 * The `Intl.DateTimeFormat("en-CA")` trick yields YYYY-MM-DD in any TZ.
 */
export function bucketSamplesByDay(samples: RawSample[]): Map<string, RawSample[]> {
  const out = new Map<string, RawSample[]>();
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Vilnius" });
  for (const s of samples) {
    const date = fmt.format(new Date(s.clock * 1000));
    let bucket = out.get(date);
    if (!bucket) {
      bucket = [];
      out.set(date, bucket);
    }
    bucket.push(s);
  }
  return out;
}

/**
 * Aggregate one day's samples to (avg, peak, minutesAbove, totalSamples).
 *
 * `threshold` is inclusive (sample.value ≥ threshold counts). Returns zeros
 * for an empty input rather than NaN.
 */
export function aggregateDay(samples: RawSample[], threshold: number): DayAggregate {
  if (samples.length === 0) {
    return { date: "", avg: 0, peak: 0, minutesAbove: 0, totalSamples: 0 };
  }
  let sum = 0;
  let peak = -Infinity;
  let above = 0;
  for (const s of samples) {
    sum += s.value;
    if (s.value > peak) peak = s.value;
    if (s.value >= threshold) above += 1;
  }
  return {
    date: "",
    avg: Math.round((sum / samples.length) * 10) / 10,
    peak: Math.round(peak * 10) / 10,
    minutesAbove: above,
    totalSamples: samples.length,
  };
}

/**
 * Decide whether Retellect was running on the host on a given day.
 *
 * Rule: ON when at least `minPctCoverage` percent of the day's expected
 * sample windows have a python.cpu sample present. Default 10% covers the
 * "Retellect was active for at least 2.4 hours" floor — long enough that an
 * agent gap (a few minutes here and there) doesn't flip the bit, short
 * enough that a partial-day rollout/rollback still registers.
 *
 * `expectedMinutesPerDay` defaults to 1440 (one sample per minute).
 * `minSampleValue` (default 0.5%) filters out near-zero noise samples that
 * Zabbix sometimes emits when a process exists but is doing nothing —
 * present-but-idle should NOT count as Retellect running.
 */
export function isRetellectOnDay(
  pythonSamples: RawSample[],
  opts: { minPctCoverage?: number; expectedMinutesPerDay?: number; minSampleValue?: number } = {},
): boolean {
  const minPct = opts.minPctCoverage ?? 10;
  const expected = opts.expectedMinutesPerDay ?? 1440;
  const minVal = opts.minSampleValue ?? 0.5;
  if (expected <= 0) return false;
  let active = 0;
  for (const s of pythonSamples) {
    if (s.value >= minVal) active += 1;
  }
  return (active / expected) * 100 >= minPct;
}

/**
 * Build the A/B compare summary from per-day aggregates + ON/OFF flags.
 *
 * Deltas: `deltaPp` is signed — negative means CPU dropped when Retellect
 * was ON (the win we're hoping to see), positive means CPU went UP. `deltaRel`
 * is delta as a percentage of the OFF baseline so a 30 → 27 % drop reports
 * as −10% relative; clamps to 0 when OFF baseline is 0 to avoid NaN.
 *
 * If a side has no days, its avg/peak come back as `null` (not 0) so the UI
 * can render "—" instead of misleading zeros.
 */
export interface CompareSummary {
  onCount: number;
  offCount: number;
  onAvg: number | null;
  onPeak: number | null;
  offAvg: number | null;
  offPeak: number | null;
  deltaPp: number | null;
  deltaRel: number | null;
}

export function compareOnOff(
  days: Array<{ agg: DayAggregate; retellectOn: boolean }>,
): CompareSummary {
  let onSum = 0, onPeak = -Infinity, onN = 0;
  let offSum = 0, offPeak = -Infinity, offN = 0;
  for (const d of days) {
    if (d.agg.totalSamples === 0) continue;
    if (d.retellectOn) {
      onSum += d.agg.avg;
      if (d.agg.peak > onPeak) onPeak = d.agg.peak;
      onN += 1;
    } else {
      offSum += d.agg.avg;
      if (d.agg.peak > offPeak) offPeak = d.agg.peak;
      offN += 1;
    }
  }
  const onAvg = onN > 0 ? Math.round((onSum / onN) * 10) / 10 : null;
  const offAvg = offN > 0 ? Math.round((offSum / offN) * 10) / 10 : null;
  const onPeakOut = onN > 0 ? Math.round(onPeak * 10) / 10 : null;
  const offPeakOut = offN > 0 ? Math.round(offPeak * 10) / 10 : null;
  let deltaPp: number | null = null;
  let deltaRel: number | null = null;
  if (onAvg !== null && offAvg !== null) {
    deltaPp = Math.round((onAvg - offAvg) * 10) / 10;
    if (offAvg > 0) {
      deltaRel = Math.round(((onAvg - offAvg) / offAvg) * 1000) / 10;
    } else {
      deltaRel = 0;
    }
  }
  return {
    onCount: onN,
    offCount: offN,
    onAvg,
    onPeak: onPeakOut,
    offAvg,
    offPeak: offPeakOut,
    deltaPp,
    deltaRel,
  };
}

/**
 * Build the list of date strings (YYYY-MM-DD, Europe/Vilnius) covering the
 * last `days` days, oldest-first. Used by the API route to fill empty days
 * (no samples → date present, totalSamples=0) so the chart's x-axis always
 * has the full window even when the host has gaps.
 */
export function listDateRange(daysBack: number, now: Date = new Date()): string[] {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Vilnius" });
  const out: string[] = [];
  const oneDayMs = 24 * 60 * 60 * 1000;
  for (let i = daysBack - 1; i >= 0; i--) {
    out.push(fmt.format(new Date(now.getTime() - i * oneDayMs)));
  }
  return out;
}
