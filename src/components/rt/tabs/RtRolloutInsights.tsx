"use client";

/**
 * Rollout Insights — leadership-facing decision page.
 *
 * Sits above the analytical tabs (Timeline / CPU Comparison / Capacity Risk /
 * Hypotheses) and answers the rollout question in one scan:
 *   1. which CPU classes are safe to roll out now,
 *   2. which need caution or optimisation first,
 *   3. what mainly drives CPU bottlenecks,
 *   4. what to do next,
 *   5. where decision confidence is still limited.
 *
 * Deliberately calmer than the analysis tabs — no drill-downs, no per-host
 * exploration, no charts that already exist elsewhere. The Decision Matrix is
 * the answer; everything else exists to qualify, not to invite more digging.
 */

import { useEffect, useMemo, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { RtPilotData, ZabbixData } from "../RtPilotWorkspace";
import { useRtFilters } from "../RtFiltersContext";
import { resolveCpuModel, computeCpuTotal } from "./rt-inventory-helpers";
import { isRetellectActiveToday } from "./rt-overview-helpers";
import type { RolloutOnOffAggregate, RolloutPerHostEntry } from "@/lib/rollout-insights/types";
import { emptyOnOffAggregate } from "@/lib/rollout-insights/types";
import { mergeOnOff, weightedAvg } from "@/lib/rollout-insights/aggregate";

// ─── Types ──────────────────────────────────────────────────────────

type RolloutStatus = "safe" | "validate" | "optimize" | "do-not-roll-out" | "unproven";
type Confidence = "high" | "medium" | "low";

interface MatrixRow {
  model: string;
  hostCount: number;
  hostsOn: number;
  hostsOff: number;
  /** Hosts with at least one usable trend/snapshot sample contributing
   *  to peakOn. May be < hostsOn when a host has python.cpu activity
   *  but no system.cpu.util trend data (e.g. agent state=1 across the
   *  window). Drives the "from N hosts" sub-label under the bar. */
  hostsOnObserved: number;
  hostsOffObserved: number;
  /** Average per-host peak CPU across the observed hosts in the group.
   *  - Legacy compute: max trend-bucket value across the FULL period.
   *  - Aggregate compute: max totalCpu across that host's ACTIVE buckets
   *    only (busy windows where spss.cpu was above baseline + threshold).
   *  Averaging across hosts smooths single-host outliers either way. */
  peakOn: number | null;
  peakOff: number | null;
  minAboveOn: number | null;
  minAboveOff: number | null;
  status: RolloutStatus;
  confidence: Confidence;
  /** True when the OFF column has too few hosts/days to compare. */
  comparabilityWeak: boolean;
  /** Compute path that produced this row. The aggregate path uses the
   *  Phase 1 per-host minute-level analytics and exposes the extra
   *  retellect/active-minutes fields below; legacy path uses the older
   *  snapshot+daily-trend approximation. */
  source: "aggregate" | "legacy";
  /** Avg Retellect CPU % across active minutes classified Retellect ON.
   *  Aggregate path only — null in legacy. Surfaces "direct Retellect
   *  attribution" so the comparison isn't just total-CPU based. */
  avgRetellectOn: number | null;
  /** Avg Retellect CPU % across active minutes classified Retellect OFF.
   *  Should be close to 0; deviations indicate a host whose python items
   *  fired below the 0.5% ON cutoff (drove false-OFF classification). */
  avgRetellectOff: number | null;
  /** Sum of real (history) active minutes across ON + OFF in this group.
   *  Drives the confidence band and the coverage footer. */
  activeRealMinutes: number;
  /** Sum of synthetic (60-min trend) active minutes across ON + OFF. */
  activeSynMinutes: number;
  /** Hosts that had a computable baseline (≥30 night samples). Hosts
   *  with no baseline are counted in hostCount but contribute nothing
   *  to the aggregate metrics. */
  hostsWithBaseline: number;
  /** Minutes (anywhere in the window, NOT restricted to busy) where
   *  totalCpu exceeded the chosen threshold. Counted unconditionally so
   *  CPU spikes from non-SCO sources (SQL backup, antivirus, OS task)
   *  stay visible and the column matches CPU Timeline's minute counts. */
  minutesAboveOnAtThreshold: number;
  minutesAboveOffAtThreshold: number;
  /** Total tracked minutes per direction (any bucket with a usable
   *  totalCpu reading). Drives the percent denominator. Apple-to-apple:
   *  same per-direction denominator even when CPU classes have very
   *  different absolute minute counts. */
  totalTrackedOn: number;
  totalTrackedOff: number;
}

interface DriverSlice {
  id: "scoApp" | "db" | "system" | "retellect" | "other";
  label: string;
  /** Average CPU% contribution across hosts during peak windows */
  value: number;
  /** measured | partly | unattributed */
  evidence: "measured" | "partly" | "unattributed";
  color: string;
}

// ─── Constants ──────────────────────────────────────────────────────

const STATUS_LABEL: Record<RolloutStatus, string> = {
  safe: "Safe now",
  validate: "Validate further",
  optimize: "Optimize first",
  "do-not-roll-out": "Do not roll out",
  unproven: "No Retellect data",
};

const STATUS_STYLES: Record<RolloutStatus, string> = {
  safe: "bg-emerald-50 text-emerald-700 border-emerald-200",
  validate: "bg-blue-50 text-blue-700 border-blue-200",
  optimize: "bg-amber-50 text-amber-700 border-amber-200",
  "do-not-roll-out": "bg-red-50 text-red-700 border-red-200",
  unproven: "bg-gray-100 text-gray-600 border-gray-300",
};

const STATUS_DOT: Record<RolloutStatus, string> = {
  safe: "bg-emerald-500",
  validate: "bg-blue-500",
  optimize: "bg-amber-500",
  "do-not-roll-out": "bg-red-500",
  unproven: "bg-gray-400",
};

const CONFIDENCE_STYLES: Record<Confidence, string> = {
  high: "text-emerald-700 bg-emerald-50",
  medium: "text-amber-700 bg-amber-50",
  low: "text-gray-600 bg-gray-100",
};

/** Sort priority for the matrix — highest risk first. */
const STATUS_RANK: Record<RolloutStatus, number> = {
  "do-not-roll-out": 0,
  optimize: 1,
  validate: 2,
  safe: 3,
  // "unproven" sorts last — these classes haven't been tested so they
  // shouldn't crowd the top of the matrix where graded decisions live.
  unproven: 4,
};

// ─── Component ──────────────────────────────────────────────────────

export function RtRolloutInsights({
  pilot,
  zabbix,
}: {
  pilot: RtPilotData;
  zabbix: ZabbixData;
}) {
  const { filters, setFilter } = useRtFilters();
  const threshold = filters.threshold;
  const storeFilter = filters.store;
  const activeThresholdPpFromFilter = filters.activeThresholdPp;
  const cpuCountFrom = filters.cpuCountFrom;

  // Period selector mirrors RtTimeline's URL-driven pattern. Changing the
  // dropdown pushes ?period=... into the URL, which triggers the page server
  // component to refetch the CPU history for the new window. Without the
  // router.push the dropdown was a no-op — context updated, but the data
  // remained whatever the page initially fetched, so the matrix never
  // changed. The useEffect handles the inverse direction (deep-link/back-nav
  // syncing URL → context).
  const router = useRouter();
  const pathname = usePathname();
  const urlSearchParams = useSearchParams();
  // useTransition wraps the router.push so React reports back when the
  // Server Component navigation is in flight. Period changes trigger a
  // batched Zabbix trend.get for up to 23 item-chunks sequentially —
  // typically 5-10 s on the 30/90 d windows. Without a pending flag the
  // dropdown looked broken: the chip showed the new value instantly but
  // the matrix kept rendering the previous period's data until the fetch
  // returned. The flag drives the small "Updating…" pill and the matrix
  // opacity fade below, so the user can tell something is happening.
  const [isRefreshing, startTransition] = useTransition();
  useEffect(() => {
    const urlPeriod = urlSearchParams.get("period");
    if (urlPeriod && urlPeriod !== filters.period) {
      setFilter("period", urlPeriod);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlSearchParams]);
  const setPeriod = (v: string) => {
    setFilter("period", v);
    const params = new URLSearchParams(urlSearchParams.toString());
    params.set("period", v);
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
  };

  // Active-threshold slider — local state with 300 ms debounce before URL
  // push. The slider drags through ~21 discrete positions (0–10 pp in
  // 0.5 pp steps); without debouncing every step would fire its own
  // router.push and trigger a Server Component refetch, swamping Zabbix.
  // The local state keeps the UI responsive; URL sync runs once the user
  // stops moving the handle. URL → context sync covers the inverse
  // direction (deep-link / back-nav).
  const [sliderValue, setSliderValue] = useState(activeThresholdPpFromFilter);
  useEffect(() => {
    setSliderValue(activeThresholdPpFromFilter);
  }, [activeThresholdPpFromFilter]);
  useEffect(() => {
    const urlAt = urlSearchParams.get("at");
    if (!urlAt) return;
    const parsed = parseFloat(urlAt);
    if (!Number.isFinite(parsed)) return;
    if (parsed !== filters.activeThresholdPp) {
      setFilter("activeThresholdPp", parsed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlSearchParams]);
  useEffect(() => {
    if (sliderValue === activeThresholdPpFromFilter) return;
    const t = setTimeout(() => {
      setFilter("activeThresholdPp", sliderValue);
      const params = new URLSearchParams(urlSearchParams.toString());
      params.set("at", String(sliderValue));
      startTransition(() => {
        router.push(`${pathname}?${params.toString()}`);
      });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sliderValue]);

  // Two compute paths:
  //   • aggregate — Phase 1 per-host minute-level analytics (server-fetched
  //     as `zabbix.rolloutPerHost`). Preferred when present because it
  //     restricts averages to active minutes and surfaces direct Retellect
  //     attribution alongside total CPU.
  //   • legacy — snapshot+daily-trend approximation that ran before Phase 1.
  //     Falls back when the per-host fetch returned null/empty (Zabbix
  //     unreachable, no matched hosts in pilot). Drivers + actions still
  //     come from the legacy path either way — Phase 2 will move drivers
  //     onto the new aggregate; for now the snapshot-based decomposition
  //     is informative enough.
  const legacy = useMemo(
    () => computeRolloutInsights(pilot, zabbix, threshold, storeFilter),
    [pilot, zabbix, threshold, storeFilter],
  );
  const aggregate = useMemo(
    () => computeRolloutInsightsFromAggregate(pilot, zabbix, storeFilter, threshold, cpuCountFrom),
    [pilot, zabbix, storeFilter, threshold, cpuCountFrom],
  );
  const useAggregate = aggregate !== null;
  const matrix = useAggregate ? aggregate!.matrix : legacy.matrix;
  const periodDays = useAggregate ? aggregate!.periodDays : legacy.periodDays;
  const activeThresholdPp = useAggregate ? aggregate!.activeThresholdPp : null;
  // Actions derived from the active matrix so they reflect the correct
  // status mix; drivers stay from legacy compute (snapshot-based).
  const actions = useMemo(() => actionsFromMatrix(matrix), [matrix]);
  const drivers = legacy.drivers;

  // Client-side anomaly surfacing — fires once per rendered matrix so
  // operators investigating "why does row X look weird" can grep the
  // browser console for the summary instead of digging into payloads.
  // Counts only; the actual numbers are visible in the UI itself.
  useEffect(() => {
    if (!useAggregate) return;
    const lowConfidence = matrix.filter((r) => r.confidence === "low").length;
    const noBaselineHosts = matrix.reduce((s, r) => s + (r.hostCount - r.hostsWithBaseline), 0);
    const emptyGroups = matrix.filter(
      (r) => r.activeRealMinutes + r.activeSynMinutes === 0,
    ).length;
    if (lowConfidence === 0 && noBaselineHosts === 0 && emptyGroups === 0) return;
    console.warn(
      `[rollout-insights] matrix diagnostics — rows=${matrix.length} ` +
        `lowConfidence=${lowConfidence} hostsWithoutBaseline=${noBaselineHosts} ` +
        `zeroActiveGroups=${emptyGroups}`,
    );
  }, [matrix, useAggregate]);

  return (
    <>
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-800">Rollout Insights</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Decision summary for {pilot.name} — last {periodDays} days
            {useAggregate
              ? `, active threshold +${activeThresholdPp} pp (above each host's night-time spss.cpu baseline)`
              : `, threshold ${threshold}%`}
            . One read tells you which CPU classes to roll out, hold, or optimize.
          </p>
        </div>
      </div>

      {/* ── Filters — minimal: period / threshold / store ──────────── */}
      <div className="bg-white rounded-lg border border-gray-200 px-4 py-3 mb-5 flex flex-wrap items-center gap-4 text-xs">
        <FilterSelect
          label="Period"
          value={filters.period}
          options={[
            { v: "7d", l: "7 days" },
            { v: "14d", l: "14 days" },
            { v: "30d", l: "30 days" },
            { v: "90d", l: "90 days" },
          ]}
          onChange={setPeriod}
        />
        {isRefreshing ? (
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
            Updating window…
          </span>
        ) : null}
        {useAggregate && cpuCountFrom === "active" && (
          <ActiveThresholdSlider
            value={sliderValue}
            onChange={setSliderValue}
            pending={sliderValue !== activeThresholdPpFromFilter}
          />
        )}
        <FilterSelect
          label="High-CPU threshold"
          value={String(threshold)}
          options={[
            { v: "20", l: "20%" },
            { v: "30", l: "30%" },
            { v: "40", l: "40%" },
            { v: "50", l: "50%" },
            { v: "60", l: "60%" },
            { v: "70", l: "70%" },
            { v: "80", l: "80%" },
            { v: "90", l: "90%" },
          ]}
          onChange={(v) => setFilter("threshold", Number(v))}
        />
        {useAggregate && (
          <CountFromToggle
            value={cpuCountFrom}
            onChange={(v) => setFilter("cpuCountFrom", v)}
          />
        )}
        <FilterSelect
          label="Store"
          value={filters.store}
          options={[
            { v: "all", l: "All stores" },
            ...pilot.stores.map((s) => ({ v: s.name, l: s.name })),
          ]}
          onChange={(v) => setFilter("store", v)}
        />
        <span className="text-gray-300 ml-auto text-[11px]">
          Filters persist across tabs
        </span>
      </div>

      {/* ── A. CPU Rollout Decision Matrix ─────────────────────────── */}
      {/* Single in-flight dimmer wraps the matrix + drivers + actions so
          the whole period-dependent surface fades together while the
          Server Component refetch lands. opacity-60 keeps the previous
          numbers legible (so the user can still read them) but signals
          "this is being replaced". pointer-events-none avoids accidental
          clicks landing on the stale UI. */}
      <div
        className={`transition-opacity duration-200 ${isRefreshing ? "opacity-60 pointer-events-none" : ""}`}
        aria-busy={isRefreshing || undefined}
      >
      <section className="mb-8">
        <div className="flex items-baseline justify-between mb-2">
          <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
            CPU Rollout Decision Matrix
          </h3>
          <span className="text-[11px] text-gray-400">
            sorted by risk · ON = Retellect enabled
          </span>
        </div>
        {matrix.length === 0 ? (
          <div className="bg-white rounded-lg border border-gray-200 px-5 py-10 text-center text-sm text-gray-400">
            Not enough CPU history to score rollout. Check Data Health.
          </div>
        ) : (
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left py-3 px-4 text-[11px] font-semibold text-gray-500 uppercase">CPU class</th>
                  <th className="text-center py-3 px-3 text-[11px] font-semibold text-gray-500 uppercase">Hosts</th>
                  <th className="text-left py-3 px-3 text-[11px] font-semibold text-gray-500 uppercase">
                    {useAggregate ? "Avg peak Total CPU" : "Avg peak CPU"}
                    <span className="ml-1 normal-case font-normal text-gray-400 lowercase">
                      {useAggregate ? "during active min · ON vs OFF" : "per host · ON vs OFF"}
                    </span>
                  </th>
                  <th className="text-center py-3 px-3 text-[11px] font-semibold text-gray-500 uppercase">
                    {useAggregate ? "Retellect CPU avg" : `Min ≥ ${threshold}%`}
                  </th>
                  {useAggregate && (
                    <th className="text-center py-3 px-3 text-[11px] font-semibold text-gray-500 uppercase">
                      Min &gt; {threshold}%
                      <span className="ml-1 normal-case font-normal text-gray-400 lowercase">
                        {cpuCountFrom === "active" ? "% of busy" : "% of tracked"}
                      </span>
                    </th>
                  )}
                  <th className="text-center py-3 px-4 text-[11px] font-semibold text-gray-500 uppercase">Status</th>
                  <th className="text-center py-3 px-3 text-[11px] font-semibold text-gray-500 uppercase">Confidence</th>
                </tr>
              </thead>
              <tbody>
                {matrix.map((row) => (
                  <tr key={row.model} className="border-t border-gray-100 align-middle">
                    <td className="py-3 px-4 font-medium text-gray-900">
                      {row.model}
                      {row.comparabilityWeak && (
                        <div className="text-[10px] text-amber-600 font-normal mt-0.5">
                          ON/OFF comparability limited
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-3 text-center text-gray-500">
                      <span className="font-medium text-gray-700">{row.hostCount}</span>
                      {row.source === "aggregate" && row.hostsWithBaseline < row.hostCount && (
                        <div
                          className="text-[10px] text-amber-600"
                          title={`${row.hostCount - row.hostsWithBaseline} of ${row.hostCount} ${row.hostCount - row.hostsWithBaseline === 1 ? "host" : "hosts"} have no usable spss.cpu baseline (no Zabbix samples, broken agent, or fewer than 30 night samples) and are excluded from the ON/OFF aggregate.`}
                        >
                          {row.hostsWithBaseline}/{row.hostCount} with data
                        </div>
                      )}
                      <div className="text-[10px] text-gray-400">
                        {row.hostsOn} ON · {row.hostsOff} OFF
                      </div>
                    </td>
                    <td className="py-3 px-3">
                      <OnOffBars peakOn={row.peakOn} peakOff={row.peakOff} threshold={threshold} hostsOnObserved={row.hostsOnObserved} hostsOffObserved={row.hostsOffObserved} />
                    </td>
                    <td className="py-3 px-3 text-center text-xs">
                      {row.source === "aggregate" ? (
                        <>
                          <div className={`font-medium ${retellectColor(row.avgRetellectOn)}`}>
                            {fmtPct(row.avgRetellectOn)} <span className="text-gray-400 font-normal">ON</span>
                          </div>
                          <div className={`${retellectColor(row.avgRetellectOff)}`}>
                            {fmtPct(row.avgRetellectOff)} <span className="text-gray-400 font-normal">OFF</span>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className={`font-medium ${minutesColor(row.minAboveOn)}`}>
                            {fmtMinutes(row.minAboveOn)} <span className="text-gray-400 font-normal">ON</span>
                          </div>
                          <div className={`${minutesColor(row.minAboveOff)}`}>
                            {fmtMinutes(row.minAboveOff)} <span className="text-gray-400 font-normal">OFF</span>
                          </div>
                        </>
                      )}
                    </td>
                    {useAggregate && (
                      <td className="py-3 px-3 text-center text-xs">
                        <AboveThresholdCell
                          minutes={row.minutesAboveOnAtThreshold}
                          total={row.totalTrackedOn}
                          label="ON"
                          accent
                          countFromLabel={cpuCountFrom === "active" ? "busy" : "tracked"}
                        />
                        <AboveThresholdCell
                          minutes={row.minutesAboveOffAtThreshold}
                          total={row.totalTrackedOff}
                          label="OFF"
                          countFromLabel={cpuCountFrom === "active" ? "busy" : "tracked"}
                        />
                      </td>
                    )}
                    <td className="py-3 px-4 text-center">
                      <span
                        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-[11px] font-medium ${STATUS_STYLES[row.status]}`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[row.status]}`} />
                        {STATUS_LABEL[row.status]}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-center">
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium uppercase ${CONFIDENCE_STYLES[row.confidence]}`}
                      >
                        {row.confidence}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {matrix.length > 0 ? (
          useAggregate ? (
            <p className="mt-2 text-[11px] text-gray-400 leading-relaxed">
              Coverage: {matrix.reduce((s, r) => s + r.hostsOnObserved, 0)} ON-hosts &middot;{" "}
              {matrix.reduce((s, r) => s + r.hostsOffObserved, 0)} OFF-hosts (per-bucket classification — a
              host can appear in both columns) across the last {periodDays}-day window.
              {" "}
              Active minutes total{" "}
              {matrix.reduce((s, r) => s + r.activeRealMinutes, 0).toLocaleString("en-US")} reliable
              {" "}/ {matrix.reduce((s, r) => s + r.activeSynMinutes, 0).toLocaleString("en-US")} synthetic
              (hourly trend, 60 min/bucket). A minute counts as active when{" "}
              <code>spss.cpu &gt; baseline + {activeThresholdPp} pp</code>; baseline is the median spss.cpu
              between 02:00 and 05:00 Europe/Vilnius. Avg peak Total CPU = mean of per-host peak{" "}
              <code>system.cpu.util[,,avg1]</code> across active minutes. &ldquo;Min &gt; {threshold}%&rdquo;
              counts from {cpuCountFrom === "active" ? "active (busy) minutes only" : "all tracked minutes (matches CPU Timeline)"} — toggle via the
              &ldquo;Count from&rdquo; control above.
            </p>
          ) : (
            <p className="mt-2 text-[11px] text-gray-400 leading-relaxed">
              Coverage: {matrix.reduce((s, r) => s + r.hostsOnObserved, 0)} ON-hosts &middot;{" "}
              {matrix.reduce((s, r) => s + r.hostsOffObserved, 0)} OFF-hosts across the last {periodDays}
              -day window ({matrix.reduce((s, r) => s + r.hostsOnObserved, 0) * periodDays} ON host-days &middot;{" "}
              {matrix.reduce((s, r) => s + r.hostsOffObserved, 0) * periodDays} OFF host-days observed).
              Per-host peak = max hourly trend bucket; column shows the average of those per-host peaks.
            </p>
          )
        ) : null}
      </section>

      {/* ── B + C side by side on wide screens, stacked on narrow ── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 mb-8">
        {/* B. Main Bottleneck Drivers */}
        <section className="lg:col-span-3">
          <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-2">
            Main Bottleneck Drivers
          </h3>
          <div className="bg-white rounded-lg border border-gray-200 p-5">
            <DriverDecomposition drivers={drivers} />
            <p className="text-[11px] text-gray-400 mt-3 leading-relaxed">
              Decomposition of CPU during high-load windows. Retellect bucket
              captures all python-named processes — the Retellect helper runs
              under the Python service, so it is already counted here. Bars
              labelled <em>unattributed</em> are residual host CPU not covered
              by per-process telemetry.
            </p>
          </div>
        </section>

        {/* C. Recommended Next Actions */}
        <section className="lg:col-span-2">
          <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-2">
            Recommended Next Actions
          </h3>
          <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
            {actions.length === 0 ? (
              <div className="px-4 py-6 text-sm text-gray-400 text-center">
                No actions ranked yet — Decision Matrix is empty.
              </div>
            ) : (
              actions.map((a, idx) => (
                <div key={idx} className="flex items-start gap-3 px-4 py-3">
                  <span
                    className={`mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      a.priority === "high"
                        ? "bg-red-500"
                        : a.priority === "medium"
                          ? "bg-amber-500"
                          : "bg-blue-500"
                    }`}
                  />
                  <div className="text-sm text-gray-800 leading-snug">{a.text}</div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      {/* ── D. How metrics are calculated ──────────────────────────── */}
      {useAggregate && (
        <section className="mb-6">
          <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-2">
            How each metric is calculated
          </h3>
          <div className="bg-white rounded-lg border border-gray-200 px-5 py-4">
            <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-sm text-gray-600">
              <div>
                <dt className="font-semibold text-gray-800">Active threshold (+pp)</dt>
                <dd className="mt-0.5 leading-relaxed">
                  {ACTIVE_THRESHOLD_TOOLTIP}
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">High-CPU threshold (%)</dt>
                <dd className="mt-0.5 leading-relaxed">
                  Absolute <code>system.cpu.util[,,avg1]</code> level used by the &ldquo;Active min &gt; X%&rdquo;
                  column. Tunable across 20/30/40/50/60/70/80/90 bands precomputed per host —
                  changing it re-aggregates from cache without a Zabbix round-trip. Pick a lower
                  band when typical busy peaks sit below 50% (Rimi i3-4330/i3-6100 hardware
                  spends most active minutes in the 30–60% range; 70% catches only the
                  worst-loaded hosts and most rows would read 0%).
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Hosts</dt>
                <dd className="mt-0.5 leading-relaxed">
                  Total devices in the CPU class, plus the per-bucket split. ON / OFF reflect
                  whether the host contributed at least one ON-classified minute and at least
                  one OFF-classified minute respectively — the same host can appear in both
                  if Retellect ran for part of the window. The amber{" "}
                  <em>&ldquo;X/Y with data&rdquo;</em> sub-line appears when some devices have
                  no usable baseline (missing <code>spss.cpu</code> items, broken Zabbix agent,
                  or fewer than 30 overnight samples) and were dropped from the aggregate.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Avg peak Total CPU</dt>
                <dd className="mt-0.5 leading-relaxed">
                  For each host with a usable baseline, take the maximum
                  <code> system.cpu.util[,,avg1]</code> observed during that host&rsquo;s
                  <em> active</em> minutes (busy windows). The column shows the mean of those
                  per-host peaks — smooths single-host outliers while still being the worst
                  moment under load, restricted to busy time so idle hours don&rsquo;t dilute it.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Retellect CPU avg</dt>
                <dd className="mt-0.5 leading-relaxed">
                  Sum of all <code>python*.cpu</code> samples in each active minute, averaged
                  across minutes weighted by minute count. Direct attribution of how much CPU
                  Retellect itself consumed while the SCO was actually transacting.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Min &gt; X%</dt>
                <dd className="mt-0.5 leading-relaxed">
                  Percentage of minutes where Total CPU crossed the high-CPU threshold,
                  normalised so CPU classes with different sample counts compare apple-to-apple.
                  The &ldquo;Count from&rdquo; toggle switches the denominator:
                  {" "}<strong>All tracked</strong> counts every minute with a usable Total CPU
                  reading — same source as CPU Timeline, so the two views agree at the same
                  threshold. <strong>Active only</strong> restricts to busy windows
                  (spss &gt; baseline + active threshold) and is useful when the question is
                  &ldquo;What does Retellect itself cost when the SCO is transacting?&rdquo; —
                  it intentionally excludes non-SCO CPU sources (SQL backups, antivirus,
                  OS housekeeping). Hover the cell for absolute count.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Status</dt>
                <dd className="mt-0.5 leading-relaxed">
                  Graded only when the class has at least one ON-classified host
                  (real Retellect evidence). Bands on the Avg peak Total CPU:
                  <strong> safe</strong> &lt; 70%, <strong>validate further</strong> 70–84%,
                  <strong> optimize first</strong> 85–94%, <strong>do not roll out</strong> ≥ 95%.
                  When <em>hostsOn = 0</em> the row is <strong>No Retellect data</strong> regardless
                  of how cool the OFF baseline runs — without an ON sample we have no evidence the
                  class behaves the same with the Retellect load added.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Confidence</dt>
                <dd className="mt-0.5 leading-relaxed">
                  <strong>High</strong> when ≥5 000 reliable (1-min history) active minutes
                  AND ≥50% of the group&rsquo;s hosts have a computable baseline.
                  <strong> Medium</strong> at ≥500 reliable minutes.
                  <strong> Low</strong> otherwise — treat the row as directional, not decisive.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Per-host baseline</dt>
                <dd className="mt-0.5 leading-relaxed">
                  Median <code>spss.cpu</code> between 02:00 and 05:00 Europe/Vilnius. Median
                  (not mean) ignores housekeeping spikes — antivirus, Windows Update — and
                  reports the steady idle floor that lets the same threshold pp work across
                  Pentium-tier and i5-tier hardware.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Reliable vs synthetic minutes</dt>
                <dd className="mt-0.5 leading-relaxed">
                  Reliable = 1-min samples from Zabbix <code>history.get</code> (last ~14 d
                  retention). Synthetic = hourly <code>trend.get</code> averages extrapolated to
                  60 minutes per hour for periods beyond 14 d — conservative (the hour is
                  marked active only when its hour-average crosses baseline + threshold).
                  Only reliable minutes count toward the confidence band.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Cross-tab consistency note</dt>
                <dd className="mt-0.5 leading-relaxed">
                  Active mode reconciles exactly with CPU Timeline cells (same per-day source).
                  Tracked mode may show a small (&lt;10 %) drift between the matrix counters and
                  Timeline cells: cpuTrends counts every <code>history.get</code> sample
                  independently, while the matrix de-duplicates samples to a single per-minute
                  bucket per host. For periods &gt; 14 days the matrix additionally folds
                  synthetic minutes from hourly trend (weight 60) into the denominator; Timeline
                  only counts raw history. Pick a single tab as the source of truth for any
                  exact-count question.
                </dd>
              </div>
            </dl>
          </div>
        </section>
      )}

      {/* ── E. Where Decision Confidence Is Limited ────────────────── */}
      <section className="mb-2">
        <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-2">
          Where Decision Confidence Is Limited
        </h3>
        <div className="bg-gray-50 rounded-lg border border-gray-200 px-5 py-4">
          <ul className="space-y-1.5 text-sm text-gray-600">
            <li className="flex items-start gap-2">
              <span className="text-gray-300 mt-0.5">·</span>
              <span>
                Retellect bucket captures all python-named processes
                (including the helper, which runs under the Python service)
                — only non-python auxiliary processes, if any exist, would
                fall into <em>Other</em>.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-gray-300 mt-0.5">·</span>
              <span>
                Some older hosts still have incomplete process attribution,
                so the exact Retellect-only footprint is not fully proven on
                every CPU class.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-gray-300 mt-0.5">·</span>
              <span>
                Rows marked <em>ON/OFF comparability limited</em> have an
                imbalanced sample — verify under controlled load before final
                rollout decisions.
              </span>
            </li>
          </ul>
        </div>
      </section>
      </div>
    </>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { v: string; l: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="text-gray-500 font-medium">{label}</span>
      <select
        className="border border-gray-200 rounded px-2 py-1 text-xs bg-white text-gray-700 focus:outline-none focus:border-blue-400"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.v} value={o.v}>
            {o.l}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Active-threshold slider — only renders on the aggregate compute path.
 *
 * Why a slider here (vs the legacy 5-step Threshold dropdown): the active
 * threshold is a CONTINUOUS tuning parameter — "how aggressive should
 * we be at calling a minute 'busy'?". A coarse dropdown would prevent
 * users from feeling out the value's effect on the matrix in small
 * steps, which is the whole point of letting them adjust it. 0.5 pp
 * resolution matches the meaningful step size given typical diurnal
 * swing of 1–3 pp on Rimi hosts.
 *
 * Bounds 0–10 pp:
 *   • 0 pp = every minute above the baseline counts (trivial — every
 *     bucket where the agent reported any data is active).
 *   • 10 pp = only sustained heavy load counts (Pentium-tier hosts
 *     working hard); higher values collapse the matrix to silence on
 *     mid-tier hardware.
 *
 * Pending state (`pending` prop) reflects the debounce window — the
 * value moved but the URL push hasn't fired yet. Renders the inline
 * value badge in a muted tone so the user can see "your change is
 * pending, hold on".
 */
/** One-line definition exposed both in the slider tooltip and in the
 *  bottom methodology section so they don't drift out of sync. */
const ACTIVE_THRESHOLD_TOOLTIP =
  "A minute counts as ACTIVE (busy) when spss.cpu rises above this many " +
  "percentage points over the host's own nighttime baseline. Baseline = " +
  "median spss.cpu between 02:00 and 05:00 Europe/Vilnius. Lower values " +
  "treat more minutes as busy; higher values restrict to heavier load.";

function ActiveThresholdSlider({
  value,
  onChange,
  pending,
}: {
  value: number;
  onChange: (v: number) => void;
  pending: boolean;
}) {
  return (
    <label className="flex items-center gap-2" title={ACTIVE_THRESHOLD_TOOLTIP}>
      <span className="text-gray-500 font-medium inline-flex items-center gap-1">
        Active threshold
        <span
          aria-hidden="true"
          className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-gray-300 text-[9px] font-semibold text-gray-400 cursor-help"
        >
          i
        </span>
      </span>
      <input
        type="range"
        min={0}
        max={10}
        step={0.5}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-32 accent-blue-600"
        aria-label="Active threshold in percentage points above baseline"
        title={ACTIVE_THRESHOLD_TOOLTIP}
      />
      <span
        className={`tabular-nums text-xs font-medium ${pending ? "text-amber-600" : "text-gray-700"}`}
        title={pending ? "Releasing soon — debounce 300 ms" : ACTIVE_THRESHOLD_TOOLTIP}
      >
        +{value.toFixed(1)} pp
      </span>
    </label>
  );
}

/**
 * Segmented control: "Count from [All tracked | Active only]".
 *
 * Drives the &ldquo;Min &gt; X%&rdquo; column behaviour. All-tracked
 * counts every minute with a totalCpu reading (matches CPU Timeline);
 * active-only restricts to busy windows (spss above baseline + active-
 * threshold pp) for pure Retellect attribution. Default is tracked so
 * the matrix agrees with Timeline at the same threshold — switching to
 * active is a power-user move.
 */
function CountFromToggle({
  value,
  onChange,
}: {
  value: "tracked" | "active";
  onChange: (v: "tracked" | "active") => void;
}) {
  const baseBtn =
    "px-2 py-0.5 text-[11px] font-medium transition";
  const activeCls = "bg-blue-50 text-blue-700";
  const inactiveCls = "text-gray-500 hover:text-gray-700";
  return (
    <label className="flex items-center gap-2">
      <span
        className="text-gray-500 font-medium inline-flex items-center gap-1"
        title="Whether the Min > X% column counts from every tracked minute (Timeline-consistent) or only from busy minutes (Retellect attribution)."
      >
        Count from
        <span
          aria-hidden="true"
          className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-gray-300 text-[9px] font-semibold text-gray-400 cursor-help"
        >
          i
        </span>
      </span>
      <div className="inline-flex border border-gray-200 rounded overflow-hidden bg-white" role="radiogroup" aria-label="Count from">
        <button
          type="button"
          role="radio"
          aria-checked={value === "tracked"}
          className={`${baseBtn} ${value === "tracked" ? activeCls : inactiveCls}`}
          onClick={() => onChange("tracked")}
        >
          All tracked
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={value === "active"}
          className={`${baseBtn} border-l border-gray-200 ${value === "active" ? activeCls : inactiveCls}`}
          onClick={() => onChange("active")}
        >
          Active only
        </button>
      </div>
    </label>
  );
}

/**
 * "Active min &gt; X %" cell — normalised as % of the group's busy
 * minutes for this direction (ON or OFF). Showing % is the apple-to-
 * apple form: a 3-host i3-6100 group with 1 800 active min and a
 * 40-host i3-4330 group with 30 000 active min would otherwise look
 * incomparable on absolute count.
 *
 * Absolute count goes into the tooltip so the reader can sanity-check
 * "is this 80 % computed from 4 minutes or 4 000 minutes?".
 */
function AboveThresholdCell({
  minutes,
  total,
  label,
  accent,
  countFromLabel,
}: {
  minutes: number;
  total: number;
  label: "ON" | "OFF";
  accent?: boolean;
  /** "tracked" or "busy" — drives the tooltip wording so the user can
   *  tell at a glance which denominator the cell counts against. */
  countFromLabel: "tracked" | "busy";
}) {
  const pct = total > 0 ? (minutes / total) * 100 : null;
  const colour =
    pct === null
      ? "text-gray-400"
      : pct >= 50
        ? "text-red-600"
        : pct >= 20
          ? "text-amber-700"
          : pct > 0
            ? "text-gray-600"
            : "text-emerald-700";
  // Visible value:
  //   • "—" when there is no denominator data at all
  //   • "<0.1%" when minutes > 0 but the percent rounds below 0.1 — keeps
  //     the user from concluding "no data" when in fact a handful of
  //     minutes crossed the threshold; the tooltip still carries the
  //     absolute count
  //   • Otherwise a rounded percent
  const formatted = pct === null
    ? "—"
    : minutes > 0 && pct < 0.1
      ? "<0.1%"
      : pct < 0.05
        ? "0%"
        : pct >= 10
          ? `${Math.round(pct)}%`
          : `${pct.toFixed(1)}%`;
  const labelClasses = accent ? "text-blue-600 font-medium" : "text-gray-400 font-normal";
  return (
    <div
      className={`tabular-nums ${colour}`}
      title={
        pct === null
          ? `No ${countFromLabel} minutes for ${label}`
          : `${minutes.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} ${countFromLabel} minutes (${label})`
      }
    >
      {formatted} <span className={`text-[10px] ${labelClasses}`}>{label}</span>
    </div>
  );
}

function OnOffBars({
  peakOn,
  peakOff,
  threshold,
  hostsOnObserved,
  hostsOffObserved,
}: {
  peakOn: number | null;
  peakOff: number | null;
  threshold: number;
  hostsOnObserved: number;
  hostsOffObserved: number;
}) {
  return (
    <div className="space-y-1 max-w-[260px]">
      <BarRow label="ON" value={peakOn} threshold={threshold} accent observed={hostsOnObserved} />
      <BarRow label="OFF" value={peakOff} threshold={threshold} accent={false} observed={hostsOffObserved} />
    </div>
  );
}

function BarRow({
  label,
  value,
  threshold,
  accent,
  observed,
}: {
  label: string;
  value: number | null;
  threshold: number;
  accent: boolean;
  /** Host count contributing to the avg shown by `value`. Rendered as
   *  a small "from N" sub-label after the percentage so the user can
   *  tell whether the aggregate covers a meaningful sample. */
  observed: number;
}) {
  const pct = value !== null ? Math.min(100, Math.max(0, value)) : 0;
  const color =
    value === null
      ? "bg-gray-200"
      : value >= 90
        ? "bg-red-500"
        : value >= threshold
          ? "bg-amber-500"
          : "bg-emerald-500";
  return (
    <div className="flex items-center gap-2">
      <span className={`w-7 text-[10px] font-medium ${accent ? "text-blue-600" : "text-gray-400"}`}>
        {label}
      </span>
      <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
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
          <div className={`h-full ${color} rounded-full`} style={{ width: `${pct}%` }} />
        )}
      </div>
      <span
        className={`w-12 text-right text-xs font-medium ${
          value === null
            ? "text-gray-400"
            : value >= 90
              ? "text-red-600"
              : value >= threshold
                ? "text-amber-700"
                : "text-emerald-700"
        }`}
      >
        {value === null ? "—" : `${value.toFixed(0)}%`}
      </span>
      <span className="w-[60px] text-left text-[10px] text-gray-400 leading-tight">
        from {observed} {observed === 1 ? "host" : "hosts"}
      </span>
    </div>
  );
}

function DriverDecomposition({ drivers }: { drivers: DriverSlice[] }) {
  const total = drivers.reduce((s, d) => s + d.value, 0) || 1;
  // Group evidence-tag labels so the stack header is informative without
  // duplicating each slice.
  const measuredPct =
    (drivers.filter((d) => d.evidence === "measured").reduce((s, d) => s + d.value, 0) / total) *
    100;
  const partlyPct =
    (drivers.filter((d) => d.evidence === "partly").reduce((s, d) => s + d.value, 0) / total) *
    100;
  const unattrPct =
    (drivers.filter((d) => d.evidence === "unattributed").reduce((s, d) => s + d.value, 0) /
      total) *
    100;

  return (
    <>
      {/* Evidence tags */}
      <div className="flex items-center gap-4 text-[11px] mb-2">
        <span className="text-emerald-700">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1.5 align-middle" />
          Measured · {Math.round(measuredPct)}%
        </span>
        <span className="text-amber-700">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 mr-1.5 align-middle" />
          Partly attributed · {Math.round(partlyPct)}%
        </span>
        <span className="text-gray-500">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-gray-400 mr-1.5 align-middle" />
          Unattributed · {Math.round(unattrPct)}%
        </span>
      </div>

      {/* Stacked bar */}
      <div className="w-full h-7 rounded overflow-hidden flex bg-gray-100 border border-gray-100">
        {drivers.map((d) => {
          const pct = (d.value / total) * 100;
          if (pct < 0.5) return null;
          return (
            <div
              key={d.id}
              className="h-full flex items-center justify-center text-[10px] font-medium text-white"
              style={{ width: `${pct}%`, backgroundColor: d.color }}
              title={`${d.label} · ${d.value.toFixed(1)}% avg CPU`}
            >
              {pct >= 8 ? d.label : ""}
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-x-3 gap-y-1 mt-3 text-[11px]">
        {drivers.map((d) => (
          <div key={d.id} className="flex items-center gap-1.5 text-gray-600">
            <span
              className="inline-block w-2 h-2 rounded-sm flex-shrink-0"
              style={{ backgroundColor: d.color }}
            />
            <span className="truncate">{d.label}</span>
            <span className="text-gray-400 ml-auto">{d.value.toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────

function fmtMinutes(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  if (n === 0) return "0 min";
  if (n < 60) return `${Math.round(n)} min`;
  const hours = n / 60;
  return `${hours.toFixed(1)} h`;
}

function minutesColor(n: number | null): string {
  if (n === null) return "text-gray-400";
  if (n >= 120) return "text-red-600";
  if (n >= 30) return "text-amber-700";
  if (n > 0) return "text-gray-600";
  return "text-emerald-700";
}

/** Compact percentage formatter for the aggregate-path Retellect column. */
function fmtPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  if (n < 0.05) return "0.0%";
  return `${n.toFixed(1)}%`;
}

/** Colour band for the Retellect-avg cell. Anything above ~5 % during
 *  active minutes is a meaningful CPU pressure source on these tiers. */
function retellectColor(n: number | null): string {
  if (n === null) return "text-gray-400";
  if (n >= 10) return "text-red-600";
  if (n >= 5) return "text-amber-700";
  if (n > 0) return "text-gray-600";
  return "text-emerald-700";
}

// ─── Compute layer ──────────────────────────────────────────────────

/**
 * Phase 1 aggregate-based compute path.
 *
 * Reads `zabbix.rolloutPerHost` (per-host aggregates already filtered to
 * active minutes and split by Retellect ON/OFF on the server) and groups
 * by CPU model. Each row carries:
 *
 *   • Peak Total CPU per direction = avg across hosts of each host's max
 *     totalCpu during its own active windows. Reuses the "avg of per-host
 *     peaks" convention agreed for legacy compute (see 2b1f961 commit and
 *     [[feedback_settings_architecture]]), now restricted to busy minutes
 *     so idle host time can't dilute the comparison.
 *   • Avg Retellect CPU per direction = weighted average of retellectCpu
 *     across active minutes, weighted by minute count. Surfaces direct
 *     Retellect attribution alongside the total-CPU outcome.
 *   • Active minute counts (real history vs synthetic hourly) drive both
 *     the confidence band and the coverage footer.
 *
 * Per-bucket classification means a single host can contribute to BOTH
 * the ON and the OFF aggregate (different minutes in the window had
 * Retellect on vs off). hostsOn / hostsOff therefore count hosts that
 * contributed at least one minute to each direction — their sum can
 * exceed hostCount, which is expected and called out in the UI footer.
 *
 * Returns null when the per-host payload is missing or empty so the
 * caller can fall back to the legacy snapshot+trend path without losing
 * the matrix entirely.
 */
function computeRolloutInsightsFromAggregate(
  pilot: RtPilotData,
  zabbix: ZabbixData,
  storeFilter: string,
  thresholdPct: number,
  cpuCountFrom: "tracked" | "active",
): { matrix: MatrixRow[]; periodDays: number; activeThresholdPp: number } | null {
  const payload = zabbix.rolloutPerHost;
  if (!payload || payload.perHost.length === 0) return null;

  const perHostMap = new Map<string, RolloutPerHostEntry>(
    payload.perHost.map((p) => [p.hostId, p]),
  );
  const zabbixByName = new Map(zabbix.hosts.map((h) => [h.hostName, h]));

  type GroupAcc = {
    model: string;
    totalHosts: number;
    hostsWithBaseline: number;
    hostsOn: Set<string>;
    hostsOff: Set<string>;
    /** Per-host peak totalCpu observed in ON-classified active minutes.
     *  Aggregated as "avg of per-host peaks", same convention as legacy. */
    perHostPeakOn: number[];
    perHostPeakOff: number[];
    on: RolloutOnOffAggregate;
    off: RolloutOnOffAggregate;
  };
  const groups = new Map<string, GroupAcc>();

  for (const d of pilot.devices) {
    if (storeFilter !== "all" && d.storeName !== storeFilter) continue;
    const matchedHost = zabbixByName.get(d.sourceHostKey || "") || zabbixByName.get(d.name);
    const model = resolveCpuModel(d.cpuModel, matchedHost?.inventory?.cpuModel ?? null, "Unknown");
    let g = groups.get(model);
    if (!g) {
      g = {
        model,
        totalHosts: 0,
        hostsWithBaseline: 0,
        hostsOn: new Set(),
        hostsOff: new Set(),
        perHostPeakOn: [],
        perHostPeakOff: [],
        on: emptyOnOffAggregate(),
        off: emptyOnOffAggregate(),
      };
      groups.set(model, g);
    }
    g.totalHosts++;
    if (!matchedHost) continue;
    const entry = perHostMap.get(matchedHost.hostId);
    if (!entry) continue; // host had no usable items at all
    const hasBaseline = entry.baselineSpssCpu !== null;
    if (hasBaseline) g.hostsWithBaseline++;
    // hostsOn / hostsOff classify by ANY Retellect ON/OFF activity in
    // the window — i.e. tracked minutes, not active minutes. A host
    // where Retellect ran for a week but never coincided with an
    // spss-busy minute should still appear as "ON" in the matrix
    // (Pavilnonys SCO2 was the canonical complaint). Gating by active
    // minutes was hiding such hosts and producing misleading
    // "No Retellect data" status on classes with real installs.
    const onTracked = entry.on.realTrackedMinutes + entry.on.syntheticTrackedMinutes;
    const offTracked = entry.off.realTrackedMinutes + entry.off.syntheticTrackedMinutes;
    if (onTracked > 0) g.hostsOn.add(matchedHost.hostId);
    if (offTracked > 0) g.hostsOff.add(matchedHost.hostId);
    // Per-host peaks stay gated by ACTIVE minutes — the column is
    // "avg per-host peak during active min" and a peak from idle data
    // would mean something different.
    const onActiveMin = entry.on.realActiveMinutes + entry.on.syntheticActiveMinutes;
    const offActiveMin = entry.off.realActiveMinutes + entry.off.syntheticActiveMinutes;
    if (hasBaseline && onActiveMin > 0 && entry.on.peakTotalCpu !== null) {
      g.perHostPeakOn.push(entry.on.peakTotalCpu);
    }
    if (hasBaseline && offActiveMin > 0 && entry.off.peakTotalCpu !== null) {
      g.perHostPeakOff.push(entry.off.peakTotalCpu);
    }
    // Merge unconditionally so all aggregates (tracked + active +
    // threshold counters) flow into the group regardless of baseline.
    g.on = mergeOnOff(g.on, entry.on);
    g.off = mergeOnOff(g.off, entry.off);
  }

  // Pure: mean of a non-empty number array, null when empty. Same shape
  // as the legacy `mean` helper so the matrix rows look identical to the
  // legacy path for the headline column.
  const mean = (xs: number[]) =>
    xs.length === 0 ? null : xs.reduce((s, v) => s + v, 0) / xs.length;

  const matrix: MatrixRow[] = [];
  for (const g of groups.values()) {
    const peakOn = mean(g.perHostPeakOn);
    const peakOff = mean(g.perHostPeakOff);
    const avgRetellectOn = weightedAvg(g.on, "sumRetellectCpu");
    const avgRetellectOff = weightedAvg(g.off, "sumRetellectCpu");
    const activeRealMinutes = g.on.realActiveMinutes + g.off.realActiveMinutes;
    const activeSynMinutes = g.on.syntheticActiveMinutes + g.off.syntheticActiveMinutes;
    // Snap the user-chosen heatmap threshold (50/60/70/80/90) onto the
    // available buckets so the column reads from a precomputed counter
    // instead of replaying every bucket per render.
    const thKey = (
      thresholdPct >= 90 ? 90 :
      thresholdPct >= 80 ? 80 :
      thresholdPct >= 70 ? 70 :
      thresholdPct >= 60 ? 60 :
      thresholdPct >= 50 ? 50 :
      thresholdPct >= 40 ? 40 :
      thresholdPct >= 30 ? 30 :
      20
    ) as 20 | 30 | 40 | 50 | 60 | 70 | 80 | 90;
    // Mode-aware: tracked uses every minute (matches CPU Timeline),
    // active restricts to busy windows. Same columns either way; only
    // the denominator and matching counter swap.
    const totalTrackedOn = cpuCountFrom === "active"
      ? g.on.realActiveMinutes + g.on.syntheticActiveMinutes
      : g.on.realTrackedMinutes + g.on.syntheticTrackedMinutes;
    const totalTrackedOff = cpuCountFrom === "active"
      ? g.off.realActiveMinutes + g.off.syntheticActiveMinutes
      : g.off.realTrackedMinutes + g.off.syntheticTrackedMinutes;
    const minutesAboveOnAtThreshold = cpuCountFrom === "active"
      ? g.on.activeMinutesAboveThreshold[thKey]
      : g.on.minutesAboveThreshold[thKey];
    const minutesAboveOffAtThreshold = cpuCountFrom === "active"
      ? g.off.activeMinutesAboveThreshold[thKey]
      : g.off.minutesAboveThreshold[thKey];

    // Status — requires at least one ON-classified host to make ANY
    // graded recommendation. Without Retellect data on this CPU class
    // we cannot honestly say "safe" or "optimize" — the OFF baseline
    // tells us how hot the hardware runs WITHOUT Retellect, but says
    // nothing about how it'll behave with the load Retellect adds.
    // "unproven" is the explicit signal: pilot needed before rollout.
    //
    // Once ON evidence exists, bands stay aligned with the legacy
    // status tree (95/85/70) so users transitioning between paths see
    // consistent labels.
    let status: RolloutStatus;
    if (g.hostsOn.size === 0) {
      status = "unproven";
    } else {
      const effectivePeak = peakOn ?? peakOff ?? 0;
      if (effectivePeak >= 95) status = "do-not-roll-out";
      else if (effectivePeak >= 85) status = "optimize";
      else if (effectivePeak >= 70) status = "validate";
      else status = "safe";
    }

    // Confidence — driven by total reliable (history-source) minutes
    // across this group. Bands chosen to match the user-agreed decision
    // #6: high ≥5 000 reliable minutes (~3 host-days at 1-min cadence),
    // medium ≥500, low otherwise. Hosts-without-baseline ratio is also
    // a damper: if half the group's hosts couldn't get a baseline, even
    // a fat minute count is shaky.
    const baselineCoverage = g.totalHosts > 0 ? g.hostsWithBaseline / g.totalHosts : 0;
    let confidence: Confidence;
    if (activeRealMinutes >= 5000 && baselineCoverage >= 0.5) confidence = "high";
    else if (activeRealMinutes >= 500) confidence = "medium";
    else confidence = "low";

    // Comparability — at least 2 hosts contributing to each direction.
    const comparabilityWeak = !(g.hostsOn.size >= 2 && g.hostsOff.size >= 2);

    matrix.push({
      model: g.model,
      hostCount: g.totalHosts,
      hostsOn: g.hostsOn.size,
      hostsOff: g.hostsOff.size,
      hostsOnObserved: g.perHostPeakOn.length,
      hostsOffObserved: g.perHostPeakOff.length,
      peakOn,
      peakOff,
      minAboveOn: null,
      minAboveOff: null,
      status,
      confidence,
      comparabilityWeak,
      source: "aggregate",
      avgRetellectOn,
      avgRetellectOff,
      activeRealMinutes,
      activeSynMinutes,
      hostsWithBaseline: g.hostsWithBaseline,
      minutesAboveOnAtThreshold,
      minutesAboveOffAtThreshold,
      totalTrackedOn,
      totalTrackedOff,
    });
  }

  matrix.sort((a, b) => {
    if (a.model === "Unknown" && b.model !== "Unknown") return 1;
    if (b.model === "Unknown" && a.model !== "Unknown") return -1;
    const r = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (r !== 0) return r;
    return (b.peakOn ?? b.peakOff ?? 0) - (a.peakOn ?? a.peakOff ?? 0);
  });

  return { matrix, periodDays: payload.periodDays, activeThresholdPp: payload.activeThresholdPp };
}

/**
 * Build everything the page renders from the same in-memory snapshot the
 * other tabs use. Pure function — no fetches, no side effects — so the page
 * stays in sync with the rest of the workspace and renders predictably for
 * tests.
 */
function computeRolloutInsights(
  pilot: RtPilotData,
  zabbix: ZabbixData,
  threshold: number,
  storeFilter: string,
): {
  matrix: MatrixRow[];
  drivers: DriverSlice[];
  actions: { priority: "high" | "medium" | "low"; text: string }[];
  periodDays: number;
} {
  // Snap threshold to nearest minutesAbove bucket key
  const thKey = (threshold >= 90 ? 90 : threshold >= 80 ? 80 : threshold >= 70 ? 70 : threshold >= 60 ? 60 : 50) as 50 | 60 | 70 | 80 | 90;

  // Period (best-effort — page render is independent of the actual data range)
  const periodDays = (() => {
    const raw = (zabbix.cpuTrends?.length || 0) > 0 ? new Set(zabbix.cpuTrends!.map((t) => t.date)).size : 14;
    return Math.max(1, raw);
  })();

  // Build host lookups
  const zabbixByName = new Map(zabbix.hosts.map((h) => [h.hostName, h]));
  const trendsByHost = new Map<string, typeof zabbix.cpuTrends>();
  for (const t of zabbix.cpuTrends ?? []) {
    if (!trendsByHost.has(t.hostId)) trendsByHost.set(t.hostId, []);
    trendsByHost.get(t.hostId)!.push(t);
  }

  // Snapshot CPU per host (fallback for groups with no trend data)
  const cpuSnapshotByHost = new Map<string, number>();
  const cpuParts = new Map<string, { user: number; system: number; total: number }>();
  for (const item of zabbix.cpuDetail) {
    if (!cpuParts.has(item.hostId)) cpuParts.set(item.hostId, { user: 0, system: 0, total: 0 });
    const e = cpuParts.get(item.hostId)!;
    if (item.key === "system.cpu.util[,user]") e.user = item.value;
    if (item.key === "system.cpu.util[,system]") e.system = item.value;
    if (item.key === "system.cpu.util[,,avg1]" || item.key === "system.cpu.util") {
      e.total = item.value;
    }
  }
  for (const [hostId, p] of cpuParts.entries()) {
    cpuSnapshotByHost.set(hostId, computeCpuTotal(p.user, p.system, p.total));
  }

  // Build the "Retellect ON in period" host set. Two layers:
  //
  //   1. Period-aware: zabbix.retellectActiveInPeriodHostIds is the
  //      server-fetched set of hosts whose python.cpu trend records had
  //      value_max > 0.5% at any point in the selected periodDays window
  //      (defaults to 14 d). Captures intermittent hosts that ran
  //      Retellect during the window but are currently idle —
  //      Pavilnonys SCO2 is the canonical case.
  //
  //   2. Live fallback (24-h python.cpu snapshot, isRetellectActiveToday):
  //      only used when the period-aware payload is missing or empty,
  //      which can happen on first paint before the registry fetch
  //      resolves, or in dev when Zabbix trend.get is unreachable. We
  //      prefer to under-classify ON in that edge case rather than over-
  //      classify based on a stale local heuristic.
  //
  // Why not Device.retellectEnabled (DB flag): essentially never populated
  // in Rimi prod. Drove the original bug where every row showed Peak ON = —.
  const retellectActiveInPeriodHostIds = new Set<string>(
    zabbix.retellectActiveInPeriodHostIds ?? [],
  );
  let retellectLiveHostIds: Set<string>;
  if (retellectActiveInPeriodHostIds.size > 0) {
    retellectLiveHostIds = retellectActiveInPeriodHostIds;
  } else {
    const refMs = Date.now();
    const retellectCpuByHostId = new Map<string, number>();
    const retellectFreshestMsByHostId = new Map<string, number>();
    for (const proc of zabbix.procCpu || []) {
      if (proc.category !== "retellect") continue;
      const lastMs = proc.lastClock ? new Date(proc.lastClock).getTime() : 0;
      if (lastMs > 0) {
        const prev = retellectFreshestMsByHostId.get(proc.hostId) || 0;
        if (lastMs > prev) retellectFreshestMsByHostId.set(proc.hostId, lastMs);
        const cur = retellectCpuByHostId.get(proc.hostId) || 0;
        retellectCpuByHostId.set(proc.hostId, cur + Math.max(0, proc.cpuValue));
      }
    }
    retellectLiveHostIds = new Set<string>();
    for (const [hid, totalCpu] of retellectCpuByHostId) {
      const freshestMs = retellectFreshestMsByHostId.get(hid) || 0;
      if (isRetellectActiveToday({ freshestMs, refMs, totalCpu })) {
        retellectLiveHostIds.add(hid);
      }
    }
  }

  // Group devices by CPU class, splitting by Retellect ON/OFF
  type GroupAcc = {
    model: string;
    hostsOn: { hostId: string }[];
    hostsOff: { hostId: string }[];
    /** total hosts in this class (matched OR unmatched — drives "host count" col) */
    totalHosts: number;
  };
  const groups = new Map<string, GroupAcc>();

  for (const d of pilot.devices) {
    // Store filter: device.storeName carries the store assignment threaded
    // from RtPilotData, so we can apply scope strictly. Devices in other
    // stores are skipped entirely — they don't contribute to the matrix or
    // the drivers tally. "all" passes everything through unchanged.
    if (storeFilter !== "all" && d.storeName !== storeFilter) continue;

    const matchedHost =
      zabbixByName.get(d.sourceHostKey || "") || zabbixByName.get(d.name);
    const model = resolveCpuModel(d.cpuModel, matchedHost?.inventory?.cpuModel ?? null, "Unknown");
    if (!groups.has(model)) {
      groups.set(model, { model, hostsOn: [], hostsOff: [], totalHosts: 0 });
    }
    const g = groups.get(model)!;
    g.totalHosts++;
    if (!matchedHost) continue;
    // Live python.cpu activity (24 h window) — see retellectLiveHostIds above
    // for why this replaced d.retellectEnabled.
    if (retellectLiveHostIds.has(matchedHost.hostId)) g.hostsOn.push({ hostId: matchedHost.hostId });
    else g.hostsOff.push({ hostId: matchedHost.hostId });
  }

  // Aggregate per group
  const matrix: MatrixRow[] = [];
  for (const g of groups.values()) {
    const onPeaks: number[] = [];
    const offPeaks: number[] = [];
    let onMin = 0;
    let offMin = 0;
    let onMinDataPresent = false;
    let offMinDataPresent = false;

    for (const h of g.hostsOn) {
      const trends = trendsByHost.get(h.hostId) || [];
      if (trends.length > 0) {
        const maxVal = Math.max(...trends.map((t) => t.max));
        if (Number.isFinite(maxVal) && maxVal > 0) onPeaks.push(maxVal);
        for (const t of trends) {
          if (t.minutesAbove) {
            onMin += t.minutesAbove[thKey] || 0;
            onMinDataPresent = true;
          }
        }
      } else {
        const snap = cpuSnapshotByHost.get(h.hostId);
        if (snap !== undefined && snap > 0) onPeaks.push(snap);
      }
    }
    for (const h of g.hostsOff) {
      const trends = trendsByHost.get(h.hostId) || [];
      if (trends.length > 0) {
        const maxVal = Math.max(...trends.map((t) => t.max));
        if (Number.isFinite(maxVal) && maxVal > 0) offPeaks.push(maxVal);
        for (const t of trends) {
          if (t.minutesAbove) {
            offMin += t.minutesAbove[thKey] || 0;
            offMinDataPresent = true;
          }
        }
      } else {
        const snap = cpuSnapshotByHost.get(h.hostId);
        if (snap !== undefined && snap > 0) offPeaks.push(snap);
      }
    }

    // Avg of per-host peaks. Each entry in onPeaks/offPeaks is a single
    // host's max trend-bucket value within the window. Averaging across
    // hosts smooths single-host outliers (Windows Update spike on one
    // SCO, antivirus scan, etc.) so the comparison reflects the typical
    // worst-load moment per host of this class — a better proxy for
    // Retellect's effect than the absolute maximum across hosts.
    const mean = (xs: number[]) =>
      xs.length === 0 ? null : xs.reduce((s, v) => s + v, 0) / xs.length;
    const peakOn = mean(onPeaks);
    const peakOff = mean(offPeaks);
    const minAboveOn = onMinDataPresent ? onMin : null;
    const minAboveOff = offMinDataPresent ? offMin : null;

    // Status decision tree — deliberately conservative
    const effectivePeak = peakOn ?? peakOff ?? 0;
    let status: RolloutStatus;
    if (effectivePeak >= 95) status = "do-not-roll-out";
    else if (effectivePeak >= 85 && (peakOff ?? 0) >= 80) status = "optimize";
    else if (effectivePeak >= 85) status = "optimize";
    else if (effectivePeak >= 70) status = "validate";
    else status = "safe";

    // Confidence — sample size + comparability
    const onSamples = g.hostsOn.length;
    const offSamples = g.hostsOff.length;
    const balanced =
      onSamples > 0 && offSamples > 0 && Math.min(onSamples, offSamples) >= 2;
    const totalSamples = onSamples + offSamples;
    const haveTrends = onMinDataPresent || offMinDataPresent;
    let confidence: Confidence;
    if (totalSamples >= 6 && balanced && haveTrends) confidence = "high";
    else if (totalSamples >= 3 && haveTrends) confidence = "medium";
    else confidence = "low";

    const comparabilityWeak = !(onSamples >= 2 && offSamples >= 2);

    matrix.push({
      model: g.model,
      hostCount: g.totalHosts,
      hostsOn: onSamples,
      hostsOff: offSamples,
      hostsOnObserved: onPeaks.length,
      hostsOffObserved: offPeaks.length,
      peakOn,
      peakOff,
      minAboveOn,
      minAboveOff,
      status,
      confidence,
      comparabilityWeak,
      source: "legacy",
      avgRetellectOn: null,
      avgRetellectOff: null,
      activeRealMinutes: 0,
      activeSynMinutes: 0,
      hostsWithBaseline: 0,
      minutesAboveOnAtThreshold: onMin,
      minutesAboveOffAtThreshold: offMin,
      totalTrackedOn: 0,
      totalTrackedOff: 0,
    });
  }

  // Sort: risk first, then class name; unknown rows last
  matrix.sort((a, b) => {
    if (a.model === "Unknown" && b.model !== "Unknown") return 1;
    if (b.model === "Unknown" && a.model !== "Unknown") return -1;
    const r = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (r !== 0) return r;
    return (b.peakOn ?? b.peakOff ?? 0) - (a.peakOn ?? a.peakOff ?? 0);
  });

  // ─── Bottleneck drivers ───────────────────────────────────────────
  // Aggregate per-process CPU into broad categories. Each contributor's
  // value = average CPU % across hosts during reporting windows. The
  // "Unattributed Other" slice is host-level CPU minus sum of attributed
  // categories — a conservative residual, capped at 0.

  const totalsByCategory: Record<string, { sum: number; n: number }> = {
    scoApp: { sum: 0, n: 0 },
    db: { sum: 0, n: 0 },
    system: { sum: 0, n: 0 },
    retellect: { sum: 0, n: 0 },
  };
  let hostCpuSum = 0;
  let hostCpuN = 0;

  for (const item of zabbix.procCpu ?? []) {
    const bucket =
      item.category === "sco"
        ? "scoApp"
        : item.category === "db"
          ? "db"
          : item.category === "sys"
            ? "system"
            : item.category === "retellect"
              ? "retellect"
              : null;
    if (!bucket) continue;
    if (!Number.isFinite(item.cpuValue) || item.cpuValue < 0) continue;
    totalsByCategory[bucket].sum += item.cpuValue;
    totalsByCategory[bucket].n += 1;
  }

  // Host-level CPU averages — for the "Other" residual
  for (const cpu of cpuSnapshotByHost.values()) {
    if (cpu > 0) {
      hostCpuSum += cpu;
      hostCpuN += 1;
    }
  }

  const avg = (b: { sum: number; n: number }) =>
    b.n > 0 ? Math.round((b.sum / b.n) * 10) / 10 : 0;

  // Per-host-average contributions to the rendered stack. We approximate
  // each category as (sum across processes / number of hosts reporting host CPU)
  // — gives a host-level decomposition the bar can express in one shape.
  const denom = Math.max(1, hostCpuN);
  const scoApp = Math.round((totalsByCategory.scoApp.sum / denom) * 10) / 10;
  const db = Math.round((totalsByCategory.db.sum / denom) * 10) / 10;
  const system = Math.round((totalsByCategory.system.sum / denom) * 10) / 10;
  const retellect = Math.round((totalsByCategory.retellect.sum / denom) * 10) / 10;
  const hostAvg = hostCpuN > 0 ? hostCpuSum / hostCpuN : 0;
  const accountedFor = scoApp + db + system + retellect;
  const other = Math.max(0, Math.round((hostAvg - accountedFor) * 10) / 10);

  const drivers: DriverSlice[] = [
    {
      id: "scoApp",
      label: "SCO App",
      value: scoApp,
      evidence: "measured",
      color: "#f59f00",
    },
    {
      id: "db",
      label: "DB (SQL)",
      value: db,
      evidence: "measured",
      color: "#9775fa",
    },
    {
      id: "system",
      label: "VM / System",
      value: system,
      evidence: "partly",
      color: "#0c8feb",
    },
    {
      id: "retellect",
      label: "Retellect (python)",
      value: retellect,
      evidence: "partly",
      color: "#fa5252",
    },
    {
      id: "other",
      label: "Other / Unattributed",
      value: other,
      evidence: "unattributed",
      color: "#94a3b8",
    },
  ];
  // Hide slices that round to 0 — keeps the bar honest
  void avg;

  return {
    matrix,
    drivers,
    actions: actionsFromMatrix(matrix),
    periodDays,
  };
}

/**
 * Derive 1–4 ranked actions from a matrix. Shared by legacy and aggregate
 * compute paths so the page surface stays consistent regardless of which
 * data source produced the matrix.
 */
function actionsFromMatrix(matrix: MatrixRow[]): { priority: "high" | "medium" | "low"; text: string }[] {
  const actions: { priority: "high" | "medium" | "low"; text: string }[] = [];
  const safeClasses = matrix.filter((m) => m.status === "safe").map((m) => m.model);
  const validateClasses = matrix.filter((m) => m.status === "validate").map((m) => m.model);
  const optimizeClasses = matrix.filter((m) => m.status === "optimize").map((m) => m.model);
  const blockedClasses = matrix.filter((m) => m.status === "do-not-roll-out").map((m) => m.model);
  const unprovenClasses = matrix.filter((m) => m.status === "unproven").map((m) => m.model);
  if (safeClasses.length > 0) {
    actions.push({ priority: "high", text: `Roll out first on safe CPU classes: ${formatList(safeClasses)}.` });
  }
  if (validateClasses.length > 0) {
    actions.push({ priority: "medium", text: `Validate borderline classes under controlled peak load: ${formatList(validateClasses)}.` });
  }
  if (optimizeClasses.length > 0) {
    actions.push({ priority: "high", text: `Optimize background and system load before rollout on: ${formatList(optimizeClasses)}.` });
  }
  if (blockedClasses.length > 0) {
    actions.push({ priority: "high", text: `Hold rollout on ${formatList(blockedClasses)} until hardware tier is upgraded.` });
  }
  if (unprovenClasses.length > 0) {
    actions.push({
      priority: "medium",
      text: `Pilot Retellect on a single host of each unproven class before fleet rollout: ${formatList(unprovenClasses)}.`,
    });
  }
  if (matrix.some((m) => m.confidence === "low") && actions.length < 4) {
    actions.push({ priority: "medium", text: "Improve process-level observability on the weakest fleet segment before a final decision." });
  }
  return actions.slice(0, 4);
}

function formatList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
