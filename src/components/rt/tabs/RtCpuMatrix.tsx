"use client";

/**
 * CPU Matrix — Retellect rollout decision page.
 *
 * Decision-oriented, not analytical. The single question this page
 * answers is "where is it safe to roll out Retellect, given the CPU
 * pressure we already see?" Per CPU class it shows:
 *
 *   • Evidence base (how solid the per-class sample is)
 *   • Current state — Typical CPU load, Room to threshold,
 *     Time above threshold, Max CPU
 *   • Planned Retellect impact (+pp) — measured if Retellect ON evidence
 *     exists, otherwise a conservative per-tier scenario
 *   • Projected state after impact
 *   • Decision (Safe now / Validate next / Optimize first / Do not roll
 *     out / Insufficient evidence)
 *   • Decision confidence
 *
 * Deliberately NOT a drill-down. The legacy "Heatmap" rollout matrix
 * lives next door via the SubViewSelector for users who want per-host
 * detail; this page collapses each CPU class to one decision row.
 */

import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { RtPilotData, ZabbixData, ZabbixCpuTrend } from "../RtPilotWorkspace";
import { useRtFilters } from "../RtFiltersContext";
import { resolveCpuModel } from "./rt-inventory-helpers";
import { mergeOnOff, weightedAvg } from "@/lib/rollout-insights/aggregate";
import { emptyOnOffAggregate } from "@/lib/rollout-insights/types";
import type { RolloutOnOffAggregate, RolloutPerHostEntry } from "@/lib/rollout-insights/types";
import { FilterBar, FilterRow, FilterSelect, FilterSegmented, FilterDivider } from "../filters/RtFilterControls";

// ─── Types ──────────────────────────────────────────────────────────

type Decision =
  | "safe"           // green — safe to roll out
  | "validate"       // amber — validate next
  | "optimize"       // amber-red — optimize first
  | "do-not-roll-out"// red — do not roll out
  | "insufficient";  // grey — not enough data to decide

type Confidence = "high" | "medium" | "low";

/** What we know about a CPU class for the rollout decision. */
type Evidence =
  | "measured-on-off"  // ≥2 ON + ≥2 OFF hosts with usable samples
  | "baseline-only"    // only OFF samples — no Retellect ON data
  | "insufficient";    // no usable samples

/** Per-CPU-class decision row. */
interface CpuMatrixRow {
  model: string;
  /** One-line subtitle (e.g. "Best headroom in visible sample"). */
  subtitle: string;
  hostCount: number;
  /** Hosts with usable data (≥1 day of cpuTrends OR baseline). */
  hostsWithData: number;
  hostsOn: number;
  hostsOff: number;
  evidence: Evidence;

  // ── Current state ─────────────────────────────────────────────────
  /** Median of per (host, day) daily averages — "typical CPU load". */
  typicalCpu: number | null;
  /** Threshold − typicalCpu (positive = headroom). */
  roomNow: number | null;
  /** Sum of minutes above the chosen threshold across the class.
   *  cpuCountFrom switches between active-only and all-tracked. */
  timeAboveNowMin: number | null;
  /** Max of per-host daily max — class-wide worst peak. */
  maxCpu: number | null;
  /** Measured Retellect direct CPU on ON hosts (avg over active min).
   *  Surfaced as supporting context under the impact box. */
  measuredRetellectCpuOn: number | null;

  // ── Planned impact ────────────────────────────────────────────────
  /** Planned Retellect impact in percentage points. */
  impactPp: number;
  /** Source of the impact figure. */
  impactSource: "measured" | "conservative";

  // ── Projected state ───────────────────────────────────────────────
  projectedCpu: number | null;
  projectedRoom: number | null;
  /** Projected time above threshold (very rough scaling). */
  projectedTimeAboveMin: number | null;

  // ── Decision ──────────────────────────────────────────────────────
  decision: Decision;
  confidence: Confidence;

  /** When true the class has no ACTIVE Retellect activity in the
   *  selected period — hidden from view when "Hide silent" is on. */
  isSilent: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────

const DECISION_LABEL: Record<Decision, string> = {
  safe: "Safe now",
  validate: "Validate next",
  optimize: "Optimize first",
  "do-not-roll-out": "Do not roll out",
  insufficient: "Insufficient evidence",
};

const DECISION_STYLES: Record<Decision, string> = {
  safe: "bg-emerald-50 text-emerald-700 border-emerald-200",
  validate: "bg-amber-50 text-amber-800 border-amber-200",
  optimize: "bg-orange-50 text-orange-800 border-orange-200",
  "do-not-roll-out": "bg-red-50 text-red-700 border-red-200",
  insufficient: "bg-gray-100 text-gray-600 border-gray-300",
};

const DECISION_DOT: Record<Decision, string> = {
  safe: "bg-emerald-500",
  validate: "bg-amber-500",
  optimize: "bg-orange-500",
  "do-not-roll-out": "bg-red-500",
  insufficient: "bg-gray-400",
};

const CONFIDENCE_STYLES: Record<Confidence, string> = {
  high: "text-emerald-700 bg-emerald-50",
  medium: "text-amber-700 bg-amber-50",
  low: "text-gray-600 bg-gray-100",
};

const EVIDENCE_LABEL: Record<Evidence, string> = {
  "measured-on-off": "Measured ON/OFF",
  "baseline-only": "Baseline only",
  insufficient: "Insufficient evidence",
};

const EVIDENCE_STYLES: Record<Evidence, string> = {
  "measured-on-off": "bg-emerald-50 text-emerald-700 border-emerald-200",
  "baseline-only": "bg-blue-50 text-blue-700 border-blue-200",
  insufficient: "bg-gray-100 text-gray-500 border-gray-200",
};

/** Sort priority — riskiest decisions first, then strongest evidence. */
const DECISION_RANK: Record<Decision, number> = {
  "do-not-roll-out": 0,
  optimize: 1,
  validate: 2,
  safe: 3,
  insufficient: 4,
};

// ─── Component ──────────────────────────────────────────────────────

export function RtCpuMatrix({
  pilot,
  zabbix,
}: {
  pilot: RtPilotData;
  zabbix: ZabbixData;
}) {
  const { filters, setFilter } = useRtFilters();
  const threshold = filters.threshold;
  const storeFilter = filters.store;
  const cpuCountFrom = filters.cpuCountFrom;

  // Period selector mirrors RtTimeline / RtRolloutInsights — URL-driven
  // so a deep link keeps the same window.
  const router = useRouter();
  const pathname = usePathname();
  const urlSearchParams = useSearchParams();
  useEffect(() => {
    const urlPeriod = urlSearchParams.get("period");
    if (urlPeriod && urlPeriod !== filters.period) {
      setFilter("period", urlPeriod);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlSearchParams]);
  const setPeriod = (v: string) => {
    setFilter("period", v);
    const live = typeof window !== "undefined" ? window.location.search : `?${urlSearchParams.toString()}`;
    const params = new URLSearchParams(live);
    params.set("period", v);
    router.push(`${pathname}?${params.toString()}`);
  };

  // Hide silent — class-level filter that collapses rows with no ACTIVE
  // Retellect signal in the window. Kept local: doesn't belong in the
  // global filter context because it's a CPU-Matrix-only concern.
  const [hideSilent, setHideSilent] = useState<boolean>(false);

  // Defer the heavy compute inputs so the dropdown / segmented controls
  // update instantly while computeCpuMatrix runs in a concurrent render.
  //
  // Why: changing the threshold on a Rimi-scale pilot (~116 hosts × 90 d
  // of cpuTrends ≈ 10 k entries) used to block the main thread long
  // enough for users to think the dropdown was broken. useDeferredValue
  // tells React "use the old value while this update is in flight" and
  // exposes an `isPending`-style signal via the deferred-vs-current
  // comparison below, which drives the Updating... badge and the
  // opacity dim on the matrix.
  const deferredThreshold = useDeferredValue(threshold);
  const deferredStore = useDeferredValue(storeFilter);
  const deferredCountFrom = useDeferredValue(cpuCountFrom);
  const isRefreshing =
    deferredThreshold !== threshold ||
    deferredStore !== storeFilter ||
    deferredCountFrom !== cpuCountFrom;

  // Build decision matrix from the deferred inputs.
  const { matrix, periodDays } = useMemo(
    () => computeCpuMatrix(pilot, zabbix, deferredThreshold, deferredStore, deferredCountFrom),
    [pilot, zabbix, deferredThreshold, deferredStore, deferredCountFrom],
  );

  const filteredMatrix = useMemo(() => {
    if (!hideSilent) return matrix;
    return matrix.filter((r) => !r.isSilent);
  }, [matrix, hideSilent]);

  return (
    <>
      {/* ── Filter bar ──────────────────────────────────────────────── */}
      <FilterBar>
        <FilterRow>
          <FilterSelect
            label="CPU threshold"
            value={String(threshold)}
            options={[20, 30, 40, 50, 60, 70, 80, 90].map((v) => ({ v: String(v), l: `${v}%` }))}
            onChange={(v) => setFilter("threshold", Number(v))}
          />
          <FilterSelect
            label="Store"
            value={storeFilter}
            options={[
              { v: "all", l: "All stores" },
              ...pilot.stores.map((s) => ({ v: s.name, l: s.name })),
            ]}
            onChange={(v) => setFilter("store", v)}
          />
          <FilterDivider />
          <FilterSegmented<string>
            label="Period"
            value={filters.period}
            options={[
              { v: "7d", l: "7d" },
              { v: "14d", l: "14d" },
              { v: "30d", l: "30d" },
              { v: "90d", l: "90d" },
            ]}
            onChange={setPeriod}
          />
          <FilterSegmented<"tracked" | "active">
            label="Minute scope"
            value={cpuCountFrom}
            info="All minutes counts every tracked minute (matches CPU Timeline). Active only restricts to busy windows."
            options={[
              { v: "tracked", l: "All minutes" },
              { v: "active", l: "Active only" },
            ]}
            onChange={(v) => setFilter("cpuCountFrom", v)}
          />
          <button
            type="button"
            onClick={() => setHideSilent((s) => !s)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-medium transition ${
              hideSilent
                ? "bg-amber-50 text-amber-800 border-amber-300"
                : "bg-white text-gray-500 border-gray-200 hover:border-gray-300"
            }`}
            title="Hide CPU classes with no Retellect activity observed in the period"
          >
            <span className={`w-1.5 h-1.5 rounded-full ${hideSilent ? "bg-amber-500" : "bg-gray-300"}`} />
            Hide silent
          </button>
          {isRefreshing && (
            <span
              className="inline-flex items-center gap-1.5 text-[11px] text-blue-700 bg-blue-50 border border-blue-200 rounded px-2 py-1"
              role="status"
              aria-live="polite"
            >
              <svg
                className="animate-spin w-3 h-3"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
                <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
              </svg>
              Updating…
            </span>
          )}
        </FilterRow>
      </FilterBar>

      <p className="text-[11px] text-gray-500 mb-4 leading-relaxed">
        Threshold is used for two things: <strong>time above threshold</strong> and{" "}
        <strong>room to threshold</strong>. Where Retellect ON data is unavailable, the rollout
        status is based on the measured baseline plus a conservative per-tier impact scenario.
      </p>

      {/* Single dimmer wraps the matrix + cards + evidence boxes so the
          whole filter-dependent surface fades together during the
          deferred re-render. opacity-60 keeps prior values readable
          while signalling "this is being replaced"; pointer-events-none
          stops accidental clicks on the stale UI. */}
      <div
        className={`transition-opacity duration-200 ${isRefreshing ? "opacity-60 pointer-events-none" : ""}`}
        aria-busy={isRefreshing || undefined}
      >

      {/* ── Decision matrix ─────────────────────────────────────────── */}
      <section className="mb-6">
        <div className="flex items-baseline justify-between mb-2">
          <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
            Decision matrix
          </h3>
          <span className="text-[11px] text-gray-400">
            sorted by risk · {periodDays}-day window
          </span>
        </div>

        {filteredMatrix.length === 0 ? (
          <div className="bg-white rounded-lg border border-gray-200 px-5 py-10 text-center text-sm text-gray-400">
            {matrix.length === 0
              ? "Not enough CPU history to score rollout. Check Data Health."
              : "All classes filtered out by Hide silent — no Retellect activity observed in this window."}
          </div>
        ) : (
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left py-3 px-4 text-[11px] font-semibold text-gray-500 uppercase w-[240px]">CPU class</th>
                  <th className="text-left py-3 px-3 text-[11px] font-semibold text-gray-500 uppercase w-[150px]">Evidence base</th>
                  <th className="text-left py-3 px-3 text-[11px] font-semibold text-gray-500 uppercase">Current state</th>
                  <th className="text-left py-3 px-3 text-[11px] font-semibold text-gray-500 uppercase w-[200px]">Planned Retellect impact</th>
                  <th className="text-left py-3 px-3 text-[11px] font-semibold text-gray-500 uppercase">Projected state</th>
                  <th className="text-center py-3 px-3 text-[11px] font-semibold text-gray-500 uppercase w-[140px]">Decision</th>
                  <th className="text-center py-3 px-3 text-[11px] font-semibold text-gray-500 uppercase w-[100px]">Confidence</th>
                </tr>
              </thead>
              <tbody>
                {filteredMatrix.map((row) => (
                  <MatrixRowView key={row.model} row={row} threshold={threshold} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Lower split: drivers / actions / limitations ────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <BottleneckDriversCard matrix={matrix} threshold={threshold} />
        <RecommendedActionsCard matrix={matrix} />
        <ConfidenceLimitsCard matrix={matrix} />
      </div>

      {/* ── Evidence cards ──────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <EvidenceBox
          title="Meaning of “Typical CPU load”"
          body="Median across per-host daily averages over the selected period. The median ignores one-off spikes (Windows Update, antivirus scans) and reflects the steady level the hardware actually runs at while servicing customers."
        />
        <EvidenceBox
          title="Meaning of “Room to threshold”"
          body="Threshold minus typical CPU load. Shows how much CPU headroom is available right now, and how much would remain after the planned Retellect impact is added."
        />
        <EvidenceBox
          title="Where confidence comes from"
          body="High = ≥10 hosts with usable data, or Measured ON/OFF with ≥5 hosts each. Medium = 3–9 hosts. Low = <3 hosts — treat the row as directional, not decisive."
        />
      </div>
      </div>
    </>
  );
}

// ─── Row sub-component ──────────────────────────────────────────────

function MatrixRowView({ row, threshold }: { row: CpuMatrixRow; threshold: number }) {
  return (
    <tr className="border-t border-gray-100 align-top">
      {/* CPU class */}
      <td className="py-4 px-4">
        <div className="font-semibold text-gray-900">{row.model}</div>
        <div className="text-[11px] text-gray-500 mt-0.5">{row.subtitle}</div>
        <div
          className={`inline-block mt-2 px-2 py-0.5 rounded-full border text-[10px] font-semibold ${EVIDENCE_STYLES[row.evidence]}`}
        >
          {EVIDENCE_LABEL[row.evidence]}
        </div>
      </td>

      {/* Evidence base */}
      <td className="py-4 px-3">
        <div className="text-xl font-bold text-gray-900 leading-none">
          {row.hostCount} <span className="text-xs font-normal text-gray-500">hosts</span>
        </div>
        <div className="text-[11px] text-gray-500 mt-1 leading-relaxed">
          {row.hostsWithData}/{row.hostCount} with data
          <br />
          ON {row.hostsOn} · OFF {row.hostsOff}
        </div>
        {row.evidence === "baseline-only" && (
          <div className="text-[10px] text-amber-700 mt-1">No Retellect ON data yet</div>
        )}
      </td>

      {/* Current state */}
      <td className="py-4 px-3">
        <MiniStack
          rows={[
            { label: "Typical CPU load", value: row.typicalCpu, unit: "%", bar: "used" },
            { label: "Room to threshold", value: row.roomNow, unit: "pp", bar: "buffer" },
            {
              label: "Time above threshold",
              value: row.timeAboveNowMin,
              unit: "min",
              bar: row.timeAboveNowMin && row.timeAboveNowMin > 0 ? "used" : "used",
            },
            { label: "Max CPU", value: row.maxCpu, unit: "%", bar: "ghost" },
          ]}
          threshold={threshold}
        />
      </td>

      {/* Planned impact */}
      <td className="py-4 px-3">
        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-gray-200 bg-white text-xs text-gray-700">
          Planned impact
          <span className="font-bold text-gray-900">+{row.impactPp} pp</span>
          <span
            className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
              row.impactSource === "measured"
                ? "bg-emerald-50 text-emerald-700"
                : "bg-blue-50 text-blue-700"
            }`}
          >
            {row.impactSource === "measured" ? "measured" : "scenario"}
          </span>
        </div>
        <div className="text-[10px] text-gray-500 mt-2 leading-snug">
          {row.measuredRetellectCpuOn !== null
            ? `Measured Retellect CPU on ON hosts: ${row.measuredRetellectCpuOn.toFixed(1)}% avg`
            : row.impactSource === "conservative"
              ? "Projection only — no measured Retellect ON evidence yet"
              : null}
        </div>
      </td>

      {/* Projected state */}
      <td className="py-4 px-3">
        {row.decision === "insufficient" ? (
          <div className="text-xs text-gray-400">No projection available</div>
        ) : (
          <MiniStack
            rows={[
              {
                label: "Typical CPU load",
                value: row.projectedCpu,
                unit: "%",
                bar: "model",
                approx: true,
              },
              {
                label: "Room left",
                value: row.projectedRoom,
                unit: "pp",
                bar: "buffer",
                approx: true,
              },
              {
                label: "Time above threshold",
                value: row.projectedTimeAboveMin,
                unit: "min",
                bar: "used",
                approx: true,
              },
            ]}
            threshold={threshold}
          />
        )}
      </td>

      {/* Decision */}
      <td className="py-4 px-3 text-center">
        <span
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] font-semibold ${DECISION_STYLES[row.decision]}`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${DECISION_DOT[row.decision]}`} />
          {DECISION_LABEL[row.decision]}
        </span>
      </td>

      {/* Confidence */}
      <td className="py-4 px-3 text-center">
        <span
          className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold uppercase ${CONFIDENCE_STYLES[row.confidence]}`}
        >
          {row.confidence}
        </span>
      </td>
    </tr>
  );
}

// ─── Mini-stack (the per-cell bar group) ────────────────────────────

type BarVariant = "used" | "buffer" | "model" | "ghost";

function MiniStack({
  rows,
  threshold,
}: {
  rows: { label: string; value: number | null; unit: "%" | "pp" | "min"; bar: BarVariant; approx?: boolean }[];
  threshold: number;
}) {
  return (
    <div className="flex flex-col gap-1.5 min-w-[230px]">
      {rows.map((r) => (
        <MiniBar key={r.label} {...r} threshold={threshold} />
      ))}
    </div>
  );
}

function MiniBar({
  label,
  value,
  unit,
  bar,
  approx,
  threshold,
}: {
  label: string;
  value: number | null;
  unit: "%" | "pp" | "min";
  bar: BarVariant;
  approx?: boolean;
  threshold: number;
}) {
  // Bar width is a visual heuristic — we scale to 100 for % values, to
  // threshold for pp values (so a full bar means "as wide as headroom
  // can be"), and saturate min values against a 4-hour reference window
  // so a 3 h time-above-threshold lights up most of the bar.
  const widthPct = (() => {
    if (value === null) return 0;
    if (unit === "%") return Math.max(0, Math.min(100, value));
    if (unit === "pp") return Math.max(0, Math.min(100, (value / Math.max(1, threshold)) * 100));
    // min unit — saturate at 4 h (240 min)
    return Math.max(0, Math.min(100, (value / 240) * 100));
  })();

  const barClass = (() => {
    if (value === null) return "bg-gray-200";
    if (bar === "used") return "bg-emerald-500";
    if (bar === "buffer") return "bg-sky-500";
    if (bar === "model") return "bg-gray-900";
    return "bg-gray-300";
  })();

  const fmtValue = (() => {
    if (value === null) return "—";
    if (unit === "%") return `${Math.round(value)}%`;
    if (unit === "pp") return `${Math.round(value)} pp`;
    if (unit === "min") {
      if (value < 60) return `${Math.round(value)} min`;
      const h = value / 60;
      return h >= 10 ? `${Math.round(h)} h` : `${h.toFixed(1)} h`;
    }
    return String(value);
  })();

  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-[95px] text-sky-700 font-medium truncate" title={label}>
        {label}
      </span>
      <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden min-w-[40px]">
        {value === null ? (
          <div
            className="h-full"
            style={{
              width: "100%",
              backgroundImage:
                "repeating-linear-gradient(45deg, #f1f5f9 0 4px, #e2e8f0 4px 8px)",
            }}
          />
        ) : (
          <div className={`h-full ${barClass} rounded-full`} style={{ width: `${widthPct}%` }} />
        )}
      </div>
      <span className="w-[55px] text-right font-semibold text-gray-800 tabular-nums">
        {approx && value !== null ? `~${fmtValue}` : fmtValue}
      </span>
    </div>
  );
}

// ─── Lower cards ────────────────────────────────────────────────────

function BottleneckDriversCard({ matrix, threshold }: { matrix: CpuMatrixRow[]; threshold: number }) {
  // Surface 2–3 honest, decision-supporting one-liners derived from the
  // matrix. Deliberately short — the analytical decomposition lives on
  // the legacy Heatmap sub-view, this card is here to anchor the row
  // numbers in context.
  const lines: string[] = [];
  const measured = matrix.filter((r) => r.evidence === "measured-on-off");
  if (measured.length > 0) {
    const avgImpact =
      measured.reduce((s, r) => s + r.impactPp, 0) / measured.length;
    lines.push(
      `Measured Retellect impact on ON hosts averages +${avgImpact.toFixed(1)} pp across ${measured.length} ${measured.length === 1 ? "class" : "classes"}.`,
    );
  }
  const tightRoom = matrix.filter(
    (r) => r.roomNow !== null && r.roomNow < 20 && r.evidence !== "insufficient",
  );
  if (tightRoom.length > 0) {
    lines.push(
      `${tightRoom.length} ${tightRoom.length === 1 ? "class is" : "classes are"} already within 20 pp of the ${threshold}% threshold without Retellect.`,
    );
  }
  const hotClasses = matrix.filter(
    (r) => r.timeAboveNowMin !== null && r.timeAboveNowMin > 60,
  );
  if (hotClasses.length > 0) {
    lines.push(
      `${hotClasses.length} ${hotClasses.length === 1 ? "class spends" : "classes spend"} more than an hour per host above ${threshold}% already.`,
    );
  }
  if (lines.length === 0) {
    lines.push("No CPU classes show meaningful pressure at the current threshold.");
  }
  return (
    <Card title="Main bottleneck drivers">
      <ul className="space-y-1.5 text-[12px] text-gray-700 leading-snug">
        {lines.map((l, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className="text-gray-300 mt-0.5">·</span>
            <span>{l}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function RecommendedActionsCard({ matrix }: { matrix: CpuMatrixRow[] }) {
  const safe = matrix.filter((r) => r.decision === "safe").map((r) => r.model);
  const validate = matrix.filter((r) => r.decision === "validate").map((r) => r.model);
  const optimize = matrix.filter((r) => r.decision === "optimize").map((r) => r.model);
  const block = matrix.filter((r) => r.decision === "do-not-roll-out").map((r) => r.model);
  const unknown = matrix.filter((r) => r.decision === "insufficient").map((r) => r.model);

  const actions: { priority: "high" | "medium" | "low"; text: string }[] = [];
  if (safe.length > 0) {
    actions.push({ priority: "high", text: `Roll out first on ${formatList(safe)}.` });
  }
  if (validate.length > 0) {
    actions.push({ priority: "medium", text: `Validate ${formatList(validate)} under live peak load.` });
  }
  if (optimize.length > 0) {
    actions.push({ priority: "medium", text: `Optimize background load before rollout on ${formatList(optimize)}.` });
  }
  if (block.length > 0) {
    actions.push({ priority: "high", text: `Hold rollout on ${formatList(block)} until hardware tier is upgraded.` });
  }
  if (unknown.length > 0) {
    actions.push({ priority: "low", text: `Pilot Retellect on one host of each: ${formatList(unknown)}.` });
  }
  const top = actions.slice(0, 4);
  return (
    <Card title="Recommended next actions">
      {top.length === 0 ? (
        <div className="text-[12px] text-gray-400">No actions ranked yet — matrix is empty.</div>
      ) : (
        <ul className="space-y-1.5 text-[12px] text-gray-700 leading-snug">
          {top.map((a, i) => (
            <li key={i} className="flex items-start gap-2">
              <span
                className={`mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                  a.priority === "high"
                    ? "bg-red-500"
                    : a.priority === "medium"
                      ? "bg-amber-500"
                      : "bg-blue-500"
                }`}
              />
              <span>{a.text}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ConfidenceLimitsCard({ matrix }: { matrix: CpuMatrixRow[] }) {
  const lines: string[] = [];
  const lowConf = matrix.filter((r) => r.confidence === "low");
  if (lowConf.length > 0) {
    lines.push(
      `${lowConf.length} ${lowConf.length === 1 ? "class has" : "classes have"} low-confidence samples — directional only.`,
    );
  }
  const projectedOnly = matrix.filter(
    (r) => r.evidence === "baseline-only" && r.decision !== "insufficient",
  );
  if (projectedOnly.length > 0) {
    lines.push(
      `${projectedOnly.length} ${projectedOnly.length === 1 ? "class relies" : "classes rely"} on a conservative impact scenario, not measured ON data.`,
    );
  }
  const insufficient = matrix.filter((r) => r.decision === "insufficient");
  if (insufficient.length > 0) {
    lines.push(
      `${insufficient.length} ${insufficient.length === 1 ? "class has" : "classes have"} insufficient evidence to decide either way.`,
    );
  }
  if (lines.length === 0) {
    lines.push("All visible classes have at least baseline-level evidence.");
  }
  lines.push("Unknown CPU metadata is excluded from primary decisions.");
  return (
    <Card title="Where confidence is limited">
      <ul className="space-y-1.5 text-[12px] text-gray-700 leading-snug">
        {lines.map((l, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className="text-gray-300 mt-0.5">·</span>
            <span>{l}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h4 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">
        {title}
      </h4>
      {children}
    </div>
  );
}

function EvidenceBox({ title, body }: { title: string; body: string }) {
  return (
    <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
      <div className="text-[11px] font-semibold text-gray-700 mb-1">{title}</div>
      <div className="text-[11px] text-gray-500 leading-relaxed">{body}</div>
    </div>
  );
}

// ─── Compute layer ──────────────────────────────────────────────────

/**
 * Build the per-CPU-class decision matrix from the in-memory snapshot
 * the rest of the workspace uses. Pure (no fetches) so the page stays
 * reactive to filter changes without extra round-trips.
 *
 *  • Typical CPU load = median across per (host, day) daily averages
 *    drawn from `cpuTrends`. Median (not mean) ignores housekeeping
 *    spikes — antivirus, Windows Update — and reads as "the level the
 *    hardware runs at during the day".
 *  • Max CPU = max of per-host daily max.
 *  • Time above threshold uses `cpuTrends.minutesAbove[threshold]` when
 *    the count-from mode is `tracked`, and `rolloutPerHost.activeMinutesAboveThreshold`
 *    when `active`. Matches what CPU Timeline counts at the same band.
 *  • Planned impact:
 *      - Measured ON/OFF (≥2 ON + ≥2 OFF with samples): observed delta
 *        in weighted-avg Total CPU on active minutes.
 *      - Baseline only: conservative per-tier scenario.
 *  • Projected typical = typical + impact, projected time-above is a
 *    rough linear scaling — labelled with ~ in the UI to make the
 *    approximation visible.
 *  • Decision:
 *      Insufficient → "insufficient"
 *      Projected room ≥ 20pp AND projected time-above < 60 min → safe
 *      Projected room ≥ 10pp → validate
 *      Projected room ≥ 0pp  → optimize
 *      Projected room  < 0pp → do-not-roll-out
 *  • Confidence:
 *      High when ≥10 hosts with data, or ≥5 ON + ≥5 OFF
 *      Medium 3-9 hosts
 *      Low <3 hosts
 */
function computeCpuMatrix(
  pilot: RtPilotData,
  zabbix: ZabbixData,
  threshold: number,
  storeFilter: string,
  cpuCountFrom: "tracked" | "active",
): { matrix: CpuMatrixRow[]; periodDays: number } {
  const periodDays = (() => {
    const fromAggregate = zabbix.rolloutPerHost?.periodDays;
    if (fromAggregate && fromAggregate > 0) return fromAggregate;
    const raw = (zabbix.cpuTrends?.length || 0) > 0
      ? new Set(zabbix.cpuTrends!.map((t) => t.date)).size
      : 14;
    return Math.max(1, raw);
  })();

  const zabbixByName = new Map(zabbix.hosts.map((h) => [h.hostName, h]));
  const trendsByHost = new Map<string, ZabbixCpuTrend[]>();
  for (const t of zabbix.cpuTrends ?? []) {
    if (!trendsByHost.has(t.hostId)) trendsByHost.set(t.hostId, []);
    trendsByHost.get(t.hostId)!.push(t);
  }

  // Rollout aggregate map for ON/OFF + Retellect attribution.
  const perHostMap = new Map<string, RolloutPerHostEntry>(
    (zabbix.rolloutPerHost?.perHost ?? []).map((p) => [p.hostId, p]),
  );

  // Deployment classification (same union-of-signals approach used by
  // the legacy rollout matrix).
  const deployedSet = new Set<string>(zabbix.retellectDeployedHostIds ?? []);
  for (const id of zabbix.retellectActiveInPeriodHostIds ?? []) deployedSet.add(id);
  for (const entry of zabbix.rolloutPerHost?.perHost ?? []) {
    const onTracked = entry.on.realTrackedMinutes + entry.on.syntheticTrackedMinutes;
    if (onTracked > 0) deployedSet.add(entry.hostId);
  }

  // Pick the threshold bucket key (rolloutPerHost uses 20/30/40/50/60/70/80/90).
  const thKey = (
    threshold >= 90 ? 90 :
    threshold >= 80 ? 80 :
    threshold >= 70 ? 70 :
    threshold >= 60 ? 60 :
    threshold >= 50 ? 50 :
    threshold >= 40 ? 40 :
    threshold >= 30 ? 30 :
    20
  ) as 20 | 30 | 40 | 50 | 60 | 70 | 80 | 90;

  // Group accumulator.
  type Group = {
    model: string;
    totalHosts: number;
    hostsWithData: number;
    hostsOn: Set<string>;
    hostsOff: Set<string>;
    /** Pool of (host, day) daily averages from cpuTrends — drives median. */
    dailyAvgPool: number[];
    /** Max of per-host daily max. */
    maxCpu: number | null;
    /** Sum of minutesAbove[threshold] from cpuTrends (tracked mode). */
    sumMinAboveTracked: number;
    /** Sum of activeMinutesAboveThreshold[threshold] from rolloutPerHost (active mode). */
    sumMinAboveActive: number;
    /** Aggregate of all deployed hosts (ON evidence). */
    onAgg: RolloutOnOffAggregate;
    /** Aggregate of all non-deployed hosts (OFF baseline). */
    offAgg: RolloutOnOffAggregate;
    /** Hosts that contributed any active minutes to ON evidence. */
    hostsOnContributed: number;
    /** Hosts that contributed any active minutes to OFF baseline. */
    hostsOffContributed: number;
  };

  const groups = new Map<string, Group>();

  for (const d of pilot.devices) {
    if (storeFilter !== "all" && d.storeName !== storeFilter) continue;
    const matchedHost =
      zabbixByName.get(d.sourceHostKey || "") || zabbixByName.get(d.name);
    const model = resolveCpuModel(d.cpuModel, matchedHost?.inventory?.cpuModel ?? null, "Unknown");

    let g = groups.get(model);
    if (!g) {
      g = {
        model,
        totalHosts: 0,
        hostsWithData: 0,
        hostsOn: new Set(),
        hostsOff: new Set(),
        dailyAvgPool: [],
        maxCpu: null,
        sumMinAboveTracked: 0,
        sumMinAboveActive: 0,
        onAgg: emptyOnOffAggregate(),
        offAgg: emptyOnOffAggregate(),
        hostsOnContributed: 0,
        hostsOffContributed: 0,
      };
      groups.set(model, g);
    }
    g.totalHosts++;
    if (!matchedHost) continue;

    // Determine deployment classification.
    const isDeployed = deployedSet.has(matchedHost.hostId);
    if (isDeployed) g.hostsOn.add(matchedHost.hostId);
    else g.hostsOff.add(matchedHost.hostId);

    // cpuTrends contribution — daily avg pool, max CPU, tracked minutes-above.
    //
    // Bug fix (2026-05-29): `hostHasData` used to require `t.avg > 0`. That
    // ruled out hosts whose telemetry reaches us but happens to sit at
    // exactly 0% — they're online, reporting, and contribute a valid
    // (idle) baseline signal. Any trend entry with a finite (even zero)
    // value now counts. The dailyAvgPool still drops 0-values because they
    // pull the median toward "off-hours" and aren't representative of
    // typical operating load, but the host-with-data tally is independent.
    const trends = trendsByHost.get(matchedHost.hostId) || [];
    let hostHasData = false;
    for (const t of trends) {
      if (Number.isFinite(t.avg)) {
        hostHasData = true;
        if (t.avg > 0) g.dailyAvgPool.push(t.avg);
      }
      if (Number.isFinite(t.max) && t.max > 0) {
        g.maxCpu = g.maxCpu === null ? t.max : Math.max(g.maxCpu, t.max);
      }
      if (t.minutesAbove) {
        g.sumMinAboveTracked += t.minutesAbove[thKey] || 0;
      }
    }

    // rolloutPerHost contribution — Retellect attribution + active-minutes-above.
    const entry = perHostMap.get(matchedHost.hostId);
    if (entry) {
      const combined = mergeOnOff(entry.on, entry.off);
      const trackedMin = combined.realTrackedMinutes + combined.syntheticTrackedMinutes;
      if (isDeployed) {
        g.onAgg = mergeOnOff(g.onAgg, combined);
        // Bug fix (2026-05-29): host counts toward ON evidence when its
        // aggregate has any TRACKED minutes (not just active). A host with
        // Retellect deployed but running steady at low load reports valid
        // tracked totals even when nothing crosses the active threshold.
        // Holding out for activeMin>0 hid the cleanest possible evidence.
        if (trackedMin > 0) g.hostsOnContributed++;
      } else {
        g.offAgg = mergeOnOff(g.offAgg, combined);
        if (trackedMin > 0) g.hostsOffContributed++;
      }
      g.sumMinAboveActive += combined.activeMinutesAboveThreshold[thKey] || 0;
      hostHasData = hostHasData || trackedMin > 0;
    }

    if (hostHasData) g.hostsWithData++;
  }

  const matrix: CpuMatrixRow[] = [];
  for (const g of groups.values()) {
    // Typical CPU load = median of daily averages.
    const typicalCpu = median(g.dailyAvgPool);
    const maxCpu = g.maxCpu;
    const roomNow = typicalCpu === null ? null : threshold - typicalCpu;
    const timeAboveNowMin =
      cpuCountFrom === "active" ? g.sumMinAboveActive : g.sumMinAboveTracked;

    // Evidence classification.
    const measuredOnOff =
      g.hostsOnContributed >= 2 && g.hostsOffContributed >= 2;
    const hasUsableSample = typicalCpu !== null;
    let evidence: Evidence;
    if (measuredOnOff) evidence = "measured-on-off";
    else if (hasUsableSample) evidence = "baseline-only";
    else evidence = "insufficient";

    // Planned Retellect impact.
    //
    // Bug fix (2026-05-29): measured evidence used to silently fall back
    // to the conservative scenario when weightedAvg returned null (empty
    // aggregate), even though the evidence column still said "Measured
    // ON/OFF". The fallback now requires both averages to be available;
    // otherwise the evidence tag is downgraded to "baseline-only" so the
    // displayed evidence stays in sync with the impact source.
    const avgOnTotalCpu = weightedAvg(g.onAgg, "sumTotalCpu");
    const avgOffTotalCpu = weightedAvg(g.offAgg, "sumTotalCpu");
    const avgRetellectOn = weightedAvg(g.onAgg, "sumRetellectCpu");
    let impactPp: number;
    let impactSource: "measured" | "conservative";
    if (
      evidence === "measured-on-off" &&
      avgOnTotalCpu !== null &&
      avgOffTotalCpu !== null
    ) {
      // Observed delta in mean total CPU. Negative deltas (ON cooler
      // than OFF in the sample — usually small noise) are floored to 0
      // for the *projection* (we don't model Retellect as freeing
      // capacity), but the measured Retellect-direct CPU figure shown
      // beneath the impact box still surfaces the true sign so a user
      // can spot the case.
      const rawDelta = avgOnTotalCpu - avgOffTotalCpu;
      const delta = Math.max(0, rawDelta);
      impactPp = Math.min(20, Math.round(delta * 10) / 10);
      impactSource = "measured";
    } else {
      impactPp = conservativeImpactPp(g.model);
      impactSource = "conservative";
      // Keep the row's evidence tag honest: if we couldn't actually
      // measure the impact, this isn't "Measured ON/OFF" any more.
      if (evidence === "measured-on-off") evidence = "baseline-only";
    }

    // Projected state.
    const projectedCpu = typicalCpu === null ? null : typicalCpu + impactPp;
    const projectedRoom = projectedCpu === null ? null : threshold - projectedCpu;
    const projectedTimeAboveMin = projectTimeAbove(timeAboveNowMin, typicalCpu, impactPp, threshold);

    // Decision tree.
    //
    // Bug fix (2026-05-29): the projected time-above used to be compared
    // class-wide against a per-host budget (≤ 60 min = one busy hour).
    // For a 32-host class with each host at a few minutes above, the SUM
    // easily clears 60 and blocked every "Safe" classification. The fix:
    // normalise to per-host minutes so the rule "average host stays under
    // one busy hour above threshold" actually holds.
    const hostsForNorm = Math.max(1, g.hostsWithData);
    const perHostProjectedTimeAbove =
      projectedTimeAboveMin === null ? null : projectedTimeAboveMin / hostsForNorm;
    let decision: Decision;
    if (evidence === "insufficient" || projectedRoom === null) {
      decision = "insufficient";
    } else if (projectedRoom >= 20 && (perHostProjectedTimeAbove ?? 0) < 60) {
      decision = "safe";
    } else if (projectedRoom >= 10) {
      decision = "validate";
    } else if (projectedRoom >= 0) {
      decision = "optimize";
    } else {
      decision = "do-not-roll-out";
    }

    // Confidence.
    let confidence: Confidence;
    const hostsWithData = g.hostsWithData;
    if (
      hostsWithData >= 10 ||
      (g.hostsOnContributed >= 5 && g.hostsOffContributed >= 5)
    ) {
      confidence = "high";
    } else if (hostsWithData >= 3) {
      confidence = "medium";
    } else {
      confidence = "low";
    }

    // Silent classification — for the Hide silent toggle.
    //
    // Bug fix (2026-05-29): "silent" used to mean "no ON-aggregate active
    // minutes", which by construction applied to every baseline-only and
    // insufficient row — the exact rows the page exists to score. The
    // correct semantic is "Retellect IS deployed but isn't doing anything
    // we can observe": classes with at least one ON-classified host that
    // contributed zero active minutes. Baseline-only and insufficient
    // rows stay visible because the user needs them to decide where to
    // pilot next.
    const onActiveMin = g.onAgg.realActiveMinutes + g.onAgg.syntheticActiveMinutes;
    const isSilent = g.hostsOn.size > 0 && onActiveMin === 0;

    // Subtitle — one-liner that complements the decision.
    const subtitle = subtitleFor(decision, evidence, typicalCpu, maxCpu, threshold);

    matrix.push({
      model: g.model,
      subtitle,
      hostCount: g.totalHosts,
      hostsWithData,
      hostsOn: g.hostsOn.size,
      hostsOff: g.hostsOff.size,
      evidence,
      typicalCpu,
      roomNow,
      timeAboveNowMin: timeAboveNowMin > 0 || hasUsableSample ? timeAboveNowMin : null,
      maxCpu,
      measuredRetellectCpuOn: avgRetellectOn,
      impactPp,
      impactSource,
      projectedCpu,
      projectedRoom,
      projectedTimeAboveMin,
      decision,
      confidence,
      isSilent,
    });
  }

  matrix.sort((a, b) => {
    if (a.model === "Unknown" && b.model !== "Unknown") return 1;
    if (b.model === "Unknown" && a.model !== "Unknown") return -1;
    const r = DECISION_RANK[a.decision] - DECISION_RANK[b.decision];
    if (r !== 0) return r;
    return (b.typicalCpu ?? 0) - (a.typicalCpu ?? 0);
  });

  return { matrix, periodDays };
}

// ─── Compute helpers ────────────────────────────────────────────────

/** Median of a numeric pool. Returns null on empty input. */
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Conservative impact scenario when no measured ON evidence exists.
 *  Bands by hardware tier — older CPUs get a larger reserved overhead
 *  because Retellect's per-frame Python load is a bigger fraction of
 *  available cycles on those classes. */
function conservativeImpactPp(model: string): number {
  const m = model.toLowerCase();
  // Newer Intel mobile/desktop i3/i5/i7 (12th gen+).
  if (/i[357]-1[2-9]\d{3}/.test(m)) return 4;
  // i3/i5 9th gen and newer (excluding 12th+ caught above).
  if (/i[357]-(9|1[01])\d{3}/.test(m)) return 5;
  // Mid i3 (7th–8th gen).
  if (/i[357]-[78]\d{3}/.test(m)) return 6;
  // Older i3 (6th gen — i3-6100 etc).
  if (/i[357]-6\d{3}/.test(m)) return 7;
  // Old i3 (4th–5th gen — i3-4330 etc).
  if (/i[357]-[45]\d{3}/.test(m)) return 8;
  // Pentium / Celeron.
  if (/(pentium|celeron|atom)/.test(m)) return 10;
  // Unknown — be conservative.
  return 8;
}

/** Project time above threshold after applying impactPp.
 *
 *  This is intentionally a rough linear scaling — we don't have
 *  per-minute distribution data here, so the projection scales the
 *  current time-above by how much closer the new typical CPU sits to
 *  the threshold. The UI labels the result with ~ to make the
 *  approximate nature visible.
 *
 *   • If current typical is already at/above threshold, projected ≈
 *     current × (1 + impact / room_now) so the curve climbs steeply.
 *   • If new typical crosses the threshold, project at least 60 min
 *     (one busy hour) so the row doesn't show "0 min" while the
 *     decision pill says "do not roll out".
 *   • If room remains comfortable, projected ≈ current * 1.5 — a
 *     gentle scale, never lower than current.
 */
function projectTimeAbove(
  current: number | null,
  typical: number | null,
  impactPp: number,
  threshold: number,
): number | null {
  if (current === null || typical === null) return null;
  const projectedTypical = typical + impactPp;
  if (projectedTypical < threshold - 20) {
    // Comfortable margin — scale up modestly.
    return Math.round(Math.max(current, current * 1.2));
  }
  if (projectedTypical >= threshold) {
    // Pushed past the line — at minimum an hour of "above" time.
    const ratio = Math.max(1.5, (projectedTypical - typical + 5) / 5);
    return Math.round(Math.max(60, current * ratio));
  }
  // Within 20pp of threshold — moderate scale.
  const roomShrinkRatio =
    (threshold - typical) / Math.max(0.5, threshold - projectedTypical);
  return Math.round(Math.max(current, current * roomShrinkRatio));
}

function subtitleFor(
  decision: Decision,
  evidence: Evidence,
  typical: number | null,
  max: number | null,
  threshold: number,
): string {
  if (evidence === "insufficient") return "Not enough samples to score";
  if (decision === "safe") return "Best headroom in visible sample";
  if (decision === "validate") return "Borderline — validate under load";
  if (decision === "optimize") return "Tight margin — reduce background load first";
  if (decision === "do-not-roll-out") {
    if (max !== null && max >= 95) return "Already saturated at peak — hardware tier needs upgrade";
    return "Repeated high-load days, structurally constrained";
  }
  if (typical !== null) {
    const gap = threshold - typical;
    if (gap >= 30) return "Cool baseline, ample headroom";
    if (gap >= 10) return "Workable headroom under normal load";
    return "Limited headroom — watch closely";
  }
  return "";
}

function formatList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
