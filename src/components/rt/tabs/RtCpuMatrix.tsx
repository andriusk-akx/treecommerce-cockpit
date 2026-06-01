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

import { useDeferredValue, useEffect, useMemo, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { RtPilotData, ZabbixData, ZabbixCpuTrend } from "../RtPilotWorkspace";
import { useRtFilters } from "../RtFiltersContext";
import { resolveCpuModel } from "./rt-inventory-helpers";
import { mergeOnOff, weightedAvg } from "@/lib/rollout-insights/aggregate";
import { emptyOnOffAggregate } from "@/lib/rollout-insights/types";
import type {
  ActiveAboveBucket,
  RolloutOnOffAggregate,
  RolloutPerHostEntry,
} from "@/lib/rollout-insights/types";
import { ACTIVE_ABOVE_BUCKETS } from "@/lib/rollout-insights/types";
import { FilterBar, FilterRow, FilterSelect, FilterSegmented, FilterDivider } from "../filters/RtFilterControls";

// ─── Types ──────────────────────────────────────────────────────────

type Decision =
  | "safe"           // green — safe to roll out
  | "validate"       // amber — validate next
  | "optimize"       // amber-red — optimize first
  | "do-not-roll-out"// red — do not roll out
  | "insufficient";  // grey — not enough data to decide

type Confidence = "high" | "medium" | "low";

/** What we know about a CPU class for the rollout decision.
 *  Labels:
 *    measured-on-off → "Measured ON/OFF"
 *    no-on-data      → "No Retellect ON data yet"
 *    insufficient    → "Insufficient evidence"
 *  (Was "no-on-data" — renamed per the agreed terminology so the UI
 *  reads as a decision-grade statement rather than a data-source label.) */
type Evidence =
  | "measured-on-off"
  | "no-on-data"
  | "insufficient";

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
  /** Length of the sampling window in days — used to normalise
   *  time-above-threshold counts to a per-day RATE so changing the
   *  Period dropdown doesn't change the displayed intensity for a
   *  stable workload. */
  periodDays: number;
  /** Physical core count for this CPU model. Null when the model
   *  string doesn't match a known SKU; row falls back to no spec line. */
  cpuCores: number | null;
  /** Logical thread count (cores × SMT factor). */
  cpuThreads: number | null;
  /** Ordinal performance rank, higher = stronger. -1 for unrecognised
   *  models so they sort to the bottom alongside "Unknown". */
  cpuRank: number;

  // ── Current state ─────────────────────────────────────────────────
  /** Median of per (host, day) daily averages — "typical CPU load". */
  typicalCpu: number | null;
  /** Threshold − typicalCpu (positive = headroom). */
  roomNow: number | null;
  /** Sum of minutes above the chosen threshold across the class.
   *  cpuCountFrom switches between active-only and all-tracked. */
  timeAboveNowMin: number | null;
  /** Per-threshold-bucket minutes-above counts summed across the class.
   *  Drives the principled projected-time-above calculation: shifting
   *  CPU up by +impact_pp means projected minutes above `threshold` =
   *  current minutes above `threshold − impact_pp`. Linear interpolation
   *  between adjacent buckets approximates non-grid values. */
  minutesAboveByBucket: Record<ActiveAboveBucket, number>;
  /** Max of per-host daily max — class-wide worst peak. */
  maxCpu: number | null;
  /** Measured Retellect direct CPU on ON hosts (avg over active min).
   *  Surfaced as supporting context under the impact box. */
  measuredRetellectCpuOn: number | null;

  // ── Planned impact ────────────────────────────────────────────────
  /** Effective Planned Retellect impact in percentage points — this is
   *  the value the projection / decision are calculated from. Defaults
   *  to the measured-delta or per-tier conservative value, but can be
   *  overridden manually by the user via the per-row input. */
  impactPp: number;
  /** Source of the impact figure. */
  impactSource: "measured" | "conservative" | "manual";
  /** Default impact (auto-derived) — preserved so the user can reset
   *  back to it after manually overriding. */
  defaultImpactPp: number;
  /** True when the user has explicitly entered a value for this CPU
   *  class. Drives the supporting-line text and the "Reset" affordance. */
  hasManualOverride: boolean;

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

const EVIDENCE_LABEL: Record<Evidence, string> = {
  "measured-on-off": "Measured A/B",
  "no-on-data": "No ON data",
  insufficient: "Too few hosts",
};

const EVIDENCE_TIP: Record<Evidence, string> = {
  "measured-on-off":
    "Direct A/B: ≥2 hosts ON and ≥2 hosts OFF contributed active-minute samples, so the impact figure is observed, not modelled.",
  "no-on-data":
    "Conservative tier scenario. No Retellect ON evidence in this class yet — projection uses the per-tier default impact value.",
  insufficient:
    "Sample too small to score this class. Need more hosts with telemetry before a rollout decision is defensible.",
};

const CONFIDENCE_TONE: Record<Confidence, string> = {
  high: "text-emerald-700",
  medium: "text-amber-700",
  low: "text-gray-500",
};

const CONFIDENCE_TIP: Record<Confidence, string> = {
  high: "High confidence — ≥10 hosts with data, or Measured A/B with ≥5 each side.",
  medium: "Medium confidence — 3–9 hosts contributing.",
  low: "Low confidence — fewer than 3 hosts. Treat as directional.",
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
  // Current page contract: calculation is always from ALL minutes in the
  // selected period. Active-only mode is on the roadmap but disabled in
  // the UI for now (see Minute scope below), so we force the compute
  // input to "tracked" regardless of what the cross-tab filter context
  // happens to hold from the legacy heatmap.
  const cpuCountFrom = "tracked" as const;

  // Period selector mirrors RtTimeline / RtRolloutInsights — URL-driven
  // so a deep link keeps the same window. Period changes trigger a
  // SERVER-side refetch (the page server component reads ?period= and
  // rebuilds cpuTrends / rolloutPerHost for the new window), which can
  // take several seconds on a 90d window. useTransition exposes a
  // pending flag while the navigation is in flight so we can show the
  // Updating... badge below — without it, the user clicks 90d and
  // perceives the page as frozen until the new data lands.
  const router = useRouter();
  const pathname = usePathname();
  const urlSearchParams = useSearchParams();
  const [isPeriodPending, startPeriodTransition] = useTransition();
  useEffect(() => {
    const urlPeriod = urlSearchParams.get("period");
    if (!urlPeriod) return;
    // Bug fix (2026-06-01): an old bookmark with ?period=90d would
    // restore "90d" into filter state — display'd then collapse to
    // 30d via the FilterSegmented `value=` remap, while the actual
    // server fetch kept using 90d. Normalise on read so URL + state
    // + UI all agree.
    const normalised = urlPeriod === "90d" ? "30d" : urlPeriod;
    if (normalised !== filters.period) {
      setFilter("period", normalised);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlSearchParams]);
  const setPeriod = (v: string) => {
    setFilter("period", v);
    const live = typeof window !== "undefined" ? window.location.search : `?${urlSearchParams.toString()}`;
    const params = new URLSearchParams(live);
    params.set("period", v);
    startPeriodTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
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
    isPeriodPending ||
    deferredThreshold !== threshold ||
    deferredStore !== storeFilter ||
    deferredCountFrom !== cpuCountFrom;

  // Build decision matrix from the deferred inputs.
  const { matrix: baselineMatrix, periodDays, fleetTotal } = useMemo(
    () => computeCpuMatrix(pilot, zabbix, deferredThreshold, deferredStore, deferredCountFrom),
    [pilot, zabbix, deferredThreshold, deferredStore, deferredCountFrom],
  );

  // ── Custom (manual) Planned Retellect impact, keyed by CPU model ──
  //
  // The Planned Retellect impact column is intentionally manual: an
  // analyst can override the system-derived default per CPU class to
  // try "what if Retellect adds +12 pp on this tier?" The override is
  // persisted per (pilot, model) so the next visit picks up where the
  // analyst left off.
  //
  // Empty string clears the override (back to default).
  const impactStorageKey = `rtCpuMatrixImpacts:${pilot.id}`;
  const [customImpacts, setCustomImpacts] = useState<Record<string, number>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const raw = window.localStorage.getItem(impactStorageKey);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return {};
      // Bug fix (2026-05-29): the old `as Record<string, number>` was an
      // unchecked assertion. A corrupted/legacy entry (string value,
      // null, etc.) would flow into Math.min(30, "8.5") → NaN, then
      // into value.toFixed(1) → "NaN", and every projection on the
      // affected row turned into NaN. Validate each entry up front and
      // drop anything that isn't a finite number in [0, 30].
      const cleaned: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v !== "number" || !Number.isFinite(v)) continue;
        if (v < 0 || v > 30) continue;
        cleaned[k] = v;
      }
      return cleaned;
    } catch {
      return {};
    }
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(impactStorageKey, JSON.stringify(customImpacts));
    } catch {
      // Quota / privacy mode — silent.
    }
  }, [customImpacts, impactStorageKey]);

  const setImpactFor = (model: string, value: number | null) => {
    setCustomImpacts((prev) => {
      const next = { ...prev };
      if (value === null) delete next[model];
      else next[model] = value;
      return next;
    });
  };

  // Overlay customImpacts onto the baseline matrix — recomputes
  // projection + decision per row, but reuses the heavy current-state
  // numbers from the baseline pass.
  const matrix = useMemo(() => {
    return baselineMatrix.map((row) => {
      const override = customImpacts[row.model];
      const hasManualOverride =
        override !== undefined && Number.isFinite(override) && override !== row.defaultImpactPp;
      if (!hasManualOverride) return row;
      const effective = Math.max(0, Math.min(30, override));
      const re = applyImpact(row, effective, deferredThreshold);
      return {
        ...row,
        impactPp: effective,
        impactSource: "manual" as const,
        hasManualOverride: true,
        projectedCpu: re.projectedCpu,
        projectedRoom: re.projectedRoom,
        projectedTimeAboveMin: re.projectedTimeAboveMin,
        decision: re.decision,
      };
    });
  }, [baselineMatrix, customImpacts, deferredThreshold]);

  const filteredMatrix = useMemo(() => {
    if (!hideSilent) return matrix;
    return matrix.filter((r) => !r.isSilent);
  }, [matrix, hideSilent]);

  // ── Sequential drilldown selection ────────────────────────────────
  //
  // Two-level state machine for the bottom workspace:
  //   selectedModel === null  → fleet-level summary cards (drivers /
  //                             actions / limits) visible.
  //   selectedModel set        → drilldown workspace visible, replaces
  //                             the fleet cards. State 1 = host list.
  //   + selectedHostId set     → drilldown is in State 2 (per-host
  //                             evidence summary). Cleared whenever
  //                             selectedModel changes so a CPU swap
  //                             always returns the user to the host
  //                             list, not to a stale host detail.
  //
  // Click the same matrix row twice to collapse — explicit escape hatch
  // for users who selected by accident.
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const onMatrixRowSelect = (model: string) => {
    setSelectedModel((cur) => (cur === model ? null : model));
    setSelectedHostId(null);
  };
  // If the active filters pruned the selected model out of view, drop
  // the selection so the workspace doesn't dangle.
  useEffect(() => {
    if (selectedModel === null) return;
    const stillVisible = filteredMatrix.some((r) => r.model === selectedModel);
    if (!stillVisible) {
      setSelectedModel(null);
      setSelectedHostId(null);
    }
  }, [filteredMatrix, selectedModel]);
  const selectedRow = selectedModel
    ? matrix.find((r) => r.model === selectedModel) ?? null
    : null;

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
          {/* 90d removed (2026-06-01) — Zabbix trend.get retention only
              reliably covers ~29 days, so a 90d window mostly returned
              empty later periods and made the matrix look like it was
              missing data. Keep the three windows that map to actual
              retention. */}
          <FilterSegmented<string>
            label="Period"
            value={filters.period === "90d" ? "30d" : filters.period}
            options={[
              { v: "7d", l: "7d" },
              { v: "14d", l: "14d" },
              { v: "30d", l: "30d" },
            ]}
            onChange={setPeriod}
          />
          <FilterSegmented<"tracked" | "active">
            label="Minute scope"
            value="tracked"
            info="Current effective calculation: All minutes in the selected period. Active-only mode (busy-windows-only) is planned for a future iteration."
            options={[
              { v: "tracked", l: "All minutes" },
              {
                v: "active",
                l: "Active only (later)",
                title: "Active-only mode (restricting the calculation to busy windows) is planned for a later release.",
                disabled: true,
              },
            ]}
            onChange={() => {
              /* no-op — Active only is intentionally disabled for now;
                 the current page always computes from all tracked minutes. */
            }}
          />
          <button
            type="button"
            onClick={() => setHideSilent((s) => !s)}
            className={`inline-flex items-center px-3 py-1.5 rounded border text-[11px] font-medium transition ${
              hideSilent
                ? "bg-amber-50 text-amber-800 border-amber-300"
                : "bg-white text-gray-600 border-gray-200 hover:border-gray-300"
            }`}
            title="Hide CPU classes with no Retellect activity observed in the period"
          >
            Hide silent
          </button>
          {/* The "Updating window…" pill lives as a centered overlay on
              the matrix itself (further down) — same visual treatment
              as CPU Timeline so the two tabs feel identical during a
              period change. */}
        </FilterRow>
      </FilterBar>

      <p className="text-[11px] text-gray-500 mb-6 leading-relaxed">
        Threshold drives <strong className="text-gray-700 font-medium">time above</strong> and{" "}
        <strong className="text-gray-700 font-medium">room to threshold</strong>. Classes without ON evidence use a scenario impact;
        calculations include all minutes in the period.
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
            sorted by CPU tier (weakest first) · {periodDays}-day window
          </span>
        </div>

        {filteredMatrix.length === 0 ? (
          <div className="bg-white rounded-lg border border-gray-200 px-5 py-10 text-center text-sm text-gray-400">
            {matrix.length === 0
              ? "Not enough CPU history to score rollout. Check Data Health."
              : "All classes filtered out by Hide silent — no Retellect activity observed in this window."}
          </div>
        ) : (
          <div className="relative bg-white rounded-lg border border-gray-200 overflow-x-auto">
            {/* Centered overlay updating pill — same visual treatment as
                CPU Timeline so the user sees identical feedback when
                changing the Period dropdown on either tab. Positioned
                near the top of the table, opacity:2 counteracts the
                parent's opacity-60 dim so the pill stays fully visible. */}
            {isRefreshing && (
              <div
                role="status"
                aria-live="polite"
                style={{
                  position: "absolute",
                  top: 60,
                  left: "50%",
                  transform: "translateX(-50%)",
                  opacity: 2,
                  pointerEvents: "none",
                  zIndex: 10,
                }}
              >
                <span
                  title="Recomputing the matrix for the new window — typically 30–60 s on a cold cache."
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 12,
                    color: "#0369a1",
                    background: "#f0f9ff",
                    border: "1px solid #bae6fd",
                    borderRadius: 999,
                    padding: "6px 14px",
                    boxShadow: "none",
                    fontWeight: 500,
                  }}
                >
                  <svg
                    className="animate-spin"
                    width={14}
                    height={14}
                    viewBox="0 0 24 24"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
                    <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
                  </svg>
                  Updating window…
                </span>
              </div>
            )}
            <table className="w-full text-sm min-w-[1060px]">
              <thead>
                <tr className="bg-gray-50/60 border-b border-gray-200">
                  <th className="text-left py-3 px-4 text-xs font-semibold text-gray-600 uppercase tracking-widest w-[200px]">CPU class</th>
                  <th className="text-left py-3 px-3 text-xs font-semibold text-gray-600 uppercase tracking-widest">Current state</th>
                  <th className="text-left py-3 px-3 text-xs font-semibold text-gray-600 uppercase tracking-widest w-[150px]">Planned impact</th>
                  <th className="text-left py-3 px-3 text-xs font-semibold text-gray-600 uppercase tracking-widest">Projected state</th>
                  {/* Evidence sits immediately before Decision so the
                      reader's eye picks up the supporting sample size
                      right before the verdict it backs. */}
                  <th className="text-left py-3 px-3 text-xs font-semibold text-gray-600 uppercase tracking-widest w-[120px]">Evidence</th>
                  <th
                    className="text-center py-3 px-3 text-xs font-semibold text-gray-600 uppercase tracking-widest w-[200px] cursor-help"
                    title="Rollout verdict + how confident we are."
                  >
                    Decision
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredMatrix.map((row) => (
                  <MatrixRowView
                    key={row.model}
                    row={row}
                    threshold={threshold}
                    fleetTotal={fleetTotal}
                    onImpactChange={setImpactFor}
                    isSelected={row.model === selectedModel}
                    onSelect={onMatrixRowSelect}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Drilldown OR fleet cards ───────────────────────────────────
          Sequential drilldown takes over the bottom workspace when a
          CPU class is selected. Fleet-level summary cards (drivers /
          actions / limits) are the default when nothing is selected —
          they're still useful at-a-glance answers when the user is just
          scanning the matrix. The swap (not a stack) keeps the page
          focused on one investigation level at a time, per the IA spec. */}
      {selectedRow ? (
        <CpuDrilldownWorkspace
          row={selectedRow}
          threshold={threshold}
          periodDays={periodDays}
          pilot={pilot}
          zabbix={zabbix}
          selectedHostId={selectedHostId}
          onSelectHost={setSelectedHostId}
          onClose={() => {
            setSelectedModel(null);
            setSelectedHostId(null);
          }}
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
          <BottleneckDriversCard matrix={matrix} threshold={threshold} />
          <RecommendedActionsCard matrix={matrix} />
          <ConfidenceLimitsCard matrix={matrix} />
        </div>
      )}

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

function MatrixRowView({
  row,
  threshold,
  fleetTotal,
  onImpactChange,
  isSelected,
  onSelect,
}: {
  row: CpuMatrixRow;
  threshold: number;
  /** Total devices in the (store-filtered) pilot — denominator for the
   *  per-class "% of fleet" line. Includes unmonitored hosts on purpose
   *  so the share reflects physical inventory, not monitoring coverage. */
  fleetTotal: number;
  onImpactChange: (model: string, value: number | null) => void;
  isSelected: boolean;
  onSelect: (model: string) => void;
}) {
  // Compute rollout-priority signal — surfaces "what to do with this
  // class strategically?" beyond the decision colour. Subtle, not loud:
  // small grey/coloured label under the evidence badge, only when the
  // class actually merits a priority tag. Most rows show nothing.
  const priority = computePriority(row);
  // Class share of fleet. Rendered as a small highlighted chip so the
  // decision-maker can scan "how big is this segment of the rollout?"
  // at a glance without comparing absolute counts across rows. The chip
  // shows ONLY the percent — the absolute counts live in the Evidence
  // base column to avoid the same numbers appearing twice in one row.
  const sharePct =
    fleetTotal > 0 ? Math.round((row.hostCount / fleetTotal) * 100) : 0;
  // Coverage gap = hosts in the class with no telemetry: either
  // unmonitored (no Zabbix link) or monitored but silent (broken agent).
  // Surfaced explicitly in the Evidence base cell so the user knows how
  // much of the class the metrics actually speak for.
  const coverageGap = Math.max(0, row.hostCount - row.hostsWithData);
  return (
    <tr
      className={`border-t border-gray-100 align-top cursor-pointer transition-colors focus:outline-none focus:bg-blue-50/40 ${
        isSelected
          ? "bg-blue-50/60"
          : "hover:bg-gray-50/60"
      }`}
      onClick={() => onSelect(row.model)}
      // Bug fix (2026-06-01): clickable rows had no keyboard affordance.
      // Tab focus + Enter/Space now mirrors the mouse interaction so
      // keyboard-only operators (and screen readers) can drive the
      // drilldown. role=button signals the semantic.
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(row.model);
        }
      }}
      tabIndex={0}
      // Native <tr role> is "row" inside a <table>, which supports
      // aria-selected. Explicit role="button" was breaking that;
      // dropped it. Keyboard / click handlers still drive selection.
      aria-selected={isSelected}
      title={
        isSelected
          ? "Click again to close the drilldown."
          : "Click to open hosts in this CPU class."
      }
    >
      {/* CPU class — now strictly identity: model, cores/threads, and the
          fleet-share chip. The interpretation signals (subtitle, evidence
          badge, priority badge) moved into the Decision cell where they
          read alongside the decision they qualify, instead of cluttering
          the inventory identity. */}
      <td className={`py-4 px-4 relative ${isSelected ? "border-l-4 border-l-blue-500 pl-3" : ""}`}>
        <div className="font-semibold text-gray-900">{row.model}</div>
        {row.cpuCores !== null && row.cpuThreads !== null && (
          <div className="text-[10px] text-gray-400 mt-0.5 tabular-nums font-medium uppercase tracking-wide">
            {row.cpuCores}C / {row.cpuThreads}T
          </div>
        )}
        {fleetTotal > 0 && (
          <div
            className="inline-flex items-center gap-1 mt-1.5 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-sky-50 text-sky-700 border border-sky-200 tabular-nums cursor-help whitespace-nowrap"
            title={`This CPU class covers ${row.hostCount} of ${fleetTotal} devices (${sharePct}%) in the pilot${fleetTotal === row.hostCount ? "" : ", counting hosts without Zabbix monitoring or telemetry too"}. Useful as a priority signal — risk on a large segment matters more than the same risk on a small one.`}
          >
            <span className="w-1 h-1 rounded-full bg-sky-500" />
            {sharePct}% of fleet
            <span className="font-normal text-sky-600/80">· {row.hostCount} {row.hostCount === 1 ? "host" : "hosts"}</span>
          </div>
        )}
      </td>

      {/* Current state — note time-above is shown PER HOST (averaged
          across the hosts in this class) so it matches the user's
          natural reading. The internal decision logic already
          normalises per-host (perHostProjectedTimeAbove < 60 min) so
          the displayed value now matches the decision logic.
          Evidence base used to sit before this column but moved to
          just before Decision so the supporting sample size reads
          alongside the verdict it backs. */}
      <td className="py-4 px-3">
        <MiniStack
          rows={[
            {
              label: "Typical CPU load",
              value: row.typicalCpu,
              unit: "%",
              bar: "used",
              tip: "Median CPU over the selected period.",
              valueColor: typicalLoadColor(row.typicalCpu, threshold),
            },
            {
              label: "Room to threshold",
              value: row.roomNow,
              unit: "pp",
              bar: "buffer",
              tip: "Percentage points from the typical (median) CPU load to the selected threshold. Note: this is measured from the typical load — peaks (see Max CPU) may still cross the threshold even when the room number looks comfortable.",
              valueColor: roomColor(row.roomNow),
            },
            {
              label: "Time above threshold",
              value: perHostPerDay(row.timeAboveNowMin, row.hostsWithData, row.periodDays),
              unit: "min/d",
              bar: "used",
              tip: "Average minutes per host per day above the selected CPU threshold, normalised over the selected period. Period-invariant for stable workloads — choosing 7d vs 30d vs 90d changes the sampling-window confidence, not the displayed intensity.",
              valueColor: timeAboveColor(
                perHostPerDay(row.timeAboveNowMin, row.hostsWithData, row.periodDays),
              ),
            },
            {
              label: "Max CPU",
              value: row.maxCpu,
              unit: "%",
              bar: "ghost",
              tip: "Highest observed CPU value in the selected period across the class. Supporting context: a high Max CPU with a calm Typical load means the workload is spiky — peaks may already cross the threshold even when room-to-threshold looks comfortable.",
              secondary: true,
              valueColor: maxCpuColor(row.maxCpu),
            },
          ]}
          threshold={threshold}
        />
      </td>

      {/* Planned Retellect impact — editable (except when there is no
          typical-CPU baseline to project from). For "Insufficient
          evidence" rows the Projected state cell already reads
          "No projection available", so an editable input here would be
          a vanity control: it would accept input, persist it, but
          change nothing visible because applyImpact pins the decision
          to "insufficient" whenever typicalCpu is null. */}
      {/* stopPropagation on this cell keeps the editable controls
          self-contained — a click inside the impact input or the Reset
          link must not bubble up to the row-level onSelect handler. */}
      <td className="py-4 px-3" onClick={(e) => e.stopPropagation()}>
        <ImpactInput
          model={row.model}
          value={row.impactPp}
          defaultValue={row.defaultImpactPp}
          hasManualOverride={row.hasManualOverride}
          disabled={row.evidence === "insufficient"}
          onChange={onImpactChange}
        />
        <div className="text-[11px] mt-3 leading-snug">
          {row.hasManualOverride ? (
            <span className="text-amber-700 font-medium">Manual override</span>
          ) : row.evidence === "measured-on-off" &&
              row.measuredRetellectCpuOn !== null &&
              row.measuredRetellectCpuOn > 0.05 ? (
            // Bug fix (2026-05-29): only show measured Reference
            // evidence when the row's evidence column also says
            // "Measured A/B". Otherwise we'd contradict the evidence
            // tag — a row labelled "No ON data" can still have a
            // non-null avgRetellectOn when exactly one host
            // contributed python.cpu (the ≥2/≥2 measured-on-off rule
            // failed). The label below would then claim measured
            // evidence the column says we don't have.
            <span className="text-emerald-700 font-medium">
              Measured: {row.measuredRetellectCpuOn.toFixed(1)}%
            </span>
          ) : (
            <span className="text-gray-400">Scenario default</span>
          )}
        </div>
      </td>

      {/* Projected state — projected time-above shown PER HOST in the
          same units as Current state for honest visual comparison. */}
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
                tip: "Projected median CPU after applying the Planned Retellect impact.",
                valueColor: typicalLoadColor(row.projectedCpu, threshold),
              },
              {
                label: "Room to threshold",
                value: row.projectedRoom,
                unit: "pp",
                bar: "buffer",
                approx: true,
                tip: "Percentage points from the projected typical CPU load to the selected threshold. Same caveat as in Current state: peaks may still cross even when this number looks comfortable.",
                valueColor: roomColor(row.projectedRoom),
              },
              {
                // Label says "Time above threshold" to mirror the
                // Current CPU state column so the eye can compare the
                // two values side-by-side at the same row offset. The
                // "Projected" qualifier is supplied by the column
                // header ("Projected CPU state") and reinforced by the
                // tooltip — preserves the spec's intent of
                // distinguishing modeled from measured without
                // truncating the label.
                label: "Time above threshold",
                value: perHostPerDay(
                  row.projectedTimeAboveMin,
                  row.hostsWithData,
                  row.periodDays,
                ),
                unit: "min/d",
                bar: "used",
                approx: true,
                tip: "Projected time above threshold — estimated minutes per host per day above the threshold after applying the Planned Retellect impact. Modeled value derived from the underlying per-minute distribution. Period-invariant: changing the Period dropdown adjusts the sampling-window confidence, not the displayed rate, when the workload is stable.",
                valueColor: timeAboveColor(
                  perHostPerDay(
                    row.projectedTimeAboveMin,
                    row.hostsWithData,
                    row.periodDays,
                  ),
                ),
              },
            ]}
            threshold={threshold}
          />
        )}
      </td>

      {/* Evidence base — how solid is the per-class sample?
          Three lines, each answering a distinct question:
            (1) class size              — how big is this segment?
            (2) coverage                — how much of it can we see?
            (3) Retellect ON/OFF split  — how strong is the A/B?
          The big number is the absolute host count; the share-of-fleet
          version of the same lives in the CPU class cell, so the two
          columns don't repeat the same figure in two formats. Sits
          immediately before Decision so sample size reads as setup
          for the verdict, not as an early stat the eye has to hold. */}
      <td className="py-4 px-3 align-top">
        <div className="text-xl font-bold text-gray-900 leading-none">
          {row.hostCount}{" "}
          <span className="text-xs font-normal text-gray-500">
            {row.hostCount === 1 ? "host" : "hosts"}
          </span>
        </div>
        <div className="text-[11px] mt-1.5 leading-relaxed space-y-0.5">
          <div
            className={coverageGap > 0 ? "text-amber-600" : "text-gray-500"}
            title={
              coverageGap > 0
                ? `${row.hostsWithData} of ${row.hostCount} hosts report telemetry. ${coverageGap} have no Zabbix data — either unmonitored or with broken agents.`
                : "All hosts in this class report telemetry."
            }
          >
            {row.hostsWithData} reporting
            {coverageGap > 0 && ` · ${coverageGap} no data`}
          </div>
          <div
            className="text-gray-700 font-medium"
            title="Hosts classified as ON (Retellect active in window) vs OFF (Retellect inactive). Drives the measured A/B impact when both sides have enough samples."
          >
            {row.hostsOn} ON · {row.hostsOff} OFF
          </div>
        </div>
      </td>

      {/* Decision cell — minimalist hierarchy.
            • One coloured pill (the verdict) anchors the cell.
            • Subtitle, qualifier line, and priority all sit as plain
              gray typography underneath. No competing pills, no
              uppercase tracking blocks — type weight + colour do the
              hierarchy work, not bordered chips.
            • Confidence is conveyed by a subtle text-colour shift on
              the word itself (emerald / amber / gray), so the eye picks
              up the tier in scan reading without needing a separate
              badge. */}
      <td className="py-4 px-3 text-center align-top">
        <div className="flex flex-col items-center gap-2.5 mx-auto max-w-[180px]">
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] font-semibold whitespace-nowrap ${DECISION_STYLES[row.decision]}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${DECISION_DOT[row.decision]}`} />
            {DECISION_LABEL[row.decision]}
          </span>
          {row.subtitle && (
            <p className="text-[11px] text-gray-500 leading-snug">
              {row.subtitle}
            </p>
          )}
          <p className="text-[10px] text-gray-400 leading-snug">
            <span
              className={`cursor-help font-medium ${CONFIDENCE_TONE[row.confidence]}`}
              title={CONFIDENCE_TIP[row.confidence]}
            >
              {capitalize(row.confidence)} confidence
            </span>
            <span className="mx-1.5 text-gray-300">·</span>
            <span className="cursor-help" title={EVIDENCE_TIP[row.evidence]}>
              {EVIDENCE_LABEL[row.evidence]}
            </span>
          </p>
          {priority && (
            <p
              className={`text-[10px] font-medium ${priority.tone}`}
              title={priority.tip}
            >
              {priority.label}
            </p>
          )}
        </div>
      </td>
    </tr>
  );
}

// ─── Editable Planned Retellect impact input ────────────────────────

/** Numeric input for Planned Retellect impact (in pp).
 *
 *  Behaviour:
 *  - Pre-filled with the system default (measured delta or per-tier
 *    conservative figure).
 *  - User can edit; commit on blur or Enter. Clamped to 0–30 pp, snapped
 *    to 0.5 pp granularity.
 *  - "Reset" link appears when the user has overridden the default;
 *    clicking it restores the system default.
 *  - The orange ring on the input cues "this is a manual override" so
 *    the user knows the number isn't system-derived.
 */
function ImpactInput({
  model,
  value,
  defaultValue,
  hasManualOverride,
  disabled,
  onChange,
}: {
  model: string;
  value: number;
  defaultValue: number;
  hasManualOverride: boolean;
  /** When true, the input is read-only and the Reset link is hidden.
   *  Used by Insufficient-evidence rows where there is no baseline to
   *  project from, so a manual impact value can't change the displayed
   *  projection ("No projection available"). */
  disabled?: boolean;
  onChange: (model: string, value: number | null) => void;
}) {
  const [draft, setDraft] = useState<string>(value.toFixed(1));
  useEffect(() => {
    setDraft(value.toFixed(1));
  }, [value]);

  const commit = () => {
    if (disabled) return;
    const raw = parseFloat(draft);
    if (!Number.isFinite(raw)) {
      setDraft(value.toFixed(1));
      return;
    }
    const clamped = Math.max(0, Math.min(30, raw));
    const snapped = Math.round(clamped * 2) / 2;
    setDraft(snapped.toFixed(1));
    if (snapped === defaultValue) {
      // Match default → clear the override.
      if (hasManualOverride) onChange(model, null);
    } else if (snapped !== value) {
      onChange(model, snapped);
    }
  };
  // Bug fix (2026-06-01): no escape hatch for an in-flight edit. If the
  // user typed "20" but wanted to abandon the change, the only way to
  // restore the live value was to click outside, which also commits.
  // Escape now reverts the draft to the committed value and blurs.
  const cancelDraft = () => {
    setDraft(value.toFixed(1));
  };

  return (
    <div className="flex flex-col gap-1">
      <label
        className={`inline-flex items-center gap-1.5 text-[11px] ${disabled ? "text-gray-400" : "text-gray-600"}`}
        title={
          disabled
            ? "No baseline to project from on this row — manual impact input has no effect."
            : "Manual CPU impact input used for rollout projection."
        }
      >
        {/* "Planned impact" prefix removed — the column header already
            says "Planned impact". Inline label now just '+ N pp'. */}
        <span className="text-gray-400">+</span>
        <input
          type="number"
          min={0}
          max={30}
          step={0.5}
          inputMode="decimal"
          value={draft}
          disabled={disabled}
          readOnly={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
              (e.currentTarget as HTMLInputElement).blur();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelDraft();
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
          className={`w-14 text-xs px-1.5 py-1 border rounded text-center bg-white tabular-nums focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-300/40 ${
            disabled
              ? "border-gray-200 text-gray-400 bg-gray-50 cursor-not-allowed"
              : hasManualOverride
                ? "border-amber-300 text-amber-800 font-semibold"
                : "border-gray-300 text-gray-800"
          }`}
          aria-label={`Planned Retellect impact for ${model}, percentage points`}
          aria-disabled={disabled || undefined}
        />
        <span className="text-gray-400">pp</span>
      </label>
      {hasManualOverride && !disabled && (
        <button
          type="button"
          onClick={() => onChange(model, null)}
          className="self-start text-[10px] text-blue-600 hover:underline"
          title={`Reset to default +${defaultValue} pp`}
        >
          Reset to default
        </button>
      )}
    </div>
  );
}

// ─── Mini-stack (the per-cell bar group) ────────────────────────────

type BarVariant = "used" | "buffer" | "model" | "ghost";

function MiniStack({
  rows,
  threshold,
}: {
  rows: {
    label: string;
    value: number | null;
    unit: "%" | "pp" | "min" | "min/d";
    bar: BarVariant;
    approx?: boolean;
    tip?: string;
    secondary?: boolean;
    /** Optional Tailwind text-color class for the value — encodes
     *  severity (green good / amber moderate / red bad) so the eye
     *  catches the warnings without reading numbers. */
    valueColor?: string;
  }[];
  threshold: number;
}) {
  return (
    <div className="flex flex-col gap-1.5 min-w-[190px]">
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
  tip,
  secondary,
  valueColor,
}: {
  label: string;
  value: number | null;
  unit: "%" | "pp" | "min" | "min/d";
  bar: BarVariant;
  approx?: boolean;
  threshold: number;
  /** Hover explanation — rendered as a native title attribute on the
   *  label span so it's discoverable without a custom tooltip component. */
  tip?: string;
  /** True when this row is supporting context, not a primary decision
   *  metric. Visually de-emphasised (neutral label colour, dimmer
   *  value), matches the spec's "Max CPU is secondary context" rule. */
  secondary?: boolean;
  /** Optional severity-based Tailwind text color for the value. */
  valueColor?: string;
}) {
  // Bar width is a visual heuristic — we scale to 100 for % values, to
  // threshold for pp values (so a full bar means "as wide as headroom
  // can be"), and saturate min values against a 4-hour reference window
  // so a 3 h time-above-threshold lights up most of the bar.
  const widthPct = (() => {
    if (value === null) return 0;
    if (unit === "%") return Math.max(0, Math.min(100, value));
    if (unit === "pp") return Math.max(0, Math.min(100, (value / Math.max(1, threshold)) * 100));
    if (unit === "min/d") {
      // Saturate at 60 min/host/day — anything ≥ 1 h daily saturation
      // fills the bar. Matches the red-band cut-off in timeAboveColor.
      return Math.max(0, Math.min(100, (value / 60) * 100));
    }
    // min unit — saturate at 4 h (240 min) total
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
    if (unit === "min/d") {
      // Tiered precision so small rates stay readable:
      //   < 0.1  → "<0.1 min/d" (avoid "0.0 min/d" implying perfect zero)
      //   < 10   → one decimal ("1.4 min/d")
      //   < 60   → integer ("12 min/d")
      //   ≥ 60   → hours per day ("1.5 h/d")
      if (value === 0) return "0 min/d";
      if (value < 0.1) return "<0.1 min/d";
      if (value < 10) return `${value.toFixed(1)} min/d`;
      if (value < 60) return `${Math.round(value)} min/d`;
      const h = value / 60;
      return h >= 10 ? `${Math.round(h)} h/d` : `${h.toFixed(1)} h/d`;
    }
    if (unit === "min") {
      if (value < 60) return `${Math.round(value)} min`;
      const h = value / 60;
      return h >= 10 ? `${Math.round(h)} h` : `${h.toFixed(1)} h`;
    }
    return String(value);
  })();

  // Short label for the bar row — column headers ("Current CPU state",
  // "Projected CPU state") already supply the context, so the per-row
  // label can drop the redundant "CPU"/"to threshold"/"above threshold"
  // suffixes. Full description still surfaces via the tooltip.
  const shortLabel = (() => {
    if (label === "Typical CPU load") return "Typical";
    if (label === "Room to threshold") return "Room";
    if (label === "Time above threshold") return "Time above";
    if (label === "Max CPU") return "Max";
    return label;
  })();

  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span
        className={`w-[88px] shrink-0 font-medium ${secondary ? "text-gray-500" : "text-gray-700"} ${tip ? "cursor-help underline decoration-dotted underline-offset-2 decoration-gray-300" : ""}`}
        title={tip ?? label}
      >
        {shortLabel}
      </span>
      <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden min-w-[32px]">
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
      <span className={`w-[54px] shrink-0 text-right font-semibold tabular-nums ${valueColor ?? "text-gray-800"}`}>
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
    (r) => r.evidence === "no-on-data" && r.decision !== "insufficient",
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
    <div className="bg-white rounded-md border border-gray-200 p-5">
      <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-widest mb-3">
        {title}
      </h4>
      {children}
    </div>
  );
}

function EvidenceBox({ title, body }: { title: string; body: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-md p-4">
      <div className="text-xs font-semibold text-gray-700 uppercase tracking-widest mb-2">
        {title}
      </div>
      <div className="text-[12px] text-gray-600 leading-relaxed">{body}</div>
    </div>
  );
}

// ─── Drilldown workspace ────────────────────────────────────────────
//
// Sequential drilldown that takes over the bottom area when a matrix
// row is selected. Two states managed by selectedHostId:
//
//   State 1 — host inventory   (selectedHostId === null)
//   State 2 — per-host evidence (selectedHostId !== null)
//
// State 3 (minute detail) is deliberately out of scope here. Minute-
// level inspection lives on the CPU Timeline tab and the bridge from
// State 2 is a deep link to that tab with the host preselected.
//
// IA discipline: only ONE primary investigation block is visible at a
// time. We do NOT stack the host list and the evidence card side-by-
// side — the breadcrumb at the top + the "Back to host list" link
// is the path the user takes between them.

interface DrilldownHost {
  /** Zabbix hostId, or null when the device has no monitoring link. */
  hostId: string | null;
  hostName: string;
  storeName: string;
  monitored: boolean;
  peakCpu: number | null;
  typicalCpu: number | null;
  /** Minutes-above-threshold across the whole period for this host. */
  minutesAbove: number | null;
  /** Same, normalised per day so different period lengths compare. */
  minutesAbovePerDay: number | null;
  /** Composite risk used for sorting in "Risky first". Higher = worse. */
  riskScore: number;
}

function CpuDrilldownWorkspace({
  row,
  threshold,
  periodDays,
  pilot,
  zabbix,
  selectedHostId,
  onSelectHost,
  onClose,
}: {
  row: CpuMatrixRow;
  threshold: number;
  periodDays: number;
  pilot: RtPilotData;
  zabbix: ZabbixData;
  selectedHostId: string | null;
  onSelectHost: (hostId: string | null) => void;
  onClose: () => void;
}) {
  // Build the per-host inventory once per (row, threshold, periodDays).
  // Pure derivation — no fetch, all data already lives in props.
  const hosts = useMemo(
    () => buildDrilldownHosts(row.model, pilot, zabbix, threshold, periodDays),
    [row.model, pilot, zabbix, threshold, periodDays],
  );

  // Fleet-share signal in the header — "this CPU class is N% of the
  // pilot fleet". Surfaces priority context that the matrix row alone
  // can't communicate (40 hosts means more if the total is 80 than if
  // the total is 400).
  const fleetSize = pilot.devices.length;
  const storesInClass = new Set(hosts.map((h) => h.storeName)).size;
  const fleetSharePct =
    fleetSize > 0 ? Math.round((row.hostCount / fleetSize) * 100) : 0;

  // Recover the selected-host record when we're in State 2. If the
  // hostId no longer matches anything (host filtered out, refresh
  // changed the inventory), drop back to State 1.
  const selectedHost = selectedHostId
    ? hosts.find((h) => h.hostId === selectedHostId) ?? null
    : null;
  useEffect(() => {
    if (selectedHostId !== null && selectedHost === null) {
      onSelectHost(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedHostId, selectedHost]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 mb-6">
      {/* ── Header / breadcrumb ──────────────────────────────────── */}
      <div className="flex items-start justify-between gap-6 px-5 py-4 border-b border-gray-200">
        <div className="min-w-0">
          {/* Breadcrumb: model > host (when in State 2). The model link
              clears the host selection so the user falls back to the
              inventory list — explicit IA path, no browser-back surprise. */}
          <div className="flex items-center gap-1.5 text-[12px] text-gray-500 font-medium">
            <button
              type="button"
              onClick={() => onSelectHost(null)}
              className={`hover:text-gray-900 transition-colors ${
                selectedHost ? "cursor-pointer underline decoration-dotted underline-offset-2" : "cursor-default"
              }`}
              disabled={!selectedHost}
            >
              {row.model}
            </button>
            {selectedHost && (
              <>
                <span className="text-gray-300">/</span>
                <span className="text-gray-900">{selectedHost.hostName}</span>
              </>
            )}
          </div>
          <div className="text-[11px] text-gray-500 mt-0.5">
            {row.hostCount} hosts · {storesInClass} {storesInClass === 1 ? "store" : "stores"}
            {fleetSize > 0 && ` · ${fleetSharePct}% of fleet`}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-[11px] text-gray-400 hover:text-gray-700 transition-colors shrink-0"
          title="Close drilldown and return to fleet-level summary"
          aria-label="Close drilldown"
        >
          <span aria-hidden="true">✕</span> Close
        </button>
      </div>

      {/* ── State-dependent body ─────────────────────────────────── */}
      {selectedHost ? (
        <HostEvidenceView
          host={selectedHost}
          row={row}
          threshold={threshold}
          periodDays={periodDays}
          pilot={pilot}
          onBack={() => onSelectHost(null)}
        />
      ) : (
        <HostInventoryView
          hosts={hosts}
          threshold={threshold}
          onSelectHost={onSelectHost}
        />
      )}
    </div>
  );
}

/** State 1 — host inventory for the selected CPU class.
 *
 *  Default sort is risk-first (composite score on peak CPU + minutes
 *  above threshold). The tab set lets the user pivot quickly:
 *    Risky first  → monitored hosts, sorted by riskScore desc
 *    All          → every host, monitored sorted by risk, unmonitored at end
 *    Monitored    → only monitored, alphabetical
 *    Unmonitored  → only unmonitored — pure inventory-coverage view
 *
 *  Important: unmonitored hosts never contribute to a risk score; they
 *  appear in the list only as coverage gaps, never mixed into measured
 *  metric computations. Mixing the two would silently lower fleet-level
 *  "minutes above" rates because we'd be dividing by a denominator that
 *  includes hosts we can't actually see. */
function HostInventoryView({
  hosts,
  threshold,
  onSelectHost,
}: {
  hosts: DrilldownHost[];
  threshold: number;
  onSelectHost: (hostId: string) => void;
}) {
  type Tab = "risky" | "all" | "monitored" | "unmonitored";
  type SortCol = "peak" | "typical" | "minAbove";
  const [tab, setTab] = useState<Tab>("risky");
  // Column sort overrides the tab's natural ordering. Null = tab default
  // applies. Switching tabs clears the override so each tab's invariant
  // stays predictable (Risky-first really is risk-first, Monitored really
  // is alphabetical).
  const [sortCol, setSortCol] = useState<SortCol | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const setTabAndResetSort = (next: Tab) => {
    setTab(next);
    setSortCol(null);
    setSortDir("desc");
  };
  const onHeaderClick = (col: SortCol) => {
    if (sortCol === col) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortCol(col);
      setSortDir("desc");
    }
  };

  const filtered = useMemo(() => {
    // First, apply the tab's filter + natural ordering.
    let items: DrilldownHost[];
    if (tab === "risky") {
      items = hosts.filter((h) => h.monitored).sort((a, b) => b.riskScore - a.riskScore);
    } else if (tab === "monitored") {
      items = hosts.filter((h) => h.monitored).sort((a, b) => a.hostName.localeCompare(b.hostName));
    } else if (tab === "unmonitored") {
      items = hosts.filter((h) => !h.monitored).sort((a, b) => a.hostName.localeCompare(b.hostName));
    } else {
      const mon = hosts.filter((h) => h.monitored).sort((a, b) => b.riskScore - a.riskScore);
      const unmon = hosts.filter((h) => !h.monitored).sort((a, b) => a.hostName.localeCompare(b.hostName));
      items = [...mon, ...unmon];
    }
    // Then, if a column sort is active, override.
    if (sortCol !== null) {
      const get = (h: DrilldownHost): number | null => {
        if (sortCol === "peak") return h.peakCpu;
        if (sortCol === "typical") return h.typicalCpu;
        return h.minutesAbovePerDay;
      };
      items = [...items].sort((a, b) => {
        const av = get(a);
        const bv = get(b);
        // Nulls always sink to the end regardless of direction — there's
        // nothing useful to compare against.
        if (av === null && bv === null) return a.hostName.localeCompare(b.hostName);
        if (av === null) return 1;
        if (bv === null) return -1;
        const diff = sortDir === "desc" ? bv - av : av - bv;
        // Bug fix (2026-06-01): when two hosts have identical values
        // (e.g. both at peak 99%), their order would flip across
        // re-renders / re-sorts. Use hostName as a stable tiebreaker
        // so the list never visually jumps on a no-op sort.
        return diff !== 0 ? diff : a.hostName.localeCompare(b.hostName);
      });
    }
    return items;
  }, [hosts, tab, sortCol, sortDir]);

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: "risky", label: "Risky first", count: hosts.filter((h) => h.monitored).length },
    { id: "all", label: "All", count: hosts.length },
    { id: "monitored", label: "Monitored", count: hosts.filter((h) => h.monitored).length },
    { id: "unmonitored", label: "Unmonitored", count: hosts.filter((h) => !h.monitored).length },
  ];

  // Compact sort indicator: ↑ / ↓ when active, faint dot when sortable
  // but not active. Both fit in the same width so headers don't shift
  // when the active column changes.
  const sortIndicator = (col: SortCol) => {
    if (sortCol !== col) return <span className="text-gray-400 ml-1" aria-hidden="true">·</span>;
    return (
      <span className="text-gray-700 ml-1 font-medium" aria-hidden="true">
        {sortDir === "desc" ? "↓" : "↑"}
      </span>
    );
  };

  return (
    <div className="p-5">
      <div className="flex items-center gap-1 mb-4 flex-wrap">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTabAndResetSort(t.id)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium border transition-colors ${
              tab === t.id
                ? "bg-sky-50 text-sky-700 border-sky-200"
                : "bg-white text-gray-600 border-gray-200 hover:border-gray-300"
            }`}
          >
            {t.label}
            <span className="text-[10px] text-gray-400 tabular-nums">{t.count}</span>
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="py-8 text-center text-[12px] text-gray-400">
          {tab === "unmonitored"
            ? "All hosts in this CPU class are monitored — no coverage gaps."
            : "No hosts to show."}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-widest text-gray-600 border-b border-gray-200">
                <th className="py-2 px-2 font-semibold">Host</th>
                <th className="py-2 px-2 font-semibold">Store</th>
                {/* Native <th> role is "columnheader" which supports
                    aria-sort; explicit role="button" was overriding
                    that. Removed — keyboard/click handlers still work. */}
                <th
                  className="py-2 px-2 font-semibold text-right cursor-pointer select-none hover:text-gray-700"
                  onClick={() => onHeaderClick("peak")}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onHeaderClick("peak");
                    }
                  }}
                  tabIndex={0}
                  aria-sort={sortCol === "peak" ? (sortDir === "desc" ? "descending" : "ascending") : "none"}
                  title="Sort by peak CPU"
                >
                  Peak CPU{sortIndicator("peak")}
                </th>
                <th
                  className="py-2 px-2 font-semibold text-right cursor-pointer select-none hover:text-gray-700"
                  onClick={() => onHeaderClick("typical")}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onHeaderClick("typical");
                    }
                  }}
                  tabIndex={0}
                  aria-sort={sortCol === "typical" ? (sortDir === "desc" ? "descending" : "ascending") : "none"}
                  title="Sort by typical (median daily avg) CPU"
                >
                  Typical{sortIndicator("typical")}
                </th>
                <th
                  className="py-2 px-2 font-semibold text-right cursor-pointer select-none hover:text-gray-700"
                  onClick={() => onHeaderClick("minAbove")}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onHeaderClick("minAbove");
                    }
                  }}
                  tabIndex={0}
                  aria-sort={sortCol === "minAbove" ? (sortDir === "desc" ? "descending" : "ascending") : "none"}
                  title={`Sort by minutes per day above ${threshold}%`}
                >
                  Min above {threshold}%/d{sortIndicator("minAbove")}
                </th>
                <th className="py-2 px-2 font-semibold w-[24px]" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((h, idx) => {
                const flagged =
                  h.monitored &&
                  ((h.peakCpu !== null && h.peakCpu >= 95) ||
                    (h.minutesAbovePerDay !== null && h.minutesAbovePerDay >= 30));
                return (
                  <tr
                    // Bug fix (2026-06-01): two unmonitored hosts with
                    // identical device.name would collide on the React key
                    // (`hostId ?? hostName` falls back to a non-unique
                    // hostName). Compose key from hostId/hostName + store
                    // + idx so duplicates stay distinct without losing
                    // identity-based reconciliation for monitored hosts.
                    key={`${h.hostId ?? h.hostName}::${h.storeName}::${idx}`}
                    className={`border-t border-gray-100 transition-colors focus:outline-none focus:bg-blue-50/30 ${
                      h.monitored
                        ? "hover:bg-gray-50 cursor-pointer"
                        : "opacity-60 cursor-not-allowed"
                    }`}
                    onClick={() => {
                      if (h.monitored && h.hostId) onSelectHost(h.hostId);
                    }}
                    onKeyDown={(e) => {
                      if ((e.key === "Enter" || e.key === " ") && h.monitored && h.hostId) {
                        e.preventDefault();
                        onSelectHost(h.hostId);
                      }
                    }}
                    role={h.monitored ? "button" : undefined}
                    tabIndex={h.monitored ? 0 : undefined}
                    aria-disabled={!h.monitored || undefined}
                    title={
                      h.monitored
                        ? "Open per-host evidence summary"
                        : "Unmonitored — no Zabbix data on this host yet."
                    }
                  >
                    <td className="py-3 px-3 font-medium text-gray-900">{h.hostName}</td>
                    <td className="py-3 px-3 text-gray-600">{h.storeName}</td>
                    <td className="py-3 px-3 text-right tabular-nums font-semibold text-gray-900">
                      {h.peakCpu === null ? "—" : `${Math.round(h.peakCpu)}%`}
                    </td>
                    <td className="py-3 px-3 text-right tabular-nums text-gray-500">
                      {h.typicalCpu === null ? "—" : `${Math.round(h.typicalCpu)}%`}
                    </td>
                    <td className="py-3 px-3 text-right tabular-nums text-gray-700">
                      {h.minutesAbovePerDay === null
                        ? "—"
                        : h.minutesAbovePerDay < 0.1
                          ? "<0.1"
                          : h.minutesAbovePerDay < 10
                            ? h.minutesAbovePerDay.toFixed(1)
                            : Math.round(h.minutesAbovePerDay).toString()}
                    </td>
                    <td className="py-3 px-3 text-right">
                      {flagged && <span className="text-amber-600" title="High peak or sustained time above threshold">⚠</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** State 2 — focused evidence summary for one host.
 *
 *  This is NOT a minute timeline (that lives on the CPU Timeline tab).
 *  It's an "evidence card" — the user has picked a host, this view
 *  proves why it landed where it did in the risk ordering. The bucket
 *  distribution at the bottom gives a sense of HOW the minutes-above
 *  are spread across severity bands, which a single "34 min/d" number
 *  can't communicate. */
function HostEvidenceView({
  host,
  row,
  threshold,
  periodDays,
  pilot,
  onBack,
}: {
  host: DrilldownHost;
  row: CpuMatrixRow;
  threshold: number;
  periodDays: number;
  pilot: RtPilotData;
  onBack: () => void;
}) {
  return (
    <div className="p-5">
      <button
        type="button"
        onClick={onBack}
        className="text-[11px] text-blue-600 hover:text-blue-800 mb-3 inline-flex items-center gap-1"
      >
        ◂ Back to host list
      </button>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Evidence headline numbers */}
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
          <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-3">
            Evidence summary
          </div>
          <dl className="space-y-2 text-[12px]">
            <EvidenceRow label={`Minutes above ${threshold}%`} value={fmtMinutesPerDay(host.minutesAbovePerDay)} />
            <EvidenceRow label="Total in period" value={host.minutesAbove === null ? "—" : `${Math.round(host.minutesAbove)} min over ${periodDays} d`} />
            <EvidenceRow label="Peak CPU in period" value={host.peakCpu === null ? "—" : `${Math.round(host.peakCpu)}%`} />
            <EvidenceRow label="Typical (median daily avg)" value={host.typicalCpu === null ? "—" : `${Math.round(host.typicalCpu)}%`} />
            <EvidenceRow label="Store" value={host.storeName} />
          </dl>
        </div>

        {/* Class context — answers "is this host an outlier within its class?" */}
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
          <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-3">
            {row.model === "Unknown" ? "Class context" : `Compared to ${row.model}`}
          </div>
          <dl className="space-y-2 text-[12px]">
            <EvidenceRow label="Class peak" value={row.maxCpu === null ? "—" : `${Math.round(row.maxCpu)}%`} />
            <EvidenceRow label="Class typical (median)" value={row.typicalCpu === null ? "—" : `${Math.round(row.typicalCpu)}%`} />
            <EvidenceRow label="Class decision" value={DECISION_LABEL[row.decision]} />
            <EvidenceRow label="Evidence base" value={EVIDENCE_LABEL[row.evidence]} />
            <EvidenceRow label="Planned impact" value={`+${row.impactPp.toFixed(1)} pp`} />
          </dl>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-2 text-[11px] text-gray-500">
        <span>For minute-level inspection of this host:</span>
        <a
          href={`/retellect/${pilot.id}?tab=timeline&host=${host.hostId ?? ""}`}
          className="text-blue-600 hover:underline"
        >
          Open in CPU Timeline ↗
        </a>
      </div>
    </div>
  );
}

function EvidenceRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-gray-500">{label}</dt>
      <dd className="font-semibold text-gray-900 tabular-nums">{value}</dd>
    </div>
  );
}

function fmtMinutesPerDay(value: number | null): string {
  if (value === null) return "—";
  // Bug fix (2026-06-01): a literal "0 min / day" reads as if the
  // threshold was the operative number; "never above threshold" maps
  // directly to the user's mental model and is more honest about what
  // a zero rate means.
  if (value === 0) return "Never above threshold";
  if (value < 0.1) return "<0.1 min / day";
  if (value < 10) return `${value.toFixed(1)} min / day`;
  if (value < 60) return `${Math.round(value)} min / day`;
  const h = value / 60;
  return h >= 10 ? `${Math.round(h)} h / day` : `${h.toFixed(1)} h / day`;
}

/** Derive a per-host risk view for one CPU class. Pure — same data the
 *  matrix already received from the server. */
function buildDrilldownHosts(
  modelMatch: string,
  pilot: RtPilotData,
  zabbix: ZabbixData,
  threshold: number,
  periodDays: number,
): DrilldownHost[] {
  const zabbixByName = new Map(zabbix.hosts.map((h) => [h.hostName, h]));
  const trendsByHost = new Map<string, ZabbixCpuTrend[]>();
  for (const t of zabbix.cpuTrends ?? []) {
    if (!trendsByHost.has(t.hostId)) trendsByHost.set(t.hostId, []);
    trendsByHost.get(t.hostId)!.push(t);
  }
  const thKey: ActiveAboveBucket =
    threshold >= 90 ? 90 :
    threshold >= 80 ? 80 :
    threshold >= 70 ? 70 :
    threshold >= 60 ? 60 :
    threshold >= 50 ? 50 :
    threshold >= 40 ? 40 :
    threshold >= 30 ? 30 : 20;

  const out: DrilldownHost[] = [];
  for (const d of pilot.devices) {
    // Bug fix (2026-06-01): `d.sourceHostKey || ""` falls through to
    // `Map.get("")`, which would match an actual zabbix host literally
    // named "" (unlikely in prod but possible in seed/fixture data).
    // Skip the lookup entirely when the key is empty, falling straight
    // through to the d.name match path.
    const matched =
      (d.sourceHostKey ? zabbixByName.get(d.sourceHostKey) : undefined) ||
      zabbixByName.get(d.name);
    const model = resolveCpuModel(d.cpuModel, matched?.inventory?.cpuModel ?? null, "Unknown");
    if (model !== modelMatch) continue;

    if (!matched) {
      // Unmonitored — render as inventory coverage row, never feed
      // into measured metric calculations elsewhere.
      out.push({
        hostId: null,
        hostName: d.name,
        storeName: d.storeName,
        monitored: false,
        peakCpu: null,
        typicalCpu: null,
        minutesAbove: null,
        minutesAbovePerDay: null,
        riskScore: -1,
      });
      continue;
    }

    const trends = trendsByHost.get(matched.hostId) || [];
    let peakCpu: number | null = null;
    const dailyAvgs: number[] = [];
    let minutesAbove = 0;
    let sawAnyData = false;
    for (const t of trends) {
      if (Number.isFinite(t.avg)) {
        sawAnyData = true;
        if (t.avg > 0) dailyAvgs.push(t.avg);
      }
      if (Number.isFinite(t.max) && t.max > 0) {
        peakCpu = peakCpu === null ? t.max : Math.max(peakCpu, t.max);
      }
      if (t.minutesAbove) minutesAbove += t.minutesAbove[thKey] || 0;
    }
    const typicalCpu = dailyAvgs.length > 0 ? median(dailyAvgs) : null;
    const minutesAbovePerDay =
      sawAnyData && periodDays > 0 ? minutesAbove / periodDays : null;

    // Composite risk for sorting. Peak gets the heaviest weight because
    // a single high peak is what makes a host "interesting" for rollout
    // risk; sustained minutes-above is the supporting signal.
    const riskScore =
      (peakCpu ?? 0) + (minutesAbovePerDay ?? 0) * 0.5;

    out.push({
      hostId: matched.hostId,
      hostName: matched.hostName,
      storeName: d.storeName,
      monitored: true,
      peakCpu,
      typicalCpu,
      minutesAbove: sawAnyData ? minutesAbove : null,
      minutesAbovePerDay,
      riskScore,
    });
  }
  return out;
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
 *      - No Retellect ON data yet: conservative per-tier scenario.
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
): { matrix: CpuMatrixRow[]; periodDays: number; fleetTotal: number } {
  // Fleet denominator for the per-row "% of fleet" badge. Includes
  // every pilot device under the current store filter — even hosts
  // without a Zabbix link or with no agent installed at all. The
  // share is a strategic-importance signal, not a measurement signal,
  // so the count must reflect physical inventory, not monitoring
  // coverage. (Coverage gaps are surfaced separately in the drilldown
  // "Unmonitored" tab.)
  const fleetTotal =
    storeFilter === "all"
      ? pilot.devices.length
      : pilot.devices.filter((d) => d.storeName === storeFilter).length;
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
    /** Sum of cpuTrends.minutesAbove per bucket — drives the bucket-
     *  derived projected-time-above calculation (the principled
     *  "shift the distribution up by +impact_pp" model). */
    minutesAboveByBucketTracked: Record<ActiveAboveBucket, number>;
    /** Same as above but from the rolloutPerHost active-minutes path;
     *  unused while the page is locked to tracked mode but kept for
     *  symmetry so a future active-mode rollout can read straight from
     *  here without a refactor. */
    minutesAboveByBucketActive: Record<ActiveAboveBucket, number>;
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
    // Bug fix (2026-06-01): see buildDrilldownHosts — empty
    // sourceHostKey must not fall through to Map.get("").
    const matchedHost =
      (d.sourceHostKey ? zabbixByName.get(d.sourceHostKey) : undefined) ||
      zabbixByName.get(d.name);
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
        minutesAboveByBucketTracked: emptyBucketRecord(),
        minutesAboveByBucketActive: emptyBucketRecord(),
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
        for (const b of ACTIVE_ABOVE_BUCKETS) {
          g.minutesAboveByBucketTracked[b] += t.minutesAbove[b] || 0;
        }
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
      for (const b of ACTIVE_ABOVE_BUCKETS) {
        g.minutesAboveByBucketActive[b] += combined.activeMinutesAboveThreshold[b] || 0;
      }
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
    else if (hasUsableSample) evidence = "no-on-data";
    else evidence = "insufficient";

    // Planned Retellect impact.
    //
    // Bug fix (2026-05-29): measured evidence used to silently fall back
    // to the conservative scenario when weightedAvg returned null (empty
    // aggregate), even though the evidence column still said "Measured
    // ON/OFF". The fallback now requires both averages to be available;
    // otherwise the evidence tag is downgraded to "no-on-data" so the
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
      // Cap raised 20 → 30 pp (2026-06-01) so legitimate worst-case
      // measurements like i3-6100 Pavilnionys (+23 pp) and projected
      // pre-Skylake tiers aren't silently clipped — the cap is only
      // there to swallow obvious outliers (e.g. a single host with
      // 60 pp delta from a stuck Zabbix counter), not to suppress real
      // hardware-tier overhead.
      impactPp = Math.min(30, Math.round(delta * 10) / 10);
      impactSource = "measured";
    } else {
      impactPp = conservativeImpactPp(g.model);
      impactSource = "conservative";
      // Keep the row's evidence tag honest: if we couldn't actually
      // measure the impact, this isn't "Measured ON/OFF" any more.
      if (evidence === "measured-on-off") evidence = "no-on-data";
    }

    // Projected state + decision derive from the *default* impact here.
    // The component layer recomputes both when the user manually
    // overrides Planned Retellect impact for a CPU class. See applyImpact.
    const { projectedCpu, projectedRoom, projectedTimeAboveMin, decision } =
      applyImpact(
        {
          typicalCpu,
          timeAboveNowMin,
          minutesAboveByBucket:
            cpuCountFrom === "active"
              ? g.minutesAboveByBucketActive
              : g.minutesAboveByBucketTracked,
          hostsWithData: g.hostsWithData,
          evidence,
          periodDays,
        },
        impactPp,
        threshold,
      );

    // Confidence — meaning is "decision confidence for rollout", not
    // "data quality". Critical rule (spec 2026-05-29):
    //   • High is reserved for genuinely Measured ON/OFF cases (≥5 ON
    //     hosts AND ≥5 OFF hosts contributed, OR ≥10 hosts with data
    //     when measured-on-off evidence exists). A class without any
    //     Retellect ON data cannot give a High rollout decision no
    //     matter how many OFF hosts the sample has — we'd be
    //     extrapolating across an untested boundary.
    //   • No Retellect ON data yet → capped at Medium.
    //   • Insufficient evidence → always Low.
    let confidence: Confidence;
    const hostsWithData = g.hostsWithData;
    const measuredEvidence = evidence === "measured-on-off";
    if (
      measuredEvidence &&
      (hostsWithData >= 10 ||
        (g.hostsOnContributed >= 5 && g.hostsOffContributed >= 5))
    ) {
      confidence = "high";
    } else if (hostsWithData >= 3 && evidence !== "insufficient") {
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

    // Subtitle — one-liner that complements the decision. Pass the
    // per-host-per-day rate so the subtitle uses the same yardstick
    // as the displayed Time-above-threshold cell.
    const perHostPerDayRateForSubtitle =
      timeAboveNowMin > 0 || hasUsableSample
        ? perHostPerDay(timeAboveNowMin, g.hostsWithData, periodDays)
        : null;
    const subtitle = subtitleFor(
      decision,
      evidence,
      typicalCpu,
      maxCpu,
      threshold,
      perHostPerDayRateForSubtitle,
    );

    const spec = cpuSpec(g.model);

    matrix.push({
      model: g.model,
      subtitle,
      hostCount: g.totalHosts,
      hostsWithData,
      hostsOn: g.hostsOn.size,
      hostsOff: g.hostsOff.size,
      evidence,
      periodDays,
      cpuCores: spec?.cores ?? null,
      cpuThreads: spec?.threads ?? null,
      cpuRank: spec?.rank ?? -1,
      typicalCpu,
      roomNow,
      timeAboveNowMin: timeAboveNowMin > 0 || hasUsableSample ? timeAboveNowMin : null,
      minutesAboveByBucket:
        cpuCountFrom === "active" ? g.minutesAboveByBucketActive : g.minutesAboveByBucketTracked,
      maxCpu,
      measuredRetellectCpuOn: avgRetellectOn,
      impactPp,
      impactSource,
      defaultImpactPp: impactPp,
      hasManualOverride: false,
      projectedCpu,
      projectedRoom,
      projectedTimeAboveMin,
      decision,
      confidence,
      isSilent,
    });
  }

  matrix.sort((a, b) => {
    // Unknown / unrecognised CPU models stay at the bottom.
    if (a.model === "Unknown" && b.model !== "Unknown") return 1;
    if (b.model === "Unknown" && a.model !== "Unknown") return -1;
    if (a.cpuRank === -1 && b.cpuRank !== -1) return 1;
    if (b.cpuRank === -1 && a.cpuRank !== -1) return -1;
    // Primary order: weakest CPU tier first (ascending rank). Puts
    // the most at-risk hardware at the top of the matrix, regardless
    // of current load level.
    if (a.cpuRank !== b.cpuRank) return a.cpuRank - b.cpuRank;
    // Tiebreaker (same rank): riskiest decision first, then typical CPU.
    const r = DECISION_RANK[a.decision] - DECISION_RANK[b.decision];
    if (r !== 0) return r;
    return (b.typicalCpu ?? 0) - (a.typicalCpu ?? 0);
  });

  return { matrix, periodDays, fleetTotal };
}

// ─── Compute helpers ────────────────────────────────────────────────

/** Apply an impact figure (pp) to a row's current-state numbers and
 *  re-derive the projected fields + decision.
 *
 *  Extracted so the page can recompute projections when the user edits
 *  the impact input without touching the (expensive) baseline compute.
 *  computeCpuMatrix uses it once with the default impact; the component
 *  uses it again with the user's manual override.
 */
function applyImpact(
  row: Pick<CpuMatrixRow,
    "typicalCpu" | "timeAboveNowMin" | "minutesAboveByBucket" | "hostsWithData" | "evidence" | "periodDays"
  >,
  impactPp: number,
  threshold: number,
): {
  projectedCpu: number | null;
  projectedRoom: number | null;
  projectedTimeAboveMin: number | null;
  decision: Decision;
} {
  const projectedCpu = row.typicalCpu === null ? null : row.typicalCpu + impactPp;
  const projectedRoom = projectedCpu === null ? null : threshold - projectedCpu;
  const projectedTimeAboveMin = projectTimeAbove(
    row.minutesAboveByBucket,
    threshold,
    impactPp,
  );

  // Decision uses the per-host-per-day RATE, not the absolute period
  // total. Without this, choosing a longer Period (e.g. 30d instead of
  // 14d) made every stable-workload row look "worse" — more total
  // minutes above threshold — and flipped Safe rows to Validate solely
  // because of sampling-window size, not actual CPU intensity. The
  // rate stays stable across periods when the workload is stable, so
  // the decision becomes a property of the CPU pattern instead of the
  // user's period choice.
  const perHostPerDayRate = perHostPerDay(
    projectedTimeAboveMin,
    row.hostsWithData,
    row.periodDays,
  );

  let decision: Decision;
  if (row.evidence === "insufficient" || projectedRoom === null) {
    decision = "insufficient";
  } else if (projectedRoom >= 20 && (perHostPerDayRate ?? 0) < 5) {
    // < 5 min/host/day above threshold = ~one peak burst per day,
    // safe-budget-wise. Matches the previous absolute 60 min total
    // when period was ~14 days (5 × 14 ≈ 70) but is now genuinely
    // period-invariant for any window.
    decision = "safe";
  } else if (projectedRoom >= 10) {
    decision = "validate";
  } else if (projectedRoom >= 0) {
    decision = "optimize";
  } else {
    decision = "do-not-roll-out";
  }

  return { projectedCpu, projectedRoom, projectedTimeAboveMin, decision };
}

// ─── Display helpers — per-host normalization + severity colors ─────
//
// Time-above values stored on the row are CLASS-WIDE sums (sum across
// every host in the class). The decision logic already normalises to
// per-host (perHostProjectedTimeAbove < 60 min); the UI now follows
// suit so a row that decides "Safe" because per-host averages to
// ~14 min doesn't display "1.2 h" (5 hosts × 14 min) and trigger the
// "wait, why is room comfortable but time-above huge?" reaction the
// user flagged.

/** Per-host-per-day rate from a class-wide minute total. The displayed
 *  Time-above-threshold value uses this so the number stays roughly
 *  constant across Period choices when the underlying workload is
 *  stable. Lets the user compare 7d vs 30d vs 90d as different
 *  sampling-window confidence levels, not as different "amount of
 *  problem". */
function perHostPerDay(
  total: number | null,
  hostsWithData: number,
  periodDays: number,
): number | null {
  if (total === null) return null;
  const denom = Math.max(1, hostsWithData * Math.max(1, periodDays));
  return total / denom;
}

/** Colour the Typical CPU load value by how close it sits to the
 *  selected threshold. Green when comfortable, amber as it approaches,
 *  red once it would already meet the threshold. */
function typicalLoadColor(value: number | null, threshold: number): string | undefined {
  if (value === null) return undefined;
  if (value >= threshold) return "text-red-600";
  if (value >= threshold - 10) return "text-amber-700";
  if (value >= threshold - 30) return "text-gray-800";
  return "text-emerald-700";
}

/** Colour the Room to threshold value by remaining headroom. */
function roomColor(value: number | null): string | undefined {
  if (value === null) return undefined;
  if (value < 0) return "text-red-600";
  if (value < 10) return "text-amber-700";
  if (value < 20) return "text-gray-800";
  return "text-emerald-700";
}

/** Colour the Time above threshold value (per-host-per-day rate, in
 *  min/host/day). Aligned with the decision rule's < 5 min/host/day
 *  Safe cut-off:
 *    0          → emerald (never spiked above threshold)
 *    > 0 to <5  → gray    (occasional spikes, within Safe budget)
 *    5 to <30   → amber   (daily saturation, decision-relevant)
 *    ≥ 30       → red     (substantial daily time above threshold) */
function timeAboveColor(value: number | null): string | undefined {
  if (value === null) return undefined;
  if (value >= 30) return "text-red-600";
  if (value >= 5) return "text-amber-700";
  if (value > 0) return "text-gray-700";
  return "text-emerald-700";
}

/** Colour the Max CPU value. Max CPU is "secondary" by default (gray
 *  label) but the *value* gets a severity tint so a 99% peak draws
 *  the eye instead of disappearing into the gray context tier. */
function maxCpuColor(value: number | null): string | undefined {
  if (value === null) return undefined;
  if (value >= 95) return "text-red-600";
  if (value >= 85) return "text-amber-700";
  if (value >= 70) return "text-gray-700";
  return "text-gray-500";
}

/** Capitalise the first letter of a single word. */
function capitalize(word: string): string {
  if (!word) return word;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Median of a numeric pool. Returns null on empty input. */
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** CPU specification for sorting and per-row display.
 *
 *  Rank is an ordinal performance score: higher = stronger. The matrix
 *  sort uses it to place the WEAKEST CPU class at the top — the
 *  classes most at risk from Retellect rollout — so the user reads
 *  riskiest hardware first, regardless of whether that class currently
 *  has high CPU load. Tier-derived from CPU generation and the
 *  known cores/threads of common SCO/POS-grade SKUs.
 *
 *  Cores/threads come from the actual Intel SKU spec where the model
 *  string is uniquely identifiable. Returns null for unrecognised
 *  models — caller falls back to "Unknown" handling. */
interface CpuSpec {
  /** Ordinal performance rank, lower = weaker hardware. */
  rank: number;
  cores: number;
  threads: number;
}

function cpuSpec(model: string): CpuSpec | null {
  const m = model.toLowerCase();
  if (!m || m === "unknown" || m === "—") return null;

  // Intel Core i7 / i5 / i3 by generation.
  // Note: i3 12th gen is 4P+0E in most SKUs (no E-cores in i3), so 4C/8T.
  if (/i7-1[2-9]\d{3}/.test(m)) return { rank: 100, cores: 8, threads: 16 };
  if (/i5-1[2-9]\d{3}/.test(m)) return { rank: 95, cores: 6, threads: 12 };
  if (/i3-1[2-9]\d{3}/.test(m)) return { rank: 90, cores: 4, threads: 8 };

  if (/i7-(10|11)\d{3}/.test(m)) return { rank: 85, cores: 8, threads: 16 };
  if (/i5-(10|11)\d{3}/.test(m)) return { rank: 80, cores: 6, threads: 12 };
  if (/i3-(10|11)\d{3}/.test(m)) return { rank: 75, cores: 4, threads: 8 };

  if (/i7-9\d{3}/.test(m)) return { rank: 72, cores: 8, threads: 16 };
  if (/i5-9\d{3}/.test(m)) return { rank: 68, cores: 6, threads: 6 };
  if (/i3-9\d{3}/.test(m)) return { rank: 60, cores: 4, threads: 4 };

  if (/i7-8\d{3}/.test(m)) return { rank: 67, cores: 6, threads: 12 };
  if (/i5-8\d{3}/.test(m)) return { rank: 62, cores: 6, threads: 6 };
  if (/i3-8\d{3}/.test(m)) return { rank: 58, cores: 4, threads: 4 };

  if (/i7-7\d{3}/.test(m)) return { rank: 55, cores: 4, threads: 8 };
  if (/i5-7\d{3}/.test(m)) return { rank: 52, cores: 4, threads: 4 };
  if (/i3-7\d{3}/.test(m)) return { rank: 50, cores: 2, threads: 4 };

  if (/i7-6\d{3}/.test(m)) return { rank: 47, cores: 4, threads: 8 };
  if (/i5-6\d{3}/.test(m)) return { rank: 44, cores: 4, threads: 4 };
  if (/i3-6\d{3}/.test(m)) return { rank: 42, cores: 2, threads: 4 };

  if (/i3-[45]\d{3}/.test(m)) return { rank: 35, cores: 2, threads: 4 };

  // Pentium G-series desktop (Skylake/Kaby Lake, 2C/2T).
  if (/pentium/.test(m)) return { rank: 25, cores: 2, threads: 2 };

  // Celeron J3160 — Braswell 4C/4T (uncommon but exists in some SCO HW).
  if (/j316\d/.test(m)) return { rank: 14, cores: 4, threads: 4 };
  // Celeron J3060 — Apollo Lake 2C/2T (very low-power 6W TDP).
  if (/j30[6-9]\d/.test(m)) return { rank: 8, cores: 2, threads: 2 };
  // Other low-power J-series Celeron / Atom mobile chips.
  if (/j\d{4}/.test(m)) return { rank: 10, cores: 2, threads: 2 };
  // Celeron G-series desktop (Skylake, 2C/2T).
  if (/celeron.*g\d/.test(m)) return { rank: 22, cores: 2, threads: 2 };
  if (/celeron/.test(m)) return { rank: 15, cores: 2, threads: 2 };
  if (/atom/.test(m)) return { rank: 5, cores: 2, threads: 2 };

  return null;
}

/** Rollout-priority signal — small secondary badge under evidence.
 *
 *  Decision colour alone tells the user "is this CPU class risky?"
 *  but says nothing about how much of the fleet that class covers, or
 *  whether it's a good place to START the rollout. Priority answers
 *  that compact question in one short label:
 *
 *    "Best start candidate"  — Safe + High confidence + ≥3 hosts
 *    "Large risky segment"   — Optimize / Do not roll out, ≥10 hosts
 *    "Small fragile cohort"  — Optimize / Do not roll out, <3 hosts
 *    (no label)              — every other case, kept visually quiet
 *
 *  Returns null when no signal is warranted — the cell renders nothing.
 *  Spec rule: do not make this visually loud. Tones are muted text-only
 *  (no pill / background) so they read as supporting metadata, not as
 *  a third decision dimension competing with the main pill. */
function computePriority(row: CpuMatrixRow): { label: string; tone: string; tip: string } | null {
  if (row.decision === "safe" && row.confidence === "high" && row.hostCount >= 3) {
    return {
      label: "Best start candidate",
      tone: "text-emerald-700",
      tip: "Safe rollout decision with high confidence on a meaningful fleet slice — good place to begin.",
    };
  }
  if (
    (row.decision === "optimize" || row.decision === "do-not-roll-out") &&
    row.hostCount >= 10
  ) {
    return {
      label: "Large risky segment",
      tone: "text-amber-700",
      tip: "Risky rollout decision on a large share of the fleet — high blast radius if rolled out blindly.",
    };
  }
  if (
    (row.decision === "optimize" || row.decision === "do-not-roll-out") &&
    row.hostCount > 0 &&
    row.hostCount < 3
  ) {
    return {
      label: "Small fragile cohort",
      tone: "text-gray-600",
      tip: "Risky decision on a tiny fleet slice — easy to defer, low priority to chase.",
    };
  }
  return null;
}

/** Conservative impact scenario when no measured ON evidence exists.
 *  Bands by hardware tier — older CPUs get a larger reserved overhead
 *  because Retellect's per-frame Python load is a bigger fraction of
 *  available cycles on those classes.
 *
 *  Anchors (real Rimi data observed 2026-05-08 .. 2026-06-01):
 *   • i3-12300HL (12th gen) — Rimi Outlet SCO 1: RT On 12.6% / Off 12.3%
 *     → +0.3 pp measured. Conservative band: 1 pp.
 *   • i3-9100E (Coffee Lake-R) — Rimi Dangerutis SCO 1: RT On 26% /
 *     Off 21% → +5 pp measured, but Retellect was lightly active
 *     there (process avg 1%). Full-rollout conservative: 10 pp.
 *   • i3-6100 (Skylake) — Pavilnionys SCO 2: RT On 43% / Off 20%
 *     → +23 pp measured. Conservative = measured (already worst-case).
 *   • i3-4330 (Haswell) — no installations yet. Extrapolated from
 *     i3-6100 (weaker tier, same 2C/4T topology): 28 pp.
 *   • Pentium/Celeron — no installations yet. Extrapolated further
 *     down the tier ladder, headroom ~halved: 30 pp.
 *
 *  These defaults are used ONLY when the matrix lacks ≥2 ON + ≥2 OFF
 *  hosts with active-minute samples for the class (the gate at
 *  `measuredOnOff` above). Once that bar is cleared, the dashboard
 *  uses the directly-measured delta (capped at 30 pp). */
function conservativeImpactPp(model: string): number {
  const m = model.toLowerCase();
  // 12th gen+ — anchor: i3-12300HL Rimi Outlet +0.3 pp measured.
  if (/i[357]-1[2-9]\d{3}/.test(m)) return 1;
  // 9th–11th gen — anchor: i3-9100E Dangerutis +5 pp measured (light
  // activity), conservative projection for full rollout.
  if (/i[357]-(9|1[01])\d{3}/.test(m)) return 10;
  // 7th–8th gen — interpolated between 9-11th (+10) and 6th (+23).
  if (/i[357]-[78]\d{3}/.test(m)) return 15;
  // 6th gen — anchor: i3-6100 Pavilnionys +23 pp measured.
  if (/i[357]-6\d{3}/.test(m)) return 23;
  // 4th–5th gen — extrapolated from i3-6100, weaker IPC + same
  // 2C/4T topology means less headroom for injected work.
  if (/i[357]-[45]\d{3}/.test(m)) return 28;
  // Pentium / Celeron — further extrapolation.
  if (/(pentium|celeron|atom)/.test(m)) return 30;
  // Unknown — middle-of-the-road conservative.
  return 10;
}

/** Empty zero-filled bucket record — used as the zero element for
 *  the per-class minutes-above accumulator. */
function emptyBucketRecord(): Record<ActiveAboveBucket, number> {
  const r = {} as Record<ActiveAboveBucket, number>;
  for (const b of ACTIVE_ABOVE_BUCKETS) r[b] = 0;
  return r;
}

/** Project time above threshold after applying +impactPp pp shift.
 *
 *  Mathematical model the spec mandates:
 *
 *    projected_cpu(t) = current_cpu(t) + impactPp
 *
 *  Therefore:
 *
 *    minutes where projected_cpu > threshold
 *      ≡ minutes where current_cpu > (threshold − impactPp)
 *
 *  We have current minutes-above counts at the discrete buckets
 *  {20, 30, 40, 50, 60, 70, 80, 90}. Linear interpolation between
 *  adjacent buckets gives a non-grid value:
 *
 *    f(x) = minutes_above(x), monotonically decreasing in x.
 *    For lower ≤ x ≤ upper (adjacent bucket keys), interpolate
 *    f(x) ≈ f(lower) + (x − lower) × (f(upper) − f(lower)) / (upper − lower).
 *
 *  Boundary handling:
 *   • effective ≤ 20 → saturate at f(20) (we have no lower bucket,
 *     so this is the lower bound on "everything significant").
 *   • effective ≥ 90 → return f(90) (the smallest bucket count).
 *   • effective exactly on a bucket → that bucket's count.
 *
 *  Returns null only when no bucket data is available (no cpuTrends
 *  for the class at all). Zero is a valid value and is returned as 0.
 */
function projectTimeAbove(
  buckets: Record<ActiveAboveBucket, number>,
  threshold: number,
  impactPp: number,
): number | null {
  // Defensive — caller passes a populated record, but if somehow it's
  // empty we can't say anything useful.
  const allZero = ACTIVE_ABOVE_BUCKETS.every((b) => (buckets[b] ?? 0) === 0);
  if (allZero) return null;

  const effective = threshold - impactPp;
  if (effective <= 20) return buckets[20] ?? 0;
  if (effective >= 90) return buckets[90] ?? 0;

  // Find adjacent buckets (lower ≤ effective ≤ upper).
  let lower: ActiveAboveBucket = 20;
  let upper: ActiveAboveBucket = 90;
  for (const k of ACTIVE_ABOVE_BUCKETS) {
    if (k <= effective && k >= lower) lower = k;
    if (k >= effective && k <= upper) upper = k;
  }
  if (lower === upper) return buckets[lower] ?? 0;
  const lowerVal = buckets[lower] ?? 0;
  const upperVal = buckets[upper] ?? 0;
  const t = (effective - lower) / (upper - lower);
  return Math.round(lowerVal + (upperVal - lowerVal) * t);
}

function subtitleFor(
  decision: Decision,
  evidence: Evidence,
  typical: number | null,
  max: number | null,
  threshold: number,
  perHostPerDayRate: number | null,
): string {
  if (evidence === "insufficient") return "Not enough samples to score";

  // Peak-vs-typical mismatch detector. A row can decide "safe" off the
  // median while real peaks already cross the threshold. Rate of >= 2
  // min/host/day above threshold counts as "meaningful" — that's
  // roughly one peak burst per day, period-invariant signal.
  const peakNearSaturation = max !== null && max >= 90;
  const meaningfulTimeAbove =
    perHostPerDayRate !== null && perHostPerDayRate >= 2;

  if (decision === "safe") {
    if (peakNearSaturation && meaningfulTimeAbove) {
      return "Calm baseline, peaks cross threshold";
    }
    if (peakNearSaturation) return "Calm baseline, peaks near threshold";
    if (meaningfulTimeAbove) return "Mostly calm, occasional spikes";
    return "Ample headroom";
  }
  if (decision === "validate") return "Validate under live load";
  if (decision === "optimize") return "Tight margin, reduce background load";
  if (decision === "do-not-roll-out") {
    if (max !== null && max >= 95) return "Saturated peaks, upgrade tier";
    return "Structurally constrained";
  }
  if (typical !== null) {
    const gap = threshold - typical;
    if (gap >= 30) return "Ample headroom";
    if (gap >= 10) return "Workable headroom";
    return "Limited headroom";
  }
  return "";
}

function formatList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
