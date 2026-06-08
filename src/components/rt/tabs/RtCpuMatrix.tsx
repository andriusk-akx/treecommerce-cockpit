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

import { useDeferredValue, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { RtPilotData, ZabbixData, ZabbixCpuTrend, ZabbixHostData } from "../RtPilotWorkspace";
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
import { FilterBar, FilterRow, FilterSelect, FilterSegmented, FilterDivider, FilterMultiSelect } from "../filters/RtFilterControls";
import type { MultiOption } from "../filters/RtFilterControls";

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
  /** Sum of business-hour samples observed across all hosts in this
   *  class over the period. When > 0, perHostPerDay() uses it as the
   *  denominator (intensity-based formula). Zero when no business
   *  filter data is available (mixed DB-rollup window), in which case
   *  perHostPerDay() falls back to the calendar-day formula. */
  businessSamples: number;
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
  /** Indicative-only measured-impact signal when exactly ONE ON host
   *  contributed to the class aggregate. The class falls below the
   *  "≥2 ON + ≥2 OFF" bar for measured-on-off evidence, so this is
   *  NOT used to drive the projection / decision — but it surfaces in
   *  the Decision cell as a qualifier so the operator can see real
   *  evidence (e.g. Pavilnionys SCO2 +23 pp on i3-6100) sitting next
   *  to the conservative scenario the model is using instead. Null
   *  when no single-ON-host signal is available. */
  singleHostMeasuredImpactPp: number | null;

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

/** Country ISO-code → display label. Kept small (3 Baltic states) and
 *  centralised so the filter dropdown and any future header chip read
 *  the same human name. Falls back to the raw code when unknown. */
const COUNTRY_LABEL: Record<string, string> = {
  LT: "Lithuania",
  LV: "Latvia",
  EE: "Estonia",
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
  const countryFilter = filters.country;
  // Current page contract: calculation is always from ALL minutes in the
  // selected period. Active-only mode is on the roadmap but disabled in
  // the UI for now (see Minute scope below), so we force the compute
  // input to "tracked" regardless of what the cross-tab filter context
  // happens to hold from the legacy heatmap.
  const cpuCountFrom = "tracked" as const;

  // Store filter is multi-select (string[]); empty = all stores.
  // Build the option list once, ordering stores we have Zabbix data for
  // first. "Has Zabbix data" = at least one device in the store maps to a
  // configured Zabbix host (covers stores we currently or historically
  // receive monitoring for; stores never wired to Zabbix sink to the
  // bottom). Honours the active Country filter so the two slicers agree.
  const storeOptions = useMemo<MultiOption[]>(() => {
    const hostKeys = new Set<string>();
    for (const h of zabbix.hosts) hostKeys.add(h.hostName);
    const tracked = new Set<string>();
    for (const d of pilot.devices) {
      if (hostKeys.has(d.sourceHostKey || "") || hostKeys.has(d.name)) tracked.add(d.storeName);
    }
    return pilot.stores
      .filter((s) => countryFilter === "all" || s.country === countryFilter)
      .map((s) => ({ v: s.name, l: s.name, tracked: tracked.has(s.name) }))
      .sort((a, b) =>
        a.tracked === b.tracked ? a.l.localeCompare(b.l) : a.tracked ? -1 : 1,
      );
  }, [zabbix.hosts, pilot.devices, pilot.stores, countryFilter]);

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
  const deferredCountry = useDeferredValue(countryFilter);
  const deferredCountFrom = useDeferredValue(cpuCountFrom);
  const deferredBusinessOnly = useDeferredValue(filters.businessHoursOnly);
  const isRefreshing =
    isPeriodPending ||
    deferredThreshold !== threshold ||
    deferredStore !== storeFilter ||
    deferredCountry !== countryFilter ||
    deferredCountFrom !== cpuCountFrom ||
    deferredBusinessOnly !== filters.businessHoursOnly;

  // Perf 2026-06-02: derived maps that depend ONLY on pilot + zabbix
  // (host lookup, trend index, rollout map, deployed set) used to be
  // rebuilt inside computeCpuMatrix every time it ran — which meant
  // every threshold / store / country / business-hour toggle paid the
  // O(hosts + trends + perHost) map-construction cost. Hoist them here
  // so they survive filter changes, then pass them in as a precomputed
  // bundle. Filter-only changes now skip the map work entirely (about
  // a 35-45 % reduction in computeCpuMatrix wall time on Rimi-scale
  // pilot data measured locally). Same hoisted bundle is reused by
  // buildDrilldownHosts so the drilldown opens faster as well.
  const pilotZabbixIndex = useMemo(
    () => buildPilotZabbixIndex(zabbix),
    [zabbix],
  );

  // Build decision matrix from the deferred inputs.
  const { matrix: baselineMatrix, periodDays, fleetTotal } = useMemo(
    () => computeCpuMatrix(pilot, zabbix, pilotZabbixIndex, deferredThreshold, deferredStore, deferredCountry, deferredCountFrom, deferredBusinessOnly),
    [pilot, zabbix, pilotZabbixIndex, deferredThreshold, deferredStore, deferredCountry, deferredCountFrom, deferredBusinessOnly],
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

  // Factor the Decision-matrix `<section>` out so the same JSX can sit
  // both inside the MatrixSplitPane (when a row is selected) and
  // inline above the fleet-summary cards (when nothing is selected).
  // Closes over the same component-level state (filteredMatrix,
  // periodDays, isRefreshing, etc.), so capturing it once keeps the
  // two render paths in lock-step.
  const matrixSection = (
    <section>
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
          {/* Bug fix (2026-06-02, batch of 10): the previous empty
              state claimed "Not enough CPU history" unconditionally
              when matrix.length === 0, which was wrong whenever a
              Country / Store / CPU filter had narrowed the input
              down to zero devices (data exists, filters just hid
              everything) or when Business-hours-only was on and the
              available days were all rollup-sourced (so they got
              skipped to avoid mixed semantics — see Bug 1 of the
              previous batch). The copy now points at the actual
              likely cause so the operator doesn't go hunting for a
              data-health issue that doesn't exist. */}
          {matrix.length === 0
            ? (filters.country !== "all" || filters.store.length > 0 || filters.cpuModel !== "all")
              ? "No CPU classes match the current Country / Store / CPU filters. Clear filters to see the full matrix."
              : filters.businessHoursOnly
                ? "No business-hour CPU history in this window. The available days came through the DB rollup (no business-hour filter applied yet). Switch off 'Business hours only' to read 24h aggregates, or pick a more recent Period."
                : "Not enough CPU history to score rollout. Check Data Health."
            : "All classes filtered out by Hide silent — no Retellect activity observed in this window."}
        </div>
      ) : (
        <div className="relative bg-white rounded-lg border border-gray-200 overflow-x-auto">
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
          <table className="w-full text-sm min-w-[900px]">
            <thead>
              <tr className="bg-gray-50/60 border-b border-gray-200">
                <th className="text-left py-3 px-3 text-xs font-semibold text-gray-600 uppercase tracking-widest w-[170px]">CPU class</th>
                <th className="text-left py-3 px-2 text-xs font-semibold text-gray-600 uppercase tracking-widest">Current</th>
                <th className="text-left py-3 px-2 text-xs font-semibold text-gray-600 uppercase tracking-widest w-[130px] leading-snug">Projected impact</th>
                <th className="text-left py-3 px-2 text-xs font-semibold text-gray-600 uppercase tracking-widest">Projected</th>
                <th className="text-left py-3 px-2 text-xs font-semibold text-gray-600 uppercase tracking-widest w-[100px]">Evidence</th>
                <th
                  className="text-left py-3 px-2 text-xs font-semibold text-gray-600 uppercase tracking-widest w-[170px] cursor-help"
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
                  filtersNarrowed={filters.country !== "all" || filters.store.length > 0}
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
  );

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
          {/* Country filter — derived from the distinct ISO codes in
              pilot.stores. Hidden when only one country is present
              (single-country pilot, no slice to make). When the
              operator switches countries, the Store dropdown is
              automatically narrowed to that country's stores so the
              two filters don't fight each other. */}
          {(() => {
            const countries = Array.from(
              new Set(pilot.stores.map((s) => s.country).filter((c): c is string => !!c)),
            ).sort();
            // Bug fix (2026-06-02, batch of 10): the dropdown used to
            // disappear whenever `countries.length <= 1`, which made
            // sense as long as the operator's `countryFilter` was
            // also "all". But if a stale localStorage value (e.g.
            // "LV" left over from a multi-country session) kept
            // countryFilter at an inactive country, the dropdown
            // hid AND the chip bar didn't have a country entry yet
            // — the operator literally couldn't see or clear the
            // filter, and the matrix silently rendered empty. Now:
            // the dropdown stays visible whenever the filter isn't
            // already "all", regardless of country count, so the
            // operator can always clear it. Also include the stale
            // value in the option list so it's selectable / visible
            // even when no current store is in that country.
            if (countries.length <= 1 && countryFilter === "all") return null;
            const optionCountries = countryFilter !== "all" && !countries.includes(countryFilter)
              ? [...countries, countryFilter].sort()
              : countries;
            return (
              <FilterSelect
                label="Country"
                value={countryFilter}
                options={[
                  { v: "all", l: "All countries" },
                  ...optionCountries.map((c) => ({ v: c, l: COUNTRY_LABEL[c] ?? c })),
                ]}
                onChange={(v) => {
                  setFilter("country", v);
                  // Drop any selected stores that don't belong to the new
                  // country so the operator doesn't see "no rows" because
                  // a previously picked store is out of scope. Multi-select:
                  // keep the stores that survive, clear only the rest.
                  if (v !== "all" && storeFilter.length > 0) {
                    const stillVisible = storeFilter.filter((name) =>
                      pilot.stores.some((s) => s.name === name && s.country === v),
                    );
                    if (stillVisible.length !== storeFilter.length) {
                      setFilter("store", stillVisible);
                    }
                  }
                }}
              />
            );
          })()}
          <FilterMultiSelect
            label="Store"
            selected={storeFilter}
            options={storeOptions}
            onChange={(next) => setFilter("store", next)}
            allLabel="All stores"
            title="Pick one or more stores. Stores we receive Zabbix data for are listed first."
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
          {/* Global Business-hours-only toggle. When on, every CPU
              metric on this page — Typical / Room / Max / Time above
              and the drilldown's per-host inventory — restricts to
              Rimi store-operating hours (Mon–Sat 08–22, Sun 09–21).
              When off, the matrix falls back to 24h-uniform
              aggregation. Stand-in for true active minutes until the
              transaction-timestamp API ships. */}
          <label
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded border text-[11px] font-medium transition cursor-pointer select-none ${
              filters.businessHoursOnly
                ? "bg-sky-50 text-sky-800 border-sky-300"
                : "bg-white text-gray-600 border-gray-200 hover:border-gray-300"
            }`}
            title="When on, every CPU metric on this page restricts to Rimi store-operating hours (Mon–Sat 08:00–22:00, Sun 09:00–21:00 Europe/Vilnius). Off-hours peaks (Windows updates, antivirus, OS maintenance) are filtered out. Stand-in for true active minutes until the Retellect transaction-timestamp API ships."
          >
            <input
              type="checkbox"
              checked={filters.businessHoursOnly}
              onChange={(e) => setFilter("businessHoursOnly", e.target.checked)}
              className="w-3 h-3 accent-sky-600 cursor-pointer"
            />
            Business hours only
          </label>
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

      {/* ── Decision matrix + bottom workspace ──────────────────────────
          When a row is selected the matrix table and the drilldown sit
          inside a vertical splitter so the operator can drag the bar
          between them up or down (handle is the small gray pill, also
          keyboard-accessible via Tab + Arrow keys). When nothing is
          selected, the matrix renders at natural height with the
          fleet-summary cards stacked below it. */}
      {selectedRow ? (
        <MatrixSplitPane
          storageKey={`rtMatrixSplit:${pilot.id}`}
          top={matrixSection}
          bottom={
            <CpuDrilldownWorkspace
              row={selectedRow}
              threshold={threshold}
              periodDays={periodDays}
              pilot={pilot}
              index={pilotZabbixIndex}
              businessHoursOnly={filters.businessHoursOnly}
              selectedHostId={selectedHostId}
              onSelectHost={setSelectedHostId}
              onClose={() => {
                setSelectedModel(null);
                setSelectedHostId(null);
              }}
            />
          }
        />
      ) : (
        <div className="mb-6">{matrixSection}</div>
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
  filtersNarrowed,
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
  /** True when Country or Store filter is narrowing fleetTotal away
   *  from the whole-pilot count — drives the chip tooltip wording so
   *  the operator isn't told "% of fleet" when the denominator is
   *  actually the filtered subset. */
  filtersNarrowed: boolean;
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
  // Evidence column is strictly about the *Zabbix-monitored* slice of
  // the class — unmonitored coverage rows live in the CPU class cell's
  // fleet-share chip (which counts them) and in the drilldown's
  // Unmonitored tab. Inside Evidence we only count hosts that are in
  // Zabbix (ON ∪ OFF). Of those, some may have a broken agent and not
  // report telemetry — that's the inner "silent" sub-count.
  const zabbixHosts = row.hostsOn + row.hostsOff;
  const silentZabbixHosts = Math.max(0, zabbixHosts - row.hostsWithData);
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
            title={
              /* Bug fix (2026-06-02, batch of 10): tooltip used to
                  read "% of fleet in pilot" unconditionally, which
                  was misleading once Country / Store filters were
                  active — the denominator (fleetTotal) is itself
                  filtered, so the same class would jump from 5% to
                  20% as the operator narrowed scope, with the
                  tooltip claiming nothing had changed. Now we name
                  the actual denominator the chip is using. */
              filtersNarrowed
                ? `This CPU class covers ${row.hostCount} of ${fleetTotal} devices (${sharePct}%) WITHIN THE CURRENT FILTER (Country / Store narrowed scope). Clear the filters to see the whole-pilot share.`
                : `This CPU class covers ${row.hostCount} of ${fleetTotal} devices (${sharePct}%) in the pilot${fleetTotal === row.hostCount ? "" : ", counting hosts without Zabbix monitoring or telemetry too"}. Useful as a priority signal — risk on a large segment matters more than the same risk on a small one.`
            }
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
              value: perHostPerDay(row.timeAboveNowMin, row.hostsWithData, row.periodDays, row.businessSamples),
              unit: "min/d",
              bar: "used",
              tip: "Business-hour intensity, projected to a 24h equivalent. Counts only samples taken during Rimi store-operating hours (Mon–Sat 08–22, Sun 09–21 Europe/Vilnius) and divides by observed business-hour sample minutes × 1440 — so a host with 5 minutes above threshold over 192 business hours reads as ~37 min/d-equivalent, not the 5/14 ≈ 0.4 min/d a 24h-uniform average would give. Off-hours peaks (Windows updates, antivirus) are excluded. Stand-in for true active minutes until the Retellect-side transaction-timestamp API ships.",
              valueColor: timeAboveColor(
                perHostPerDay(row.timeAboveNowMin, row.hostsWithData, row.periodDays, row.businessSamples),
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
                  row.businessSamples,
                ),
                unit: "min/d",
                bar: "used",
                approx: true,
                tip: "Projected time above threshold — estimated business-hour intensity (projected to a 24h equivalent) after applying the Planned Retellect impact. Same business-hour denominator as Current state Time above. Will become transaction-derived active-minutes once the API ships.",
                valueColor: timeAboveColor(
                  perHostPerDay(
                    row.projectedTimeAboveMin,
                    row.hostsWithData,
                    row.periodDays,
                    row.businessSamples,
                  ),
                ),
              },
            ]}
            threshold={threshold}
          />
        )}
      </td>

      {/* Evidence base — Zabbix-monitored slice only. Font size
          uniform across all three lines so no number 'screams' at the
          reader; the count stays slightly bolder than its qualifiers
          but doesn't dominate. */}
      <td className="py-4 px-3 align-top">
        <div className="text-[12px] text-gray-700 leading-relaxed space-y-0.5">
          <div
            className="font-semibold text-gray-900"
            title={`${zabbixHosts} of ${row.hostCount} hosts in this class run a Zabbix agent. Unmonitored hosts live in the Unmonitored drilldown tab and never feed measured metrics.`}
          >
            {zabbixHosts}{" "}
            <span className="text-gray-500 font-normal">on Zabbix</span>
          </div>
          <div
            title="Hosts classified as ON (Retellect active in window) vs OFF (Retellect inactive). Drives the measured A/B impact when both sides have enough samples."
          >
            {row.hostsOn} ON · {row.hostsOff} OFF
          </div>
          {silentZabbixHosts > 0 && (
            <div
              className="text-amber-600"
              title={
                /* Bug fix (2026-06-02, batch of 10): when the
                    Business-hours-only toggle is on, a host can
                    look "silent" not because the agent is broken
                    but because its only available data came
                    through the DB rollup, which has no business-
                    hour filter applied yet (the matrix skips
                    those days outright to avoid mixed semantics).
                    Tooltip now spells the alternative cause out
                    so the operator doesn't go hunting for an
                    agent issue that doesn't exist. */
                `${silentZabbixHosts} Zabbix-monitored host${silentZabbixHosts === 1 ? "" : "s"} contributed no usable telemetry in this window — broken agent, ZBX_NOTSUPPORTED items, or (under the Business-hours-only toggle) only DB-rollup days available (which don't carry a business-hour filter yet).`
              }
            >
              {silentZabbixHosts} silent
            </div>
          )}
        </div>
      </td>

      {/* Decision cell — restrained pill + bulleted qualifier list.
          The verdict is the only coloured element, and even it now
          sits in a calmer size; subtitle, confidence, evidence, and
          priority read as a short bulleted memo underneath rather
          than competing pills. Each bullet's tone shift carries one
          piece of meaning (confidence tier, priority colour) without
          requiring border / badge geometry. */}
      <td className="py-4 px-3 align-top">
        <div className="flex flex-col items-start gap-1.5 mx-auto max-w-[180px]">
          <span
            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium whitespace-nowrap ${DECISION_STYLES[row.decision]}`}
          >
            <span className={`w-1 h-1 rounded-full ${DECISION_DOT[row.decision]}`} />
            {DECISION_LABEL[row.decision]}
          </span>
          <ul className="text-[11px] text-gray-500 leading-snug space-y-0.5 w-full mt-0.5">
            <li className="flex items-start gap-1.5">
              <span className="text-gray-300 mt-px" aria-hidden="true">·</span>
              <span
                className={`cursor-help ${CONFIDENCE_TONE[row.confidence]}`}
                title={CONFIDENCE_TIP[row.confidence]}
              >
                {capitalize(row.confidence)} confidence
              </span>
            </li>
            {row.subtitle && (
              <li className="flex items-start gap-1.5">
                <span className="text-gray-300 mt-px" aria-hidden="true">·</span>
                <span>{row.subtitle}</span>
              </li>
            )}
            <li className="flex items-start gap-1.5">
              <span className="text-gray-300 mt-px" aria-hidden="true">·</span>
              <span className="cursor-help" title={EVIDENCE_TIP[row.evidence]}>
                {EVIDENCE_LABEL[row.evidence]}
              </span>
            </li>
            {/* Single-ON-host indicative signal (batch 2, 2026-06-02).
                Surfaces real measured behaviour from the one ON host
                in the class so the operator doesn't lose sight of it
                while the conservative scenario drives the projection
                numbers above. Tone shifts to amber when the measured
                delta differs from the conservative impact by ≥ 5 pp
                — that's the "your real evidence contradicts the
                model" case (e.g. Pavilnionys SCO2 +23 pp on i3-6100
                when the conservative scenario also says +28 pp; close
                enough). Drives validation focus when divergence is
                wide. */}
            {row.singleHostMeasuredImpactPp !== null &&
              row.impactSource !== "measured" && (
                (() => {
                  const measured = row.singleHostMeasuredImpactPp;
                  const conservative = row.defaultImpactPp;
                  const diverges = Math.abs(measured - conservative) >= 5;
                  return (
                    <li className="flex items-start gap-1.5">
                      <span className="text-gray-300 mt-px" aria-hidden="true">·</span>
                      <span
                        className={`cursor-help ${diverges ? "text-amber-700" : "text-gray-500"}`}
                        title={
                          diverges
                            ? `One ON host in this class measured a +${measured.toFixed(1)} pp shift in mean CPU — diverges from the conservative scenario (${conservative.toFixed(1)} pp) by ≥ 5 pp. The class falls below the ≥2 ON + ≥2 OFF bar for "Measured ON/OFF" evidence, so projection above still uses the conservative figure. Validate the single host's behaviour against the projection before rollout.`
                            : `One ON host in this class measured a +${measured.toFixed(1)} pp shift in mean CPU (consistent with the conservative scenario of ${conservative.toFixed(1)} pp).`
                        }
                      >
                        1 ON host measured {measured >= 0 ? "+" : ""}{measured.toFixed(1)} pp
                      </span>
                    </li>
                  );
                })()
              )}
            {priority && (
              <li className="flex items-start gap-1.5">
                <span className="text-gray-300 mt-px" aria-hidden="true">·</span>
                <span className={priority.tone} title={priority.tip}>
                  {priority.label}
                </span>
              </li>
            )}
          </ul>
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
    <div className="flex flex-col gap-1.5 min-w-[160px]">
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
        className={`w-[68px] shrink-0 font-medium ${secondary ? "text-gray-500" : "text-gray-700"} ${tip ? "cursor-help underline decoration-dotted underline-offset-2 decoration-gray-300" : ""}`}
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
      <span className={`w-[46px] shrink-0 text-right font-semibold tabular-nums ${valueColor ?? "text-gray-800"}`}>
        {approx && value !== null ? `~${fmtValue}` : fmtValue}
      </span>
    </div>
  );
}

// ─── Lower cards ────────────────────────────────────────────────────
//
// (BottleneckDriversCard, RecommendedActionsCard, ConfidenceLimitsCard
// and the shared Card wrapper were removed 2026-06-01 — the matrix +
// drilldown carries the same information per-row and the fleet-level
// summary was redundant.)

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

/** Vertical split-pane wrapping the matrix table (top) and the drilldown
 *  workspace (bottom). The operator drags the horizontal handle to give
 *  either pane more height; ratio is persisted per pilot in localStorage
 *  so the layout stays where they put it last.
 *
 *  Constraints:
 *   • Each pane has a 180 px minimum so neither collapses entirely.
 *   • The pane container is sized to (100vh − header chrome) with a
 *     500 px floor — keeps the split useful on small viewports without
 *     locking the page below the viewport.
 *   • Keyboard: tab to the handle, ArrowUp / ArrowDown nudge the ratio
 *     5 % at a time. role="separator" with aria-valuenow announces the
 *     current split to screen readers. */
function MatrixSplitPane({
  storageKey,
  top,
  bottom,
}: {
  storageKey: string;
  top: React.ReactNode;
  bottom: React.ReactNode;
}) {
  const [ratio, setRatio] = useState<number>(() => {
    if (typeof window === "undefined") return 0.45;
    try {
      const s = window.localStorage.getItem(storageKey);
      if (s) {
        const n = parseFloat(s);
        if (Number.isFinite(n) && n >= 0.15 && n <= 0.85) return n;
      }
    } catch {
      // ignore
    }
    return 0.45;
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(storageKey, String(ratio));
    } catch {
      // quota / privacy mode — silent
    }
  }, [ratio, storageKey]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || rect.height < 300) return;
    const y = e.clientY - rect.top;
    const min = 180 / rect.height;
    const max = 1 - 180 / rect.height;
    setRatio(Math.max(min, Math.min(max, y / rect.height)));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    try {
      (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    } catch {
      // already released
    }
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setRatio((r) => Math.max(0.15, r - 0.05));
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setRatio((r) => Math.min(0.85, r + 0.05));
    }
  };

  return (
    <div
      ref={wrapRef}
      className="flex flex-col mb-6"
      style={{ height: "calc(100vh - 240px)", minHeight: 520 }}
    >
      <div
        className="overflow-auto"
        style={{ flexBasis: `${ratio * 100}%`, minHeight: 0 }}
      >
        {top}
      </div>
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onKeyDown}
        role="separator"
        aria-orientation="horizontal"
        aria-valuemin={15}
        aria-valuemax={85}
        aria-valuenow={Math.round(ratio * 100)}
        aria-label="Resize matrix / drilldown split"
        tabIndex={0}
        title="Drag to resize · arrow keys to nudge"
        className="group h-2.5 my-1 cursor-row-resize select-none flex items-center justify-center bg-gray-50 hover:bg-sky-50 focus:bg-sky-50 focus:outline-none transition-colors rounded"
      >
        <div className="w-12 h-0.5 rounded-full bg-gray-300 group-hover:bg-sky-400 group-focus:bg-sky-400 transition-colors" />
      </div>
      <div
        className="overflow-auto"
        style={{ flexBasis: `${(1 - ratio) * 100}%`, minHeight: 0 }}
      >
        {bottom}
      </div>
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
  index,
  businessHoursOnly,
  selectedHostId,
  onSelectHost,
  onClose,
}: {
  row: CpuMatrixRow;
  threshold: number;
  periodDays: number;
  pilot: RtPilotData;
  /** Hoisted pilot+zabbix index — see buildPilotZabbixIndex. Carries
   *  the heavy maps so the drilldown doesn't rebuild them on every
   *  re-render. `zabbix` itself is no longer needed downstream. */
  index: PilotZabbixIndex;
  businessHoursOnly: boolean;
  selectedHostId: string | null;
  onSelectHost: (hostId: string | null) => void;
  onClose: () => void;
}) {
  // Build the per-host inventory once per (row, threshold, periodDays,
  // businessHoursOnly). Pure derivation — no fetch. The shared
  // PilotZabbixIndex carries the heavy maps so this re-runs in O(devices)
  // rather than O(devices + hosts + trends) per re-render.
  const hosts = useMemo(
    () => buildDrilldownHosts(row.model, pilot, index, threshold, periodDays, businessHoursOnly),
    [row.model, pilot, index, threshold, periodDays, businessHoursOnly],
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
          threshold={threshold}
          periodDays={periodDays}
          pilot={pilot}
          businessHoursOnly={businessHoursOnly}
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
  threshold,
  periodDays,
  pilot,
  businessHoursOnly,
  onBack,
}: {
  host: DrilldownHost;
  threshold: number;
  periodDays: number;
  pilot: RtPilotData;
  businessHoursOnly: boolean;
  onBack: () => void;
}) {
  // Level 3 selection: which minute the operator clicked, or null for
  // the list view. Cleared whenever host / threshold / period change
  // so the user doesn't see a stale process breakdown attached to the
  // wrong host context.
  const [selectedMinute, setSelectedMinute] = useState<MinuteSample | null>(null);
  useEffect(() => {
    // Bug fix (2026-06-02, batch 2): businessHoursOnly was missing
    // from the dep list. Toggling the global Business-hours-only
    // filter while the operator was inspecting a Level-4 process
    // breakdown could leave them staring at a breakdown for a
    // minute that the new toggle state had hidden from the Level-3
    // list above. Clearing on toggle keeps the workspace honest.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedMinute(null);
  }, [host.hostId, threshold, periodDays, businessHoursOnly]);

  return (
    <div className="p-5">
      <button
        type="button"
        onClick={onBack}
        className="text-[11px] text-blue-600 hover:text-blue-800 mb-3 inline-flex items-center gap-1"
      >
        ◂ Back to host list
      </button>

      {/* Trust-audit fix (2026-06-02): the previous header showed
          host.peakCpu / typical / minutesAbovePerDay with no scope
          label, leaving the operator to remember which mode the
          numbers were aggregated under. Now we surface the active
          scope (business hours vs 24h, plus the window size) in a
          small tag next to the headline numbers so anyone reading
          the drilldown can see at a glance what the figures are
          conditioned on. Matches the chip bar's "Window" filter
          semantics. */}
      <div className="text-[11px] text-gray-500 mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span>{host.storeName}</span>
        <span>peak {host.peakCpu === null ? "—" : `${Math.round(host.peakCpu)}%`}</span>
        <span>typical {host.typicalCpu === null ? "—" : `${Math.round(host.typicalCpu)}%`}</span>
        <span>{fmtMinutesPerDay(host.minutesAbovePerDay)} above {threshold}%</span>
        <span
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border ${
            businessHoursOnly
              ? "bg-sky-50 text-sky-700 border-sky-200"
              : "bg-gray-50 text-gray-600 border-gray-200"
          }`}
          title={
            businessHoursOnly
              ? `Numbers above restrict to Rimi store-operating hours (Mon-Sat 08-22, Sun 09-21 Europe/Vilnius), aggregated over the last ${periodDays} days.`
              : `Numbers above use the full 24h window, aggregated over the last ${periodDays} days.`
          }
        >
          {businessHoursOnly ? "Business hrs" : "24h"} · {periodDays}d
        </span>
      </div>

      {/* Level 3 / 4 drilldown — only meaningful for Zabbix-monitored
          hosts. Unmonitored coverage rows skip this whole block. */}
      {host.hostId && (
        <div>
          {selectedMinute ? (
            <HostMinuteBreakdown
              hostId={host.hostId}
              hostName={host.hostName}
              minute={selectedMinute}
              threshold={threshold}
              onBack={() => setSelectedMinute(null)}
            />
          ) : (
            <HostMinutesList
              hostId={host.hostId}
              hostName={host.hostName}
              threshold={threshold}
              periodDays={periodDays}
              businessHoursOnly={businessHoursOnly}
              onSelectMinute={setSelectedMinute}
            />
          )}
        </div>
      )}

      <div className="mt-4 flex items-center gap-2 text-[11px] text-gray-500">
        <span>For full hour-level / day-level inspection:</span>
        <a
          // Trust-audit fix (2026-06-02): the cross-tab link used to
          // strip Period entirely, so clicking it took the operator
          // from a 30-day drilldown straight into a 14-day Timeline.
          // Preserve Period in the URL so the Timeline opens on the
          // same window the operator was just reading.
          href={`/retellect/${pilot.id}?tab=timeline&host=${host.hostId ?? ""}&period=${periodDays}d`}
          className="text-blue-600 hover:underline"
        >
          Open in CPU Timeline ↗
        </a>
      </div>
    </div>
  );
}

/** Per-minute sample returned by /api/rt/host-episodes. */
interface MinuteSample {
  /** Unix-seconds of the minute's primary sample. */
  clockSec: number;
  /** system.cpu.util[,,avg1] value at that minute (already > threshold). */
  cpu: number;
}

/** Rimi store-operating-hours definition used as a stand-in for
 *  "active minutes" until the Retellect-side transaction-timestamp
 *  API ships and we can swap to real activity windows.
 *
 *    Mon–Sat: 08:00–22:00  (14 hours / day)
 *    Sunday : 09:00–21:00  (12 hours / day)
 *    Weekly : 6 × 14 + 12 = 96 business hours / 168 calendar hours
 *
 *  Bias notes:
 *   • Holidays / national days off are not modelled. They look like
 *     "business hours" but the lane is closed — a small over-count.
 *   • Mid-day breaks are not modelled. We treat the full open
 *     window as active, which is fine for rollout decisions
 *     (off-hours noise was the bigger problem we wanted to filter
 *     out, not within-business lulls). */
/** Cache of (Vilnius weekday, Vilnius offsetSec) keyed by UTC-midnight
 *  unix-day. Building it once per day eliminates the per-sample
 *  Intl.DateTimeFormat call that was costing ~0.5 ms × 500 minutes ≈
 *  250 ms per drilldown render. Used by isVilniusBusinessHour. Cache
 *  cleared whenever the module reloads, which is fine — it's just a
 *  warm path. */
const vilniusDayCache = new Map<number, { weekday: string; offsetSec: number }>();
const VILNIUS_DAY_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Vilnius",
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hour12: false,
});
function getVilniusDayMeta(clockSec: number): { weekday: string; hour: number } {
  // Bucket by UTC day so the same day across many samples shares an
  // entry. Vilnius DST transitions can shift offset mid-day, but for
  // business-hour classification the weekday + Vilnius hour at the
  // SAMPLE is what matters, not the cached day boundary.
  const utcDay = Math.floor(clockSec / 86400);
  let entry = vilniusDayCache.get(utcDay);
  if (!entry) {
    // Reference clock = noon UTC on the day, which lands inside a
    // single Vilnius calendar day for every DST regime.
    const refSec = utcDay * 86400 + 43200;
    const parts = VILNIUS_DAY_FMT.formatToParts(new Date(refSec * 1000));
    const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
    const y = parts.find((p) => p.type === "year")?.value ?? "1970";
    const m = parts.find((p) => p.type === "month")?.value ?? "01";
    const d = parts.find((p) => p.type === "day")?.value ?? "01";
    const hRaw = parts.find((p) => p.type === "hour")?.value ?? "12";
    const vH = parseInt(hRaw, 10) === 24 ? 0 : parseInt(hRaw, 10);
    // Recover offset: Vilnius local-noon vs UTC reference noon.
    const utcRef = Date.UTC(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10), vH);
    const offsetSec = Math.round((utcRef - refSec * 1000) / 1000);
    entry = { weekday, offsetSec };
    vilniusDayCache.set(utcDay, entry);
  }
  // Apply the cached offset and recompute weekday/hour for this exact
  // sample without another Intl call.
  const vilniusSec = clockSec + entry.offsetSec;
  const vilniusUtcDay = Math.floor(vilniusSec / 86400);
  const hour = Math.floor((vilniusSec - vilniusUtcDay * 86400) / 3600);
  // Weekday only changes when the Vilnius day crosses midnight — for
  // samples that straddle two cached days the weekday from the cache
  // is the noon weekday of the OWNING UTC day, which is correct after
  // applying the offset.
  return { weekday: entry.weekday, hour };
}
function isVilniusBusinessHour(clockSec: number): boolean {
  const { weekday, hour } = getVilniusDayMeta(clockSec);
  if (weekday === "Sun") {
    return hour >= 9 && hour < 21;
  }
  // Mon, Tue, Wed, Thu, Fri, Sat
  return hour >= 8 && hour < 22;
}

/** Level 3 — flat list of every minute the host's CPU was above the
 *  selected threshold. Lazy-fetched on mount and on host / threshold
 *  / period change. Capped at 500 minutes — beyond that, the operator
 *  is told to narrow the Period filter for a fuller view. */
function HostMinutesList({
  hostId,
  hostName,
  threshold,
  periodDays,
  businessHoursOnly,
  onSelectMinute,
}: {
  hostId: string;
  hostName: string;
  threshold: number;
  periodDays: number;
  businessHoursOnly: boolean;
  onSelectMinute: (m: MinuteSample) => void;
}) {
  const [minutes, setMinutes] = useState<MinuteSample[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Standard fetch-on-deps pattern: clearing state inside the
    // effect *is* the correct lifecycle here — we want stale rows
    // visually cleared the moment the operator picks a different
    // host. The lint rule targets a different anti-pattern.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMinutes(null);
    setTruncated(false);
    setError(null);
    setLoading(true);
    const url = `/api/rt/host-episodes?hostId=${encodeURIComponent(hostId)}&periodDays=${periodDays}&threshold=${threshold}`;
    fetch(url, { credentials: "same-origin" })
      .then(async (r) => {
        if (!r.ok) {
          const text = await r.text().catch(() => "");
          throw new Error(`HTTP ${r.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
        }
        return r.json();
      })
      .then((data) => {
        if (cancelled) return;
        if (data.error) {
          setError(String(data.error));
        } else {
          setMinutes(Array.isArray(data.minutes) ? data.minutes : []);
          setTruncated(!!data.truncated);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Unknown error");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hostId, threshold, periodDays]);

  // Drilldown's minute list now obeys the GLOBAL Business-hours-only
  // toggle in the matrix filter bar — single source of truth, so the
  // numbers the operator sees match between matrix metric and per-host
  // detail. The local toggle that used to live here was removed when
  // the global toggle landed.
  const displayedMinutes = useMemo(() => {
    if (!minutes) return null;
    if (!businessHoursOnly) return minutes;
    return minutes.filter((m) => isVilniusBusinessHour(m.clockSec));
  }, [minutes, businessHoursOnly]);
  const totalCount = minutes?.length ?? 0;
  const displayedCount = displayedMinutes?.length ?? 0;
  const filteredOutCount = totalCount - displayedCount;

  // Trust-audit fix (2026-06-02): Zabbix history.get retention only
  // reliably covers ~14 days. When the operator picks Period = 30 d,
  // the matrix row + drilldown header still show full 30-day counts
  // (cpuTrends combines live Zabbix + DB rollup), but the per-minute
  // list endpoint reads from Zabbix history.get directly — so the
  // list only ever shows the most recent ~14 days of breach minutes.
  // Without a banner the operator sees a class row claiming "100
  // min/d above 70 %" and a list of 30 entries and assumes the math
  // is broken. Surface the gap explicitly when periodDays > 14.
  const MINUTE_LEVEL_RETENTION_DAYS = 14;
  const minuteCoverageGap = periodDays > MINUTE_LEVEL_RETENTION_DAYS;

  return (
    <div>
      <div className="flex items-baseline justify-between mb-3 gap-3 flex-wrap">
        <div className="text-[11px] font-semibold text-gray-600 uppercase tracking-widest">
          Minutes above {threshold}%
          {minutes && (
            <span className="ml-2 text-gray-400 font-normal normal-case tracking-normal">
              ({displayedCount}
              {truncated ? "+" : ""} in {periodDays} d
              {businessHoursOnly && filteredOutCount > 0
                ? `, ${filteredOutCount} off-hours hidden`
                : ""})
            </span>
          )}
        </div>
        <span className="text-[10px] text-gray-400">
          {hostName} · Europe/Vilnius
        </span>
      </div>

      {/* Minute-level coverage banner. Renders only when the chosen
          Period reaches beyond Zabbix history.get retention so the
          operator sees the gap before they wonder why the per-minute
          numbers don't reconcile with the matrix / drilldown totals. */}
      {minuteCoverageGap && (
        <div className="text-[11px] text-gray-500 bg-gray-50 border border-gray-200 rounded px-3 py-2 mb-3 leading-snug">
          <span className="font-medium text-gray-700">Note:</span>{" "}
          Minute-level data is only retained for the last
          {" "}~{MINUTE_LEVEL_RETENTION_DAYS} days
          {" "}in Zabbix. The matrix row and the drilldown header
          above include older days from rolled-up daily aggregates,
          but the per-minute list below covers only the recent
          {" "}{MINUTE_LEVEL_RETENTION_DAYS}-day slice. Switch Period
          to <span className="font-medium">14 d</span> for an apples-
          to-apples comparison.
        </div>
      )}

      {loading ? (
        <div className="text-[12px] text-gray-500 inline-flex items-center gap-2 py-2">
          <svg
            className="animate-spin"
            width={14}
            height={14}
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
            <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
          </svg>
          Loading minutes…
        </div>
      ) : error ? (
        <div className="text-[12px] text-red-600">Failed to load: {error}</div>
      ) : displayedMinutes === null || displayedMinutes.length === 0 ? (
        <div className="text-[12px] text-gray-400 italic py-2">
          {/* Bug fix (2026-06-02, batch 2): the old copy said
              "All N minutes above X% fell outside business hours"
              even when the endpoint was capped at 500 — implying
              the host had exactly N minutes and they ALL fell
              outside business hours. In a heavy host where the
              server returned 500 of, say, 8 000 actual minutes-
              above-threshold, that's a misleading absolute claim.
              The reworded copy reflects what we actually know. */}
          {businessHoursOnly && totalCount > 0
            ? truncated
              ? `Of the ${totalCount} most recent above-${threshold}% minutes returned (server cap), none fall in business hours. Older bursts beyond the cap may still include business-hour minutes — narrow the Period filter to inspect.`
              : `All ${totalCount} minutes above ${threshold}% in this window fell outside business hours.`
            : `No minutes above ${threshold}% in the ${periodDays}-day window.`}
        </div>
      ) : (
        <>
          {/* Bounded-height scrollable container — even 500 rows stays
              comfortable on a laptop because we keep it tight to the
              host inventory's visual rhythm. */}
          <div className="border border-gray-200 rounded-md max-h-[420px] overflow-y-auto">
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-gray-50/95 backdrop-blur">
                <tr className="text-left text-[10px] uppercase tracking-widest text-gray-600 border-b border-gray-200">
                  <th className="py-2 px-3 font-semibold">Date</th>
                  <th className="py-2 px-3 font-semibold">Time</th>
                  <th className="py-2 px-3 font-semibold text-right">CPU</th>
                  <th className="py-2 px-3 font-semibold w-[24px]" />
                </tr>
              </thead>
              <tbody>
                {displayedMinutes.map((m) => (
                  <tr
                    key={m.clockSec}
                    className="border-t border-gray-100 hover:bg-sky-50/40 cursor-pointer focus:outline-none focus:bg-sky-50/40 transition-colors"
                    onClick={() => onSelectMinute(m)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelectMinute(m);
                      }
                    }}
                    tabIndex={0}
                    title="Open process breakdown for this minute"
                  >
                    <td className="py-1.5 px-3 text-gray-700 tabular-nums">
                      {fmtVilniusDate(m.clockSec)}
                    </td>
                    <td className="py-1.5 px-3 text-gray-700 tabular-nums">
                      {fmtVilniusTime(m.clockSec)}
                    </td>
                    <td
                      className={`py-1.5 px-3 text-right tabular-nums font-semibold ${
                        m.cpu >= 95
                          ? "text-red-600"
                          : m.cpu >= 85
                            ? "text-amber-700"
                            : "text-gray-800"
                      }`}
                    >
                      {Math.round(m.cpu)}%
                    </td>
                    <td className="py-1.5 px-3 text-right text-gray-300">▸</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {truncated && (
            <div className="text-[11px] text-amber-700 mt-2">
              {/* Bug fix (2026-06-02): when the operator is viewing
                  business-hours-only, the visible list may be a small
                  fraction of the 500 the endpoint actually returned —
                  reading 'showing 500' next to 30 visible rows was
                  confusing. Surface BOTH counts explicitly when they
                  diverge, plus the off-hours fraction the client is
                  hiding. */}
              {businessHoursOnly && displayedCount !== totalCount
                ? `${totalCount} above-threshold minutes returned (server cap); ${displayedCount} fall in business hours, ${totalCount - displayedCount} off-hours hidden. Older bursts beyond the cap may still include business-hour minutes — narrow the Period filter to inspect.`
                : `Showing the 500 most recent minutes — host has more in the window. Narrow the Period filter for older minutes.`}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Level 4 — per-process CPU breakdown at the burst peak minute.
 *  Reuses the existing /api/rt/process-history endpoint with
 *  granularity=1 (per-minute slots), pulls the date that contains the
 *  episode peak, and renders the slot whose timestamp matches peakSec.
 *  No new backend code path.
 *
 *  Bug fix (2026-06-01): the slot shape returned by process-history is
 *  FLAT (retellect/scoApp/db/system/besclient/elastic/osCore/other as
 *  top-level number fields), not a nested `categories` object. The
 *  earlier draft of this interface invented the nested shape, which
 *  meant every category resolved to undefined and the bar rendered
 *  empty. Also added besclient / elastic / osCore which the V2 split
 *  rolled out in May. */
interface ProcessHistorySlot {
  slot: number;
  hourKey: string;
  hour: number;
  minute: number;
  label: string;
  retellect: number;
  scoApp: number;
  db: number;
  system: number;
  besclient: number;
  elastic: number;
  osCore: number;
  other: number;
  free: number;
  /** Avg system.cpu.util for the slot window. Null when no samples
   *  landed — slot may still have proc.cpu data (e.g. only python
   *  reported), in which case the total host-CPU bar should fall back
   *  to Σ(named) instead of crashing on a null call. */
  hostCpu: number | null;
}

const CATEGORY_LABEL: Record<string, string> = {
  retellect: "Retellect",
  scoApp: "SCO App (sp.sss)",
  db: "Database (SQL)",
  system: "System (VMWare)",
  besclient: "BESClient",
  elastic: "Elastic",
  osCore: "OS Core",
  other: "Other",
};
const CATEGORY_COLOR: Record<string, string> = {
  retellect: "#0ea5e9",
  scoApp: "#6366f1",
  db: "#a855f7",
  system: "#64748b",
  besclient: "#10b981",
  elastic: "#f59e0b",
  osCore: "#94a3b8",
  other: "#cbd5e1",
};
const CATEGORY_ORDER = [
  "retellect",
  "scoApp",
  "db",
  "system",
  "besclient",
  "elastic",
  "osCore",
  "other",
];

function HostMinuteBreakdown({
  hostId,
  hostName,
  minute,
  threshold,
  onBack,
}: {
  hostId: string;
  hostName: string;
  minute: MinuteSample;
  threshold: number;
  onBack: () => void;
}) {
  const [slot, setSlot] = useState<ProcessHistorySlot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resolve the Vilnius-local date of the minute so the endpoint
  // scopes its day-window correctly. Hour/minute are then used to
  // find the matching per-minute slot client-side.
  const minuteDate = useMemo(
    () => new Date(minute.clockSec * 1000).toLocaleDateString("en-CA", { timeZone: "Europe/Vilnius" }),
    [minute.clockSec],
  );
  const minuteLabel = useMemo(
    () => fmtVilniusDateTime(minute.clockSec),
    [minute.clockSec],
  );

  useEffect(() => {
    let cancelled = false;
    // Reset stale UI before the new fetch lands. See the matching
    // comment in HostMinutesList for the lint-rule rationale.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSlot(null);
    setError(null);
    setLoading(true);
    // Granularity=1 — exact per-minute slot. The legend then sums
    // directly to the minute's host-CPU value, which is what the
    // operator reads in the row above. Anything coarser (5/15 min
    // buckets) averaged the peak minute together with quieter
    // surrounding minutes and made the math look wrong.
    const url = `/api/rt/process-history?hostId=${encodeURIComponent(hostId)}&date=${minuteDate}&granularity=1`;
    fetch(url, { credentials: "same-origin" })
      .then(async (r) => {
        if (!r.ok) {
          // Surface the HTTP status so we don't silently render
          // "Load failed" as a generic browser fetch error.
          const text = await r.text().catch(() => "");
          throw new Error(`HTTP ${r.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
        }
        return r.json();
      })
      .then((data: { slots?: ProcessHistorySlot[]; error?: string }) => {
        if (cancelled) return;
        if (data.error) {
          setError(String(data.error));
          return;
        }
        const slots = data.slots ?? [];
        // Granularity=1 returns 1440 per-day slots keyed by exact
        // Vilnius-local hour and minute. Match the operator's chosen
        // minute exactly — no rounding.
        const hm = vilniusHourMinute(minute.clockSec);
        const match =
          slots.find((s) => s.hour === hm.hour && s.minute === hm.minute) ??
          null;
        setSlot(match);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Unknown error");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hostId, minuteDate, minute.clockSec]);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <button
          type="button"
          onClick={onBack}
          className="text-[11px] text-blue-600 hover:text-blue-800 inline-flex items-center gap-1"
        >
          ◂ Back to minute list
        </button>
        <span className="text-[10px] text-gray-400">{hostName}</span>
      </div>
      <div className="text-[11px] font-semibold text-gray-600 uppercase tracking-widest mb-2">
        Process breakdown for this minute
      </div>
      <div className="text-[12px] text-gray-500 mb-3">
        {minuteLabel} · host CPU{" "}
        <span className="font-semibold text-gray-800">
          {Math.round(minute.cpu)}%
        </span>
        {" "}(threshold {threshold}%)
      </div>

      {loading ? (
        <div className="text-[12px] text-gray-500 inline-flex items-center gap-2 py-2">
          <svg
            className="animate-spin"
            width={14}
            height={14}
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
            <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
          </svg>
          Loading process breakdown…
        </div>
      ) : error ? (
        <div className="text-[12px] text-red-600">Failed to load: {error}</div>
      ) : slot === null ? (
        <div className="text-[12px] text-gray-400 italic py-2">
          No process telemetry for this minute — proc.cpu items may have been
          ZBX_NOTSUPPORTED at the time of the burst.
        </div>
      ) : (
        <ProcessStackedBar slot={slot} />
      )}
    </div>
  );
}

/** Stacked-bar rendering of a per-minute process breakdown. Mirrors the
 *  visual treatment from the CPU Timeline drilldown so operators see the
 *  same chart shape across tabs.
 *
 *  Bug fix (2026-06-01):
 *   • Read category values from the flat slot shape — the previous
 *     draft reached into a nested `slot.categories` object that the
 *     endpoint never returns. Every category came back undefined and
 *     the bar was always empty.
 *   • Guard against `slot.hostCpu === null` — the endpoint sets it
 *     null when no system.cpu.util samples landed in the minute. The
 *     earlier draft called `null.toFixed(1)` and crashed. Falls back
 *     to Σ(named) when total host CPU isn't available. */
function ProcessStackedBar({ slot }: { slot: ProcessHistorySlot }) {
  const rows = useMemo(() => {
    const out: { key: string; label: string; value: number; color: string }[] = [];
    const slotAny = slot as unknown as Record<string, number | null | undefined>;
    for (const key of CATEGORY_ORDER) {
      const v = slotAny[key];
      if (typeof v === "number" && v > 0.05) {
        out.push({ key, label: CATEGORY_LABEL[key], value: v, color: CATEGORY_COLOR[key] });
      }
    }
    // Sort descending so the biggest contributor leads the bar.
    out.sort((a, b) => b.value - a.value);
    return out;
  }, [slot]);
  const totalNamed = rows.reduce((s, r) => s + r.value, 0);
  // Robust host-CPU figure: prefer the explicit slot.hostCpu, fall
  // back to Σ(named) when null, finally clamp [0, 100] for the
  // stacked-bar geometry below.
  const hostCpu = slot.hostCpu === null ? totalNamed : slot.hostCpu;
  const hostCpuDisplay = Math.max(0, Math.min(100, hostCpu));
  const free = Math.max(0, 100 - hostCpuDisplay);

  return (
    <div className="space-y-3">
      {/* Stacked bar */}
      <div className="flex h-3 w-full overflow-hidden rounded-md border border-gray-200 bg-gray-50">
        {rows.map((r) => (
          <div
            key={r.key}
            style={{
              width: `${Math.max(0, Math.min(100, r.value))}%`,
              background: r.color,
            }}
            title={`${r.label}: ${r.value.toFixed(1)}%`}
          />
        ))}
        <div
          style={{ width: `${free}%`, background: "#f8fafc" }}
          title={`Free / unattributed: ${free.toFixed(1)}%`}
        />
      </div>

      {/* Legend / numeric table */}
      <ul className="text-[12px] text-gray-700 space-y-1">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center gap-2">
            <span
              className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
              style={{ background: r.color }}
            />
            <span className="flex-1">{r.label}</span>
            <span className="tabular-nums font-semibold">{r.value.toFixed(1)}%</span>
          </li>
        ))}
        {hostCpu - totalNamed > 1 && (
          <li className="flex items-center gap-2 text-gray-400 italic">
            <span className="inline-block w-2.5 h-2.5 rounded-sm shrink-0 bg-gray-200" />
            <span className="flex-1">Unattributed (named categories sum &lt; host total)</span>
            <span className="tabular-nums">{(hostCpu - totalNamed).toFixed(1)}%</span>
          </li>
        )}
        <li className="flex items-center gap-2 pt-1 mt-1 border-t border-gray-100">
          <span className="inline-block w-2.5 h-2.5 rounded-sm shrink-0 bg-gray-100 border border-gray-200" />
          <span className="flex-1 font-medium text-gray-600">
            Host CPU at this minute
            {slot.hostCpu === null ? " — estimated from named categories" : ""}
          </span>
          <span className="tabular-nums font-semibold text-gray-900">
            {hostCpu.toFixed(1)}%
          </span>
        </li>
      </ul>
    </div>
  );
}

/** Format a Unix-seconds instant as a Vilnius date string (yyyy-MM-dd). */
function fmtVilniusDate(sec: number): string {
  return new Date(sec * 1000).toLocaleDateString("en-CA", {
    timeZone: "Europe/Vilnius",
  });
}
function fmtVilniusTime(sec: number): string {
  return new Date(sec * 1000).toLocaleTimeString("lt-LT", {
    timeZone: "Europe/Vilnius",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function fmtVilniusDateTime(sec: number): string {
  return `${fmtVilniusDate(sec)} · ${fmtVilniusTime(sec)}`;
}
/** Vilnius hour + minute for a Unix-seconds instant — used to align an
 *  episode's peak second with a granularity=1 slot returned by the
 *  process-history endpoint (which keys slots by Vilnius h/m). */
function vilniusHourMinute(sec: number): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Vilnius",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(sec * 1000));
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? "0", 10);
  // Intl returns "24" at midnight on some engines — normalise.
  const rawH = get("hour");
  return { hour: rawH === 24 ? 0 : rawH, minute: get("minute") };
}

// EvidenceRow used to back the now-removed Evidence-summary / Class
// context cards in HostEvidenceView; deleted 2026-06-01 along with
// those cards. Their numbers already live in the matrix row above.

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
  index: PilotZabbixIndex,
  threshold: number,
  periodDays: number,
  businessHoursOnly: boolean,
): DrilldownHost[] {
  // Bug fix (2026-06-02, batch 2): the previous signature still
  // accepted `zabbix` even though it consumed everything through
  // `index` and silenced the unused param with `void zabbix`. Drop
  // it. Callers only need to pass the precomputed index.
  const { zabbixByName, trendsByHost } = index;
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
    let hostBusinessSamples = 0;
    let sawAnyData = false;
    for (const t of trends) {
      // Bug fix (2026-06-02, batch of 10): drilldown's per-host
      // peak / typical / minutes-above must use the SAME skip-on-
      // missing-business-data semantics as the matrix above. The
      // earlier draft silently fell back to t.avg / t.max for
      // trend-only days when business stats were absent, producing
      // drilldown numbers that drifted from the matrix row above
      // (which now skips those days entirely per the earlier fix).
      // Now: skip the day outright when business toggle is on and
      // there's no business data for it. Drilldown header values
      // therefore round-trip with the matrix class row.
      const businessOk =
        businessHoursOnly &&
        t.avgBusiness !== null &&
        t.avgBusiness !== undefined &&
        t.maxBusiness !== null &&
        t.maxBusiness !== undefined;
      if (businessHoursOnly && !businessOk) continue;
      const useAvg = businessHoursOnly ? (t.avgBusiness as number) : t.avg;
      const useMax = businessHoursOnly ? (t.maxBusiness as number) : t.max;
      if (Number.isFinite(useAvg)) {
        sawAnyData = true;
        if (useAvg > 0) dailyAvgs.push(useAvg);
      }
      if (Number.isFinite(useMax) && useMax > 0) {
        peakCpu = peakCpu === null ? useMax : Math.max(peakCpu, useMax);
      }
      if (t.minutesAbove) {
        const businessBucket = businessHoursOnly ? t.minutesAboveBusiness : undefined;
        minutesAbove += businessBucket
          ? businessBucket[thKey] ?? 0
          : t.minutesAbove[thKey] ?? 0;
        if (businessBucket && typeof t.businessSamples === "number") {
          hostBusinessSamples += t.businessSamples;
        }
      }
    }
    const typicalCpu = dailyAvgs.length > 0 ? median(dailyAvgs) : null;
    // Use the business-intensity formula when business samples are
    // available; fall back to calendar-day rate otherwise (older
    // dates from the DB rollup).
    const minutesAbovePerDay = sawAnyData
      ? hostBusinessSamples > 0
        ? (minutesAbove * 1440) / hostBusinessSamples
        : periodDays > 0
          ? minutesAbove / periodDays
          : null
      : null;

    // Composite risk for sorting. Peak gets the heaviest weight because
    // a single high peak is what makes a host "interesting" for rollout
    // risk; sustained minutes-above is the supporting signal.
    //
    // Bug fix (2026-06-02, batch of 10): the raw addition
    // `(peakCpu ?? 0) + (minutesAbovePerDay ?? 0) * 0.5` was a
    // dimensional-analysis bug — peakCpu lives in 0-100 (%), while
    // minutesAbovePerDay lives in 0-1440 (min/day). With the global
    // business-hours toggle on, minutesAbovePerDay can land in the
    // 200-600 range (intensity-projected to 24h equivalent), which
    // utterly dominated peakCpu in the sort and reshuffled the
    // drilldown host order whenever the operator toggled business
    // hours. Now: cap the minutes-above contribution at 60 min/d
    // (anything above 1h/day is all "very bad", a flat tie-breaker)
    // and clamp peakCpu to 100. Sort order is now stable across
    // toggle modes and consistent in semantics.
    const cappedMin = Math.min(minutesAbovePerDay ?? 0, 60);
    const riskScore = Math.min(100, peakCpu ?? 0) + cappedMin * 0.5;

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
/** Bundle of indexes derived purely from pilot + zabbix payload.
 *  Built once per pilot/zabbix payload via `buildPilotZabbixIndex` and
 *  reused across every filter-change run of `computeCpuMatrix` /
 *  `buildDrilldownHosts`. Splitting this out keeps the per-filter
 *  compute cost down to the matching/aggregation loop itself. */
interface PilotZabbixIndex {
  zabbixByName: Map<string, ZabbixHostData>;
  trendsByHost: Map<string, ZabbixCpuTrend[]>;
  perHostMap: Map<string, RolloutPerHostEntry>;
  deployedSet: Set<string>;
  /** Pre-computed period length derived from the zabbix payload.
   *  Hoisted here so filter-only re-renders of computeCpuMatrix don't
   *  re-iterate `new Set(cpuTrends.map(t.date))` every time. */
  periodDays: number;
}

function buildPilotZabbixIndex(zabbix: ZabbixData): PilotZabbixIndex {
  // Bug fix (2026-06-02, batch 2): the previous signature accepted
  // `pilot` only to keep its symmetry with the older non-hoisted
  // call sites and silenced the unused-arg lint warning with
  // `void pilot`. Now that every call site reads from `index`, the
  // unused parameter is just dead noise — drop it. Future device-
  // level indexes can re-add the param without breaking callers
  // because `index` is a typed bundle.
  const zabbixByName = new Map(zabbix.hosts.map((h) => [h.hostName, h]));
  const trendsByHost = new Map<string, ZabbixCpuTrend[]>();
  for (const t of zabbix.cpuTrends ?? []) {
    let list = trendsByHost.get(t.hostId);
    if (!list) {
      list = [];
      trendsByHost.set(t.hostId, list);
    }
    list.push(t);
  }
  const perHostMap = new Map<string, RolloutPerHostEntry>(
    (zabbix.rolloutPerHost?.perHost ?? []).map((p) => [p.hostId, p]),
  );
  const deployedSet = new Set<string>(zabbix.retellectDeployedHostIds ?? []);
  for (const id of zabbix.retellectActiveInPeriodHostIds ?? []) deployedSet.add(id);
  for (const entry of zabbix.rolloutPerHost?.perHost ?? []) {
    const onTracked = entry.on.realTrackedMinutes + entry.on.syntheticTrackedMinutes;
    if (onTracked > 0) deployedSet.add(entry.hostId);
  }
  const periodDays = (() => {
    const fromAggregate = zabbix.rolloutPerHost?.periodDays;
    if (fromAggregate && fromAggregate > 0) return fromAggregate;
    const trends = zabbix.cpuTrends ?? [];
    if (trends.length === 0) return 14;
    const dates = new Set<string>();
    for (const t of trends) dates.add(t.date);
    return Math.max(1, dates.size);
  })();
  return { zabbixByName, trendsByHost, perHostMap, deployedSet, periodDays };
}

function computeCpuMatrix(
  pilot: RtPilotData,
  zabbix: ZabbixData,
  index: PilotZabbixIndex,
  threshold: number,
  storeFilter: string[],
  countryFilter: string,
  cpuCountFrom: "tracked" | "active",
  businessHoursOnly: boolean,
): { matrix: CpuMatrixRow[]; periodDays: number; fleetTotal: number } {
  const { zabbixByName, trendsByHost, perHostMap, deployedSet, periodDays } = index;
  // Combined country + store filter — both narrow the same device
  // set, applied as an AND. Country is the coarser slice (LT / LV /
  // EE); store is finer (multi-select). When country is "all" and the
  // store set is empty we operate on the full Baltic estate. A
  // non-empty store set ORs together — a device passes if its store is
  // in the set.
  const storeSet = new Set(storeFilter);
  const matchesFilters = (d: { storeName: string; country: string | null }) => {
    if (countryFilter !== "all" && d.country !== countryFilter) return false;
    if (storeSet.size > 0 && !storeSet.has(d.storeName)) return false;
    return true;
  };

  // Fleet denominator for the per-row "% of fleet" badge. Includes
  // every pilot device under the current filters — even hosts without
  // a Zabbix link or with no agent installed at all. The share is a
  // strategic-importance signal, not a measurement signal, so the
  // count must reflect physical inventory, not monitoring coverage.
  // (Coverage gaps are surfaced separately in the drilldown
  // "Unmonitored" tab.)
  // Bug fix (2026-06-02, batch 2): fleetTotal used to live in its own
  // `pilot.devices.filter(matchesFilters).length` pass — a full O(devices)
  // sweep that ran in addition to the main loop below which already
  // iterates pilot.devices with the same filter. Now we accumulate
  // `fleetTotal` inside the main loop (see the `if (matchesFilters)
  // ... fleetTotal++` block below) so the matrix compute does ONE pass
  // through pilot.devices instead of two. Saves ~50 % on the device-
  // scan portion of computeCpuMatrix wall time at Rimi scale (1554
  // devices).
  let fleetTotal = 0;
  // (periodDays now lives on the PilotZabbixIndex bundle — see Bug
  // batch 2 perf hoist.)

  // (zabbixByName / trendsByHost / perHostMap / deployedSet now arrive
  // pre-built in `index` — see PilotZabbixIndex + buildPilotZabbixIndex
  // above. Filter-only re-renders therefore skip this O(devices+hosts+
  // trends) work entirely.)

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
    /** Sum of minutesAbove[threshold] from cpuTrends — uses the
     *  business-hours subset when cpuTrends carries it, otherwise
     *  falls back to the 24h count. */
    sumMinAboveTracked: number;
    /** Sum of *business-hour* samples observed across all
     *  (host, day) rows in this class. Acts as a true denominator
     *  for the business-intensity rate (numerator above is the
     *  business subset of `minutesAbove`, so the denominator must
     *  match — using calendar minutes here would scale the rate
     *  back down toward 24h). When 0, the rate falls back to the
     *  legacy hostsWithData × periodDays denominator so the metric
     *  stays defined for older days that came through the rollup
     *  table (no business filter yet). */
    sumBusinessSamples: number;
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
    if (!matchesFilters(d)) continue;
    // Combined fleetTotal accumulation (batch 2 perf): count every
    // filter-passing device here so we don't need a second
    // pilot.devices.filter pass for the % of fleet denominator.
    fleetTotal++;
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
        sumBusinessSamples: 0,
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
      // Pick the appropriate avg / max field based on the toggle.
      //
      // Bug fix (2026-06-02): the earlier draft silently fell back
      // to the 24h fields when business stats were missing for a
      // day, which produced a class-level Typical / Max that mixed
      // business-hour and 24h semantics across days. Now: when the
      // toggle is ON and the day has no business stats (older
      // trend-only days outside Zabbix history retention), the day
      // is SKIPPED from dailyAvgPool / maxCpu aggregation rather
      // than dilluted in. The metric is then either honestly
      // business-only (recent history-driven days only) or honestly
      // 24h (toggle off).
      const businessOk =
        businessHoursOnly &&
        t.avgBusiness !== null &&
        t.avgBusiness !== undefined &&
        t.maxBusiness !== null &&
        t.maxBusiness !== undefined;
      if (businessHoursOnly && !businessOk) {
        // Skip this day — no business data, won't mix semantics.
        continue;
      }
      const useAvg = businessHoursOnly ? (t.avgBusiness as number) : t.avg;
      const useMax = businessHoursOnly ? (t.maxBusiness as number) : t.max;
      if (Number.isFinite(useAvg)) {
        hostHasData = true;
        if (useAvg > 0) g.dailyAvgPool.push(useAvg);
      }
      if (Number.isFinite(useMax) && useMax > 0) {
        g.maxCpu = g.maxCpu === null ? useMax : Math.max(g.maxCpu, useMax);
      }
      if (t.minutesAbove) {
        // Prefer the business-hours subset when present (Zabbix
        // recent-window path) AND the toggle is on. DB-rollup days
        // have no business filter yet; for those, sumBusinessSamples
        // stays 0 and the display formula falls back to the legacy
        // calendar-day denominator further down.
        const businessBucket = businessHoursOnly ? t.minutesAboveBusiness : undefined;
        const dayMinutesAbove = businessBucket
          ? businessBucket[thKey] ?? 0
          : t.minutesAbove[thKey] ?? 0;
        g.sumMinAboveTracked += dayMinutesAbove;
        for (const b of ACTIVE_ABOVE_BUCKETS) {
          const v = businessBucket ? businessBucket[b] ?? 0 : t.minutesAbove[b] ?? 0;
          g.minutesAboveByBucketTracked[b] += v;
        }
        if (businessBucket && typeof t.businessSamples === "number") {
          g.sumBusinessSamples += t.businessSamples;
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

    // Bug fix / observability (2026-06-02, batch 2): when exactly ONE
    // ON host contributed (e.g. Pavilnionys SCO2 on i3-6100), we have
    // a real measured delta but the class falls below the "≥2 ON +
    // ≥2 OFF" bar for measured-on-off evidence. Conservative scenario
    // takes over and the operator loses sight of the single host's
    // real-world behaviour — even though that one host may have shown
    // a much larger / smaller shift than the conservative figure
    // predicts. Compute the indicative delta here so the row can
    // surface it as a Decision-cell qualifier alongside the
    // conservative scenario.
    let singleHostMeasuredImpactPp: number | null = null;
    if (
      g.hostsOnContributed === 1 &&
      g.hostsOffContributed >= 1 &&
      avgOnTotalCpu !== null &&
      avgOffTotalCpu !== null
    ) {
      const rawDelta = avgOnTotalCpu - avgOffTotalCpu;
      // Clamp same as the measured path so a stuck Zabbix counter
      // doesn't surface as +60 pp here either. Negative deltas are
      // KEPT (clamped at -10 lower bound only) — when a real ON
      // host runs cooler than the OFF average for the same hardware
      // tier, that's information worth showing, not hiding.
      singleHostMeasuredImpactPp = Math.max(-10, Math.min(30, Math.round(rawDelta * 10) / 10));
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
          businessSamples: g.sumBusinessSamples,
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
        ? perHostPerDay(timeAboveNowMin, g.hostsWithData, periodDays, g.sumBusinessSamples)
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
      businessSamples: g.sumBusinessSamples,
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
      singleHostMeasuredImpactPp,
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
    "typicalCpu" | "timeAboveNowMin" | "minutesAboveByBucket" | "hostsWithData" | "evidence" | "periodDays" | "businessSamples"
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
    row.businessSamples,
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
/** Convert a total `minutes above threshold` count into a per-day rate.
 *
 *  Two formulas, both label as "min/day":
 *
 *   • Business-intensity (preferred): when `businessSamples` is
 *     supplied, return `total × 1440 / businessSamples`. The total is
 *     business-only minutes above; the denominator is the count of
 *     observed business-hour samples (i.e. business minutes that have
 *     data). The 1440 factor projects the density to a 24h baseline so
 *     the number reads as "if the host kept this business-hour
 *     intensity for a full day". Higher than the 24h-uniform rate
 *     because off-hours quiet time isn't pulling the average down.
 *
 *   • Calendar fallback: when `businessSamples` is 0/undefined (older
 *     dates from the DB rollup table that don't carry the business
 *     filter yet, or any caller still on the legacy contract), divide
 *     by `hostsWithData × periodDays`. Same formula the matrix used
 *     before the business-hours change landed.
 *
 *  Returning null on null input keeps "no data" propagation clean. */
function perHostPerDay(
  total: number | null,
  hostsWithData: number,
  periodDays: number,
  businessSamples?: number,
): number | null {
  if (total === null) return null;
  if (businessSamples && businessSamples > 0) {
    return (total * 1440) / businessSamples;
  }
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

// (formatList was only used by the removed RecommendedActionsCard; removed 2026-06-01.)
