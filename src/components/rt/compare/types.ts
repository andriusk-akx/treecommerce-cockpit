// Shared types for the CPU Timeline "Compare two periods" sub-view.
//
// Mirrors the JSON contract documented in
//   docs/specs/cpu-timeline-compare-periods-spec.md §5
// — keep this file and the spec in sync. The API route at
//   /api/rt/cpu-compare returns exactly this shape.

export type CompareAlignment = "absolute-offset" | "time-of-day";

export type DataQuality = "full" | "trend-only" | "partial-missing";

/** Five threshold values supported by Zabbix `minutesAbove` bins (10pp step). */
export const COMPARE_THRESHOLDS = [50, 60, 70, 80, 90] as const;
export type CompareThreshold = (typeof COMPARE_THRESHOLDS)[number];

export interface PeriodMeta {
  /** ISO YYYY-MM-DD, inclusive */
  from: string;
  /** ISO YYYY-MM-DD, inclusive */
  to: string;
  /** Optional user label e.g. "Pre BES rollout". null when not provided. */
  label: string | null;
}

export interface CompareDelta {
  /** Period A value */
  a: number;
  /** Period B value */
  b: number;
  /** Absolute delta (B − A) */
  deltaAbs: number;
  /** Percent delta ((B − A) / A * 100). null when A = 0. */
  deltaPct: number | null;
}

export interface CompareKpis {
  /** Total sample-minutes spent above the selected threshold, fleet-wide. */
  minutesAboveThreshold: CompareDelta;
  /** Mean CPU % across all samples and hosts. */
  meanCpu: CompareDelta;
  /** P95 of per-sample CPU % across all samples. */
  p95Cpu: CompareDelta;
  /** Percentage of total time spent above threshold (0..100). */
  pctTimeAboveThreshold: CompareDelta;
}

export interface OverlayPoint {
  /** X coordinate. Semantics depend on `overlay.alignment`. */
  offsetMin: number;
  /** Period A mean CPU at this slot. null when no samples. */
  aCpu: number | null;
  /** Period B mean CPU at this slot. */
  bCpu: number | null;
  /** Number of host-minutes above threshold in this slot for A. */
  aMinutesAbove: number;
  bMinutesAbove: number;
}

export interface CompareOverlay {
  alignment: CompareAlignment;
  /** Total slots on the X axis. */
  totalSlots: number;
  /** Slot width in minutes — auto-picked by the aligner. Time-of-day is
   *  always 5-min slots (288/period). Absolute-offset scales from 1 min
   *  (short periods) up to 240 min (max-retention 42-day windows) so the
   *  total slot count stays under ~336. */
  slotMinutes: number;
  points: OverlayPoint[];
}

export interface CompareHostRow {
  hostId: string;
  hostName: string;
  storeName: string;
  cpuModel: string | null;
  cpuCores: number | null;
  aMinutesAbove: number;
  bMinutesAbove: number;
  deltaMinutesAbs: number;
  /** null when aMinutesAbove = 0 (division undefined). */
  deltaMinutesPct: number | null;
  aMeanCpu: number;
  bMeanCpu: number;
  aP95Cpu: number;
  bP95Cpu: number;
  aSamples: number;
  bSamples: number;
  /** Per-day micro-chart values for spark-bars (length = period length in days). */
  aSparkline: number[];
  bSparkline: number[];
  dataQuality: DataQuality;
  /** Host added during period B (no A samples) or removed before B (no B samples). */
  hostScope: "both" | "added-in-b" | "removed-before-b";
}

export interface CompareMeta {
  pilotId: string;
  threshold: CompareThreshold;
  periodLengthDays: number;
  periodA: PeriodMeta;
  periodB: PeriodMeta;
  dataQuality: {
    periodA: DataQuality;
    periodB: DataQuality;
    warnings: string[];
  };
  generatedAt: string;
}

export interface CompareResponse {
  meta: CompareMeta;
  kpis: CompareKpis;
  overlay: CompareOverlay;
  hostRows: CompareHostRow[];
}

/** Body returned when validation fails. Spec §5 error codes. */
export interface CompareErrorResponse {
  error: string;
  code: "VALIDATION" | "RETENTION" | "TIMEOUT" | "FORBIDDEN" | "INTERNAL";
  details?: Record<string, unknown>;
}
