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

import { useEffect, useMemo, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { RtPilotData, ZabbixData } from "../RtPilotWorkspace";
import { useRtFilters } from "../RtFiltersContext";
import { resolveCpuModel, computeCpuTotal } from "./rt-inventory-helpers";
import { isRetellectActiveToday } from "./rt-overview-helpers";

// ─── Types ──────────────────────────────────────────────────────────

type RolloutStatus = "safe" | "validate" | "optimize" | "do-not-roll-out";
type Confidence = "high" | "medium" | "low";

interface MatrixRow {
  model: string;
  hostCount: number;
  hostsOn: number;
  hostsOff: number;
  peakOn: number | null;
  peakOff: number | null;
  minAboveOn: number | null;
  minAboveOff: number | null;
  deltaPeak: number | null; // peakOn - peakOff
  status: RolloutStatus;
  confidence: Confidence;
  /** True when the OFF column has too few hosts/days to compare. */
  comparabilityWeak: boolean;
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
};

const STATUS_STYLES: Record<RolloutStatus, string> = {
  safe: "bg-emerald-50 text-emerald-700 border-emerald-200",
  validate: "bg-blue-50 text-blue-700 border-blue-200",
  optimize: "bg-amber-50 text-amber-700 border-amber-200",
  "do-not-roll-out": "bg-red-50 text-red-700 border-red-200",
};

const STATUS_DOT: Record<RolloutStatus, string> = {
  safe: "bg-emerald-500",
  validate: "bg-blue-500",
  optimize: "bg-amber-500",
  "do-not-roll-out": "bg-red-500",
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

  const { matrix, drivers, actions, periodDays } = useMemo(() => {
    return computeRolloutInsights(pilot, zabbix, threshold, storeFilter);
  }, [pilot, zabbix, threshold, storeFilter]);

  return (
    <>
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-800">Rollout Insights</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Decision summary for {pilot.name} — last {periodDays} days, threshold {threshold}%.
            One read tells you which CPU classes to roll out, hold, or optimize.
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
        <FilterSelect
          label="Threshold"
          value={String(threshold)}
          options={[
            { v: "50", l: "50%" },
            { v: "60", l: "60%" },
            { v: "70", l: "70%" },
            { v: "80", l: "80%" },
            { v: "90", l: "90%" },
          ]}
          onChange={(v) => setFilter("threshold", Number(v))}
        />
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
                    Peak CPU · ON vs OFF
                  </th>
                  <th className="text-center py-3 px-3 text-[11px] font-semibold text-gray-500 uppercase">
                    Min ≥ {threshold}%
                  </th>
                  <th className="text-center py-3 px-3 text-[11px] font-semibold text-gray-500 uppercase">Δ peak</th>
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
                      <div className="text-[10px] text-gray-400">
                        {row.hostsOn} ON · {row.hostsOff} OFF
                      </div>
                    </td>
                    <td className="py-3 px-3">
                      <OnOffBars peakOn={row.peakOn} peakOff={row.peakOff} threshold={threshold} />
                    </td>
                    <td className="py-3 px-3 text-center text-xs">
                      <div className={`font-medium ${minutesColor(row.minAboveOn)}`}>
                        {fmtMinutes(row.minAboveOn)} <span className="text-gray-400 font-normal">ON</span>
                      </div>
                      <div className={`${minutesColor(row.minAboveOff)}`}>
                        {fmtMinutes(row.minAboveOff)} <span className="text-gray-400 font-normal">OFF</span>
                      </div>
                    </td>
                    <td className="py-3 px-3 text-center">
                      <DeltaPill delta={row.deltaPeak} />
                    </td>
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

      {/* ── D. Where Decision Confidence Is Limited ────────────────── */}
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

function OnOffBars({
  peakOn,
  peakOff,
  threshold,
}: {
  peakOn: number | null;
  peakOff: number | null;
  threshold: number;
}) {
  return (
    <div className="space-y-1 max-w-[220px]">
      <BarRow label="ON" value={peakOn} threshold={threshold} accent />
      <BarRow label="OFF" value={peakOff} threshold={threshold} accent={false} />
    </div>
  );
}

function BarRow({
  label,
  value,
  threshold,
  accent,
}: {
  label: string;
  value: number | null;
  threshold: number;
  accent: boolean;
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
    </div>
  );
}

function DeltaPill({ delta }: { delta: number | null }) {
  if (delta === null) {
    return <span className="text-[11px] text-gray-400">—</span>;
  }
  const isPositive = delta > 0.5;
  const isNegative = delta < -0.5;
  const cls = isPositive
    ? "text-amber-700 bg-amber-50"
    : isNegative
      ? "text-emerald-700 bg-emerald-50"
      : "text-gray-500 bg-gray-100";
  const sign = isPositive ? "+" : isNegative ? "−" : "±";
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-medium ${cls}`}>
      {sign}
      {Math.abs(delta).toFixed(1)} pp
    </span>
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

// ─── Compute layer ──────────────────────────────────────────────────

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

    const peakOn = onPeaks.length > 0 ? Math.max(...onPeaks) : null;
    const peakOff = offPeaks.length > 0 ? Math.max(...offPeaks) : null;
    const minAboveOn = onMinDataPresent ? onMin : null;
    const minAboveOff = offMinDataPresent ? offMin : null;
    const deltaPeak = peakOn !== null && peakOff !== null ? peakOn - peakOff : null;

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
      peakOn,
      peakOff,
      minAboveOn,
      minAboveOff,
      deltaPeak,
      status,
      confidence,
      comparabilityWeak,
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

  // ─── Recommended actions ──────────────────────────────────────────
  // Derive from the matrix — short, ranked, executive-readable.
  const actions: { priority: "high" | "medium" | "low"; text: string }[] = [];

  const safeClasses = matrix.filter((m) => m.status === "safe").map((m) => m.model);
  const validateClasses = matrix.filter((m) => m.status === "validate").map((m) => m.model);
  const optimizeClasses = matrix
    .filter((m) => m.status === "optimize")
    .map((m) => m.model);
  const blockedClasses = matrix
    .filter((m) => m.status === "do-not-roll-out")
    .map((m) => m.model);

  if (safeClasses.length > 0) {
    actions.push({
      priority: "high",
      text: `Roll out first on safe CPU classes: ${formatList(safeClasses)}.`,
    });
  }
  if (validateClasses.length > 0) {
    actions.push({
      priority: "medium",
      text: `Validate borderline classes under controlled peak load: ${formatList(validateClasses)}.`,
    });
  }
  if (optimizeClasses.length > 0) {
    actions.push({
      priority: "high",
      text: `Optimize background and system load before rollout on: ${formatList(optimizeClasses)}.`,
    });
  }
  if (blockedClasses.length > 0) {
    actions.push({
      priority: "high",
      text: `Hold rollout on ${formatList(blockedClasses)} until hardware tier is upgraded.`,
    });
  }
  if (matrix.some((m) => m.confidence === "low") && actions.length < 4) {
    actions.push({
      priority: "medium",
      text: "Improve process-level observability on the weakest fleet segment before a final decision.",
    });
  }

  return {
    matrix,
    drivers,
    actions: actions.slice(0, 4),
    periodDays,
  };
}

function formatList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
