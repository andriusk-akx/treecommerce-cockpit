/**
 * Pure (testable) helpers for the per-process hourly rollup in writer.ts.
 * Phase 4.5 aggregation: take per-minute / per-hour HostBucket data from
 * fetchRolloutRawBuckets and collapse it into one row per (host, hour)
 * for the CpuProcessMetricHourly table.
 */
import { round1 } from "./helpers";

/** Matches the HostBucket interface from rollout-insights/aggregate.ts but
 *  inlined here to keep this module dependency-light for testing. */
export interface ProcessBucket {
  tsMs: number;
  weightMinutes: number;
  source: "history" | "trend";
  spssCpu: number | null;
  retellectCpu: number | null;
  totalCpu: number | null;
}

export interface ProcessHourAggregate {
  hostId: string;
  hourStartMs: number;
  spssCpu: number | null;
  retellectCpu: number | null;
  totalCpu: number | null;
  sawPython: boolean;
  weightMinutes: number;
  source: "history" | "trend" | "merged";
}

/**
 * Group buckets by (host, hour). Aggregate spss/python/system CPU values
 * to hourly means; track whether any python sample was observed so the
 * downstream consumer can distinguish "Retellect not running" from
 * "Retellect reported 0%".
 *
 * `windowMsRange` filters buckets to a specific time window — used when
 * the writer's requested fromIso/toIso is narrower than the cached
 * fetchRolloutRawBuckets payload.
 */
export function aggregateProcessHours(
  perHostBuckets: Array<{ hostId: string; buckets: ProcessBucket[] }>,
  fromMs: number,
  toMs: number,
): ProcessHourAggregate[] {
  type Acc = {
    hostId: string;
    hourStartMs: number;
    spssCount: number; spssSum: number;
    pythonCount: number; pythonSum: number;
    sysCount: number; sysSum: number;
    sawPython: boolean;
    weightMinutes: number;
    source: "history" | "trend" | "merged";
  };
  const hourMap = new Map<string, Acc>();
  for (const { hostId, buckets } of perHostBuckets) {
    for (const b of buckets) {
      if (b.tsMs < fromMs || b.tsMs >= toMs) continue;
      const hourStartMs = Math.floor(b.tsMs / 3_600_000) * 3_600_000;
      const key = `${hostId}|${hourStartMs}`;
      let acc = hourMap.get(key);
      if (!acc) {
        acc = {
          hostId, hourStartMs,
          spssCount: 0, spssSum: 0,
          pythonCount: 0, pythonSum: 0,
          sysCount: 0, sysSum: 0,
          sawPython: false,
          weightMinutes: 0,
          source: b.source,
        };
        hourMap.set(key, acc);
      }
      if (b.spssCpu !== null && Number.isFinite(b.spssCpu)) {
        acc.spssCount += 1;
        acc.spssSum += b.spssCpu;
      }
      if (b.retellectCpu !== null && Number.isFinite(b.retellectCpu)) {
        acc.pythonCount += 1;
        acc.pythonSum += b.retellectCpu;
        acc.sawPython = true;
      }
      if (b.totalCpu !== null && Number.isFinite(b.totalCpu)) {
        acc.sysCount += 1;
        acc.sysSum += b.totalCpu;
      }
      acc.weightMinutes += b.weightMinutes;
      if (acc.source !== b.source) acc.source = "merged";
    }
  }
  const out: ProcessHourAggregate[] = [];
  for (const acc of hourMap.values()) {
    out.push({
      hostId: acc.hostId,
      hourStartMs: acc.hourStartMs,
      spssCpu: acc.spssCount > 0 ? round1(acc.spssSum / acc.spssCount) : null,
      retellectCpu: acc.sawPython ? round1(acc.pythonSum / Math.max(acc.pythonCount, 1)) : null,
      totalCpu: acc.sysCount > 0 ? round1(acc.sysSum / acc.sysCount) : null,
      sawPython: acc.sawPython,
      weightMinutes: Math.min(acc.weightMinutes, 60),
      source: acc.source,
    });
  }
  return out;
}
