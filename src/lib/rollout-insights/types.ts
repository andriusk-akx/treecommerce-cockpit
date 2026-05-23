/**
 * Rollout Insights — Phase 1 types (minute-level analytics, no archive).
 *
 * The matrix on the Rollout Insights page used to be computed entirely on
 * the client from snapshot fields (procCpu lastvalue, daily cpuTrends max).
 * That ignored two things the leadership-grade decision needs:
 *
 *   1. **Activity context.** Idle-host averages dilute the comparison —
 *      a Retellect-ON host that spends 90 % of the day at 1 % CPU looks
 *      similar to an OFF host that does the same. To measure Retellect's
 *      CPU pressure we must restrict the aggregate to active minutes (the
 *      busy windows where SCO is actually serving transactions).
 *
 *   2. **Per-host baseline.** "Active" cannot be a single global %
 *      because hosts vary by hardware tier — a Pentium SCO at 18 % spss
 *      may be working hard while an i5 at 18 % is barely warm. Each host
 *      gets its own night-time baseline (median spss.cpu 02:00–05:00
 *      Europe/Vilnius) and "active" = `spss.cpu > baseline + N pp`.
 *
 * The server fetches minute-level history (last ~14 d Zabbix retention)
 * plus hourly trend (older days, normalised to 60 synthetic minutes per
 * hour bucket) and produces `RolloutPerHost` — small enough to ship to
 * the client (<10 KB even on Rimi's 111-host pilot) and large enough to
 * preserve the active-minute split needed by the matrix.
 *
 * Phase 2 (deferred): persisted minute archive + LLM-driven driver
 * decomposition. Phase 1 carries only what the matrix needs, no history
 * beyond Zabbix's retention window.
 */

/** Source provenance for an aggregated bucket. */
export type RolloutSampleSource = "history" | "trend";

/**
 * Per-host per-direction (ON / OFF) aggregate over the selected period.
 *
 * Each field carries weight in MINUTES so on/off can be summed across
 * hosts to produce class-level (cpu_model) aggregates client-side
 * without losing information:
 *
 *   • `realActiveMinutes`     — count of true 1-min `history.get` samples
 *                               that classified as active under the chosen
 *                               threshold. Drives the confidence band.
 *   • `syntheticActiveMinutes`— count of synthesised minutes coming from
 *                               hourly `trend.get` (weight 60 per hour).
 *                               Conservative: a trend hour counts as 60
 *                               active minutes only when the hour's spss
 *                               average crosses (baseline + threshold).
 *   • `sumTotalCpu` etc.      — running sums so the client can compute
 *                               weighted averages across multiple hosts
 *                               (avg = sum / minutes).
 */
/** Threshold bucket keys for the "minutes above X%" counters. Includes
 *  20/30/40 bands below the legacy 50/60/70/80/90 so the column stays
 *  informative on hardware whose typical busy-minute peak sits in the
 *  30–50% range — observed on Rimi i3-4330/i3-6100 SCOs where median
 *  per-host peak active-min Total CPU is ~51%, so 70% catches only the
 *  worst 10% of hosts and most rows would otherwise show 0%. Tracked
 *  as minute-weighted counters: a real history minute contributes 1,
 *  a synthetic trend hour contributes 60. */
export type ActiveAboveBucket = 20 | 30 | 40 | 50 | 60 | 70 | 80 | 90;
export const ACTIVE_ABOVE_BUCKETS: readonly ActiveAboveBucket[] = [20, 30, 40, 50, 60, 70, 80, 90] as const;

export interface RolloutOnOffAggregate {
  /** Total active minutes from 1-min history samples. Active =
   *  spss.cpu > host baseline + threshold pp. Used for the
   *  averages and per-host peaks restricted to busy windows. */
  realActiveMinutes: number;
  /** Total active minutes from hourly trend (synthetic 60-min buckets). */
  syntheticActiveMinutes: number;
  /** Σ totalCpu (%) over all active minutes, weighted by minute count. */
  sumTotalCpu: number;
  /** Σ retellectCpu (%) over all active minutes, weighted by minute count. */
  sumRetellectCpu: number;
  /** Σ spssCpu (%) over all active minutes, weighted by minute count. */
  sumSpssCpu: number;
  /** Peak (max) totalCpu seen during any active minute. Null when no
   *  active minutes contributed to this aggregate. */
  peakTotalCpu: number | null;
  /** Total tracked minutes from 1-min history samples — any minute
   *  with a usable totalCpu reading, regardless of active classification.
   *  Drives the &ldquo;Min &gt; X%&rdquo; denominator in &ldquo;all tracked&rdquo;
   *  mode (default; consistent with CPU Timeline). */
  realTrackedMinutes: number;
  /** Total tracked minutes from hourly trend (synthetic 60-min buckets). */
  syntheticTrackedMinutes: number;
  /**
   * Minute-weighted counters for &ldquo;minutes where totalCpu exceeded
   * each threshold&rdquo; — counted from ALL minutes (tracked mode).
   * Catches CPU spikes from non-SCO sources (SQL backup, antivirus, OS
   * housekeeping) so the column matches CPU Timeline at the same band.
   *
   * Convention: strict `>` (a bucket with exactly 70.0 % totalCpu does
   * NOT count toward the 70 bucket). Real history minutes contribute 1,
   * synthetic trend hours contribute 60.
   */
  minutesAboveThreshold: Record<ActiveAboveBucket, number>;
  /**
   * Same convention as `minutesAboveThreshold`, but restricted to
   * ACTIVE buckets only (spss &gt; baseline + threshold pp). Drives the
   * &ldquo;Min &gt; X%&rdquo; column when the user toggles the matrix into
   * &ldquo;active-only&rdquo; mode — useful when they want pure Retellect
   * attribution and intentionally exclude non-SCO CPU sources. Denominator
   * for that mode is realActiveMinutes + syntheticActiveMinutes.
   */
  activeMinutesAboveThreshold: Record<ActiveAboveBucket, number>;
}

/** Empty aggregate factory — used as the zero element for accumulators. */
export const emptyOnOffAggregate = (): RolloutOnOffAggregate => ({
  realActiveMinutes: 0,
  syntheticActiveMinutes: 0,
  sumTotalCpu: 0,
  sumRetellectCpu: 0,
  sumSpssCpu: 0,
  peakTotalCpu: null,
  realTrackedMinutes: 0,
  syntheticTrackedMinutes: 0,
  minutesAboveThreshold: { 20: 0, 30: 0, 40: 0, 50: 0, 60: 0, 70: 0, 80: 0, 90: 0 },
  activeMinutesAboveThreshold: { 20: 0, 30: 0, 40: 0, 50: 0, 60: 0, 70: 0, 80: 0, 90: 0 },
});

/** Per-host aggregate, with both ON and OFF directions. */
export interface RolloutPerHostEntry {
  hostId: string;
  /** Baseline spss.cpu median in 02:00–05:00 Europe/Vilnius window.
   *  Null when too few night samples to call it reliable (< minBaselineSamples). */
  baselineSpssCpu: number | null;
  /** Count of 1-min history samples collected in the baseline window. */
  baselineSampleCount: number;
  /** Was the baseline window populated *at all*? Distinguishes
   *  "agent broken, zero data" from "data fine, just no night samples". */
  hasAnySamples: boolean;
  /** Aggregate restricted to buckets classified Retellect ON
   *  (sum python.cpu > 0.5 % in that bucket). */
  on: RolloutOnOffAggregate;
  /** Aggregate restricted to buckets classified Retellect OFF. */
  off: RolloutOnOffAggregate;
  /**
   * Total minutes (active + idle) the host had any usable data in the
   * window. Lets the UI distinguish "host with broken agent" (0 minutes)
   * from "host with sample data but no active minutes under threshold".
   */
  totalMinutes: number;
}

/** Top-level payload returned by the server fetcher. */
export interface RolloutPerHostPayload {
  /** Active threshold (percentage points above baseline) used to classify
   *  a bucket as active. Echoed back so client can show it in the UI and
   *  catch any drift between request and rendered payload. */
  activeThresholdPp: number;
  /** Window length in days requested from Zabbix. */
  periodDays: number;
  /** Wall-clock ISO timestamp when the aggregate was produced. */
  generatedAt: string;
  /** Per-host aggregates. Hosts with no matching items (no spss.cpu in
   *  Zabbix) are simply omitted — the client merges by hostId, so absent
   *  entries fall through to the "no aggregate" UI path. */
  perHost: RolloutPerHostEntry[];
}
