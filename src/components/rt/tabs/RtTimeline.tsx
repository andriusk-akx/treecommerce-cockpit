"use client";

import type { ReactElement } from "react";
import { useState, useMemo, useCallback, useRef, useEffect, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { RtPilotData, ZabbixData, ZabbixCpuTrend } from "../RtPilotWorkspace";
import type { PerDayActiveCounters } from "@/lib/rollout-insights/types";
import { FilterBar, FilterRow, FilterSelect, FilterSegmented, FilterDivider } from "../filters/RtFilterControls";
// `generateIntervalData` was used by an earlier synthetic-data prototype
// for the drill-down chart; removed when the route switched to real
// process-history data. Only the IntervalSlot type stays in scope (used
// by `slotEndLabel`).
import type { IntervalSlot } from "./rt-timeline-math";
import { DataCoverageBanner } from "./DataCoverageBanner";
import { ProcessCategoryReference } from "./ProcessCategoryReference";
import { RtProcessTrend } from "./RtProcessTrend";
import { RtCompareView } from "../compare/RtCompareView";
import { useRtFilters } from "../RtFiltersContext";
import { resolveCpuModel } from "./rt-inventory-helpers";
import { isRetellectRunning, isRetellectDeployed, isRetellectActiveToday } from "./rt-overview-helpers";

// Heatmap is a per-DAY peak view, so periods shorter than 1 day make no sense.
//
// Retention reality (re-measured 2026-05-18 via scripts/probe-retention-windows.mjs):
//   trend.get  — ~29 days on this Zabbix deployment (hourly aggregates).
//   history.get — 14 d for the broadest item coverage; some active items hold
//                 up to ~42 d but coverage is uneven across the fleet.
//
// `_getCpuHistoryDailyUncached` merges both sources, so the 30d preset is
// honest: nearly every day has real data, with the older edge falling back
// to trend.get hourly aggregates. The previous "cap at 14d" comment dated
// from a time when trend retention here was 5–7 days and is no longer true.
//
// Custom (1..365) is kept for ad-hoc windows beyond the presets — but anything
// past ~29 d will currently render empty older cells until SP admin extends
// trend retention. Re-run the probe script when retention changes.
const PERIODS = [
  { id: "14d", label: "14d", days: 14 },
  { id: "30d", label: "30d", days: 30 },
] as const;

// Granularity selector was removed from the UI 2026-04-28; we now always use
// 1-minute resolution (the agent's native sample rate). The `granularity`
// value still lives in RtFiltersContext because the drill-down API call
// reads it as a query param — callers either get 1 (default) or, for any
// stale localStorage value, are migrated to 1 by the context provider.
// The legacy GRANULARITIES list of presets is no longer needed.

const C = {
  belowBg: "#e0effe", belowText: "#868e96",
  thresholdBg: "#fbbf24", highBg: "#f59f00", criticalBg: "#ef4444", exceededText: "#fff",
  retellect: "#fa5252", scoApp: "#f59f00", db: "#9775fa", system: "#0c8feb", free: "#e0effe",
  // 2026-05-12: three new buckets carved out of "Other" after SP admin
  // deployed BESClient / Elastic / kernel-CPU items on testlab_SPUB-P-SCO150.
  // Colors chosen to be visually distinct from the four original categories
  // while staying in the cool/warm palette of the heatmap.
  besclient: "#10b981", elastic: "#a3e635", osCore: "#f97316",
  pillActive: "#0070c9", border: "#e9ecef", headerBg: "#f1f3f5", headerText: "#868e96",
  textSec: "#6c757d", okGreen: "#059669",
  riskRedBg: "#fef2f2", riskRedText: "#b91c1c",
  riskAmberBg: "#fffbeb", riskAmberText: "#b45309", riskGrayBg: "#f1f3f5",
  zebraOdd: "#fafbfc",
} as const;

// (Removed `DEVICE_COLORS` + the `typeBadge()` helper 2026-05-25 — they were
// orphaned from an earlier compact-row design that rendered a device-type
// chip next to each host. The current layout encodes device type via the
// row label / Device Type filter instead, so the colour palette and the
// render function were unused. Keeping dead constants invites confusion
// when someone later searches for "where is the SCO badge styled".)

const PROCESSES = [
  { key: "retellect" as const, label: "Retellect", color: C.retellect },
  { key: "scoApp" as const, label: "SCO App", color: C.scoApp },
  { key: "db" as const, label: "DB (SQL)", color: C.db },
  { key: "system" as const, label: "System (VM host)", color: C.system },
  { key: "besclient" as const, label: "BESClient", color: C.besclient },
  { key: "elastic" as const, label: "Elastic", color: C.elastic },
  { key: "osCore" as const, label: "OS Core", color: C.osCore },
  { key: "free" as const, label: "Free", color: C.free, border: true },
];

// Drill-down state. `hostId` is the Zabbix host id — unique even when device
// names collide across stores (e.g. multiple "SCO2" devices in different
// pilots). `displayName` is what we show in headers ("SCO2"). `sourceHostKey`
// is the full Zabbix display name (e.g. "SHM Pavilnionys [T803] SCO2") used
// only for diagnostic display.
interface DrillState {
  date: string;
  dateObj: Date;
  hostId: string;
  displayName: string;
  sourceHostKey: string;
  peak: number;
}

// "exceed" sorts by absolute minutes-above-threshold; "exceedPct" sorts by
// (minutesAbove / totalMinutes) — more meaningful when hosts have different
// sample coverage (e.g. one with 18k samples vs another with 2k).
type SortKey = "name" | "store" | "rt" | "type" | "exceed" | "exceedPct" | "cpu";
type SortDir = "asc" | "desc";

// ─── Resizable Split Pane ───────────────────────────────────────────

function useSplitPane(defaultPx: number, minTop: number, minBottom: number) {
  const [splitPx, setSplitPx] = useState(defaultPx);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    const container = containerRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => {
      if (!isDragging.current) return;
      const y = ev.clientY - containerRect.top;
      setSplitPx(Math.max(minTop, Math.min(containerRect.height - minBottom - 10, y)));
    };
    const onUp = () => {
      isDragging.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [minTop, minBottom]);

  return { splitPx, setSplitPx, containerRef, onMouseDown };
}

/**
 * Conditional-precision percentage formatter for the drill-down slot panel.
 *
 *   ≥ 10   → whole-number ("11%")
 *   ≥ 1    → one decimal  ("3.4%")
 *   > 0    → two decimals ("0.04%")  ← preserves sub-1% values that would
 *                                       otherwise round to "0%" and look
 *                                       like the bar carries no signal
 *   = 0    → "0%"
 *
 * Aligns with the same tiered pattern already in use for the threshold-
 * exceed Min% column (line ~1088); centralised here so any future cell
 * that wants the same treatment can call it.
 *
 * 2026-05-13: introduced after SP admin rolled out BESClient / Elastic
 * monitoring. BESClient (~2% raw / 0.5% per host on a 4-core SCO) was
 * visible at 1 decimal, but Elastic agent (~0.16% raw / 0.04% per host)
 * collapsed to "0%" and looked broken even though the data flowed
 * correctly. averageSlot now returns 2-decimal precision so this
 * formatter has real precision to spend.
 */
function formatPct(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "0%";
  if (v >= 10) return `${Math.round(v)}%`;
  if (v >= 1) return `${(Math.round(v * 10) / 10).toFixed(1)}%`;
  return `${(Math.round(v * 100) / 100).toFixed(2)}%`;
}

// ─── Helper: time label for slot end ────────────────────────────────
function slotEndLabel(slot: IntervalSlot, minutesPerSlot: number): string {
  const endMinutes = (slot.hour * 60 + slot.minute + minutesPerSlot);
  const eh = Math.floor(endMinutes / 60) % 24;
  const em = endMinutes % 60;
  return `${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}`;
}

// ─── Component ──────────────────────────────────────────────────────

export function RtTimeline({ pilot, zabbix }: { pilot: RtPilotData; zabbix: ZabbixData }) {
  // Cross-tab filters live in the workspace-level RtFiltersContext so they
  // survive tab switches and page reloads. Tab-local UI state (drill-down
  // selection, sort, custom-input toggles) stays in component state.
  const { filters, setFilter } = useRtFilters();
  const threshold = filters.threshold;
  const setThreshold = (v: number) => setFilter("threshold", v);
  const period = filters.period;
  /**
   * Shared with the Rollout Insights matrix — same RtFiltersContext key.
   * "tracked" (default) drives the existing heatmap (counts every minute
   * above the threshold from cpuTrends). "active" UI is wired but Phase 1
   * only adapts the banner + dims the heatmap; the per-day active
   * breakdown ships in Phase 2 when aggregateHost grows perDay counters.
   */
  const cpuCountFrom = filters.cpuCountFrom;

  // ── Period selector: URL is the source of truth ───────────────────
  //
  // The CPU heatmap data is fetched server-side at the /retellect/[pilotId]
  // page level — it doesn't refetch on client state change. Before 2026-05-12
  // the period filter lived only in RtFiltersContext (localStorage), so
  // picking "30 d" widened the date axis but the cached 14-d Zabbix payload
  // left the older 16 cells empty (bug report screenshot).
  //
  // Fix: make `?period=` the source of truth. Selecting a period pushes the
  // new URL via router.push, which triggers the page server component to
  // re-render with the new searchParam and refetch CPU history with the
  // larger window. The context still mirrors the value so the rest of the
  // client UI (chip bar, dates array calc) keeps working unchanged.
  const router = useRouter();
  const pathname = usePathname();
  const urlSearchParams = useSearchParams();
  // useTransition wraps router.push so React reports back when the server
  // navigation is in flight. The 14 → 30 day jump triggers a Zabbix
  // trend.get fetch for up to ~110 hosts × multiple items — typically
  // 30–60 s on cold cache. Without an isRefreshing flag, the URL chip
  // updated instantly but the heatmap kept rendering old cells until
  // the server responded; users perceived this as "nothing happens for
  // a minute". The flag drives the inline "Updating window…" pill in
  // the filter bar and the heatmap opacity-fade below so the user can
  // see that work is in progress. Same pattern as RtRolloutInsights.
  const [isRefreshing, startPeriodTransition] = useTransition();
  // Sync URL → context. Two scenarios:
  //   - Fresh deep-link with ?period=60 → context catches up to URL.
  //   - SSR re-render after setPeriod's router.push → URL already matches
  //     context, this effect is a no-op (but cheap).
  useEffect(() => {
    const urlPeriod = urlSearchParams.get("period");
    if (urlPeriod && urlPeriod !== filters.period) {
      setFilter("period", urlPeriod);
    }
    // We intentionally don't depend on filters.period — context-only changes
    // shouldn't re-run this effect (they're already going through setPeriod).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlSearchParams]);

  // ── Sub-view selector ────────────────────────────────────────────
  //
  // CPU Timeline hosts two distinct views: the existing per-day heatmap
  // (default) and the new "Compare two periods" sub-page. We use the
  // `?view=` URL param so the choice is shareable via deeplinks and
  // survives reloads, matching the `?period=` pattern above. Spec:
  // docs/specs/cpu-timeline-compare-periods-spec.md §4.1.
  const subView: "heatmap" | "compare" = urlSearchParams.get("view") === "compare" ? "compare" : "heatmap";
  const setSubView = (v: "heatmap" | "compare") => {
    const live = typeof window !== "undefined" ? window.location.search : `?${urlSearchParams.toString()}`;
    const params = new URLSearchParams(live);
    if (v === "heatmap") {
      params.delete("view");
    } else {
      params.set("view", v);
    }
    router.push(`${pathname}?${params.toString()}`);
  };

  const setPeriod = (v: string) => {
    // Update context immediately so the UI feels responsive while the SSR
    // refetch is in flight; the destination's loading.tsx + Suspense fallback
    // already cover the transition window.
    setFilter("period", v);
    // Snapshot live URL params at click time (not whatever urlSearchParams
    // captured at component setup) so a rapid double-click won't replay
    // the older URL with stale `?at=` / `?tab=` etc.
    const live = typeof window !== "undefined" ? window.location.search : `?${urlSearchParams.toString()}`;
    const params = new URLSearchParams(live);
    params.set("period", v);
    startPeriodTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
  };
  const storeFilter = filters.store;
  const setStoreFilter = (v: string) => setFilter("store", v);
  const cpuModelFilter = filters.cpuModel;
  const setCpuModelFilter = (v: string) => setFilter("cpuModel", v);
  const search = filters.search;
  // `granularity` is consumed by the drill-down history API call. The UI
  // setter was removed alongside the granularity buttons; the value is
  // expected to be 1 (anything else is treated as legacy and normalised
  // inside RtFiltersContext on read).
  const granularity = filters.granularity;
  const retellectInstalled = filters.retellectInstalled;
  const setRetellectInstalled = (v: "today" | "installed" | null) => setFilter("retellectInstalled", v);
  // chartMode kept in filter context for backwards-compat with stored prefs;
  // chart now has a single visualisation (line) so we don't read it.

  const [drill, setDrill] = useState<DrillState | null>(null);
  const [drillTab, setDrillTab] = useState<"process" | "resources">("process");
  const [sortKey, setSortKey] = useState<SortKey>("exceed");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  // Tab-local: collapse the flat host list into hardware-class or per-store
  // buckets so the user can spot patterns at a glance (e.g. "all WN Beetle M3
  // hosts run hot from hour 18", or "Pavilnionys store hosts spike together").
  // Stays local — not in RtFiltersContext — because it only applies to this view.
  const [groupBy, setGroupBy] = useState<"host" | "cpu" | "store">("host");
  // Heatmap cell metric:
  //   "peak"     — day-MAX CPU% (current default; same data the cell title
  //                tooltip already shows as "Day max").
  //   "minAbove" — number of sample-minutes that day where CPU ≥ threshold.
  //                Uses `trend.minutesAbove[thKey]` already computed for the
  //                summary columns; just renders it cell-by-cell so users can
  //                see *for how long* a host stayed in trouble, not only how
  //                high it spiked.
  // Default to "minAbove" — Andrius prefers it because the duration spent above
  // threshold is more decision-relevant than a one-off peak (a 90% spike that
  // lasted 30s is noise; 30 min at 75% is a real capacity problem).
  const [metric, setMetric] = useState<"peak" | "minAbove">("minAbove");
  // Which CPU-model groups are currently expanded. Empty set = all collapsed,
  // showing only headers (per-class summary row with day-by-day MAX). Click
  // a header to drop in / out.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = useCallback((cpuModel: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(cpuModel)) next.delete(cpuModel); else next.add(cpuModel);
      return next;
    });
  }, []);
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null);
  // Tracks whether the user has explicitly cleared the selection (Esc, click
  // on active bar, "Clear selection" button) inside the *current* drill
  // session. The auto-select-peak effect respects this flag so it doesn't
  // bounce the cursor back onto the peak when the user has just chosen to
  // see the day at-rest. Reset to false whenever a new drill opens.
  const userClearedSelectionRef = useRef(false);
  // (custom-granularity state removed — only fixed presets are exposed now.)
  const [customPeriodDays, setCustomPeriodDays] = useState<string>("");
  const [showCustomPeriod, setShowCustomPeriod] = useState(false);
  // "Hide silent hosts" — hides hosts that haven't sent a single CPU sample
  // during the selected period. Local state (not in RtFiltersContext) because
  // the silent-host set depends on the active period; persisting it across
  // pilots/tabs would be misleading. Default ON so the heatmap opens on the
  // hosts that actually have signal — silent rows usually mean a broken agent
  // or missing monitoring template, not a real Retellect problem the user is
  // here to investigate. Auto-skipped when no global trend data is available
  // (the filter logic gate on hasTrendData prevents emptying the entire table).
  const [hideEmptyHosts, setHideEmptyHosts] = useState(true);

  // Real per-process history fetched when user drills into a host.
  // Categories: retellect (sum python*.cpu), scoApp (spss), db (sql), system (vm).
  // sysCpuAvg/sysCpuMax: overall system.cpu.util[,,avg1] for the same slot,
  //   shown as a reference line above the per-process bars (per-process sum
  //   only counts monitored processes, while system.cpu.util counts everything).
  type ProcessSlot = {
    slot: number; hourKey: string; hour: number; minute: number; label: string;
    retellect: number; scoApp: number; db: number; system: number;
    /** 2026-05-12: three new buckets fed by SP admin's BESClient / Elastic /
     *  kernel-CPU items deployed on testlab_SPUB-P-SCO150. Always present in
     *  the response (zero on hosts that don't publish the new items). */
    besclient: number; elastic: number; osCore: number;
    free: number;
    // CPU normalisation spec (2026-05-20): added by averageSlotV2 path.
    // Present whenever the route is on the new code; older clients (or
    // a server still on a prior deploy) may not send them — the renderer
    // defaults to "warn" / 0 / null when missing.
    other?: number;
    hostCpu?: number | null;
    overshootPp?: number | null;
    dataQuality?: "ok" | "warn" | "fail";
    sysCpuAvg: number | null; sysCpuMax: number | null;
  };
  type DayDataQuality = {
    day: "ok" | "warn" | "fail";
    ok: number;
    warn: number;
    fail: number;
  };
  const [drillIntervals, setDrillIntervals] = useState<ProcessSlot[] | null>(null);
  // Top-level dataQuality summary returned by /api/rt/process-history. Drives
  // the warning banner under the drill-down stacked bar.
  const [drillDataQuality, setDrillDataQuality] = useState<DayDataQuality | null>(null);
  // Cores actually used by the route to normalise this drill-down. Null when
  // the route is on a previous deploy that didn't send it. Used in the
  // drill-down header tooltip so operators know whether the displayed numbers
  // were normalised and where the value came from.
  const [drillCoresInfo, setDrillCoresInfo] = useState<{ cores: number; coresKnown: boolean; coresSource: string | null } | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);
  // 2026-05-19: Sparse categories (BESClient / Elastic / OS Core) were rolled
  // out per-host on different dates (Pavilnionys SCO02: 2026-05-09; testlab:
  // 2026-05-12). Drill-downs into earlier days have ZERO samples for those
  // items because the Zabbix items did not exist yet on that host. The route
  // surfaces this as `unmonitored: string[]` so the UI can hide deceptive
  // "0%" rows in the drill-down and fold their would-be residual into Other
  // with a tooltip explaining what's missing — preserves visual stability
  // across the rollout boundary while staying honest about coverage.
  type SparseKey = "besclient" | "elastic" | "osCore";
  const [dayUnmonitored, setDayUnmonitored] = useState<SparseKey[]>([]);
  // chartMode lives in RtFiltersContext (above) so it persists across tabs.
  // Day summary (overall system.cpu.util statistics for the drill date) —
  // answers the user's primary question: when did the spike happen and how
  // long was the host actually stressed.
  type DaySummary = {
    samples: number;
    maxValue: number;
    maxAtClock: number;
    maxLabel: string;
    avgValue: number;
    // Match the threshold dropdown one-to-one so the legend can read the
    // bucket the user actually picked. Pre-2026-04-28 only t50/t70/t90/t95
    // existed; t60/t80 were added when the legend started honouring the
    // active threshold.
    minutesAbove: { t50: number; t60: number; t70: number; t80: number; t90: number; t95: number };
    raw: Array<{ clock: number; value: number }>;
  };
  const [daySummary, setDaySummary] = useState<DaySummary | null>(null);

  const split = useSplitPane(240, 120, 200);
  const isPresetPeriod = PERIODS.some((p) => p.id === period);
  const periodDays = isPresetPeriod ? (PERIODS.find((p) => p.id === period)?.days || 14) : Number(period);

  const dates = useMemo(() => {
    const result: Date[] = [];
    const now = new Date();
    const days = Math.max(1, periodDays);
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i); result.push(d);
    }
    return result;
  }, [periodDays]);

  const { zabbixByName, cpuDetail, trendByHostDate, retellectByHost, deployedHostIds, perDayActiveByHost } = useMemo(() => {
    const byName = new Map(zabbix.hosts.map((h) => [h.hostName, h]));
    const detail = new Map<string, { user: number; system: number; total: number; numCpus: number }>();
    for (const item of zabbix.cpuDetail) {
      if (!detail.has(item.hostId)) detail.set(item.hostId, { user: 0, system: 0, total: 0, numCpus: 0 });
      const entry = detail.get(item.hostId)!;
      if (item.key === "system.cpu.util[,user]") entry.user = item.value;
      if (item.key === "system.cpu.util[,system]") entry.system = item.value;
      if (item.key === "system.cpu.util[,,avg1]" || item.key === "system.cpu.util") entry.total = item.value;
      if (item.key === "system.cpu.num") entry.numCpus = item.value;
    }
    // Build trend/history lookup: hostId -> date -> { max, avg, min }
    const trendMap = new Map<string, Map<string, ZabbixCpuTrend>>();
    for (const t of (zabbix.cpuTrends || [])) {
      if (!trendMap.has(t.hostId)) trendMap.set(t.hostId, new Map());
      trendMap.get(t.hostId)!.set(t.date, t);
    }
    // Retellect liveness map: hostId -> {cpuTotal, freshestMs}.
    // Sums python.cpu CPU% across processes per host and tracks the freshest
    // sample time. Used to derive `rtActive` (live telemetry signal) so the
    // "Retellect" filter pill reflects what Zabbix actually sees, not the
    // stale Device.retellectEnabled DB flag (see RT-BACKFILL backlog).
    const rtMap = new Map<string, { cpuTotal: number; freshestMs: number }>();
    for (const proc of zabbix.procCpu || []) {
      if (proc.category !== "retellect") continue;
      const lastMs = proc.lastClock ? new Date(proc.lastClock).getTime() : 0;
      const prev = rtMap.get(proc.hostId);
      const cpuValue = typeof proc.cpuValue === "number" && Number.isFinite(proc.cpuValue) ? proc.cpuValue : 0;
      if (prev) {
        prev.cpuTotal += cpuValue;
        if (lastMs > prev.freshestMs) prev.freshestMs = lastMs;
      } else {
        rtMap.set(proc.hostId, { cpuTotal: cpuValue, freshestMs: lastMs });
      }
    }
    // "Deployed" signal — union of three sources:
    //   (a) registry: Retellect items currently configured in the host's
    //       Zabbix template (`retellectDeployedHostIds`).
    //   (b) period-aware trend signal: hostIds with python.cpu trend
    //       value_max > 0.5% at any point in the period
    //       (`retellectActiveInPeriodHostIds`). Server-fetched with
    //       proper retention handling. Captures intermittent hosts that
    //       ran Retellect during the window but stopped before the
    //       template registry was refreshed — Pavilnonys SC02 case.
    //   (c) aggregate backup: any host whose rolloutPerHost entry has
    //       ON-classified tracked minutes. Catches the same historical
    //       evidence via a different code path so the dot still lights
    //       up even if (b) is empty on this environment.
    const deployedSet = new Set<string>(zabbix.retellectDeployedHostIds ?? []);
    for (const id of zabbix.retellectActiveInPeriodHostIds ?? []) deployedSet.add(id);
    for (const entry of zabbix.rolloutPerHost?.perHost ?? []) {
      const onTracked = entry.on.realTrackedMinutes + entry.on.syntheticTrackedMinutes;
      if (onTracked > 0) deployedSet.add(entry.hostId);
    }
    // Per-day active counters from the Rollout Insights aggregate. Keyed
    // hostId → date → counters. Drives the heatmap cells when the user
    // toggles Count from = "Active only" — cells then use
    // activeMinutesAbove[threshold] for the matching (host, date) pair
    // instead of the unclassified cpuTrends.minutesAbove[threshold].
    // Hosts without spss.cpu items don't appear in rolloutPerHost.perHost,
    // so their per-day active map is empty and cells render as "—" in
    // active mode — correct, because we can't classify active without
    // spss data.
    const perDayMap = new Map<string, Map<string, PerDayActiveCounters>>();
    for (const entry of zabbix.rolloutPerHost?.perHost ?? []) {
      const dayMap = new Map<string, PerDayActiveCounters>();
      for (const d of entry.perDay ?? []) dayMap.set(d.date, d);
      perDayMap.set(entry.hostId, dayMap);
    }
    return { zabbixByName: byName, cpuDetail: detail, trendByHostDate: trendMap, retellectByHost: rtMap, deployedHostIds: deployedSet, perDayActiveByHost: perDayMap };
  }, [zabbix]);

  // Single source of truth lives in rt-overview-helpers.ts (`isRetellectRunning`,
  // `RETELLECT_CPU_THRESHOLD`). Pre-2026-04-28 this file had its own copy with
  // a 1.0% cutoff — helper is now 0.01% because real Rimi prod idle Retellect
  // sits at 0.4–0.95%. Hard-coding 1.0% here filtered the live fleet down to
  // a single host. Always use the helper.
  //
  // Freshness window: 2h (not 5 min) because Rimi prod Zabbix polls python.cpu
  // on a ~1h cycle. A 5-min window would reject every host even when Retellect
  // is genuinely active. Matches the FILTER_FRESH_SEC choice in RtOverview.
  const RT_FILTER_FRESH_SEC = 7200;

  const hasTrendData = (zabbix.cpuTrends?.length || 0) > 0;

  // Snap the user's threshold (50/60/70/80/90) to the closest minutesAbove
  // bucket key emitted by the trend rollup. The same expression also lives
  // inside `allHostRows` for the column totals; keeping a component-scope
  // copy lets the cell renderer below read `trend.minutesAbove[thKey]`.
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

  const allHostRows = useMemo(() => {
    return pilot.devices
      .filter((d) => storeFilter === "all" || d.storeName === storeFilter)
      .map((device) => {
        const zHost = zabbixByName.get(device.sourceHostKey || "") || zabbixByName.get(device.name);
        const detail = zHost ? cpuDetail.get(zHost.hostId) : null;
        const cpuTotal = detail
          ? ((detail.user + detail.system) > 0 ? detail.user + detail.system : detail.total)
          : 0;
        const days = Math.max(1, periodDays);

        // Use real Zabbix history data only. Missing days → null (rendered as empty gray cell).
        // Previously we back-filled gaps with synthetic data; that masked the fact that we have
        // no real history, which is misleading during demos.
        // Date keys come from getCpuHistoryDaily, which uses Europe/Vilnius local date — match
        // here too so timeline labels and stored data line up regardless of UTC offset.
        let peaks: (number | null)[];
        // Keep parallel arrays of full trend data (max/avg/min) so cell tooltips
        // can show day-level context alongside the displayed peak.
        let dayTrends: (ZabbixCpuTrend | null)[];
        // Per-day active counters from rolloutPerHost — drives the heatmap
        // when the user toggles into Count from = "Active only". null when
        // the host isn't in rolloutPerHost (no spss.cpu items, broken
        // agent) or the day has no active minutes.
        let dayActives: (PerDayActiveCounters | null)[];
        if (zHost && hasTrendData) {
          const hostTrends = trendByHostDate.get(zHost.hostId);
          const hostPerDayActive = perDayActiveByHost.get(zHost.hostId);
          dayTrends = dates.map((d) => {
            const dateStr = d.toLocaleDateString("en-CA", { timeZone: "Europe/Vilnius" });
            return hostTrends?.get(dateStr) ?? null;
          });
          dayActives = dates.map((d) => {
            const dateStr = d.toLocaleDateString("en-CA", { timeZone: "Europe/Vilnius" });
            return hostPerDayActive?.get(dateStr) ?? null;
          });
          peaks = dayTrends.map((t) => t ? t.max : null);
        } else {
          peaks = Array<number | null>(days).fill(null);
          dayTrends = Array<ZabbixCpuTrend | null>(days).fill(null);
          dayActives = Array<PerDayActiveCounters | null>(days).fill(null);
        }
        // Aggregate sample-level minute counts across the visible period.
        // `minutesAbove` and `totalMinutes` are the new exceedance metric:
        // they tell the user "of N minutes we have data for, X were above
        // the threshold". `exceedDays` is kept as a fallback for hosts that
        // only have trend.get coverage (no raw 1-min samples available).
        // (thKey is hoisted to component scope above so renderHostRow can
        // share the same bucket without duplicating the snap logic.)
        let minutesAbove = 0;
        let totalMinutes = 0;
        for (const t of dayTrends) {
          if (!t) continue;
          if (t.minutesAbove) minutesAbove += t.minutesAbove[thKey] ?? 0;
          if (typeof t.totalSamples === "number") totalMinutes += t.totalSamples;
        }
        // Parallel sum for Active-only mode — pulls from the per-day
        // active counters in rolloutPerHost. Used by the sort/stats
        // bar when cpuCountFrom === "active" so totals match cells.
        // thKey is one of the precomputed bands {20,…,90} so the index
        // is type-safe by construction.
        const activeThKey = thKey as 20 | 30 | 40 | 50 | 60 | 70 | 80 | 90;
        let activeMinutesAbove = 0;
        let activeTotalMinutes = 0;
        for (const a of dayActives) {
          if (!a) continue;
          activeMinutesAbove += a.activeMinutesAbove[activeThKey] ?? 0;
          activeTotalMinutes += a.activeRealMinutes + a.activeSyntheticMinutes;
        }
        const exceedDays = peaks.filter((p): p is number => p !== null && p >= threshold).length;
        // Live Retellect signal — same definition as RtOverview: python.cpu items
        // fresh (<5 min) AND CPU% > 1.0. We capture this on the row so the
        // filter, sort, and the column dot all switch from DB flag to telemetry.
        const rt = zHost ? retellectByHost.get(zHost.hostId) : undefined;
        const refMs = Date.now();
        // Three independent signals layered on top of each other:
        //
        //   rtActive       — running RIGHT NOW (≤5 min since last sample,
        //                    summed CPU above noise floor). Drives the
        //                    "Retellect On" filter pill.
        //   rtDeployed     — Retellect items configured in the Zabbix
        //                    template for this host. Either telemetry has
        //                    seen samples (freshestMs > 0) OR the strict
        //                    registry says items exist regardless of state
        //                    — covers Pavilnonys SCO2 case where 8 python
        //                    items exist as state=1 (unsupported, no samples).
        //   rtActiveToday  — produced meaningful CPU readings TODAY (last
        //                    24 h). Subset of rtDeployed.
        const rtActive = isRetellectRunning({
          freshestMs: rt?.freshestMs ?? 0,
          refMs,
          totalCpu: rt?.cpuTotal ?? 0,
          freshSec: RT_FILTER_FRESH_SEC,
        });
        const rtDeployed =
          (zHost ? deployedHostIds.has(zHost.hostId) : false) ||
          isRetellectDeployed(rt?.freshestMs ?? 0);
        const rtActiveToday = isRetellectActiveToday({
          freshestMs: rt?.freshestMs ?? 0,
          refMs,
          totalCpu: rt?.cpuTotal ?? 0,
        });
        // Resolution order:
        //   1. Device.cpuModel (DB — sourced from Excel hardware registry)
        //   2. Zabbix host.inventory.cpuModel (rarely populated on Rimi prod)
        //   3. "${cores}-core (model unknown)" — derived from system.cpu.num so
        //      "Group by CPU model" still produces meaningful buckets even when
        //      the registry is missing entries (e.g. CHM Outlet T813 fleet).
        //      Mirrors the fallback used by RtOverview's Hardware Class panel.
        //   4. "—" placeholder (only when even cores are unknown).
        // TODO(RT-CPUMODEL phase 2): backfill Device.cpuModel and the fallback
        // becomes a no-op for the Rimi fleet.
        // Resolve cores with the same priority order resolveCoresForHost uses
        // on the server, plus a manual-override branch:
        //
        //   manual (DB.cpuCoresSource='manual')  — operator typed this in.
        //                                          Wins over live Zabbix
        //                                          (the whole point of going
        //                                          manual is that Zabbix
        //                                          reports the wrong number).
        //   live  Zabbix detail (system.cpu.num) — preferred when fresh.
        //   cached Device.cpuCores              — fallback (was 'zabbix'
        //                                          last time we probed).
        //   unknown                              — surface "?c" warning.
        //
        // Without the manual branch, the StrongPoint Testlab SCO showed the
        // wrong cores count even though we stamped cpuCores=4 in the DB
        // migration — Zabbix system.cpu.num was returning a different value
        // and Timeline rendered that over our manual ground truth.
        const liveCores = detail?.numCpus || 0;
        const cachedCores = device.cpuCores ?? 0;
        const isManualOverride = device.cpuCoresSource === "manual" && cachedCores > 0;
        const effectiveCores = isManualOverride
          ? cachedCores
          : liveCores > 0
            ? liveCores
            : cachedCores;
        const coresSource: "zabbix" | "cache" | "manual" | "unknown" =
          isManualOverride
            ? "manual"
            : liveCores > 0
              ? "zabbix"
              : cachedCores > 0
                ? "cache"
                : "unknown";
        const cpuModelFromRegistry = resolveCpuModel(device.cpuModel, zHost?.inventory?.cpuModel ?? null);
        const resolvedCpuModel =
          cpuModelFromRegistry !== "—"
            ? cpuModelFromRegistry
            : effectiveCores > 0
              ? `${effectiveCores}-core (model unknown)`
              : "—";
        return { name: device.name, storeName: device.storeName || "(unknown store)", cpuModel: resolvedCpuModel, deviceType: device.deviceType || "—", retellectEnabled: !!device.retellectEnabled, rtActive, rtDeployed, rtActiveToday, currentCpu: Math.round(cpuTotal * 10) / 10, cores: effectiveCores, coresSource, ramGb: device.ramGb, hasMatch: !!zHost, zHost, peaks, dayTrends, dayActives, exceedDays, minutesAbove, totalMinutes, activeMinutesAbove, activeTotalMinutes };
      });
    // `deployedHostIds` and `thKey` are intentionally added to the dep list:
    //   • deployedHostIds — used inside the row body (rtDeployed fallback);
    //     when the Retellect host registry changes mid-session the rows must
    //     re-derive, otherwise the "Retellect Installed" filter / cell keeps
    //     stale truth.
    //   • thKey — `threshold` is already in the deps and thKey is a pure
    //     function of threshold, so listing it changes nothing operationally
    //     but silences the exhaustive-deps lint without disabling it — the
    //     plugin's static analysis can't see through the snap-down expression.
  }, [pilot, zabbixByName, cpuDetail, trendByHostDate, perDayActiveByHost, retellectByHost, deployedHostIds, storeFilter, threshold, thKey, periodDays, dates, hasTrendData]);

  // Unique CPU model list for the dropdown — derived from currently visible
  // (post-store-filter) rows so we don't offer models that aren't applicable.
  const cpuModelOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of allHostRows) set.add(r.cpuModel);
    return [...set].sort();
  }, [allHostRows]);

  const hostRows = useMemo(() => {
    let rows = allHostRows;
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.deviceType.toLowerCase().includes(q) || r.cpuModel.toLowerCase().includes(q));
    }
    // Two mutually-exclusive Retellect filter pills (post-2026-05-07):
    //   "today"     — show only hosts that produced meaningful Retellect
    //                 (python.cpu) activity within the last 24 h.
    //   "installed" — show only hosts where Retellect items are configured
    //                 in the Zabbix template, regardless of activity.
    //                 This is a SUPERSET of "today" — picking it surfaces
    //                 deployed-but-idle hosts that "today" would hide.
    //   null        — no filter.
    if (retellectInstalled === "today") {
      rows = rows.filter((r) => r.rtActiveToday);
    } else if (retellectInstalled === "installed") {
      rows = rows.filter((r) => r.rtDeployed);
    }
    if (cpuModelFilter !== "all") {
      rows = rows.filter((r) => r.cpuModel === cpuModelFilter);
    }
    // Silent-host filter: hide rows that produced no CPU samples in the active
    // period. A host is "silent" when every per-day peak is null AND no
    // sample-minutes accumulated — covers both "no Zabbix match" and
    // "matched but agent never reported". Skipped entirely when global trend
    // data is missing, otherwise the filter would empty the whole table.
    if (hideEmptyHosts && hasTrendData) {
      rows = rows.filter(
        (r) => !(r.peaks.every((p) => p === null) && r.totalMinutes === 0),
      );
    }
    return [...rows].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "name") cmp = a.name.localeCompare(b.name);
      else if (sortKey === "store") cmp = a.storeName.localeCompare(b.storeName);
      else if (sortKey === "rt") {
        // Two-level sort: Today active first (most relevant), then Deployed
        // — so a "deployed but idle" host ranks above a "never-deployed" host
        // when "Today" is sorted desc. Matches user expectation when they
        // click the column header.
        const aKey = (a.rtActiveToday ? 2 : 0) + (a.rtDeployed ? 1 : 0);
        const bKey = (b.rtActiveToday ? 2 : 0) + (b.rtDeployed ? 1 : 0);
        cmp = aKey - bKey;
      }
      else if (sortKey === "type") cmp = a.deviceType.localeCompare(b.deviceType);
      else if (sortKey === "exceed") cmp = a.minutesAbove - b.minutesAbove;
      else if (sortKey === "exceedPct") {
        const pa = a.totalMinutes > 0 ? a.minutesAbove / a.totalMinutes : 0;
        const pb = b.totalMinutes > 0 ? b.minutesAbove / b.totalMinutes : 0;
        cmp = pa - pb;
      }
      else if (sortKey === "cpu") cmp = a.currentCpu - b.currentCpu;
      return sortDir === "desc" ? -cmp : cmp;
    });
  }, [allHostRows, search, retellectInstalled, cpuModelFilter, hideEmptyHosts, hasTrendData, sortKey, sortDir]);

  // Count hosts that haven't reported any CPU sample in the active period.
  // Surfaced on the "Hide silent" pill so the user knows up-front how many
  // rows will disappear when they toggle it on.
  const silentHostCount = useMemo(() => {
    if (!hasTrendData) return 0;
    return allHostRows.filter(
      (r) => r.peaks.every((p) => p === null) && r.totalMinutes === 0,
    ).length;
  }, [allHostRows, hasTrendData]);

  const stats = useMemo(() => {
    // Stats now use minutesAbove instead of exceedDays. Thresholds: > 60 min
    // cumulative above the chosen threshold = critical (a meaningful chunk of
    // time spent stressed); 1–60 min = warning (intermittent spikes); 0 = ok.
    const critical = allHostRows.filter((r) => r.hasMatch && r.minutesAbove > 60).length;
    const warning = allHostRows.filter((r) => r.hasMatch && r.minutesAbove > 0 && r.minutesAbove <= 60).length;
    const ok = allHostRows.filter((r) => r.hasMatch && r.minutesAbove === 0).length;
    const noData = allHostRows.filter((r) => !r.hasMatch).length;
    return { total: allHostRows.length, critical, warning, ok, noData };
  }, [allHostRows]);

  // (Removed `filteredAggregate` 2026-05-25 — the per-row sum/percent the
  // hook used to compute was never read by the JSX after the headline pill
  // was dropped in an earlier UX pass. Keeping a recomputed-on-every-row
  // useMemo for no consumer was wasted work and a maintenance trap if the
  // active-mode denominator drifted out of sync with the heatmap cells.)

  const toggleSort = useCallback((key: SortKey) => {
    if (sortKey === key) setSortDir((d) => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
  }, [sortKey]);

  // Interval data for current drill + granularity.
  // DISABLED: previously generated synthetic PRNG data seeded by hostName+date.
  // Real per-hour process breakdown requires Zabbix `perf_counter` history for
  // python.exe / sp.sss / sqlservr / vmware-vmx — those items are not deployed
  // on Rimi hosts yet. We show an honest empty state instead of simulated bars.
  useEffect(() => {
    if (!drill) {
      setDrillIntervals(null);
      setDaySummary(null);
      setDrillDataQuality(null);
      setDrillCoresInfo(null);
      return;
    }
    // Drill carries the unambiguous Zabbix host id (set when the cell was
    // clicked). Multiple devices can share the same display name across stores
    // (e.g. "SCO2" in 8 stores), so we never resolve by name here.
    setDrillLoading(true);
    const isoDate = `${drill.dateObj.getFullYear()}-${String(drill.dateObj.getMonth() + 1).padStart(2, "0")}-${String(drill.dateObj.getDate()).padStart(2, "0")}`;
    // hostName goes alongside hostId so the route can resolve Device.cpuCores
    // (Device.sourceHostKey stores the Zabbix display name, not the numeric
    // id). Without hostName the cores resolver would never find the Device
    // row and would silently fall through to coresKnown=false, leaving
    // perf_counter values un-normalised in the drill-down stack.
    fetch(`/api/rt/process-history?hostId=${drill.hostId}&hostName=${encodeURIComponent(drill.sourceHostKey)}&date=${isoDate}&granularity=${granularity}`)
      .then((r) => r.json())
      .then((d) => {
        setDrillIntervals(Array.isArray(d.slots) ? d.slots : null);
        setDaySummary(d.daySummary ?? null);
        // Defensive: allow only the three known sparse-category keys; ignore
        // anything else the server might send (forward compatibility).
        const u = Array.isArray(d.unmonitored)
          ? (d.unmonitored.filter((k: unknown) =>
              k === "besclient" || k === "elastic" || k === "osCore"
            ) as SparseKey[])
          : [];
        setDayUnmonitored(u);
        // CPU normalisation spec: surface dataQuality summary and cores info.
        // Both are optional — the renderer tolerates older route deployments.
        setDrillDataQuality(
          d.dataQuality && typeof d.dataQuality.day === "string"
            ? {
                day: d.dataQuality.day,
                ok: d.dataQuality.ok ?? 0,
                warn: d.dataQuality.warn ?? 0,
                fail: d.dataQuality.fail ?? 0,
              }
            : null,
        );
        setDrillCoresInfo(
          typeof d.cores === "number"
            ? {
                cores: d.cores,
                coresKnown: !!d.coresKnown,
                coresSource: d.coresSource ?? null,
              }
            : null,
        );
      })
      .catch(() => {
        setDrillIntervals(null);
        setDaySummary(null);
        setDayUnmonitored([]);
        setDrillDataQuality(null);
        setDrillCoresInfo(null);
      })
      .finally(() => setDrillLoading(false));
  }, [drill, granularity]);

  const drillResources = useMemo(() => {
    if (!drill) return null;
    // Look up the row by hostId — the unambiguous identifier — so we don't
    // accidentally pick a different store's "SCO2".
    const row = hostRows.find((r) => r.zHost?.hostId === drill.hostId);
    if (!row?.zHost) return null;
    const h = row.zHost;
    const d = cpuDetail.get(h.hostId);
    const memBase = h.memory?.utilization || 0;
    const diskBase = h.disk?.utilization || 0;
    const cpuBase = d ? ((d.user + d.system) > 0 ? d.user + d.system : d.total) : 0;
    const totalRamGb = h.memory ? h.memory.totalBytes / 1024 / 1024 / 1024 : 0;
    return { hostName: drill.displayName, cores: row.cores, totalRamGb: Math.round(totalRamGb * 10) / 10, deviceType: row.deviceType, diskPath: h.disk?.path || "/", hourly: null as { hour: number; cpu: number; memory: number; disk: number; ramUsedGb: number }[] | null, currentCpu: cpuBase, currentMem: memBase, currentDisk: diskBase };
  }, [drill, hostRows, cpuDetail]);

  // Per-process Zabbix items (python.cpu, spss.cpu, sql.cpu, vm.cpu) are
  // emitted by the StrongPoint agent in **% of total host CPU**, NOT
  // "% of one core". Probe (2026-04-18 SCO2): per-process sum = 23% raw vs
  // system.cpu.util = 27%. So we do NOT divide by core count — the API already
  // returns host-relative percentages. We just clamp `free` ≥ 0 in case the
  // sum exceeds 100% (rounding error or item overlap).
  const normalizeSlot = useCallback((raw: ProcessSlot): ProcessSlot => {
    const r = raw.retellect;
    const sa = raw.scoApp;
    const dbv = raw.db;
    const sys = raw.system;
    // 2026-05-12: clamp to 0 so hosts on legacy API responses (no besclient /
    // elastic / osCore fields) still flow through without producing NaN. The
    // server now always emits these fields; this is defensive plumbing.
    const bes = raw.besclient ?? 0;
    const ela = raw.elastic ?? 0;
    const os = raw.osCore ?? 0;
    return {
      ...raw,
      retellect: r,
      scoApp: sa,
      db: dbv,
      system: sys,
      besclient: bes,
      elastic: ela,
      osCore: os,
      free: Math.max(0, 100 - r - sa - dbv - sys - bes - ela - os),
    };
  }, []);

  // Peak slot = the slot with the highest overall host CPU (system.cpu.util).
  // Earlier this used the sum of monitored processes, which is misleading: the
  // host can be at 100% while monitored processes only account for ~9% (the
  // rest being kernel / untracked work). The host-CPU peak is what the user
  // cares about — it's the same metric driving the timeline cell colour.
  const peakSlot = drillIntervals
    ? drillIntervals.reduce((max, s) => ((s.sysCpuMax ?? 0) > (max.sysCpuMax ?? 0) ? s : max), drillIntervals[0])
    : null;
  const peakSlotNorm = peakSlot ? normalizeSlot(peakSlot) : null;

  const selSlotData = useMemo(() => {
    if (selectedSlot === null || !drillIntervals) return null;
    const raw = drillIntervals[selectedSlot] || null;
    return raw ? normalizeSlot(raw) : null;
  }, [selectedSlot, drillIntervals, normalizeSlot]);

  const openDrill = useCallback((date: Date, hostId: string, displayName: string, sourceHostKey: string, peak: number) => {
    const newDate = `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    if (drill?.date === newDate && drill?.hostId === hostId) { setDrill(null); setSelectedSlot(null); userClearedSelectionRef.current = false; return; }
    setDrill({ date: newDate, dateObj: date, hostId, displayName, sourceHostKey, peak });
    setDrillTab("process");
    setSelectedSlot(null);
    userClearedSelectionRef.current = false;
  }, [drill]);

  // Keyboard navigation: ←/→ moves the cursor across the day, Home/End jump to
  // the edges, Esc clears the selection. If nothing is selected yet, ← starts
  // at the peak (most informative), → at the start of the day.
  // Auto-select the day's peak slot when the drill-down opens, so the process
  // breakdown is visible immediately without an extra click.
  //   Race fix 2026-04-28: `peakSlot` identity changes on every render, which
  //   used to re-fire this effect after the user pressed Esc — because the
  //   `if (selectedSlot !== null) return` guard saw `null` again and the
  //   effect promptly restored the peak. We now gate the auto-select on a
  //   ref that's only flipped when the drill itself opens, not on every
  //   parent re-render.
  useEffect(() => {
    if (!drill || !drillIntervals || drillIntervals.length === 0) return;
    if (drillTab !== "process") return;
    if (userClearedSelectionRef.current) return;
    if (selectedSlot !== null) return;
    if (!peakSlot || (peakSlot.sysCpuMax ?? 0) <= 0) return;
    setSelectedSlot(peakSlot.slot);
    // Intentionally exclude `selectedSlot` from deps — the ref above is the
    // single source of truth for "user wanted nothing selected".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drill, drillIntervals, drillTab, peakSlot]);

  useEffect(() => {
    if (!drill || !drillIntervals || drillIntervals.length === 0) return;
    if (drillTab !== "process") return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const intervals = drillIntervals;
      if (!intervals) return;
      const max = intervals.length - 1;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const dir = e.key === "ArrowLeft" ? -1 : 1;
        const step = e.shiftKey ? 10 : 1;
        setSelectedSlot((s) => {
          const start = s ?? (peakSlot ? peakSlot.slot : 0);
          return Math.max(0, Math.min(max, start + dir * step));
        });
      } else if (e.key === "Home") {
        e.preventDefault();
        setSelectedSlot(0);
      } else if (e.key === "End") {
        e.preventDefault();
        setSelectedSlot(max);
      } else if (e.key === "Escape") {
        setSelectedSlot(null);
        userClearedSelectionRef.current = true;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drill, drillIntervals, drillTab, peakSlot]);

  const sortArrow = (key: SortKey) => sortKey === key ? (sortDir === "desc" ? " ↓" : " ↑") : "";

  const statsBar = (() => {
    // The "≥ N% across selection" aggregate pill was removed 2026-04-28 —
    // Andrius felt it added noise without changing decisions. The per-row
    // ">80% MIN / %" columns still surface the same numbers, so the user
    // can spot-check a row instead of trusting a fleet headline.
    // (`filteredAggregate` useMemo was deleted 2026-05-25 because nothing
    // else consumed it.)
    const filtered = storeFilter !== "all" || cpuModelFilter !== "all" || retellectInstalled !== null || search !== "" || hideEmptyHosts;
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 11, color: C.textSec, padding: "4px 0", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600, color: "#212529" }}>{stats.total} hosts</span>
        {stats.noData > 0 && <span style={{ color: "#adb5bd" }}>● {stats.noData} no data</span>}
        {filtered && <span style={{ color: C.pillActive }}>→ {hostRows.length} shown</span>}
      </div>
    );
  })();

  const filterBar = (compact: boolean) => (
    // Visual layer shared with RtRolloutInsights — primitives in
    // src/components/rt/filters/RtFilterControls.tsx. Two-row layout:
    //   Row 1 — primary: threshold, metric, count-from, store, CPU.
    //   Row 2 — secondary slicers: period (presets + custom), group-by,
    //           Retellect filter pills, hide-silent toggle.
    // Switching tabs preserves the user's filter context AND the visual
    // surface — same label styling, dropdown look, segmented buttons.
    // The `compact` flag tightens spacing for the drill-down sub-view.
    <FilterBar>
      <FilterRow>
        <FilterSelect
          label="Threshold"
          value={String(threshold)}
          options={[20, 30, 40, 50, 60, 70, 80, 90].map((v) => ({ v: String(v), l: `${v}%` }))}
          onChange={(v) => setThreshold(Number(v))}
        />
        <FilterSegmented<"minAbove" | "peak">
          label="Metric"
          value={metric}
          options={[
            { v: "minAbove", l: "Minutes above threshold", title: "Sample-minutes per day with CPU > threshold — how long it stayed in trouble." },
            { v: "peak", l: "Peak %", title: "Day-MAX CPU% per host — how high it spiked." },
          ]}
          onChange={setMetric}
        />
        <FilterSegmented<"tracked" | "active">
          label="Count from"
          value="tracked"
          info="The heatmap always counts every tracked minute above the threshold (matches CPU Matrix in All-tracked mode). Active-only restriction is exposed in CPU Matrix; here it's disabled so the day cells stay reconcilable with Timeline drill-downs."
          options={[
            { v: "tracked", l: "All tracked" },
            {
              v: "active",
              l: "Active only",
              title: "Active-only counting is restricted to the CPU Matrix view — Timeline cells always use the tracked-minute denominator so drill-downs reconcile.",
              disabled: true,
            },
          ]}
          onChange={() => {
            /* Active-only disabled here; CPU Matrix is the entry point for that view. */
          }}
        />
        <FilterDivider />
        <FilterSelect
          label="Store"
          value={storeFilter}
          options={[{ v: "all", l: "All stores" }, ...pilot.stores.map((s) => ({ v: s.name, l: s.name }))]}
          onChange={setStoreFilter}
        />
        <FilterSelect
          label="CPU"
          value={cpuModelFilter}
          options={[{ v: "all", l: "All" }, ...cpuModelOptions.map((m) => ({ v: m, l: m }))]}
          onChange={setCpuModelFilter}
          title="Narrow the heatmap to one hardware class"
        />
      </FilterRow>
      <FilterRow>
        <FilterSegmented<string>
          label="Period"
          value={showCustomPeriod || !isPresetPeriod ? "__custom__" : period}
          options={[
            ...PERIODS.map((p) => ({ v: p.id, l: p.label, title: `Show the last ${p.days} days` })),
            { v: "__custom__", l: "Custom", title: "Pick a custom number of days" },
          ]}
          onChange={(v) => {
            if (v === "__custom__") {
              setShowCustomPeriod(true);
            } else {
              setPeriod(v);
              setShowCustomPeriod(false);
            }
          }}
        />
        {showCustomPeriod && (
          <div className="inline-flex items-center gap-1">
            <input
              type="number"
              min="1"
              max="365"
              value={customPeriodDays}
              onChange={(e) => setCustomPeriodDays(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const v = Math.max(1, Math.min(365, parseInt(customPeriodDays) || 14));
                  setCustomPeriodDays(String(v));
                  setPeriod(String(v));
                }
              }}
              placeholder="days"
              className="w-12 text-xs px-1.5 py-1 border border-gray-200 rounded text-center bg-white text-gray-700 focus:outline-none focus:border-blue-400"
            />
            <span className="text-[10px] text-gray-400">d</span>
            <button
              onClick={() => {
                const v = Math.max(1, Math.min(365, parseInt(customPeriodDays) || 14));
                setCustomPeriodDays(String(v));
                setPeriod(String(v));
              }}
              className="px-2 py-0.5 text-[11px] border border-gray-200 rounded bg-gray-50 text-gray-700 hover:bg-gray-100"
            >
              Apply
            </button>
          </div>
        )}
        {!isPresetPeriod && !showCustomPeriod && (
          <span className="text-[10px] text-gray-300">({periodDays}d)</span>
        )}
        {/* The "Updating window…" indicator used to live here in the filter
            bar. Moved 2026-05-25 to a centered overlay on the heatmap
            itself — the spinner is more legible when it sits where the
            user's attention already is (the data being updated), instead
            of fighting the filter chips for screen real estate. */}
        <FilterDivider />
        <FilterSegmented<"host" | "cpu" | "store">
          label="Group by"
          value={groupBy}
          options={[
            { v: "host", l: "Host", title: "One row per cash register — the most detailed view." },
            { v: "cpu", l: "CPU model", title: "Group by hardware model (e.g. WN Beetle M3)." },
            { v: "store", l: "Store", title: "Group by retail location." },
          ]}
          onChange={setGroupBy}
        />
        <FilterDivider />
        <span className="text-gray-500 font-medium" title="Filter by Retellect telemetry">Filter</span>
      {/* Two mutually-exclusive Retellect filter pills (post-2026-05-07,
          relabelled 2026-05-22 — "Today" was ambiguous and the pill ordered
          before "Installed", which is conceptually a SUPERSET. New order
          puts the superset first so the user sees the broader filter before
          the narrower one — matches the column header order (RT Inst, RT Act):
          • "Retellect Installed" — only hosts where Retellect items are
                                    configured in the Zabbix template,
                                    regardless of current activity (matches
                                    the RT INST column dot).
          • "Retellect Active"    — only hosts with meaningful python.cpu
                                    activity within the last 24 h (matches
                                    the RT ACT column dot — subset of Installed).
          Internal id stays "today" / "installed" to keep localStorage
          payloads from earlier sessions valid; only the visible label moves.
          Clicking the active one deselects (returns to "show all"). */}
        <div className="inline-flex items-center gap-1">
          {([
            { id: "installed" as const, label: "Retellect Installed", dot: "bg-sky-500", activeCls: "border-blue-200 bg-blue-50 text-blue-800", tip: "Show only hosts that had Retellect installed at some point during the selected period. Includes hosts where the helper is currently idle, hosts whose Zabbix items have since been removed, and hosts that produced any python.cpu activity above 0.5% inside the window. Matches the RT INST column dot — the broader of the two Retellect signals." },
            { id: "today" as const, label: "Retellect Active", dot: "bg-emerald-500", activeCls: "border-emerald-200 bg-emerald-50 text-emerald-800", tip: "Show only hosts where Retellect produced meaningful python.cpu activity within the last 24 hours (live signal — distinct from 'installed at some point'). Matches the RT ACT column dot; strict subset of Retellect Installed." },
          ]).map((p) => {
            const active = retellectInstalled === p.id;
            return (
              <button
                key={String(p.id)}
                type="button"
                onClick={() => setRetellectInstalled(active ? null : p.id)}
                title={p.tip}
                className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] border rounded-full transition ${active ? `${p.activeCls} font-medium` : "border-gray-200 bg-white text-gray-600 hover:text-gray-800"}`}
              >
                <span className={`w-2 h-2 rounded-full ${active ? p.dot : "bg-gray-300"}`} />
                {p.label}
              </button>
            );
          })}
          {/* "Hide silent hosts" — drops rows that have not sent a single CPU
              sample within the active period. Disabled when global trend data is
              missing (the indicator on the right already explains why). The
              count tells the user up-front how many rows will disappear. */}
          <button
            type="button"
            onClick={() => setHideEmptyHosts((v) => !v)}
            title={
              hasTrendData
                ? `Hide hosts with no CPU samples in the selected period (${silentHostCount} currently silent).`
                : "No trend data available — silent-host filtering is disabled."
            }
            disabled={!hasTrendData}
            className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] border rounded-full transition ${hideEmptyHosts ? "border-amber-300 bg-amber-50 text-amber-800 font-medium" : "border-gray-200 bg-white text-gray-600 hover:text-gray-800"} ${hasTrendData ? "cursor-pointer" : "cursor-not-allowed opacity-50"}`}
          >
            <span className={`w-2 h-2 rounded-full ${hideEmptyHosts ? "bg-amber-500" : "bg-gray-300"}`} />
            Hide silent{silentHostCount > 0 ? ` (${silentHostCount})` : ""}
          </button>
        </div>
        {compact && (
          <span className={`ml-auto text-[10px] ${hasTrendData ? "text-emerald-600" : "text-gray-300"}`}>
            {hasTrendData ? "✓ Live Zabbix trends" : "⚠ No trend data"}
          </span>
        )}
      </FilterRow>
    </FilterBar>
  );

  // ─── Heatmap row renderer (extracted so grouped + flat views share it) ─
  // Renders one <tr> for a host. `rowIdx` controls zebra striping; the row
  // looks the same in flat and grouped modes — group headers are injected
  // separately around these rows by the table body.
  const renderHostRow = (row: typeof hostRows[number], rowIdx: number) => {
    const rowHostId = row.zHost?.hostId;
    const sel = !!rowHostId && drill?.hostId === rowHostId;
    const zebra = rowIdx % 2 === 1 ? C.zebraOdd : "#fff";
    const rowBg = sel ? "#eff6ff" : zebra;
    const rowTitle = row.zHost?.hostName ? `${row.name} — ${row.zHost.hostName}` : row.name;
    return (
      <tr key={`${row.name}-${rowIdx}`} style={{ borderTop: `1px solid ${rowIdx === 0 ? C.border : "#f1f3f5"}`, background: rowBg }}>
        <td style={{
          padding: "3px 8px", fontSize: 11, fontWeight: sel ? 600 : 400, whiteSpace: "nowrap",
          position: "sticky", left: 0, background: rowBg, zIndex: 11,
          color: sel ? C.pillActive : "#343a40",
          width: 180, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis",
        }} title={row.storeName}>{row.storeName}</td>
        {/* Host column — sticky alongside Store so the row identity stays
            visible when the user scrolls the heatmap horizontally. left
            offset matches the Store column's 180 px width above. The
            previous border-right on both columns introduced a visible
            divider line that 'shone through' (user feedback 2026-05-25);
            we now rely on the natural cell padding for separation. */}
        <td style={{
          padding: "3px 6px", fontFamily: "'SF Mono','Cascadia Code',monospace", fontSize: 11,
          fontWeight: sel ? 600 : 400, whiteSpace: "nowrap",
          position: "sticky", left: 180, background: rowBg, zIndex: 11,
          color: sel ? C.pillActive : "#343a40",
          width: 100, minWidth: 70, maxWidth: 100, overflow: "hidden", textOverflow: "ellipsis",
        }} title={rowTitle}>{row.name}</td>
        {/* CPU column — sticky alongside Store/Host so the hardware
            identity stays visible during horizontal scroll. Fixed
            width 130 (was minWidth 130 / maxWidth 160) so the sticky
            left offsets of RT INST / RT ACT line up deterministically. */}
        <td style={{ padding: "3px 6px", fontSize: 10, color: C.textSec, whiteSpace: "nowrap", width: 130, minWidth: 130, maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis", position: "sticky", left: 280, background: rowBg, zIndex: 11 }} title={
          row.coresSource === "unknown"
            ? `${row.cpuModel} — CPU cores unknown. system.cpu.num not published and no Device.cpuCores override. Per-counter values are NOT normalised; stacked drill-down may be misleading. Run scripts/backfill-device-cpu-cores.mjs or set the value via Settings → Devices.`
            : `${row.cpuModel} · ${row.cores} cores (${
                row.coresSource === "zabbix" ? "live"
                : row.coresSource === "manual" ? "manual override"
                : "cached"
              })`
        }>
          {row.cpuModel}
          {/* CPU core count badge. The abbreviation "4c" was opaque to anyone
              new to the dashboard (real feedback 2026-05-22 — a first-time
              viewer didn't realise the suffix meant "cores"). Spelled out as
              "4 cores" so the meaning is self-evident; still fits the
              130–160 px column for every CPU model in the Rimi fleet. The
              parent <td> already carries a richer tooltip (live vs cached
              source); we add a direct title on the span so a hover on the
              badge itself surfaces the same info without delay. */}
          {row.cores > 0 ? (
            <span
              style={{
                marginLeft: 4,
                color:
                  row.coresSource === "cache" ? "#7e7e7e"
                  : row.coresSource === "manual" ? "#7c3aed" // distinct violet so manual overrides are visible at a glance
                  : "#0c8feb",
                fontWeight: 500,
              }}
              title={`${row.cores} CPU cores (${
                row.coresSource === "zabbix" ? "from live Zabbix system.cpu.num"
                : row.coresSource === "manual" ? "manual override — beats live Zabbix because operator set this explicitly"
                : "from cached Device.cpuCores backfill"
              })`}
            >
              · {row.cores} cores
            </span>
          ) : (
            <span
              style={{ marginLeft: 4, color: "#b91c1c", fontWeight: 600 }}
              title="CPU core count unknown — system.cpu.num not published and no Device.cpuCores override. Per-counter values are NOT normalised."
            >
              · ? cores ⚠
            </span>
          )}
        </td>
        {/*
          Two-dot Retellect indicator (split 2026-05-07):
            - "Deploy" — filled green when host has EVER reported python.cpu
              (= Retellect was installed at some point).
            - "Today" — filled green only if Retellect produced meaningful
              CPU readings in the last 24 h. Logically a SUBSET of Deploy,
              so when "Today" is on, "Deploy" must also be on.
          A host with Deploy=on, Today=off means: Retellect was once installed
          here but is currently idle / not running.
        */}
        <td
          style={{ padding: "3px 6px", textAlign: "center", width: 50, minWidth: 50, maxWidth: 50, position: "sticky", left: 410, background: rowBg, zIndex: 11 }}
          title={
            row.rtDeployed
              ? "RT installed — Retellect items configured in this host's Zabbix template"
              : "RT not installed on this host"
          }
        >
          <span style={{
            display: "inline-block", width: 8, height: 8, borderRadius: "50%",
            background: row.rtDeployed ? "#0ea5e9" : "transparent",
            border: row.rtDeployed ? "none" : "1px solid #cbd5e1",
            verticalAlign: "middle",
          }} />
        </td>
        <td
          style={{ padding: "3px 6px", textAlign: "center", width: 56, minWidth: 56, maxWidth: 56, position: "sticky", left: 460, background: rowBg, zIndex: 11 }}
          title={
            row.rtActiveToday
              ? "RT active today — meaningful Retellect (python) CPU activity within the last 24 h"
              : row.rtDeployed
                ? "RT installed but no meaningful activity in the last 24 h"
                : "RT not installed on this host"
          }
        >
          <span style={{
            display: "inline-block", width: 8, height: 8, borderRadius: "50%",
            background: row.rtActiveToday ? "#10b981" : "transparent",
            border: row.rtActiveToday ? "none" : "1px solid #cbd5e1",
            verticalAlign: "middle",
          }} />
        </td>
        {row.peaks.map((peak, i) => {
          const hasValue = row.hasMatch && peak !== null;
          const trend = row.dayTrends[i];
          const dateStr = `${String(dates[i].getMonth() + 1).padStart(2, "0")}-${String(dates[i].getDate()).padStart(2, "0")}`;
          const active = sel && drill?.date === dateStr;

          // Metric switch — "peak" shows day-MAX %, "minAbove" shows the
          // minute-count above the active threshold for the same day. Both
          // colour by their own buckets; "exceeded" still drives bold/white.
          // Count-from switch: All tracked uses cpuTrends (every minute);
          // Active only uses rolloutPerHost.perHost[].perDay[] (busy-only).
          const dayActive = row.dayActives?.[i];
          const minAbove = cpuCountFrom === "active"
            ? (dayActive?.activeMinutesAbove[thKey] ?? 0)
            : (trend?.minutesAbove?.[thKey] ?? 0);
          // hasValue for Active only requires perDay data — hosts without
          // spss.cpu items (no baseline computable) won't have it; cells
          // render as a striped "—" to make that absence visible rather
          // than misread as "no spikes".
          const hasActiveValue = cpuCountFrom === "active" ? !!dayActive : true;
          const hasMinAboveValue = metric === "minAbove" ? hasActiveValue : true;
          // Active-only mode with no perDay entry for this (host, day) →
          // we genuinely can't render a count; otherwise hasValue stays
          // driven by the trend record like before.
          const cellHasValue = hasValue && hasMinAboveValue;
          const exceeded = metric === "peak"
            ? (cellHasValue && (peak ?? 0) >= threshold)
            : (cellHasValue && minAbove > 0);
          const bg = !cellHasValue
            ? "#f9fafb"
            : metric === "peak"
              ? ((peak ?? 0) >= 90 ? C.criticalBg
                : (peak ?? 0) >= 80 ? C.highBg
                : ((peak ?? 0) >= threshold) ? C.thresholdBg
                : C.belowBg)
              // Minute-count buckets, calibrated for a 24h day (1440 min):
              //   0       → below   (no exceedance)
              //   1–15    → amber   (sporadic)
              //   16–60   → high    (sustained quarter-hour to an hour)
              //   61+     → critical (≥ 1h above threshold)
              : (minAbove >= 61 ? C.criticalBg
                : minAbove >= 16 ? C.highBg
                : minAbove >= 1  ? C.thresholdBg
                : C.belowBg);
          const cellLabel = (() => {
            if (!cellHasValue) return "—";
            if (metric === "peak") return Math.round(peak!);
            if (minAbove === 0) return "0";
            if (minAbove >= 1000) return `${(minAbove / 1000).toFixed(1)}k`;
            return String(minAbove);
          })();
          // Cell tooltip — when a cell is empty ("—"), surface WHY so the
          // user can tell apart "no monitoring" from "outside retention".
          // The age check uses the same date math as the rest of the row
          // (dates[i] is a JS Date constructed at SSR boundary). >29d falls
          // outside Zabbix trend.get retention on this deployment; 14-29d
          // is in trend window only (no raw 1-min samples); <14d should
          // normally have data, so a null peak usually means agent gap.
          const ageDaysApprox = Math.floor((Date.now() - dates[i].getTime()) / 86_400_000);
          const cellTitle = !row.hasMatch
            ? "No Zabbix host match"
            : peak === null
              ? ageDaysApprox > 29
                ? `${dateStr} — outside Zabbix trend retention (~29 days). No data is available for this date.`
                : ageDaysApprox > 14
                  ? `${dateStr} — beyond raw history retention (~14 days). Trend.get should have an hourly bucket but didn't return one for this host — likely a Zabbix-side gap or cache that hasn't refreshed yet. Reload to retry.`
                  : `${dateStr} — no CPU samples received this day. Likely a Zabbix agent gap (host down, agent restarted, or item briefly unsupported).`
              : trend
                ? metric === "peak"
                  ? `${row.name} · ${dateStr}\nDay max:  ${trend.max}%\nDay avg:  ${trend.avg}%\nDay min:  ${trend.min}%\nMin ≥ ${threshold}%: ${minAbove}\nClick to open drill-down (per-minute breakdown)`
                  : `${row.name} · ${dateStr}\nMinutes ≥ ${threshold}%: ${minAbove}\nDay max:  ${trend.max}% · avg: ${trend.avg}%\nClick to open drill-down (per-minute breakdown)`
                : metric === "peak"
                  ? `Day max ${Math.round(peak!)}% — click to drill down`
                  : `${minAbove} min ≥ ${threshold}% — click to drill down`;
          return (
            <td key={i} style={{ padding: 0, textAlign: "center", width: 32, cursor: hasValue ? "pointer" : "default" }}
              onClick={() => hasValue && rowHostId && openDrill(dates[i], rowHostId, row.name, row.zHost?.hostName || row.name, peak!)}
              title={cellTitle}>
              <div style={{
                background: bg,
                color: !hasValue ? "#d1d5db" : exceeded ? C.exceededText : C.belowText,
                padding: "2px 0", fontSize: 10, fontWeight: exceeded ? 700 : 400, lineHeight: 1.2,
                outline: active ? "2px solid #0070c9" : "none", outlineOffset: -1, borderRadius: active ? 2 : 0,
              }}>
                {cellLabel}
              </div>
            </td>
          );
        })}
        {(() => {
          // Two cells: absolute minutes count and the same value as a % of
          // the sampled period. Both share the same risk colour so the eye
          // groups them visually even though they're separate columns.
          if (!row.hasMatch) {
            return (
              <>
                <td style={{ padding: "3px 6px", textAlign: "center" }}><span style={{ fontSize: 10, color: "#d1d5db" }}>—</span></td>
                <td style={{ padding: "3px 6px", textAlign: "center" }}><span style={{ fontSize: 10, color: "#d1d5db" }}>—</span></td>
              </>
            );
          }
          if (row.totalMinutes <= 0) {
            return (
              <>
                <td style={{ padding: "3px 6px", textAlign: "center" }}><span style={{ fontSize: 10, fontWeight: 500, color: C.okGreen }}>OK</span></td>
                <td style={{ padding: "3px 6px", textAlign: "center" }}><span style={{ fontSize: 10, color: "#d1d5db" }}>—</span></td>
              </>
            );
          }
          const pct = (row.minutesAbove / row.totalMinutes) * 100;
          const fmt = (n: number) => n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
          const isHigh = row.minutesAbove > 60;
          const isMed = row.minutesAbove > 0 && row.minutesAbove <= 60;
          const bg = isHigh ? C.riskRedBg : isMed ? C.riskAmberBg : C.riskGrayBg;
          const fg = isHigh ? C.riskRedText : isMed ? C.riskAmberText : C.textSec;
          const pctText = pct >= 10 ? `${Math.round(pct)}%` : pct >= 1 ? `${pct.toFixed(1)}%` : pct > 0 ? `${pct.toFixed(2)}%` : "0%";
          const tooltip = `${row.minutesAbove} of ${row.totalMinutes} sampled minutes were ≥ ${threshold}% (${pct.toFixed(2)}% of the period)`;
          return (
            <>
              <td style={{ padding: "3px 6px", textAlign: "center" }}>
                <span style={{
                  padding: "1px 6px", borderRadius: 8, fontSize: 10, fontWeight: 600,
                  background: bg, color: fg, fontVariantNumeric: "tabular-nums",
                }} title={tooltip}>
                  {fmt(row.minutesAbove)}<span style={{ opacity: 0.6 }}>/{fmt(row.totalMinutes)}</span>
                </span>
              </td>
              <td style={{ padding: "3px 6px", textAlign: "center" }}>
                <span style={{
                  padding: "1px 6px", borderRadius: 8, fontSize: 10, fontWeight: 700,
                  background: bg, color: fg, fontVariantNumeric: "tabular-nums",
                }} title={tooltip}>{pctText}</span>
              </td>
            </>
          );
        })()}
      </tr>
    );
  };

  // RT-CPUMODEL phase 1: when the user activates "Group by CPU model" but
  // most of the visible fleet has no CPU string, every group collapses into
  // one "—" bucket and the view stops being useful. Surface a one-line note
  // pointing them at the better grouping until phase 2 backfills the data.
  // Threshold is >50 % of currently-visible rows; computed here on the
  // post-filter `hostRows` so it tracks user filtering live.
  const cpuModelCoverage = useMemo(() => {
    const total = hostRows.length;
    if (total === 0) return { unknown: 0, total: 0 };
    // "Unknown" = no registry hit AND no core-count fallback. The
    // "X-core (model unknown)" buckets are still useful groupings, so they
    // don't count toward the warning's threshold.
    const unknown = hostRows.filter((r) => {
      const m = r.cpuModel.trim();
      return m === "" || m === "—" || m === "-";
    }).length;
    return { unknown, total };
  }, [hostRows]);
  const showCpuGroupWarning =
    groupBy === "cpu" &&
    cpuModelCoverage.total > 0 &&
    cpuModelCoverage.unknown * 2 > cpuModelCoverage.total;

  // ─── Heatmap table ────────────────────────────────────────────────
  const heatmapTable = (
    <>
      {statsBar}
      {showCpuGroupWarning && (
        <div
          role="note"
          style={{
            background: "#fef3c7", border: "1px solid #fcd34d", borderRadius: 6,
            padding: "6px 10px", marginBottom: 8, fontSize: 11, color: "#92400e",
            display: "flex", alignItems: "center", gap: 6,
          }}
        >
          <span aria-hidden="true">⚠</span>
          <span>
            CPU model unknown for {cpuModelCoverage.unknown} of {cpuModelCoverage.total} hosts —
            group by Store or Host instead, or wait for inventory backfill (RT-CPUMODEL).
          </span>
        </div>
      )}
      <div style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 6, overflow: "hidden", position: "relative" }}>
        <div style={{ overflowX: "auto" }}>
          {/*
            Table width strategy 2026-05-07: 'min-width: 100%' + 'width: max-content'
            so the table fills the wrapper when content is narrower than the viewport
            (small periods like 7 d) but grows to its natural content width when wider
            (30 d / 60 d). The wrapper's overflowX: auto then provides the horizontal
            scroll naturally. With the prior 'width: 100%' the browser kept trying to
            fit min-content into the viewport, occasionally squashing day cells below
            the 32 px hint when the left columns + summary couldn't compress further —
            which is the bug where '30 d period' dropped the per-day cell visualisation.
          */}
          <table style={{ minWidth: "100%", width: "max-content", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: C.headerBg }}>
                {/* New ordering per user feedback: Store → Host → CPU → Retellect.
                    Type column dropped — every host in this pilot is the same
                    type (SCO), the badge added noise without information. */}
                <th onClick={() => toggleSort("store")} style={{ textAlign: "left", padding: "4px 8px", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.4, color: C.headerText, fontWeight: 600, whiteSpace: "nowrap", position: "sticky", left: 0, background: C.headerBg, zIndex: 12, cursor: "pointer", userSelect: "none", width: 180, minWidth: 180 }}>
                  Store{sortArrow("store")}
                </th>
                {/*
                  Explicit minWidth on Host / CPU / Retellect headers (and the
                  matching <td>s in renderHostRow) is REQUIRED — without it the
                  table-layout: auto algorithm collapses these columns to 0 px
                  when the day grid + sticky Store + right summary columns
                  already exceed the container width. Symptom: header shows
                  only "STORE", individual rows show only the store name with
                  no host/CPU/retellect content visible. With 30 day cells × 32
                  px = 960 px alone, narrow viewports (< ~1320 px after sidebar)
                  trigger the collapse on `width: 100%` tables.
                */}
                <th onClick={() => toggleSort("name")} style={{ textAlign: "left", padding: "4px 6px", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.4, color: C.headerText, fontWeight: 600, whiteSpace: "nowrap", cursor: "pointer", userSelect: "none", position: "sticky", left: 180, background: C.headerBg, zIndex: 12, width: 100, minWidth: 70 }}>
                  Host{sortArrow("name")}
                </th>
                <th style={{ textAlign: "left", padding: "4px 6px", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.4, color: C.headerText, fontWeight: 600, whiteSpace: "nowrap", position: "sticky", left: 280, background: C.headerBg, zIndex: 12, width: 130, minWidth: 130 }}>CPU</th>
                {/*
                  Retellect column was a single dot mixing two questions:
                  "is it installed?" and "is it active right now?". Split
                  into two narrower columns 2026-05-07. Header labels keep
                  the "RT" prefix so the user knows both columns answer
                  Retellect-specific questions (the dashboard is general
                  enough that a bare "Inst"/"Act" pair would be ambiguous):
                    RT INST — Retellect items configured in Zabbix template
                              for this host (ever-installed signal).
                    RT ACT  — Retellect produced meaningful CPU activity
                              within the last 24 h ("Active"). Renamed from
                              "Today" 2026-05-22 to match the filter pill.
                  Both share the "rt" sort key (see toggleSort below).
                */}
                <th
                  onClick={() => toggleSort("rt")}
                  style={{ textAlign: "center", padding: "4px 6px", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.4, color: C.headerText, fontWeight: 600, cursor: "pointer", userSelect: "none", position: "sticky", left: 410, background: C.headerBg, zIndex: 12, width: 50, minWidth: 50 }}
                  title="RT installed — Retellect items are configured in this host's Zabbix template (Retellect was deployed on this checkout at some point)."
                >
                  RT&nbsp;Inst
                </th>
                <th
                  onClick={() => toggleSort("rt")}
                  style={{ textAlign: "center", padding: "4px 6px", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.4, color: C.headerText, fontWeight: 600, cursor: "pointer", userSelect: "none", position: "sticky", left: 460, background: C.headerBg, zIndex: 12, width: 56, minWidth: 56 }}
                  title="RT active — Retellect produced meaningful python.cpu activity within the last 24 h."
                >
                  RT&nbsp;Act{sortArrow("rt")}
                </th>
                {dates.map((d, i) => <th key={i} style={{ textAlign: "center", padding: "4px 0", fontSize: 8, fontWeight: 400, color: C.headerText, width: 32, minWidth: 32 }}>{String(d.getDate()).padStart(2, "0")}</th>)}
                <th onClick={() => toggleSort("exceed")} title={`Minutes ≥ ${threshold}% out of total sampled minutes`} style={{ textAlign: "center", padding: "4px 6px", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.4, color: C.headerText, fontWeight: 600, whiteSpace: "nowrap", cursor: "pointer", userSelect: "none" }}>
                  &gt;{threshold}% MIN{sortArrow("exceed")}
                </th>
                <th onClick={() => toggleSort("exceedPct")} title={`Percentage of period spent ≥ ${threshold}%`} style={{ textAlign: "center", padding: "4px 6px", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.4, color: C.headerText, fontWeight: 600, whiteSpace: "nowrap", cursor: "pointer", userSelect: "none" }}>
                  &gt;{threshold}% %{sortArrow("exceedPct")}
                </th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                // Flat (host) mode: render every row in the existing sort order.
                if (groupBy === "host") {
                  return hostRows.map((row, rowIdx) => renderHostRow(row, rowIdx));
                }

                // Grouped mode: cluster by CPU model OR store. Each header row
                // is collapsible; collapsed groups show one summary row with
                // per-day MAX across the group's hosts. Expanded groups also
                // render the individual host rows below the header.
                const groupKey = (r: typeof hostRows[number]): string =>
                  groupBy === "cpu" ? r.cpuModel : r.storeName;
                // Pre-bucket the rows so we have access to per-group totals
                // before deciding the order. We then layer the active sort on
                // top of the alphabetical fallback so headers honour the same
                // ">MIN" / ">%" toggle the user just clicked.
                const groups = new Map<string, typeof hostRows>();
                for (const r of hostRows) {
                  const k = groupKey(r);
                  if (!groups.has(k)) groups.set(k, []);
                  groups.get(k)!.push(r);
                }
                // Stable: sort members within each group alphabetically so
                // expanded groups render in a predictable order regardless of
                // the active group-level sort.
                for (const arr of groups.values()) {
                  arr.sort((a, b) => a.storeName.localeCompare(b.storeName) || a.name.localeCompare(b.name));
                }
                // Compute group-level aggregates once so the sort comparator
                // and the rendered header row read from the same source.
                type GroupAgg = { name: string; members: typeof hostRows; totalExceed: number; totalSampled: number; pct: number };
                const groupAggs: GroupAgg[] = [];
                for (const [name, members] of groups) {
                  const totalExceed = members.reduce((s, r) => s + r.minutesAbove, 0);
                  const totalSampled = members.reduce((s, r) => s + r.totalMinutes, 0);
                  const pct = totalSampled > 0 ? (totalExceed / totalSampled) * 100 : 0;
                  groupAggs.push({ name, members, totalExceed, totalSampled, pct });
                }
                groupAggs.sort((a, b) => {
                  // Only the two right-hand exceedance columns reorder groups;
                  // every other sort key falls back to alphabetical so the
                  // group list stays stable when sorting by row-level fields
                  // like Host or Retellect (which don't have a meaningful
                  // group-level interpretation).
                  let cmp = 0;
                  if (sortKey === "exceed") cmp = a.totalExceed - b.totalExceed;
                  else if (sortKey === "exceedPct") cmp = a.pct - b.pct;
                  if (cmp === 0) return a.name.localeCompare(b.name);
                  return sortDir === "desc" ? -cmp : cmp;
                });

                const elements: ReactElement[] = [];
                let runningIdx = 0;
                for (const { name: groupName, members } of groupAggs) {
                  const isExpanded = expandedGroups.has(groupName);
                  const matchedHosts = members.filter((r) => r.hasMatch).length;
                  // Pulled from groupAggs above so the sort and the rendered
                  // numbers can never disagree.
                  const groupAggEntry = groupAggs.find((g) => g.name === groupName)!;
                  const totalExceed = groupAggEntry.totalExceed;
                  const totalSampled = groupAggEntry.totalSampled;
                  // Per-day metric across the group — gives an at-a-glance
                  // heatmap row even when the group is collapsed.
                  //   Peak mode      : MAX peak% across members
                  //   Min-above mode : SUM of minutes ≥ threshold across members
                  // Both signals are aggregations the user can read down a
                  // column to see which days hit the whole group.
                  const dayAgg: (number | null)[] = dates.map((_, i) => {
                    if (metric === "peak") {
                      let max: number | null = null;
                      for (const r of members) {
                        const v = r.peaks[i];
                        if (v !== null && (max === null || v > max)) max = v;
                      }
                      return max;
                    }
                    let sum = 0;
                    let any = false;
                    for (const r of members) {
                      const t = r.dayTrends[i];
                      if (!t) continue;
                      any = true;
                      sum += t.minutesAbove?.[thKey] ?? 0;
                    }
                    return any ? sum : null;
                  });

                  elements.push(
                    <tr key={`grp-${groupName}`} style={{
                      borderTop: `1px solid ${C.border}`,
                      background: "#f1f5f9",
                      cursor: "pointer",
                    }} onClick={() => toggleGroup(groupName)}>
                      {/* Group label covers all 5 frozen columns
                          (Store + Host + CPU + RT INST + RT ACT,
                          combined width 516 px). Safe to span them
                          because every one of those 5 columns is now
                          sticky-left as well, so the grey background
                          travels with them as the user scrolls
                          horizontally — no bleeding onto day cells. */}
                      <td colSpan={5} style={{
                        padding: "6px 10px",
                        position: "sticky", left: 0, background: "#f1f5f9", zIndex: 10,
                      }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "#0f172a" }}>
                          <span style={{ fontSize: 10, color: "#64748b", width: 10, display: "inline-block", transform: isExpanded ? "rotate(90deg)" : "none", transition: "transform 0.15s ease" }}>▶</span>
                          <span style={{ fontWeight: 700, letterSpacing: 0.2 }} title={groupName}>{groupName}</span>
                          <span style={{ color: "#64748b", fontSize: 10 }}>{members.length} host{members.length === 1 ? "" : "s"}</span>
                          <span style={{ color: "#64748b", fontSize: 10 }}>· {matchedHosts} reporting</span>
                        </div>
                      </td>
                      {dayAgg.map((val, i) => {
                        const hasValue = val !== null;
                        const dateStr = `${String(dates[i].getMonth() + 1).padStart(2, "0")}-${String(dates[i].getDate()).padStart(2, "0")}`;
                        const exceeded = hasValue && (
                          metric === "peak" ? (val ?? 0) >= threshold : (val ?? 0) > 0
                        );
                        const bg = !hasValue
                          ? "#f9fafb"
                          : metric === "peak"
                            ? ((val ?? 0) >= 90 ? C.criticalBg
                              : (val ?? 0) >= 80 ? C.highBg
                              : ((val ?? 0) >= threshold) ? C.thresholdBg
                              : C.belowBg)
                            // Per-host-equivalent buckets: the per-host
                            // thresholds (≥ 61 / 16 / 1 minutes) scale with
                            // group size, so a 5-host group needs the SUM
                            // to reach 5× those values. This means the colour
                            // reflects the average member's load, not just
                            // "any one hot host pulled the total up". A single
                            // host going red inside a 5-host group keeps the
                            // group amber until at least the average host
                            // crosses the per-host threshold — prevents one
                            // outlier from painting the whole fleet red.
                            : ((val ?? 0) >= 61 * members.length ? C.criticalBg
                              : (val ?? 0) >= 16 * members.length ? C.highBg
                              : (val ?? 0) >= 1 ? C.thresholdBg
                              : C.belowBg);
                        const cellLabel = !hasValue ? "—"
                          : metric === "peak" ? Math.round(val ?? 0)
                          : (val ?? 0) >= 1000 ? `${((val ?? 0) / 1000).toFixed(1)}k`
                          : String(val ?? 0);
                        const cellTitle = hasValue
                          ? metric === "peak"
                            ? `${groupName} · ${dateStr}\nGroup MAX (across ${members.length} hosts): ${Math.round(val ?? 0)}%`
                            : `${groupName} · ${dateStr}\nGroup minutes ≥ ${threshold}% (sum of ${members.length} hosts): ${val}`
                          : `${groupName} · ${dateStr} — no data`;
                        return (
                          <td key={i} style={{ padding: 0, textAlign: "center", width: 32 }}
                            title={cellTitle}>
                            <div style={{
                              background: bg,
                              color: !hasValue ? "#d1d5db" : exceeded ? C.exceededText : C.belowText,
                              padding: "2px 0", fontSize: 10, fontWeight: exceeded ? 700 : 500, lineHeight: 1.2,
                            }}>
                              {cellLabel}
                            </div>
                          </td>
                        );
                      })}
                      {(() => {
                        const fmt = (n: number) => n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
                        const groupPct = totalSampled > 0 ? (totalExceed / totalSampled) * 100 : 0;
                        const isHigh = totalExceed > 600;
                        const isMed = totalExceed > 60 && totalExceed <= 600;
                        const bg = isHigh ? C.riskRedBg : isMed ? C.riskAmberBg : C.riskGrayBg;
                        const fg = isHigh ? C.riskRedText : isMed ? C.riskAmberText : C.textSec;
                        const pctText = groupPct >= 10 ? `${Math.round(groupPct)}%` : groupPct >= 1 ? `${groupPct.toFixed(1)}%` : groupPct > 0 ? `${groupPct.toFixed(2)}%` : "0%";
                        const tooltip = `Across ${members.length} host${members.length === 1 ? "" : "s"}: ${totalExceed} of ${totalSampled} sampled minutes were ≥ ${threshold}% (${groupPct.toFixed(2)}% of total period)`;
                        return (
                          <>
                            <td style={{ padding: "3px 6px", textAlign: "center" }}>
                              <span style={{
                                padding: "1px 6px", borderRadius: 8, fontSize: 10, fontWeight: 600,
                                background: bg, color: fg, fontVariantNumeric: "tabular-nums",
                              }} title={tooltip}>
                                {fmt(totalExceed)}<span style={{ opacity: 0.6 }}>/{fmt(totalSampled)}</span>
                              </span>
                            </td>
                            <td style={{ padding: "3px 6px", textAlign: "center" }}>
                              <span style={{
                                padding: "1px 6px", borderRadius: 8, fontSize: 10, fontWeight: 700,
                                background: bg, color: fg, fontVariantNumeric: "tabular-nums",
                              }} title={tooltip}>{pctText}</span>
                            </td>
                          </>
                        );
                      })()}
                    </tr>
                  );

                  if (isExpanded) {
                    members.forEach((row) => {
                      elements.push(renderHostRow(row, runningIdx++));
                    });
                  } else {
                    runningIdx += members.length;
                  }
                }

                return elements;
              })()}
            </tbody>
          </table>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 10, color: C.textSec, marginTop: 6 }}>
        {(metric === "peak"
          ? [
              { bg: C.belowBg, l: "Below" },
              { bg: C.thresholdBg, l: `${threshold}–${Math.min(threshold+10,80)}%` },
              { bg: C.highBg, l: "80–89%" },
              { bg: C.criticalBg, l: "≥90%" },
            ]
          : [
              { bg: C.belowBg, l: "0 min" },
              { bg: C.thresholdBg, l: "1–15 min" },
              { bg: C.highBg, l: "16–60 min" },
              { bg: C.criticalBg, l: "≥61 min" },
            ]
        ).map(({ bg, l }) => (
          <span key={l} style={{ display: "flex", alignItems: "center", gap: 3 }}>
            <span style={{ width: 10, height: 8, borderRadius: 2, background: bg, display: "inline-block" }} />{l}
          </span>
        ))}
        <span style={{ marginLeft: "auto", color: "#94a3b8" }}>
          {metric === "peak" ? `Peak · ≥ ${threshold}%` : `Min above · ≥ ${threshold}% per day`}
        </span>
      </div>
    </>
  );

  // (Bar / label sizing constants no longer needed — the chart is a line now,
  // and the time axis renders fixed hour markers independent of granularity.)

  // ─── Slot detail panel ────────────────────────────────────────────
  // Total = host CPU at that slot (system.cpu.util max). Process breakdown
  // uses the slot averages; whatever isn't accounted for by tracked processes
  // is shown as "Other" so the bar always sums to host CPU honestly.
  const hourDetailPanel = selSlotData && (() => {
    // Sum all 7 monitored buckets so "Other" only reflects genuinely
    // unattributed CPU. Before 2026-05-12 this was 4 buckets and "Other"
    // also held BESClient + Elastic + kernel — now those have their own
    // bars and Other shrinks accordingly on hosts that publish the new
    // items (testlab_SPUB-P-SCO150 first).
    const monitoredSum =
      selSlotData.retellect + selSlotData.scoApp + selSlotData.db + selSlotData.system
      + selSlotData.besclient + selSlotData.elastic + selSlotData.osCore;
    const hostCpu = selSlotData.sysCpuMax ?? selSlotData.sysCpuAvg ?? monitoredSum;
    const other = Math.max(0, hostCpu - monitoredSum);
    const otherFresh = selSlotData.sysCpuMax !== null;
    return (
      <div style={{
        background: "#fff", border: `1px solid ${C.border}`, borderRadius: 8,
        padding: "10px 16px", marginTop: 10, flexShrink: 0,
        display: "flex", alignItems: "center", gap: 20,
      }}>
        <div style={{ flexShrink: 0, textAlign: "center", minWidth: 70 }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#212529", lineHeight: 1 }}>
            {selSlotData.label}
          </div>
          <div style={{ fontSize: 10, color: C.textSec, marginTop: 2 }}>
            – {slotEndLabel(selSlotData, granularity)}
          </div>
          <div style={{ fontSize: 9, color: "#cbd5e1", marginTop: 2 }}>← → keys</div>
        </div>
        <div style={{ width: 1, height: 60, background: C.border, flexShrink: 0 }} />
        <div style={{ flexShrink: 0, textAlign: "center", minWidth: 70 }}>
          <div style={{ fontSize: 10, color: C.headerText, textTransform: "uppercase", fontWeight: 600, letterSpacing: 0.4 }}>Host CPU</div>
          <div style={{
            fontSize: 22, fontWeight: 700, lineHeight: 1.1,
            color: hostCpu >= 90 ? "#dc2626" : hostCpu >= 70 ? "#d97706" : "#212529",
          }}>
            {Math.round(hostCpu)}%
          </div>
          <div style={{ fontSize: 9, color: C.textSec, marginTop: 2 }}>
            slot {otherFresh ? "max" : "avg"}
          </div>
        </div>
        <div style={{ width: 1, height: 60, background: C.border, flexShrink: 0 }} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
          {PROCESSES.filter(p => p.key !== "free").map((proc) => {
            // 2026-05-19: rows whose underlying Zabbix items had ZERO samples
            // across the whole day (per server `unmonitored` flag) are hidden
            // here rather than rendered as a flat "0%" bar. Their residual is
            // absorbed by Other below, and Other's sub-label names them so
            // the user understands what's missing. Without this, a host that
            // gained per-process monitoring mid-window would have a sudden
            // "all 0%" pre-rollout day that looks like a real reading.
            if ((dayUnmonitored as readonly string[]).includes(proc.key)) return null;
            const val = selSlotData[proc.key];
            return (
              <div key={proc.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 11, color: C.textSec, width: 64, textAlign: "right", flexShrink: 0 }}>{proc.label}</span>
                <div style={{ flex: 1, height: 12, background: "#f1f3f5", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ height: "100%", borderRadius: 3, background: proc.color, width: `${val}%`, transition: "width 0.2s ease" }} />
                </div>
                <span style={{ fontSize: 12, fontWeight: 600, color: "#212529", width: 52, textAlign: "right", fontFamily: "'SF Mono','Cascadia Code',monospace", flexShrink: 0 }}>
                  {formatPct(val)}
                </span>
              </div>
            );
          })}
          {/* Other = host CPU - monitored process sum. Captures kernel work /
              processes not tracked by name (the difference between total host
              CPU and the named categories). When some categories were not yet
              provisioned on this host on the drilled-into day (`dayUnmonitored`
              non-empty), their would-be values fall in here too — the
              sub-label spells them out so the bar isn't silently overloaded. */}
          {(() => {
            const unmonitoredLabels = dayUnmonitored.map((k) => {
              const p = PROCESSES.find((x) => x.key === k);
              return p ? p.label : k;
            });
            // The sparse-category note used to read "no Zabbix data on this day",
            // which read as "the whole day has no Zabbix data" — confusing, since
            // host CPU and the named processes ARE present on these days. Reworded
            // to make clear it's only THESE category items (BES/Elastic/OS Core)
            // that weren't yet collected — they were rolled out across Rimi prod
            // around 2026-05-09 and so pre-rollout days have no samples for them.
            const otherTooltip = unmonitoredLabels.length > 0
              ? `CPU consumed by processes we don't monitor by name (kernel, scheduler, services). Also includes ${unmonitoredLabels.join(", ")} — those Zabbix items were not yet deployed on this host on this day (BES/Elastic/OS Core rolled out across Rimi prod ~2026-05-09).`
              : "CPU consumed by processes we don't monitor by name (kernel, scheduler, services).";
            return (
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                <span style={{ fontSize: 11, color: "#475569", width: 64, textAlign: "right", flexShrink: 0, paddingTop: 0 }} title={otherTooltip}>Other</span>
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ flex: 1, height: 12, background: "#f1f3f5", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ height: "100%", borderRadius: 3, background: "#94a3b8", width: `${other}%`, transition: "width 0.2s ease" }} />
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 600, color: "#475569", width: 52, textAlign: "right", fontFamily: "'SF Mono','Cascadia Code',monospace", flexShrink: 0 }}>
                      {formatPct(other)}
                    </span>
                  </div>
                  {unmonitoredLabels.length > 0 && (
                    <div style={{ fontSize: 10, color: "#94a3b8", lineHeight: 1.3 }} title={otherTooltip}>
                      Includes {unmonitoredLabels.join(", ")} — not yet tracked on this day
                    </div>
                  )}
                </div>
              </div>
            );
          })()}
          {/* Data-quality banner (CPU normalisation spec §7.4): surfaces
              normalisation problems the operator would otherwise have to
              spot by eyeballing the stacked bar. */}
          {drillDataQuality && drillDataQuality.day !== "ok" && (
            <div
              role="status"
              style={{
                marginTop: 12,
                padding: "8px 12px",
                borderRadius: 6,
                border: `1px solid ${drillDataQuality.day === "fail" ? "#fecaca" : "#fde68a"}`,
                background: drillDataQuality.day === "fail" ? "#fef2f2" : "#fffbeb",
                color: drillDataQuality.day === "fail" ? "#b91c1c" : "#92400e",
                fontSize: 11,
                lineHeight: 1.4,
              }}
            >
              <strong style={{ fontWeight: 700 }}>
                {drillDataQuality.day === "fail" ? "✗ Data inconsistency: " : "⚠ Data quality: "}
              </strong>
              {drillDataQuality.day === "fail" ? (
                <>
                  Monitored categories sum exceeds host CPU by more than tolerance in {drillDataQuality.fail}
                  {" "}of {drillDataQuality.ok + drillDataQuality.warn + drillDataQuality.fail} slots.
                  Likely cause:{" "}
                  {drillCoresInfo && !drillCoresInfo.coresKnown
                    ? "CPU cores unknown for this host — per-counter values were not normalised."
                    : "normalisation problem or per-counter rounding."}{" "}
                  Fix: run <code>scripts/backfill-device-cpu-cores.mjs</code> or set <code>Device.cpuCores</code> manually in Settings → Devices.
                </>
              ) : drillCoresInfo && !drillCoresInfo.coresKnown ? (
                <>
                  CPU cores unknown for this host. Per-counter values were not normalised, so the breakdown may understate or overstate categories. Recommended action: run the cpu-cores backfill or set the value manually in Settings → Devices.
                </>
              ) : (
                <>
                  {/* "warn" day with isolated `fail` slots is the common
                      case after we tightened the day-level rollup threshold
                      (route.ts): we don't want to scream "fail" for one
                      transient overshoot, but the operator should still see
                      that some slot(s) tripped, with the count visible. */}
                  {drillDataQuality.fail > 0 ? (
                    <>
                      {drillDataQuality.fail} of {drillDataQuality.ok + drillDataQuality.warn + drillDataQuality.fail} slots briefly showed Σcategories &gt; host CPU (likely sampling alignment between system.cpu.util and per-process counters). The day&apos;s breakdown is broadly correct; isolated minutes may overshoot by a few percentage points.
                    </>
                  ) : (
                    <>
                      {drillDataQuality.warn} of {drillDataQuality.ok + drillDataQuality.warn + drillDataQuality.fail} slots have mild data-quality flags. The breakdown is broadly correct but specific slot values may be off by a few percentage points.
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    );
  })();

  // ═══ COMPARE SUB-VIEW ═══════════════════════════════════════════════
  // Short-circuit: when ?view=compare is set, render the Compare component
  // instead of the heatmap. The sub-view selector is rendered above either
  // path so the user can switch back without losing the URL context.
  if (subView === "compare") {
    return (
      <>
        <SubViewSelector value={subView} onChange={setSubView} />
        <RtCompareView pilot={pilot} zabbix={zabbix} />
      </>
    );
  }

  // ═══ NO DRILL ═══════════════════════════════════════════════════════
  if (!drill) {
    return (
      <>
        <SubViewSelector value={subView} onChange={setSubView} />
        {filterBar(false)}
        <h2 style={{ fontSize: 17, fontWeight: 600, color: "#212529", marginBottom: 4 }}>CPU Threshold Timeline</h2>
        <p style={{ fontSize: 13, color: "#868e96", marginBottom: 10 }}>
          {metric === "minAbove"
            ? `Heatmap: minutes per day with CPU ≥ ${threshold}% per machine. Click a cell to drill down.`
            : "Heatmap: peak CPU per machine per day. Click a cell to drill down."}
        </p>
        {metric === "minAbove" && cpuCountFrom === "active" && (
          <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 6, padding: "10px 14px", marginBottom: 10 }}>
            <p style={{ fontSize: 12, color: "#1e40af", margin: 0, lineHeight: 1.5 }}>
              <strong>Active-only heatmap.</strong> Each cell counts only minutes where the SCO
              was busy (<code>spss.cpu &gt; baseline + active threshold</code>) AND total CPU was
              above {threshold}%. Hosts without an spss.cpu signal show striped &ldquo;—&rdquo;
              cells — we can&rsquo;t classify activity without that signal. Switch to{" "}
              <strong>All tracked</strong> to count every minute above {threshold}% regardless of
              SCO activity (matches the historic Timeline behaviour).
            </p>
          </div>
        )}
        <div
          style={{
            position: "relative",
            transition: "opacity 200ms",
            opacity: isRefreshing ? 0.5 : 1,
            pointerEvents: isRefreshing ? "none" : undefined,
          }}
          aria-busy={isRefreshing || undefined}
        >
          {heatmapTable}
          {isRefreshing ? (
            <div
              role="status"
              aria-live="polite"
              style={{
                position: "absolute",
                top: 60,
                left: "50%",
                transform: "translateX(-50%)",
                opacity: 2, // counter the parent's 0.5 fade
                pointerEvents: "none",
                zIndex: 10,
              }}
            >
              <span
                title="Fetching Zabbix trends for the new period — typically 30–60 s on a cold cache."
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  color: "#1d4ed8",
                  background: "#eff6ff",
                  border: "1px solid #bfdbfe",
                  borderRadius: 999,
                  padding: "6px 14px",
                  boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
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
          ) : null}
        </div>
        <div style={{ background: "#eff6ff", borderRadius: 6, padding: "10px 14px", marginTop: 14 }}>
          <p style={{ fontSize: 12, color: "#1e40af", margin: 0 }}>
            <strong>How to use:</strong> Click any cell to open day drill-down. Search to filter hosts. Click column headers to sort. Drag the divider to resize.
          </p>
        </div>
        {hasTrendData ? (
          <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 6, padding: "8px 12px", marginTop: 10 }}>
            <p style={{ fontSize: 11, color: "#065f46", margin: 0 }}>
              <strong>✓ Live data:</strong> {zabbix.cpuTrends?.length || 0} daily CPU records from Zabbix history.get ({zabbix.status === "live" ? "LIVE" : "CACHED"}). Days without history shown as &ldquo;—&rdquo; (no data).
            </p>
          </div>
        ) : (
          <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6, padding: "8px 12px", marginTop: 10 }}>
            <p style={{ fontSize: 11, color: "#92400e", margin: 0 }}>
              <strong>⚠ Simulated:</strong> Heatmap extrapolated from current CPU snapshot ({zabbix.status === "live" ? "LIVE" : "CACHED"}).
            </p>
          </div>
        )}
        {/* Per-host "Process trend" card — daily CPU dynamics for a chosen
            process across 14 days, with Retellect ON/OFF day backgrounds.
            Rendered below the heatmap, default collapsed; expanding without a
            drilled host shows a prompt that points the user back to the
            heatmap. With a drilled host, fetches /api/rt/process-trend.
            Spec: project_rt_process_trend.md. */}
        <RtProcessTrend
          hostId={null}
          displayName={null}
          threshold={threshold}
          periodDays={periodDays}
        />
        {/* Process category reference — explains what items map to what
            category. Sits above the data-coverage banner because the user
            asks "what's in DB?" before "what data is missing?". */}
        <ProcessCategoryReference />
        {/* Data coverage banner moved to the page bottom — it's reference
            material, not something the user needs front-and-centre every visit. */}
        <div style={{ marginTop: 14 }}>
          <DataCoverageBanner
            title="Data coverage: timeline = daily peak; drill-down = real per-process history"
            available={(
              <>
                Daily peak CPU per host from <code>trends.get</code> (up to 14 d),
                live snapshot from <code>system.cpu.util[,,avg1]</code>. Drill-down
                uses real Zabbix <code>history.get</code> for per-process items
                (<code>python.cpu</code>, <code>spss.cpu</code>, <code>sql.cpu</code>,
                <code>vm.cpu</code>) plus <code>system.cpu.util</code> as a reference
                line.
              </>
            )}
            missing={(
              <>
                Per-mode breakdown (<code>system.cpu.util[,user]</code>,
                <code> [,system]</code>, <code>[,iowait]</code>) is not yet ingested.
                Note: timeline cell shows <em>instantaneous daily max</em>, drill-down
                bars show <em>hourly average per process</em> — they will not match
                numerically. The black tick on each bar is the real
                <code>system.cpu.util</code> per-slot max for direct comparison.
              </>
            )}
            footer={(
              <>
                &ldquo;Days without history&rdquo; — host exists, but <code>trends.get</code>
                returned no value for that day (agent down, proxy lag, or retention
                limits). Use the <strong>Data Health</strong> tab to analyse wide gaps.
              </>
            )}
          />
        </div>
      </>
    );
  }

  // ═══ WITH DRILL ═══════════════════════════════════════════════════
  return (
    <>
    <SubViewSelector value={subView} onChange={setSubView} />
    <div ref={split.containerRef} style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 200px)", minHeight: 500, marginBottom: -24 }}>
      {/* TOP PANE */}
      <div style={{ height: split.splitPx, minHeight: 120, overflow: "auto", flexShrink: 0 }}>
        {filterBar(true)}
        <div
          style={{
            position: "relative",
            transition: "opacity 200ms",
            opacity: isRefreshing ? 0.5 : 1,
            pointerEvents: isRefreshing ? "none" : undefined,
          }}
          aria-busy={isRefreshing || undefined}
        >
          {heatmapTable}
          {isRefreshing ? (
            <div
              role="status"
              aria-live="polite"
              style={{
                position: "absolute",
                top: 60,
                left: "50%",
                transform: "translateX(-50%)",
                opacity: 2, // counter the parent's 0.5 fade
                pointerEvents: "none",
                zIndex: 10,
              }}
            >
              <span
                title="Fetching Zabbix trends for the new period — typically 30–60 s on a cold cache."
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  color: "#1d4ed8",
                  background: "#eff6ff",
                  border: "1px solid #bfdbfe",
                  borderRadius: 999,
                  padding: "6px 14px",
                  boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
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
          ) : null}
        </div>
      </div>

      {/* DRAG DIVIDER */}
      <div onMouseDown={split.onMouseDown} style={{
        height: 8, display: "flex", alignItems: "center", justifyContent: "center",
        cursor: "row-resize", background: "#f1f3f5",
        borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}`,
        userSelect: "none", flexShrink: 0,
      }}>
        <div style={{ width: 48, height: 3, borderRadius: 2, background: "#adb5bd" }} />
      </div>

      {/* BOTTOM PANE: Drill-down */}
      <div style={{ flex: 1, minHeight: 200, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Header */}
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "8px 16px", background: "#fff", borderBottom: `1px solid ${C.border}`, flexShrink: 0,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: "#212529", margin: 0 }}>Day drill-down: {drill.date}</h3>
            <span style={{
              fontSize: 11, padding: "2px 8px", borderRadius: 10, fontWeight: 600,
              background: drill.peak >= 90 ? C.criticalBg : drill.peak >= 80 ? C.highBg : drill.peak >= threshold ? C.thresholdBg : C.belowBg,
              color: drill.peak >= threshold ? "#fff" : C.belowText,
            }}>{drill.peak}%</span>
            <span
              style={{ fontSize: 12, color: C.textSec, fontFamily: "monospace" }}
              title={drill.sourceHostKey}
            >
              {drill.displayName}
              {drill.sourceHostKey && drill.sourceHostKey !== drill.displayName && (
                <span style={{ fontSize: 10, marginLeft: 6, color: "#94a3b8", fontFamily: "inherit" }}>
                  · {drill.sourceHostKey}
                </span>
              )}
            </span>
            {drillResources && (() => {
              // Prefer the cores number the SERVER actually used to normalise
              // this response (drillCoresInfo) over the client-side row count.
              // They should match in the happy path; when they don't (e.g.
              // the row had no cores but the server fell back to a cached
              // value), the server reading is the source of truth for what
              // the displayed numbers mean.
              const usedCores = drillCoresInfo?.cores ?? drillResources.cores;
              const coresKnown = drillCoresInfo ? drillCoresInfo.coresKnown : usedCores > 0;
              const sourceLabel =
                drillCoresInfo?.coresSource === "zabbix" ? "live from Zabbix"
                : drillCoresInfo?.coresSource === "manual" ? "manual override"
                : drillCoresInfo?.coresSource === "inferred_from_model" ? "inferred from CPU model"
                : "unknown source";
              // Short inline source tag — surfaced in the header so screenshots
              // and shared links convey not just *how many* cores were used to
              // normalise the stack, but *where that number came from*. We
              // discovered that "4 cores" alone was ambiguous: live Zabbix
              // returning the wrong value vs. the manual override sticking
              // both render identically without this hint.
              const sourceTag =
                drillCoresInfo?.coresSource === "zabbix" ? "zbx"
                : drillCoresInfo?.coresSource === "manual" ? "manual"
                : drillCoresInfo?.coresSource === "inferred_from_model" ? "infer"
                : "?";
              return (
                <span
                  style={{ fontSize: 11, color: coresKnown ? "#adb5bd" : "#b91c1c", fontWeight: coresKnown ? 400 : 600 }}
                  title={
                    coresKnown
                      ? `${usedCores} cores (${sourceLabel}) · ${drillResources.totalRamGb} GB RAM`
                      : "CPU cores unknown for this host. Per-counter values are NOT normalised; stacked bar may be misleading."
                  }
                >
                  {coresKnown
                    ? <>{usedCores} cores <span style={{ color: drillCoresInfo?.coresSource === "manual" ? "#7c3aed" : "#94a3b8", fontSize: 10 }}>({sourceTag})</span></>
                    : `?c⚠`} · {drillResources.totalRamGb} GB · {drillResources.deviceType}
                </span>
              );
            })()}
          </div>
          {/* Tab pills removed 2026-04-28 — the only meaningful view is the
              process breakdown. The Resource Utilization tab was a placeholder
              for hourly RAM/disk history that never landed; bringing it back
              would mean re-adding both the pill and the empty-state copy. */}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button onClick={() => { setDrill(null); setSelectedSlot(null); }} style={{ fontSize: 11, padding: "4px 10px", border: "1px solid #dee2e6", borderRadius: 6, background: "#fff", color: "#495057", cursor: "pointer" }}>Close ✕</button>
          </div>
        </div>

        {/* Day summary banner removed 2026-04-28 to give the chart more
            vertical room. The host-peak callout already on the chart covers
            "Day max at HH:MM"; the "Min ≥ threshold" count moved into the
            legend row at the bottom of the chart so it stays visible without
            claiming its own band of pixels. */}

        <div style={{ flex: 1, padding: "16px 20px", background: "#fafbfc", overflow: "auto" }}>
          {drillTab === "process" && drillLoading && (
            <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center" }}>
              <div style={{ fontSize: 12, color: C.textSec }}>Loading process history…</div>
            </div>
          )}
          {drillTab === "process" && !drillLoading && (!drillIntervals || drillIntervals.length === 0) && (
            <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center" }}>
              <div style={{ background: "#fff", border: `1px dashed ${C.border}`, borderRadius: 8, padding: "24px 28px", maxWidth: 560, textAlign: "center" }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#495057", marginBottom: 6 }}>No per-process CPU history</div>
                <div style={{ fontSize: 11, color: C.textSec, lineHeight: 1.6 }}>
                  This host has not published <code style={{ fontSize: 10, background: "#f1f3f5", padding: "0 4px", borderRadius: 3 }}>python.cpu</code> / <code style={{ fontSize: 10, background: "#f1f3f5", padding: "0 4px", borderRadius: 3 }}>spss.cpu</code> / <code style={{ fontSize: 10, background: "#f1f3f5", padding: "0 4px", borderRadius: 3 }}>sql.cpu</code> / <code style={{ fontSize: 10, background: "#f1f3f5", padding: "0 4px", borderRadius: 3 }}>vm.cpu</code> samples in the last 24h.
                </div>
              </div>
            </div>
          )}
          {drillTab === "process" && drillIntervals && (
            <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
              {/* Granularity selector removed 2026-04-28 — 1min is the agent's
                  native sample rate, so it's the only resolution that doesn't
                  alias. The state still exists (default 1) for the API call;
                  we just stopped exposing it as a control. */}

              {/* Chart — host CPU line + reference levels + peak marker + selection cursor.
                  Process breakdown for the selected moment lives in the panel below; we
                  don't paint it on the chart because at low percentages it becomes a flat
                  invisible smear next to the host CPU line. */}
              <div style={{
                flex: 1, minHeight: 100, position: "relative",
                // Soft tinted background so the line stands out against the
                // page chrome and the chart area is visually distinct from
                // the controls above and the detail panel below.
                background: "linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%)",
                border: `1px solid ${C.border}`,
                borderRadius: 6,
              }}>
                {/* Reference grid: 100% ceiling, 70% threshold, 0% baseline. */}
                <div aria-hidden style={{
                  position: "absolute", left: 0, right: 0, top: 0,
                  borderTop: "1px dashed #d0d7de", pointerEvents: "none", zIndex: 1,
                }}>
                  <span style={{
                    position: "absolute", right: 0, top: -1,
                    fontSize: 9, color: "#94a3b8", background: "transparent",
                    padding: "0 4px", transform: "translateY(-50%)",
                  }}>100%</span>
                </div>
                <div aria-hidden style={{
                  position: "absolute", left: 0, right: 0, top: "30%",
                  borderTop: "1px dashed #fcd34d", pointerEvents: "none", zIndex: 1,
                }}>
                  <span style={{
                    position: "absolute", right: 0, top: -1,
                    fontSize: 9, color: "#a16207", background: "transparent",
                    padding: "0 4px", transform: "translateY(-50%)",
                  }}>70%</span>
                </div>
                <div aria-hidden style={{
                  position: "absolute", left: 0, right: 0, bottom: 0,
                  borderTop: "1px dashed #d0d7de", pointerEvents: "none", zIndex: 1,
                }}>
                  <span style={{
                    position: "absolute", right: 0, top: -1,
                    fontSize: 9, color: "#94a3b8", background: "transparent",
                    padding: "0 4px", transform: "translateY(-50%)",
                  }}>0%</span>
                </div>

                {/* SVG: host CPU line (max as solid, avg as dashed) + selection cursor + peak dot. */}
                {(() => {
                  const N = drillIntervals.length;
                  if (N === 0) return null;
                  const W = 1000, H = 100;
                  const xAt = (i: number) => N > 1 ? (i / (N - 1)) * W : W / 2;
                  const sysMaxPts = drillIntervals
                    .map((s, i) => s.sysCpuMax !== null ? `${xAt(i).toFixed(2)},${(H - Math.min(100, s.sysCpuMax)).toFixed(2)}` : null)
                    .filter((p): p is string => p !== null)
                    .join(" ");
                  const sysAvgPts = drillIntervals
                    .map((s, i) => s.sysCpuAvg !== null ? `${xAt(i).toFixed(2)},${(H - Math.min(100, s.sysCpuAvg)).toFixed(2)}` : null)
                    .filter((p): p is string => p !== null)
                    .join(" ");
                  const peakIdx = peakSlot ? drillIntervals.findIndex((s) => s.slot === peakSlot.slot) : -1;
                  const peakValue = peakSlot?.sysCpuMax ?? 0;
                  const selIdx = selectedSlot !== null ? drillIntervals.findIndex((s) => s.slot === selectedSlot) : -1;
                  return (
                    <svg
                      aria-hidden
                      viewBox={`0 0 ${W} ${H}`}
                      preserveAspectRatio="none"
                      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 2 }}
                    >
                      {selIdx >= 0 && (
                        <line
                          x1={xAt(selIdx)} y1={0} x2={xAt(selIdx)} y2={H}
                          stroke="#0070c9" strokeWidth="1.2" opacity="0.85"
                          vectorEffect="non-scaling-stroke"
                        />
                      )}
                      {sysAvgPts && (
                        <polyline
                          points={sysAvgPts}
                          fill="none"
                          stroke="#94a3b8"
                          strokeWidth="0.8"
                          strokeDasharray="3 2"
                          opacity="0.7"
                          vectorEffect="non-scaling-stroke"
                        />
                      )}
                      {sysMaxPts && (
                        <polyline
                          points={sysMaxPts}
                          fill="none"
                          stroke="#0f172a"
                          strokeWidth="1.6"
                          vectorEffect="non-scaling-stroke"
                        />
                      )}
                      {peakIdx >= 0 && peakValue > 0 && (
                        <circle cx={xAt(peakIdx)} cy={H - Math.min(100, peakValue)} r="3" fill="#ef4444" />
                      )}
                    </svg>
                  );
                })()}
                {/* Peak label (host CPU). Absolute-positioned HTML so the
                    text isn't stretched by SVG preserveAspectRatio="none". */}
                {peakSlot && (peakSlot.sysCpuMax ?? 0) > 0 && (() => {
                  const idx = drillIntervals.findIndex((s) => s.slot === peakSlot.slot);
                  if (idx < 0) return null;
                  const N = drillIntervals.length;
                  const xPct = N > 1 ? (idx / (N - 1)) * 100 : 50;
                  const peakValue = peakSlot.sysCpuMax ?? 0;
                  return (
                    <span style={{
                      position: "absolute",
                      left: `${xPct}%`,
                      bottom: `calc(${Math.min(100, peakValue)}% + 8px)`,
                      transform: "translateX(-50%)",
                      fontSize: 10, fontWeight: 700, color: "#fff",
                      background: "#ef4444", padding: "1px 6px",
                      borderRadius: 3, whiteSpace: "nowrap", letterSpacing: 0.3,
                      zIndex: 3, pointerEvents: "none",
                    }}>
                      Host peak {Math.round(peakValue)}% at {peakSlot.label}
                    </span>
                  );
                })()}

                {/* Click targets — full-height transparent strips per slot. */}
                <div style={{ position: "absolute", inset: 0, display: "flex", gap: 0, alignItems: "stretch", zIndex: 5 }}>
                  {drillIntervals.map((rawSlot) => {
                    const s = normalizeSlot(rawSlot);
                    const isSelected = selectedSlot === s.slot;
                    const sysMax = rawSlot.sysCpuMax;
                    const sysAvg = rawSlot.sysCpuAvg;
                    const tot =
                      s.retellect + s.scoApp + s.db + s.system
                      + s.besclient + s.elastic + s.osCore;
                    return (
                      <div key={s.slot}
                        onClick={() => {
                          if (isSelected) {
                            setSelectedSlot(null);
                            userClearedSelectionRef.current = true;
                          } else {
                            setSelectedSlot(s.slot);
                            userClearedSelectionRef.current = false;
                          }
                        }}
                        style={{
                          flex: "1 1 0%", cursor: "pointer", position: "relative",
                          background: isSelected ? "rgba(0,112,201,0.06)" : "transparent",
                        }}
                        title={`${s.label}\nHost CPU: ${sysMax !== null ? Math.round(sysMax) + "% (max)" : "—"}${sysAvg !== null ? " · " + Math.round(sysAvg) + "% (avg)" : ""}\nMonitored processes: ${Math.round(tot)}%  (Retellect ${Math.round(s.retellect)}% · SCO ${Math.round(s.scoApp)}% · DB ${Math.round(s.db)}% · System ${Math.round(s.system)}% · BESClient ${Math.round(s.besclient)}% · Elastic ${Math.round(s.elastic)}% · OS Core ${Math.round(s.osCore)}%)`}
                      />
                    );
                  })}
                </div>
              </div>

              {/* Time axis — fixed hour markers (00 → 24). Independent of slot
                  granularity, so the day's structure is always readable. */}
              <div style={{ position: "relative", height: 18, marginTop: 2, flexShrink: 0 }}>
                {Array.from({ length: 25 }, (_, h) => {
                  const xPct = (h / 24) * 100;
                  const showLabel = granularity === 60 ? true : h % 2 === 0;
                  return (
                    <div key={h} aria-hidden style={{
                      position: "absolute",
                      left: `${xPct}%`,
                      top: 0,
                      transform: "translateX(-50%)",
                      display: "flex", flexDirection: "column", alignItems: "center",
                    }}>
                      <div style={{ width: 1, height: 4, background: "#cbd5e1" }} />
                      {showLabel && (
                        <span style={{ fontSize: 9, color: "#94a3b8", marginTop: 1, fontVariantNumeric: "tabular-nums" }}>
                          {String(h).padStart(2, "0")}
                        </span>
                      )}
                    </div>
                  );
                })}
                {selectedSlot !== null && (() => {
                  const idx = drillIntervals.findIndex((s) => s.slot === selectedSlot);
                  if (idx < 0) return null;
                  const N = drillIntervals.length;
                  const xPct = N > 1 ? (idx / (N - 1)) * 100 : 50;
                  return (
                    <span style={{
                      position: "absolute",
                      left: `${xPct}%`,
                      top: 6,
                      transform: "translateX(-50%)",
                      fontSize: 9, fontWeight: 700, color: "#0070c9",
                      background: "#fff", padding: "0 4px",
                      borderRadius: 3, fontVariantNumeric: "tabular-nums",
                      boxShadow: "0 0 0 1px #bfdbfe",
                    }}>
                      {drillIntervals[idx].label}
                    </span>
                  );
                })()}
              </div>

              {/* Hour detail panel */}
              {hourDetailPanel}

              {/* Legend + peak info */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: selSlotData ? 8 : 10, flexShrink: 0 }}>
                <div style={{ display: "flex", gap: 14, fontSize: 12, color: C.textSec, flexWrap: "wrap", alignItems: "center", flex: 1 }}>
                  {PROCESSES.map(({ color, label, border: b }) => (
                    <span key={label} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <span style={{ width: 12, height: 10, borderRadius: 2, background: color, display: "inline-block", ...(b ? { border: "1px solid #c3dafe" } : {}) }} />{label}
                    </span>
                  ))}
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }} title="system.cpu.util[,,avg1] per slot — overall host CPU including processes not tracked by name">
                    <span style={{ width: 12, height: 0, borderTop: "2px solid #0f172a", display: "inline-block" }} />
                    Host CPU max
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: 4, opacity: 0.6 }}>
                    <span style={{ width: 12, height: 0, borderTop: "1px dashed #0f172a", display: "inline-block" }} />
                    Host CPU avg
                  </span>
                  {/* Day-level numbers tucked into the legend row so they
                      remain glanceable without spending a full banner row.
                      Source: same `daySummary` that used to feed the banner. */}
                  {daySummary && (() => {
                    // Map the active threshold to its matching bucket. Buckets
                    // mirror the threshold dropdown (50/60/70/80/90) plus a 95
                    // cap. We pick the EXACT bucket here — not a
                    // "close enough" fallback — because the legend reads the
                    // value as `Min ≥ {threshold}%`, and showing the t70 count
                    // when the user picked 80 silently understated severity
                    // (saw 0 minutes ≥ 70 → painted host as quiet) before the
                    // fix.
                    const minAboveActive =
                      threshold >= 95 ? daySummary.minutesAbove.t95
                      : threshold >= 90 ? daySummary.minutesAbove.t90
                      : threshold >= 80 ? daySummary.minutesAbove.t80
                      : threshold >= 70 ? daySummary.minutesAbove.t70
                      : threshold >= 60 ? daySummary.minutesAbove.t60
                      : daySummary.minutesAbove.t50;
                    return (
                      <span style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto", color: C.textSec }}>
                        <span style={{ fontSize: 11 }}>
                          Day max <strong style={{ color: daySummary.maxValue >= 90 ? "#dc2626" : daySummary.maxValue >= 70 ? "#d97706" : "#212529" }}>{daySummary.maxValue}%</strong>
                          <span style={{ color: "#94a3b8" }}> at {daySummary.maxLabel}</span>
                        </span>
                        <span style={{ color: "#cbd5e1" }}>·</span>
                        <span style={{ fontSize: 11 }}>
                          Min ≥ {threshold}% <strong style={{ color: minAboveActive > 0 ? "#212529" : "#adb5bd", fontVariantNumeric: "tabular-nums" }}>{minAboveActive}</strong>
                        </span>
                      </span>
                    );
                  })()}
                </div>
                {!selSlotData && peakSlot && (
                  <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6, padding: "4px 12px" }}>
                    <span style={{ fontSize: 12, color: "#92400e" }}>
                      <strong>Process activity peak:</strong> {peakSlotNorm ? Math.round(
                        peakSlotNorm.retellect + peakSlotNorm.scoApp + peakSlotNorm.db + peakSlotNorm.system
                        + peakSlotNorm.besclient + peakSlotNorm.elastic + peakSlotNorm.osCore
                      ) : 0}% at {peakSlot.label} · Retellect ~{peakSlotNorm ? Math.round(peakSlotNorm.retellect) : 0}% · Headroom ~{peakSlotNorm ? Math.round(peakSlotNorm.free) : 0}%
                    </span>
                    <span style={{ fontSize: 10, color: "#a16207", marginLeft: 8, fontStyle: "italic" }}>
                      ({granularity}min avg — timeline cell shows daily instantaneous max)
                    </span>
                  </div>
                )}
                {selSlotData && (
                  <button onClick={() => { setSelectedSlot(null); userClearedSelectionRef.current = true; }} style={{
                    fontSize: 11, padding: "3px 10px", border: "1px solid #dee2e6", borderRadius: 5,
                    background: "#fff", color: "#495057", cursor: "pointer",
                  }}>Clear selection</button>
                )}
              </div>

              {!selSlotData && (
                <div style={{ fontSize: 11, color: "#adb5bd", marginTop: 6, textAlign: "center", flexShrink: 0 }}>
                  Click a bar to see process breakdown for that {granularity >= 60 ? "hour" : "interval"}
                </div>
              )}
            </div>
          )}

          {/* Resource Utilization tab removed 2026-04-28; only the process
              breakdown view remains. `drillResources` is still derived above
              for the host badge in the header (cores/RAM/type), so we keep
              the memo, just not the tab body. */}
        </div>
      </div>
    </div>
    {/* Per-host "Process trend" card — rendered OUTSIDE the split-pane so the
        existing top/bottom drag layout stays intact. The card is bound to the
        drill state (drill.hostId), so the user sees their just-clicked host's
        14-day trend without a second selector. Default collapsed; expanding
        triggers a /api/rt/process-trend fetch. Spec: project_rt_process_trend.md. */}
    <RtProcessTrend
      hostId={drill.hostId}
      sourceHostKey={drill.sourceHostKey}
      displayName={drill.displayName}
      threshold={threshold}
      periodDays={periodDays}
    />
    </>
  );
}

// ─── Sub-view selector ────────────────────────────────────────────────
//
// Top-of-tab segmented control that flips between the existing per-day
// Heatmap and the new "Compare periods" sub-view. Lives at the top so it
// stays visible across drill-down states. Visual language matches the
// FilterSegmented buttons used elsewhere in rt/, but it's kept as a
// dedicated component to avoid leaking sub-view state into the shared
// filter primitives. Spec: docs/specs/cpu-timeline-compare-periods-spec.md §4.1.
function SubViewSelector({
  value,
  onChange,
}: {
  value: "heatmap" | "compare";
  onChange: (v: "heatmap" | "compare") => void;
}) {
  const baseBtn: React.CSSProperties = {
    padding: "5px 14px",
    fontSize: 12,
    fontWeight: 500,
    border: "1px solid #e2e8f0",
    background: "#fff",
    color: "#0f172a",
    cursor: "pointer",
  };
  const activeBtn: React.CSSProperties = {
    ...baseBtn,
    background: "#0f172a",
    color: "#fff",
    borderColor: "#0f172a",
  };
  return (
    <div style={{ display: "inline-flex", marginBottom: 12, borderRadius: 6, overflow: "hidden", boxShadow: "0 1px 0 rgba(15,23,42,0.04)" }}>
      <button
        type="button"
        aria-pressed={value === "heatmap"}
        style={{ ...(value === "heatmap" ? activeBtn : baseBtn), borderTopRightRadius: 0, borderBottomRightRadius: 0, borderRight: "none" }}
        onClick={() => onChange("heatmap")}
      >
        Heatmap
      </button>
      <button
        type="button"
        aria-pressed={value === "compare"}
        style={{ ...(value === "compare" ? activeBtn : baseBtn), borderTopLeftRadius: 0, borderBottomLeftRadius: 0 }}
        onClick={() => onChange("compare")}
      >
        Compare periods
      </button>
    </div>
  );
}
