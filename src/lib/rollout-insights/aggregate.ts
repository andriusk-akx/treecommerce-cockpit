/**
 * Pure aggregation logic for Rollout Insights Phase 1.
 *
 * Splits cleanly into three steps so unit tests can target each in
 * isolation:
 *
 *   1. `vilniusHour(tsMs)` — extract Europe/Vilnius hour-of-day from
 *      a Unix millisecond timestamp. The baseline window (02:00–05:00)
 *      is a wall-clock concept; this function is the only place we
 *      convert tz so test setups don't have to mock Date.
 *
 *   2. `computeBaseline(samples)` — median of the host's spss.cpu
 *      samples whose Vilnius hour is in 2/3/4. Returns null when
 *      sample count is below `minBaselineSamples` (30 by default —
 *      roughly 1 minute every 4 days × 14 d = 14 samples min; we
 *      ask for double to insure against noisy data).
 *
 *   3. `aggregateHost(buckets, baseline, threshold)` — iterate buckets,
 *      classify each as active/idle and ON/OFF, accumulate into the
 *      `RolloutPerHostEntry`. Pure: no IO, no global state.
 *
 * Bucket schema is deliberately narrow so the fetcher can emit either
 * 1-min history samples or 60-min trend aggregates through the same
 * pipeline.
 */

import {
  ACTIVE_ABOVE_BUCKETS,
  emptyOnOffAggregate,
  type ActiveAboveBucket,
  type RolloutOnOffAggregate,
  type RolloutPerHostEntry,
  type RolloutSampleSource,
} from "./types";

/**
 * Aligned per-bucket sample for one host. Buckets are aligned to either
 * a 1-min wall-clock minute (source: "history") or a 60-min hour-start
 * (source: "trend"). Missing signals are represented as null so we can
 * tell "agent silent" apart from "agent says 0".
 */
export interface HostBucket {
  /** Unix milliseconds at the start of the bucket. */
  tsMs: number;
  /** 1 for history samples, 60 for hourly trend. */
  weightMinutes: number;
  /** Source provenance — drives the real vs synthetic split downstream. */
  source: RolloutSampleSource;
  /** spss.cpu in this bucket (history sample value, or hour value_avg from trend). */
  spssCpu: number | null;
  /** Sum of all python*.cpu samples in this bucket (history sum, or hour value_avg from trend). */
  retellectCpu: number | null;
  /** system.cpu.util[,,avg1] in this bucket. */
  totalCpu: number | null;
}

/** Default minimum night-window samples to trust the baseline. */
export const MIN_BASELINE_SAMPLES_DEFAULT = 30;

/** Threshold above which a bucket's retellectCpu counts as "Retellect ON". */
export const RETELLECT_ON_CUTOFF_PCT_DEFAULT = 0.5;

/**
 * Compute the Europe/Vilnius hour-of-day (0..23) for a Unix ms timestamp.
 *
 * Uses `Intl.DateTimeFormat` because manual offset math gets EET/EEST
 * (DST) transitions wrong twice a year — and the baseline window spans
 * exactly the night window where Vilnius switches over (03:00 local).
 * We cache the formatter at module scope: instantiation is the slow path,
 * `formatToParts` is cheap.
 */
const VILNIUS_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Vilnius",
  hour: "2-digit",
  hour12: false,
});

export function vilniusHour(tsMs: number): number {
  // formatToParts is faster than format + parse; gives ["02"] etc.
  const parts = VILNIUS_FORMATTER.formatToParts(new Date(tsMs));
  const hourPart = parts.find((p) => p.type === "hour");
  if (!hourPart) return 0;
  // Some locales emit "24" for midnight — normalise to 0.
  const h = parseInt(hourPart.value, 10);
  if (h === 24) return 0;
  return Number.isFinite(h) ? h : 0;
}

/**
 * Median of a numeric array. Returns null on empty input. Pure, allocates
 * a sorted copy so the caller's array is not mutated.
 */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Per-host baseline. Filters to history samples (1-min) inside the
 * night window (02:00, 03:00, 04:00 Vilnius), then takes the median.
 *
 * Why median over mean: night-time CPU on broken hosts has long-tail
 * spikes from Windows Update, antivirus, kernel-level housekeeping.
 * Median ignores those and reports the steady idle floor — which is
 * what we actually want as the "below this = idle" line.
 *
 * Trend buckets are excluded because their hour value is an average
 * across the full hour, blending busy and quiet portions — meaningless
 * as an idle baseline. If a host has no recent history (older than 14
 * days), we treat baseline as unknowable rather than synthesising one
 * from trend data.
 */
export function computeBaseline(
  buckets: HostBucket[],
  minSamples: number = MIN_BASELINE_SAMPLES_DEFAULT,
): { baseline: number | null; sampleCount: number; hasAnySamples: boolean } {
  const nightSpss: number[] = [];
  let totalSamples = 0;
  for (const b of buckets) {
    if (b.source !== "history") continue;
    if (b.spssCpu === null || !Number.isFinite(b.spssCpu)) continue;
    totalSamples++;
    const hour = vilniusHour(b.tsMs);
    if (hour >= 2 && hour < 5) nightSpss.push(b.spssCpu);
  }
  const hasAnySamples = totalSamples > 0;
  if (nightSpss.length < minSamples) {
    return { baseline: null, sampleCount: nightSpss.length, hasAnySamples };
  }
  const m = median(nightSpss);
  return { baseline: m, sampleCount: nightSpss.length, hasAnySamples };
}

/**
 * Aggregate a single host's buckets into the per-host entry. Buckets
 * are assumed already aligned (one per (host, minute or hour)).
 *
 * Algorithm:
 *
 *   • If baseline is null, the host can't be classified — return an
 *     entry with empty ON/OFF aggregates so the UI can still render it
 *     with a "no baseline" badge.
 *
 *   • Per bucket:
 *       - active = spss.cpu > baseline + threshold_pp (strict greater).
 *         Skip if spssCpu is null (signal missing).
 *       - retellect_on = retellectCpu > RETELLECT_ON_CUTOFF_PCT.
 *         Null/missing → treat as OFF (conservative — we'd rather
 *         miss small Retellect activity than mis-attribute pressure).
 *
 *   • Active bucket contributes (totalCpu, retellectCpu, spssCpu) to
 *     the ON or OFF aggregate, weighted by bucket.weightMinutes.
 *     Missing totalCpu is acceptable (we still count the active minute
 *     — the avg will use only buckets where totalCpu is present).
 */
export function aggregateHost(
  hostId: string,
  buckets: HostBucket[],
  thresholdPp: number,
  options: {
    minBaselineSamples?: number;
    retellectOnCutoffPct?: number;
  } = {},
): RolloutPerHostEntry {
  const minSamples = options.minBaselineSamples ?? MIN_BASELINE_SAMPLES_DEFAULT;
  const onCutoff = options.retellectOnCutoffPct ?? RETELLECT_ON_CUTOFF_PCT_DEFAULT;
  const { baseline, sampleCount: baselineSampleCount, hasAnySamples } = computeBaseline(
    buckets,
    minSamples,
  );
  const on = emptyOnOffAggregate();
  const off = emptyOnOffAggregate();
  let totalMinutes = 0;
  if (baseline === null) {
    return {
      hostId,
      baselineSpssCpu: null,
      baselineSampleCount,
      hasAnySamples,
      on,
      off,
      totalMinutes,
    };
  }

  for (const b of buckets) {
    if (b.spssCpu === null || !Number.isFinite(b.spssCpu)) continue;
    totalMinutes += b.weightMinutes;
    const isActive = b.spssCpu > baseline + thresholdPp;
    if (!isActive) continue;
    const retOn = b.retellectCpu !== null && Number.isFinite(b.retellectCpu) && b.retellectCpu > onCutoff;
    const tgt = retOn ? on : off;
    // Real vs synthetic split — drives confidence later.
    if (b.source === "history") tgt.realActiveMinutes += b.weightMinutes;
    else tgt.syntheticActiveMinutes += b.weightMinutes;
    // Weighted accumulators. spss is always present (we just checked);
    // total and retellect may be missing — accumulate only when present
    // so the eventual avg = sum / minutesWithSignal is honest.
    tgt.sumSpssCpu += b.spssCpu * b.weightMinutes;
    if (b.totalCpu !== null && Number.isFinite(b.totalCpu)) {
      tgt.sumTotalCpu += b.totalCpu * b.weightMinutes;
      tgt.peakTotalCpu = tgt.peakTotalCpu === null ? b.totalCpu : Math.max(tgt.peakTotalCpu, b.totalCpu);
      // Active-minutes-above-threshold counters. Strict `>` so a bucket
      // sitting exactly on a threshold edge falls into the next-lower
      // band (consistent with how the legacy heatmap labelled cells).
      for (const t of ACTIVE_ABOVE_BUCKETS) {
        if (b.totalCpu > t) tgt.activeMinutesAboveThreshold[t] += b.weightMinutes;
      }
    }
    if (b.retellectCpu !== null && Number.isFinite(b.retellectCpu)) {
      tgt.sumRetellectCpu += b.retellectCpu * b.weightMinutes;
    }
  }
  return {
    hostId,
    baselineSpssCpu: baseline,
    baselineSampleCount,
    hasAnySamples,
    on,
    off,
    totalMinutes,
  };
}

/**
 * Sum two per-direction aggregates. Used to merge per-host aggregates
 * into class-level (cpu model) aggregates on the client.
 */
export function mergeOnOff(
  a: RolloutOnOffAggregate,
  b: RolloutOnOffAggregate,
): RolloutOnOffAggregate {
  const peak = a.peakTotalCpu === null
    ? b.peakTotalCpu
    : b.peakTotalCpu === null
      ? a.peakTotalCpu
      : Math.max(a.peakTotalCpu, b.peakTotalCpu);
  const mergedAbove = { 50: 0, 60: 0, 70: 0, 80: 0, 90: 0 } as Record<ActiveAboveBucket, number>;
  for (const t of ACTIVE_ABOVE_BUCKETS) {
    mergedAbove[t] = a.activeMinutesAboveThreshold[t] + b.activeMinutesAboveThreshold[t];
  }
  return {
    realActiveMinutes: a.realActiveMinutes + b.realActiveMinutes,
    syntheticActiveMinutes: a.syntheticActiveMinutes + b.syntheticActiveMinutes,
    sumTotalCpu: a.sumTotalCpu + b.sumTotalCpu,
    sumRetellectCpu: a.sumRetellectCpu + b.sumRetellectCpu,
    sumSpssCpu: a.sumSpssCpu + b.sumSpssCpu,
    peakTotalCpu: peak,
    activeMinutesAboveThreshold: mergedAbove,
  };
}

/** Weighted-average helper: returns sum / (total minutes) or null when no data. */
export function weightedAvg(agg: RolloutOnOffAggregate, sumField: keyof Pick<RolloutOnOffAggregate, "sumTotalCpu" | "sumRetellectCpu" | "sumSpssCpu">): number | null {
  const minutes = agg.realActiveMinutes + agg.syntheticActiveMinutes;
  if (minutes === 0) return null;
  return agg[sumField] / minutes;
}
