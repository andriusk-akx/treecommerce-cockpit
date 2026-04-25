/**
 * Pure helper functions extracted from RtOverview for unit testing.
 * Mirror the calculation logic used in the dashboard.
 */

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
