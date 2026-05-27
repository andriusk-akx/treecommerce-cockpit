/**
 * Pure computation layer for the CPU Timeline Compare-periods sub-view.
 *
 * Inputs: two per-period payloads from `getCpuHistoryForRange` plus the host
 * metadata resolved from Prisma. Output: a `CompareResponse` matching the
 * spec exactly (docs/specs/cpu-timeline-compare-periods-spec.md §5).
 *
 * Kept side-effect-free so it can be unit-tested in isolation from Zabbix
 * and Prisma. The API route handles I/O, the compute module handles math.
 */
import { alignSamples, type RawSample } from "./align";
import type {
  CompareAlignment,
  CompareDelta,
  CompareHostRow,
  CompareResponse,
  CompareThreshold,
  DataQuality,
} from "@/components/rt/compare/types";

export interface HostMeta {
  /** Prisma Device.id */
  deviceId: string;
  /** Zabbix host.hostid */
  zHostId: string;
  /** Display name shown in UI */
  hostName: string;
  /** Display name of the parent store */
  storeName: string;
  cpuModel: string | null;
  cpuCores: number | null;
}

export interface PeriodPayload {
  daily: Array<{
    hostId: string;
    date: string;
    max: number;
    avg: number;
    min: number;
    minutesAbove: { 20: number; 30: number; 40: number; 50: number; 60: number; 70: number; 80: number; 90: number };
    totalSamples: number;
  }>;
  samples: RawSample[];
}

export interface ComputeInput {
  pilotId: string;
  hosts: HostMeta[];
  threshold: CompareThreshold;
  aFromSec: number;
  aToSec: number;
  bFromSec: number;
  bToSec: number;
  aFromIso: string;
  aToIso: string;
  bFromIso: string;
  bToIso: string;
  aLabel: string | null;
  bLabel: string | null;
  alignment: CompareAlignment;
  periodA: PeriodPayload;
  periodB: PeriodPayload;
  /** Pre-computed by the API route based on retention windows. */
  dataQualityA: DataQuality;
  dataQualityB: DataQuality;
  warnings: string[];
}

function delta(a: number, b: number): CompareDelta {
  const deltaAbs = Math.round((b - a) * 10) / 10;
  const deltaPct = a === 0 ? null : Math.round(((b - a) / a) * 1000) / 10;
  return { a, b, deltaAbs, deltaPct };
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx];
}

/**
 * Build per-host comparison rows. The daily payload from Zabbix carries
 * `minutesAbove` bins by zHostId; we keyed the host metadata by zHostId too,
 * so the join is direct. `aSparkline` / `bSparkline` are length =
 * periodLengthDays with one minutes-above-threshold value per day.
 */
function buildHostRows(input: ComputeInput, periodLengthDays: number): CompareHostRow[] {
  const thr = input.threshold;
  const aByHost = groupDailyByHost(input.periodA.daily);
  const bByHost = groupDailyByHost(input.periodB.daily);
  const aSamplesByHost = groupSamplesByHost(input.periodA.samples);
  const bSamplesByHost = groupSamplesByHost(input.periodB.samples);

  const aDates = listDateRange(input.aFromIso, periodLengthDays);
  const bDates = listDateRange(input.bFromIso, periodLengthDays);

  const rows: CompareHostRow[] = input.hosts.map((h) => {
    const aDaily = aByHost.get(h.zHostId) ?? [];
    const bDaily = bByHost.get(h.zHostId) ?? [];
    const aHostSamples = aSamplesByHost.get(h.zHostId) ?? [];
    const bHostSamples = bSamplesByHost.get(h.zHostId) ?? [];

    const aMinutesAbove = aDaily.reduce((s, d) => s + d.minutesAbove[thr], 0);
    const bMinutesAbove = bDaily.reduce((s, d) => s + d.minutesAbove[thr], 0);
    const aSamples = aDaily.reduce((s, d) => s + d.totalSamples, 0);
    const bSamples = bDaily.reduce((s, d) => s + d.totalSamples, 0);

    const aMeanCpu = weightedMean(aDaily);
    const bMeanCpu = weightedMean(bDaily);
    const aP95Cpu = p95(aHostSamples.map((s) => s.value));
    const bP95Cpu = p95(bHostSamples.map((s) => s.value));

    const aSparkline = aDates.map((d) => aDaily.find((x) => x.date === d)?.minutesAbove[thr] ?? 0);
    const bSparkline = bDates.map((d) => bDaily.find((x) => x.date === d)?.minutesAbove[thr] ?? 0);

    const hostScope: CompareHostRow["hostScope"] =
      aSamples === 0 && bSamples > 0 ? "added-in-b"
      : bSamples === 0 && aSamples > 0 ? "removed-before-b"
      : "both";

    const deltaMinutesAbs = bMinutesAbove - aMinutesAbove;
    const deltaMinutesPct = aMinutesAbove === 0 ? null : Math.round(((bMinutesAbove - aMinutesAbove) / aMinutesAbove) * 1000) / 10;

    const dq: DataQuality = hostScope === "both"
      ? (input.dataQualityA === "full" && input.dataQualityB === "full" ? "full" : "trend-only")
      : "partial-missing";

    return {
      hostId: h.deviceId,
      hostName: h.hostName,
      storeName: h.storeName,
      cpuModel: h.cpuModel,
      cpuCores: h.cpuCores,
      aMinutesAbove,
      bMinutesAbove,
      deltaMinutesAbs,
      deltaMinutesPct,
      aMeanCpu: Math.round(aMeanCpu * 10) / 10,
      bMeanCpu: Math.round(bMeanCpu * 10) / 10,
      aP95Cpu: Math.round(aP95Cpu * 10) / 10,
      bP95Cpu: Math.round(bP95Cpu * 10) / 10,
      aSamples,
      bSamples,
      aSparkline,
      bSparkline,
      dataQuality: dq,
      hostScope,
    };
  });

  return rows;
}

function groupDailyByHost<T extends { hostId: string }>(rows: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const bucket = m.get(r.hostId);
    if (bucket) bucket.push(r);
    else m.set(r.hostId, [r]);
  }
  return m;
}

function groupSamplesByHost(samples: RawSample[]): Map<string, RawSample[]> {
  const m = new Map<string, RawSample[]>();
  for (const s of samples) {
    const bucket = m.get(s.hostId);
    if (bucket) bucket.push(s);
    else m.set(s.hostId, [s]);
  }
  return m;
}

function weightedMean(daily: PeriodPayload["daily"]): number {
  let sum = 0;
  let total = 0;
  for (const d of daily) {
    // `avg` is the per-day mean; weight by `totalSamples + 60*hourlyCount`
    // would be ideal, but we only carry totalSamples here. For days with
    // zero raw samples (trend-only) treat each day as one hourly aggregate
    // representing 60 minutes — gives trend-only days a non-zero weight
    // so the period mean isn't dominated by the recent 14d window.
    const weight = d.totalSamples > 0 ? d.totalSamples : 60;
    sum += d.avg * weight;
    total += weight;
  }
  return total === 0 ? 0 : sum / total;
}

function listDateRange(fromIso: string, daysLength: number): string[] {
  const out: string[] = [];
  const start = new Date(`${fromIso}T00:00:00Z`);
  for (let i = 0; i < daysLength; i++) {
    const d = new Date(start.getTime() + i * 86_400_000);
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`);
  }
  return out;
}

export function buildCompareResponse(input: ComputeInput): CompareResponse {
  const periodLengthDays = Math.round((input.aToSec - input.aFromSec) / 86_400);
  const hostRows = buildHostRows(input, periodLengthDays);

  // Fleet-wide KPIs
  const sumA = hostRows.reduce((s, r) => s + r.aMinutesAbove, 0);
  const sumB = hostRows.reduce((s, r) => s + r.bMinutesAbove, 0);
  const meanA = weightedFleetMean(input.periodA.daily);
  const meanB = weightedFleetMean(input.periodB.daily);
  const p95A = p95(input.periodA.samples.map((s) => s.value));
  const p95B = p95(input.periodB.samples.map((s) => s.value));

  // % time above threshold — denominator = total sample-minutes recorded
  // for the period across all hosts. If a host's monitoring went silent
  // mid-period, its contribution falls out of both numerator AND denominator
  // naturally, so the percentage reflects observed time, not wall-clock.
  const totalSamplesA = input.periodA.daily.reduce((s, d) => s + d.totalSamples, 0);
  const totalSamplesB = input.periodB.daily.reduce((s, d) => s + d.totalSamples, 0);
  const pctA = totalSamplesA === 0 ? 0 : Math.round((sumA / totalSamplesA) * 1000) / 10;
  const pctB = totalSamplesB === 0 ? 0 : Math.round((sumB / totalSamplesB) * 1000) / 10;

  const overlay = alignSamples({
    aSamples: input.periodA.samples,
    bSamples: input.periodB.samples,
    aFromSec: input.aFromSec,
    aToSec: input.aToSec,
    bFromSec: input.bFromSec,
    bToSec: input.bToSec,
    threshold: input.threshold,
    alignment: input.alignment,
  });

  return {
    meta: {
      pilotId: input.pilotId,
      threshold: input.threshold,
      periodLengthDays,
      periodA: { from: input.aFromIso, to: input.aToIso, label: input.aLabel },
      periodB: { from: input.bFromIso, to: input.bToIso, label: input.bLabel },
      dataQuality: {
        periodA: input.dataQualityA,
        periodB: input.dataQualityB,
        warnings: input.warnings,
      },
      generatedAt: new Date().toISOString(),
    },
    kpis: {
      minutesAboveThreshold: delta(sumA, sumB),
      meanCpu: delta(roundTenth(meanA), roundTenth(meanB)),
      p95Cpu: delta(roundTenth(p95A), roundTenth(p95B)),
      pctTimeAboveThreshold: delta(pctA, pctB),
    },
    overlay,
    hostRows,
  };
}

function weightedFleetMean(daily: PeriodPayload["daily"]): number {
  let sum = 0;
  let total = 0;
  for (const d of daily) {
    const weight = d.totalSamples > 0 ? d.totalSamples : 60;
    sum += d.avg * weight;
    total += weight;
  }
  return total === 0 ? 0 : sum / total;
}

function roundTenth(v: number): number {
  return Math.round(v * 10) / 10;
}
