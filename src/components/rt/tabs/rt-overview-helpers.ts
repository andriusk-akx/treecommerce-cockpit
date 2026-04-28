/**
 * Pure helper functions extracted from RtOverview for unit testing.
 * Mirror the calculation logic used in the dashboard.
 */

/**
 * Threshold above which a host's summed `python.cpu` is treated as "Retellect
 * actually running" rather than rounding noise.
 *
 * Calibration history:
 *   - Originally 1.0 % with a comment "filters out residual python noise
 *     (0.01% etc)". That assumption was wrong: real-world idle Retellect on
 *     Rimi prod (Outlet T813 SCO1-SCO6, Dangeručio SCO1, observed
 *     2026-04-28) sat at 0.40 – 0.95 %. Five hosts with confirmed working
 *     Retellect were filtered out by the 1.0 % cutoff.
 *   - Lowered to 0.01 % so any non-trivial reading counts. Genuine idle
 *     readings above ~0.05 % survive; sub-0.01 readings (sensor jitter,
 *     defaulted-to-zero parses) get rejected.
 *
 * Used as the single source of truth for both:
 *   • the "Retellect Active" big tile (retellectLiveHostIds set)
 *   • the "Retellect running" filter button on the Live CPU Summary
 * — so the two stay consistent. Previous behaviour: tile said 7, filter
 * showed 2.
 */
export const RETELLECT_CPU_THRESHOLD = 0.01;

/**
 * Decide whether a host should be classified as "Retellect running right
 * now" based on freshness of its python.cpu samples and summed CPU value.
 *
 * Both conditions must hold:
 *   1. Most-recent python.cpu sample is younger than `freshSec` seconds.
 *   2. Summed CPU across all python instances exceeds RETELLECT_CPU_THRESHOLD.
 *
 * Why a single helper: prior to 2026-04-28, RtOverview.tsx had two parallel
 * implementations of this rule (one for the Active tile, one for the filter)
 * with different thresholds. Users saw inconsistent counts in the same view.
 * Centralising it here means future tweaks to the rule update both call
 * sites at once.
 */
export function isRetellectRunning(input: {
  /** Most-recent python.cpu sample timestamp, ms since epoch. 0 means "never reported". */
  freshestMs: number;
  /** Reference "now" timestamp, ms since epoch. Pass 0 for SSR/pre-mount; the helper returns false. */
  refMs: number;
  /** Sum of python.cpu values for this host (already aggregated). */
  totalCpu: number;
  /** Freshness window in seconds. Defaults to 300 s (5 min) — matches RT_FRESHNESS_THRESHOLD_SEC. */
  freshSec?: number;
}): boolean {
  const { freshestMs, refMs, totalCpu, freshSec = 300 } = input;
  if (freshestMs <= 0 || refMs <= 0) return false;
  const ageMs = refMs - freshestMs;
  if (ageMs > freshSec * 1000) return false;
  return totalCpu > RETELLECT_CPU_THRESHOLD;
}

/** Format Retellect CPU value for display. Below 0.05 (rounds to 0.0%) → "0%". Above → "X.X%" with min 0.1. */
export function formatRetellectCpu(rtCpuTotal: number): string {
  if (rtCpuTotal <= 0) return "0%";
  // toFixed(1) rounds to 1 decimal; max with 0.1 to avoid showing "0.0%" when value is positive-but-tiny
  return `${Math.max(0.1, parseFloat(rtCpuTotal.toFixed(1))).toFixed(1)}%`;
}

/** CPU value risk classification (matches Host CPU column color logic). */
export function cpuRiskColor(value: number): "red" | "amber" | "emerald" | "gray" {
  if (value > 70) return "red";
  if (value > 40) return "amber";
  if (value > 0) return "emerald";
  return "gray";
}

/** Sum python.cpu values per host, returning total CPU% used by Retellect on each host.
 *  Only counts items with valid lastClock > 0 (already published at least once). */
export function aggregateRetellectCpu(
  procCpu: Array<{ hostId: string; category: string; cpuValue: number; lastClock: string | null }>
): Map<string, number> {
  const result = new Map<string, number>();
  for (const proc of procCpu) {
    if (proc.category !== "retellect") continue;
    if (!proc.lastClock || new Date(proc.lastClock).getTime() <= 0) continue;
    const cur = result.get(proc.hostId) || 0;
    result.set(proc.hostId, cur + Math.max(0, proc.cpuValue));
  }
  return result;
}

/** Compute hardware class summary: avg + peak + sample count per class.
 *  Only fresh samples (within window) and non-zero values are included. */
export interface HardwareClassRow {
  name: string;
  hosts: number;
  avgCpu: number;
  peakCpu: number;
  sampleCount: number;
  risk: "critical" | "warn" | "ok" | "unknown";
}

export function summarizeHardwareClasses(
  groups: Map<string, { hosts: number; cpuValues: number[] }>
): HardwareClassRow[] {
  const out: HardwareClassRow[] = [];
  for (const [name, data] of groups) {
    const sampleCount = data.cpuValues.length;
    const avg = sampleCount > 0
      ? Math.round((data.cpuValues.reduce((s, v) => s + v, 0) / sampleCount) * 10) / 10
      : 0;
    const peak = sampleCount > 0
      ? Math.round(Math.max(...data.cpuValues) * 10) / 10
      : 0;
    let risk: HardwareClassRow["risk"] = "unknown";
    if (sampleCount > 0) {
      if (avg > 70) risk = "critical";
      else if (avg > 40) risk = "warn";
      else risk = "ok";
    }
    out.push({ name, hosts: data.hosts, avgCpu: avg, peakCpu: peak, sampleCount, risk });
  }
  return out.sort((a, b) => {
    if (a.sampleCount === 0 && b.sampleCount > 0) return 1;
    if (b.sampleCount === 0 && a.sampleCount > 0) return -1;
    return b.avgCpu - a.avgCpu;
  });
}
