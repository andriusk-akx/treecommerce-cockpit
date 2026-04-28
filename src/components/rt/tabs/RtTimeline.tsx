"use client";

import type { ReactElement } from "react";
import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import type { RtPilotData, ZabbixData, ZabbixCpuTrend } from "../RtPilotWorkspace";
import { generateIntervalData, type IntervalSlot } from "./rt-timeline-math";
import { DataCoverageBanner } from "./DataCoverageBanner";
import { ProcessCategoryReference } from "./ProcessCategoryReference";
import { useRtFilters } from "../RtFiltersContext";
import { resolveCpuModel } from "./rt-inventory-helpers";

// Heatmap is a per-DAY peak view, so periods shorter than 1 day make no sense.
// Trend retention on this Zabbix is ~5–7 days for trend.get and 14 days for
// raw history.get — anything longer would be empty cells, so we cap at 14d.
// Custom is kept for ad-hoc shorter windows (e.g. last 3 d).
const PERIODS = [
  { id: "14d", label: "14d", days: 14 },
] as const;

// 1m default — agent already samples every minute, so no info loss.
// 5m / 15m smooth out short spikes; 1h shows the broadest pattern.
const GRANULARITIES = [
  { id: 1, label: "1min", slots: 1440 },
  { id: 5, label: "5min", slots: 288 },
  { id: 15, label: "15min", slots: 96 },
  { id: 60, label: "1h", slots: 24 },
] as const;

const C = {
  belowBg: "#e0effe", belowText: "#868e96",
  thresholdBg: "#fbbf24", highBg: "#f59f00", criticalBg: "#ef4444", exceededText: "#fff",
  retellect: "#fa5252", scoApp: "#f59f00", db: "#9775fa", system: "#0c8feb", free: "#e0effe",
  pillActive: "#0070c9", border: "#e9ecef", headerBg: "#f1f3f5", headerText: "#868e96",
  textSec: "#6c757d", okGreen: "#059669",
  riskRedBg: "#fef2f2", riskRedText: "#b91c1c",
  riskAmberBg: "#fffbeb", riskAmberText: "#b45309", riskGrayBg: "#f1f3f5",
  zebraOdd: "#fafbfc",
} as const;

const DEVICE_COLORS: Record<string, { bg: string; text: string }> = {
  SCO: { bg: "#dbeafe", text: "#1e40af" },
  POS: { bg: "#fef3c7", text: "#92400e" },
  SERVER: { bg: "#e0e7ff", text: "#3730a3" },
  DEFAULT: { bg: "#f3f4f6", text: "#4b5563" },
};

const PROCESSES = [
  { key: "retellect" as const, label: "Retellect", color: C.retellect },
  { key: "scoApp" as const, label: "SCO App", color: C.scoApp },
  { key: "db" as const, label: "DB (SQL)", color: C.db },
  { key: "system" as const, label: "System", color: C.system },
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
  const setPeriod = (v: string) => setFilter("period", v);
  const storeFilter = filters.store;
  const setStoreFilter = (v: string) => setFilter("store", v);
  const cpuModelFilter = filters.cpuModel;
  const setCpuModelFilter = (v: string) => setFilter("cpuModel", v);
  const search = filters.search;
  const granularity = filters.granularity;
  const setGranularity = (v: number) => setFilter("granularity", v);
  const retellectInstalled = filters.retellectInstalled;
  const setRetellectInstalled = (v: boolean | null) => setFilter("retellectInstalled", v);
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
  // (custom-granularity state removed — only fixed presets are exposed now.)
  const [customPeriodDays, setCustomPeriodDays] = useState<string>("");
  const [showCustomPeriod, setShowCustomPeriod] = useState(false);

  // Real per-process history fetched when user drills into a host.
  // Categories: retellect (sum python*.cpu), scoApp (spss), db (sql), system (vm).
  // sysCpuAvg/sysCpuMax: overall system.cpu.util[,,avg1] for the same slot,
  //   shown as a reference line above the per-process bars (per-process sum
  //   only counts monitored processes, while system.cpu.util counts everything).
  type ProcessSlot = {
    slot: number; hourKey: string; hour: number; minute: number; label: string;
    retellect: number; scoApp: number; db: number; system: number; free: number;
    sysCpuAvg: number | null; sysCpuMax: number | null;
  };
  const [drillIntervals, setDrillIntervals] = useState<ProcessSlot[] | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);
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
    minutesAbove: { t50: number; t70: number; t90: number; t95: number };
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

  const { zabbixByName, cpuDetail, trendByHostDate, retellectByHost } = useMemo(() => {
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
    return { zabbixByName: byName, cpuDetail: detail, trendByHostDate: trendMap, retellectByHost: rtMap };
  }, [zabbix]);

  // Match Overview's thresholds so the two tabs stay consistent.
  const RT_FRESH_MS = 5 * 60 * 1000;     // 5 min — same as RT_FRESHNESS_THRESHOLD_SEC
  const RT_CPU_THRESHOLD = 1.0;          // > 1% — filters out residual noise

  const hasTrendData = (zabbix.cpuTrends?.length || 0) > 0;

  const allHostRows = useMemo(() => {
    return pilot.devices
      .filter((d) => storeFilter === "all" || d.storeName === storeFilter)
      .map((device, idx) => {
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
        if (zHost && hasTrendData) {
          const hostTrends = trendByHostDate.get(zHost.hostId);
          dayTrends = dates.map((d) => {
            const dateStr = d.toLocaleDateString("en-CA", { timeZone: "Europe/Vilnius" });
            return hostTrends?.get(dateStr) ?? null;
          });
          peaks = dayTrends.map((t) => t ? t.max : null);
        } else {
          peaks = Array<number | null>(days).fill(null);
          dayTrends = Array<ZabbixCpuTrend | null>(days).fill(null);
        }
        // Aggregate sample-level minute counts across the visible period.
        // `minutesAbove` and `totalMinutes` are the new exceedance metric:
        // they tell the user "of N minutes we have data for, X were above
        // the threshold". `exceedDays` is kept as a fallback for hosts that
        // only have trend.get coverage (no raw 1-min samples available).
        const thKey = (threshold >= 90 ? 90 : threshold >= 80 ? 80 : threshold >= 70 ? 70 : threshold >= 60 ? 60 : 50) as 50 | 60 | 70 | 80 | 90;
        let minutesAbove = 0;
        let totalMinutes = 0;
        for (const t of dayTrends) {
          if (!t) continue;
          if (t.minutesAbove) minutesAbove += t.minutesAbove[thKey] ?? 0;
          if (typeof t.totalSamples === "number") totalMinutes += t.totalSamples;
        }
        const exceedDays = peaks.filter((p): p is number => p !== null && p >= threshold).length;
        // Live Retellect signal — same definition as RtOverview: python.cpu items
        // fresh (<5 min) AND CPU% > 1.0. We capture this on the row so the
        // filter, sort, and the column dot all switch from DB flag to telemetry.
        const rt = zHost ? retellectByHost.get(zHost.hostId) : undefined;
        const nowMs = Date.now();
        const rtFresh = !!rt && rt.freshestMs > 0 && (nowMs - rt.freshestMs) < RT_FRESH_MS;
        const rtActive = rtFresh && (rt?.cpuTotal ?? 0) > RT_CPU_THRESHOLD;
        // TODO(RT-CPUMODEL): once phase 2 backfills Device.cpuModel, the DB
        // value will always win; until then we prefer Zabbix inventory so the
        // CPU column and "Group by CPU model" both have something useful.
        const resolvedCpuModel = resolveCpuModel(device.cpuModel, zHost?.inventory?.cpuModel ?? null);
        return { name: device.name, storeName: device.storeName || "(unknown store)", cpuModel: resolvedCpuModel, deviceType: device.deviceType || "—", retellectEnabled: !!device.retellectEnabled, rtActive, currentCpu: Math.round(cpuTotal * 10) / 10, cores: detail?.numCpus || 0, ramGb: device.ramGb, hasMatch: !!zHost, zHost, peaks, dayTrends, exceedDays, minutesAbove, totalMinutes };
      });
  }, [pilot, zabbixByName, cpuDetail, trendByHostDate, retellectByHost, storeFilter, threshold, periodDays, dates, hasTrendData]);

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
    if (retellectInstalled !== null) {
      // Hot-fix 2026-04-28: telemetry-based filter, not DB flag.
      // See RT-BACKFILL backlog item — when DB.retellectEnabled is repopulated
      // from telemetry, switch back to `r.retellectEnabled === retellectInstalled`
      // to also surface "should be running but isn't" hosts.
      rows = rows.filter((r) => r.rtActive === retellectInstalled);
    }
    if (cpuModelFilter !== "all") {
      rows = rows.filter((r) => r.cpuModel === cpuModelFilter);
    }
    return [...rows].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "name") cmp = a.name.localeCompare(b.name);
      else if (sortKey === "store") cmp = a.storeName.localeCompare(b.storeName);
      else if (sortKey === "rt") cmp = (a.rtActive ? 1 : 0) - (b.rtActive ? 1 : 0);
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
  }, [allHostRows, search, retellectInstalled, cpuModelFilter, sortKey, sortDir]);

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

  // Aggregate across CURRENTLY VISIBLE rows (after every filter is applied).
  // Sums minutes above the chosen threshold across the selection so the user
  // sees, in one number, how much of their filtered fleet time was hot.
  const filteredAggregate = useMemo(() => {
    let totalAbove = 0;
    let totalSampled = 0;
    let hostsWithData = 0;
    for (const r of hostRows) {
      if (r.totalMinutes > 0) {
        totalAbove += r.minutesAbove;
        totalSampled += r.totalMinutes;
        hostsWithData += 1;
      }
    }
    const pct = totalSampled > 0 ? (totalAbove / totalSampled) * 100 : 0;
    return { totalAbove, totalSampled, hostsWithData, pct };
  }, [hostRows]);

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
    if (!drill) { setDrillIntervals(null); setDaySummary(null); return; }
    // Drill carries the unambiguous Zabbix host id (set when the cell was
    // clicked). Multiple devices can share the same display name across stores
    // (e.g. "SCO2" in 8 stores), so we never resolve by name here.
    setDrillLoading(true);
    const isoDate = `${drill.dateObj.getFullYear()}-${String(drill.dateObj.getMonth() + 1).padStart(2, "0")}-${String(drill.dateObj.getDate()).padStart(2, "0")}`;
    fetch(`/api/rt/process-history?hostId=${drill.hostId}&date=${isoDate}&granularity=${granularity}`)
      .then((r) => r.json())
      .then((d) => {
        setDrillIntervals(Array.isArray(d.slots) ? d.slots : null);
        setDaySummary(d.daySummary ?? null);
      })
      .catch(() => { setDrillIntervals(null); setDaySummary(null); })
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
    return {
      ...raw,
      retellect: r,
      scoApp: sa,
      db: dbv,
      system: sys,
      free: Math.max(0, 100 - r - sa - dbv - sys),
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
    if (drill?.date === newDate && drill?.hostId === hostId) { setDrill(null); setSelectedSlot(null); return; }
    setDrill({ date: newDate, dateObj: date, hostId, displayName, sourceHostKey, peak });
    setDrillTab("process");
    setSelectedSlot(null);
  }, [drill]);

  // Keyboard navigation: ←/→ moves the cursor across the day, Home/End jump to
  // the edges, Esc clears the selection. If nothing is selected yet, ← starts
  // at the peak (most informative), → at the start of the day.
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
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drill, drillIntervals, drillTab, peakSlot]);

  const sortArrow = (key: SortKey) => sortKey === key ? (sortDir === "desc" ? " ↓" : " ↑") : "";

  const typeBadge = (type: string) => {
    const t = type.toUpperCase();
    const colors = DEVICE_COLORS[t] || DEVICE_COLORS.DEFAULT;
    return (
      <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, background: colors.bg, color: colors.text, fontWeight: 600, letterSpacing: 0.3, whiteSpace: "nowrap" }}>
        {t}
      </span>
    );
  };

  const statsBar = (() => {
    // "Selection filtered" = at least one filter is non-default; in that case
    // we surface a separate aggregate showing the chosen subset's combined
    // minute count and percentage, so the user immediately sees how the slice
    // they picked behaved.
    const filtered = storeFilter !== "all" || cpuModelFilter !== "all" || retellectInstalled !== null || search !== "";
    const aggFmt = (n: number) => n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
    const aggPctText = filteredAggregate.pct >= 10
      ? `${Math.round(filteredAggregate.pct)}%`
      : filteredAggregate.pct >= 1
        ? `${filteredAggregate.pct.toFixed(1)}%`
        : filteredAggregate.pct > 0
          ? `${filteredAggregate.pct.toFixed(2)}%`
          : "0%";
    const aggColor = filteredAggregate.pct >= 5 ? C.riskRedText
      : filteredAggregate.pct >= 1 ? C.riskAmberText
      : "#475569";
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 11, color: C.textSec, padding: "4px 0", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600, color: "#212529" }}>{stats.total} hosts</span>
        {stats.noData > 0 && <span style={{ color: "#adb5bd" }}>● {stats.noData} no data</span>}
        {filtered && <span style={{ color: C.pillActive }}>→ {hostRows.length} shown</span>}
        {filteredAggregate.totalSampled > 0 && (
          <span
            style={{
              marginLeft: "auto",
              padding: "2px 10px", borderRadius: 12,
              background: filteredAggregate.pct >= 5 ? C.riskRedBg : filteredAggregate.pct >= 1 ? C.riskAmberBg : "#f1f5f9",
              color: aggColor, fontWeight: 600, fontVariantNumeric: "tabular-nums",
            }}
            title={`Across ${filteredAggregate.hostsWithData} reporting host${filteredAggregate.hostsWithData === 1 ? "" : "s"} in the current selection: ${filteredAggregate.totalAbove} of ${filteredAggregate.totalSampled} sampled minutes were ≥ ${threshold}% (${filteredAggregate.pct.toFixed(2)}% of total period).`}
          >
            ≥ {threshold}% across selection: <strong>{aggFmt(filteredAggregate.totalAbove)}</strong>
            <span style={{ opacity: 0.6 }}>/{aggFmt(filteredAggregate.totalSampled)} min</span>
            <span style={{ marginLeft: 6, fontWeight: 700 }}>· {aggPctText}</span>
          </span>
        )}
      </div>
    );
  })();

  const filterBar = (compact: boolean) => (
    <div style={{ display: "flex", alignItems: "center", gap: compact ? 8 : 12, flexWrap: "wrap", padding: compact ? "5px 10px" : "8px 14px", background: "#fff", border: `1px solid ${C.border}`, borderRadius: compact ? 6 : 8, marginBottom: compact ? 6 : 12 }}>
      <span style={{ fontSize: 10, textTransform: "uppercase", color: C.headerText, fontWeight: 600 }}>Store</span>
      <select value={storeFilter} onChange={(e) => setStoreFilter(e.target.value)}
        style={{ fontSize: 12, padding: "3px 6px", border: "1px solid #dee2e6", borderRadius: 4, maxWidth: 200 }}>
        <option value="all">All</option>
        {pilot.stores.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
      </select>
      <span style={{ fontSize: 10, textTransform: "uppercase", color: C.headerText, fontWeight: 600 }}>CPU</span>
      <select value={cpuModelFilter} onChange={(e) => setCpuModelFilter(e.target.value)}
        style={{ fontSize: 12, padding: "3px 6px", border: "1px solid #dee2e6", borderRadius: 4, maxWidth: 180 }}
        title="Narrow the heatmap to one hardware class">
        <option value="all">All</option>
        {cpuModelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
      <div style={{ width: 1, height: 16, background: C.border }} />
      <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
        {PERIODS.map((p) => (
          <button key={p.id} onClick={() => { setPeriod(p.id); setShowCustomPeriod(false); }} style={{
            padding: "2px 8px", borderRadius: 12, fontSize: 11, cursor: "pointer",
            border: period === p.id && !showCustomPeriod ? `1px solid ${C.pillActive}` : "1px solid #dee2e6",
            background: period === p.id && !showCustomPeriod ? C.pillActive : "#fff",
            color: period === p.id && !showCustomPeriod ? "#fff" : "#495057", fontWeight: period === p.id && !showCustomPeriod ? 600 : 400,
          }}>{p.label}</button>
        ))}
        <button onClick={() => setShowCustomPeriod(!showCustomPeriod)} style={{
          padding: "2px 8px", borderRadius: 12, fontSize: 11, cursor: "pointer",
          border: showCustomPeriod || !isPresetPeriod ? `1px solid ${C.pillActive}` : "1px solid #dee2e6",
          background: showCustomPeriod || !isPresetPeriod ? C.pillActive : "#fff",
          color: showCustomPeriod || !isPresetPeriod ? "#fff" : "#495057",
          fontWeight: showCustomPeriod || !isPresetPeriod ? 600 : 400,
        }}>Custom</button>
        {showCustomPeriod && (
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
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
              style={{ width: 48, fontSize: 11, padding: "2px 6px", border: "1px solid #dee2e6", borderRadius: 4, textAlign: "center", outline: "none" }}
            />
            <span style={{ fontSize: 10, color: C.textSec }}>d</span>
            <button onClick={() => {
              const v = Math.max(1, Math.min(365, parseInt(customPeriodDays) || 14));
              setCustomPeriodDays(String(v));
              setPeriod(String(v));
            }} style={{
              padding: "2px 8px", borderRadius: 4, fontSize: 10, cursor: "pointer",
              border: "1px solid #dee2e6", background: "#f8f9fa", color: "#495057",
            }}>Apply</button>
          </div>
        )}
        {!isPresetPeriod && (
          <span style={{ fontSize: 10, color: "#c9cdd1" }}>({periodDays}d)</span>
        )}
      </div>
      <div style={{ width: 1, height: 16, background: C.border }} />
      <span style={{ fontSize: 10, textTransform: "uppercase", color: C.headerText, fontWeight: 600 }}>Threshold</span>
      <select value={threshold} onChange={(e) => setThreshold(Number(e.target.value))}
        style={{ fontSize: 12, padding: "3px 6px", border: "1px solid #dee2e6", borderRadius: 4, width: 56 }}>
        {[50, 60, 70, 80, 90].map((v) => <option key={v} value={v}>{v}%</option>)}
      </select>
      <div style={{ width: 1, height: 16, background: C.border }} />
      <span style={{ fontSize: 10, textTransform: "uppercase", color: C.headerText, fontWeight: 600 }}>Group</span>
      <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
        {([
          { id: "host" as const, label: "Host" },
          { id: "cpu" as const, label: "CPU model" },
          { id: "store" as const, label: "Store" },
        ]).map((g) => (
          <button key={g.id} onClick={() => setGroupBy(g.id)} style={{
            padding: "2px 8px", borderRadius: 12, fontSize: 11, cursor: "pointer",
            border: groupBy === g.id ? `1px solid ${C.pillActive}` : "1px solid #dee2e6",
            background: groupBy === g.id ? C.pillActive : "#fff",
            color: groupBy === g.id ? "#fff" : "#495057",
            fontWeight: groupBy === g.id ? 600 : 400,
          }}>{g.label}</button>
        ))}
      </div>
      <div style={{ width: 1, height: 16, background: C.border }} />
      {/* Tri-state Retellect filter pill: off → running → not running → off.
          Mirrors the Overview tab's chip style so the user recognises it.
          Filters on live python.cpu telemetry, not DB.retellectEnabled — see
          RT-BACKFILL backlog. */}
      {(() => {
        const next = retellectInstalled === null ? true : retellectInstalled === true ? false : null;
        const label = retellectInstalled === true ? "Retellect running"
          : retellectInstalled === false ? "Retellect not running"
          : "Retellect: any";
        const dot = retellectInstalled === true ? "#10b981"
          : retellectInstalled === false ? "#94a3b8"
          : "transparent";
        const active = retellectInstalled !== null;
        return (
          <button
            type="button"
            onClick={() => setRetellectInstalled(next)}
            title="Click to cycle: any → running → not running → any. Live python.cpu telemetry."
            style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              padding: "2px 10px", borderRadius: 12, fontSize: 11, cursor: "pointer",
              border: active ? "1px solid #a7f3d0" : "1px solid #dee2e6",
              background: active ? "#ecfdf5" : "#fff",
              color: active ? "#065f46" : "#495057",
              fontWeight: active ? 600 : 400,
            }}
          >
            <span style={{
              width: 8, height: 8, borderRadius: "50%",
              background: dot, border: dot === "transparent" ? "1px solid #cbd5e1" : "none",
            }} />
            {label}
          </button>
        );
      })()}
      {compact && <span style={{ fontSize: 10, color: hasTrendData ? "#059669" : "#c9cdd1", marginLeft: "auto" }}>{hasTrendData ? "✓ Live Zabbix trends" : "⚠ No trend data"}</span>}
    </div>
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
          position: "sticky", left: 0, background: rowBg, zIndex: 10,
          color: sel ? C.pillActive : "#343a40",
          maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis",
        }} title={row.storeName}>{row.storeName}</td>
        <td style={{
          padding: "3px 6px", fontFamily: "'SF Mono','Cascadia Code',monospace", fontSize: 11,
          fontWeight: sel ? 600 : 400, whiteSpace: "nowrap",
          color: sel ? C.pillActive : "#343a40",
          maxWidth: 100, overflow: "hidden", textOverflow: "ellipsis",
        }} title={rowTitle}>{row.name}</td>
        <td style={{ padding: "3px 6px", fontSize: 10, color: C.textSec, whiteSpace: "nowrap", maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis" }} title={row.cpuModel}>{row.cpuModel}</td>
        <td style={{ padding: "3px 6px", textAlign: "center" }} title={row.rtActive ? "Retellect running (live python.cpu)" : "Retellect not detected on this host"}>
          <span style={{
            display: "inline-block", width: 8, height: 8, borderRadius: "50%",
            background: row.rtActive ? "#10b981" : "transparent",
            border: row.rtActive ? "none" : "1px solid #cbd5e1",
            verticalAlign: "middle",
          }} />
        </td>
        {row.peaks.map((peak, i) => {
          const hasValue = row.hasMatch && peak !== null;
          const exceeded = hasValue && peak >= threshold;
          const dateStr = `${String(dates[i].getMonth() + 1).padStart(2, "0")}-${String(dates[i].getDate()).padStart(2, "0")}`;
          const active = sel && drill?.date === dateStr;
          const bg = !hasValue
            ? "#f9fafb"
            : peak >= 90 ? C.criticalBg
            : peak >= 80 ? C.highBg
            : exceeded ? C.thresholdBg
            : C.belowBg;
          const trend = row.dayTrends[i];
          const cellTitle = !row.hasMatch
            ? "No Zabbix host match"
            : peak === null
              ? "No history for this day"
              : trend
                ? `${row.name} · ${dateStr}\nDay max:  ${trend.max}%\nDay avg:  ${trend.avg}%\nDay min:  ${trend.min}%\nClick to open drill-down (per-minute breakdown)`
                : `Day max ${Math.round(peak!)}% — click to drill down`;
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
                {hasValue ? Math.round(peak!) : "—"}
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
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: C.headerBg }}>
                {/* New ordering per user feedback: Store → Host → CPU → Retellect.
                    Type column dropped — every host in this pilot is the same
                    type (SCO), the badge added noise without information. */}
                <th onClick={() => toggleSort("store")} style={{ textAlign: "left", padding: "4px 8px", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.4, color: C.headerText, fontWeight: 600, whiteSpace: "nowrap", position: "sticky", left: 0, background: C.headerBg, zIndex: 10, cursor: "pointer", userSelect: "none" }}>
                  Store{sortArrow("store")}
                </th>
                <th onClick={() => toggleSort("name")} style={{ textAlign: "left", padding: "4px 6px", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.4, color: C.headerText, fontWeight: 600, whiteSpace: "nowrap", cursor: "pointer", userSelect: "none" }}>
                  Host{sortArrow("name")}
                </th>
                <th style={{ textAlign: "left", padding: "4px 6px", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.4, color: C.headerText, fontWeight: 600, whiteSpace: "nowrap" }}>CPU</th>
                <th onClick={() => toggleSort("rt")} style={{ textAlign: "center", padding: "4px 6px", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.4, color: C.headerText, fontWeight: 600, cursor: "pointer", userSelect: "none" }} title="Whether Retellect is installed on this host (DB flag)">
                  Retellect{sortArrow("rt")}
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
                const sorted = [...hostRows].sort((a, b) => groupKey(a).localeCompare(groupKey(b)) || a.name.localeCompare(b.name));
                const groups = new Map<string, typeof hostRows>();
                for (const r of sorted) {
                  const k = groupKey(r);
                  if (!groups.has(k)) groups.set(k, []);
                  groups.get(k)!.push(r);
                }

                const elements: ReactElement[] = [];
                let runningIdx = 0;
                for (const [groupName, members] of groups) {
                  const isExpanded = expandedGroups.has(groupName);
                  const matchedHosts = members.filter((r) => r.hasMatch).length;
                  const totalExceed = members.reduce((s, r) => s + r.minutesAbove, 0);
                  const totalSampled = members.reduce((s, r) => s + r.totalMinutes, 0);
                  // Per-day MAX peak across the group — gives an at-a-glance
                  // heatmap row even when the group is collapsed.
                  const dayMaxes: (number | null)[] = dates.map((_, i) => {
                    let max: number | null = null;
                    for (const r of members) {
                      const v = r.peaks[i];
                      if (v !== null && (max === null || v > max)) max = v;
                    }
                    return max;
                  });

                  elements.push(
                    <tr key={`grp-${groupName}`} style={{
                      borderTop: `1px solid ${C.border}`,
                      background: "#f1f5f9",
                      cursor: "pointer",
                    }} onClick={() => toggleGroup(groupName)}>
                      <td colSpan={4} style={{
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
                      {dayMaxes.map((peak, i) => {
                        const hasValue = peak !== null;
                        const exceeded = hasValue && peak >= threshold;
                        const bg = !hasValue
                          ? "#f9fafb"
                          : peak >= 90 ? C.criticalBg
                          : peak >= 80 ? C.highBg
                          : exceeded ? C.thresholdBg
                          : C.belowBg;
                        const dateStr = `${String(dates[i].getMonth() + 1).padStart(2, "0")}-${String(dates[i].getDate()).padStart(2, "0")}`;
                        return (
                          <td key={i} style={{ padding: 0, textAlign: "center", width: 32 }}
                            title={hasValue ? `${groupName} · ${dateStr}\nGroup MAX (across ${members.length} hosts): ${Math.round(peak)}%` : `${groupName} · ${dateStr} — no data`}>
                            <div style={{
                              background: bg,
                              color: !hasValue ? "#d1d5db" : exceeded ? C.exceededText : C.belowText,
                              padding: "2px 0", fontSize: 10, fontWeight: exceeded ? 700 : 500, lineHeight: 1.2,
                            }}>
                              {hasValue ? Math.round(peak) : "—"}
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
        {[{ bg: C.belowBg, l: "Below" }, { bg: C.thresholdBg, l: `${threshold}–${Math.min(threshold+10,80)}%` }, { bg: C.highBg, l: "80–89%" }, { bg: C.criticalBg, l: "≥90%" }].map(({ bg, l }) => (
          <span key={l} style={{ display: "flex", alignItems: "center", gap: 3 }}>
            <span style={{ width: 10, height: 8, borderRadius: 2, background: bg, display: "inline-block" }} />{l}
          </span>
        ))}
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
    const monitoredSum = selSlotData.retellect + selSlotData.scoApp + selSlotData.db + selSlotData.system;
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
            const val = selSlotData[proc.key];
            return (
              <div key={proc.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 11, color: C.textSec, width: 64, textAlign: "right", flexShrink: 0 }}>{proc.label}</span>
                <div style={{ flex: 1, height: 12, background: "#f1f3f5", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ height: "100%", borderRadius: 3, background: proc.color, width: `${val}%`, transition: "width 0.2s ease" }} />
                </div>
                <span style={{ fontSize: 12, fontWeight: 600, color: "#212529", width: 44, textAlign: "right", fontFamily: "'SF Mono','Cascadia Code',monospace", flexShrink: 0 }}>
                  {Math.round(val * 10) / 10}%
                </span>
              </div>
            );
          })}
          {/* Other = host CPU - monitored process sum. Captures kernel work /
              processes not tracked by name (the difference between total host
              CPU and the four monitored categories). */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, color: "#475569", width: 64, textAlign: "right", flexShrink: 0 }} title="CPU consumed by processes we don't monitor by name (kernel, scheduler, services).">Other</span>
            <div style={{ flex: 1, height: 12, background: "#f1f3f5", borderRadius: 3, overflow: "hidden" }}>
              <div style={{ height: "100%", borderRadius: 3, background: "#94a3b8", width: `${other}%`, transition: "width 0.2s ease" }} />
            </div>
            <span style={{ fontSize: 12, fontWeight: 600, color: "#475569", width: 44, textAlign: "right", fontFamily: "'SF Mono','Cascadia Code',monospace", flexShrink: 0 }}>
              {Math.round(other * 10) / 10}%
            </span>
          </div>
        </div>
      </div>
    );
  })();

  // ═══ NO DRILL ═══════════════════════════════════════════════════════
  if (!drill) {
    return (
      <>
        {filterBar(false)}
        <h2 style={{ fontSize: 17, fontWeight: 600, color: "#212529", marginBottom: 4 }}>CPU Threshold Timeline</h2>
        <p style={{ fontSize: 13, color: "#868e96", marginBottom: 10 }}>Heatmap: peak CPU per machine per day. Click a cell to drill down.</p>
        {heatmapTable}
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
    <div ref={split.containerRef} style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 200px)", minHeight: 500, marginBottom: -24 }}>
      {/* TOP PANE */}
      <div style={{ height: split.splitPx, minHeight: 120, overflow: "auto", flexShrink: 0 }}>
        {filterBar(true)}
        {heatmapTable}
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
            {drillResources && <span style={{ fontSize: 11, color: "#adb5bd" }}>{drillResources.cores} cores · {drillResources.totalRamGb} GB · {drillResources.deviceType}</span>}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {([{ id: "process" as const, label: "Process Breakdown" }, { id: "resources" as const, label: "Resource Utilization" }]).map((t) => (
              <button key={t.id} onClick={() => { setDrillTab(t.id); setSelectedSlot(null); }} style={{
                padding: "4px 12px", fontSize: 12, fontWeight: drillTab === t.id ? 600 : 400, borderRadius: 14,
                color: drillTab === t.id ? "#fff" : C.textSec, background: drillTab === t.id ? C.pillActive : "#e9ecef",
                border: "none", cursor: "pointer",
              }}>{t.label}</button>
            ))}
            <button onClick={() => { setDrill(null); setSelectedSlot(null); }} style={{ fontSize: 11, padding: "4px 10px", border: "1px solid #dee2e6", borderRadius: 6, background: "#fff", color: "#495057", cursor: "pointer", marginLeft: 4 }}>Close ✕</button>
          </div>
        </div>

        {/* Day summary banner — answers "where did the timeline 100% come from".
            Built from raw 1-min system.cpu.util samples for the selected day. */}
        {daySummary && (
          <div style={{
            padding: "8px 16px", background: "#fff", borderBottom: `1px solid ${C.border}`,
            display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap", flexShrink: 0,
          }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <span style={{ fontSize: 10, textTransform: "uppercase", color: C.headerText, fontWeight: 600, letterSpacing: 0.4 }}>Day max</span>
              <span style={{
                fontSize: 18, fontWeight: 700,
                color: daySummary.maxValue >= 90 ? "#dc2626" : daySummary.maxValue >= 70 ? "#d97706" : "#212529",
              }}>{daySummary.maxValue}%</span>
              <span style={{ fontSize: 11, color: C.textSec }}>at <strong style={{ color: "#212529", fontFamily: "'SF Mono','Cascadia Code',monospace" }}>{daySummary.maxLabel}</strong> Vilnius</span>
            </div>
            <div style={{ width: 1, height: 28, background: C.border }} />
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <span style={{ fontSize: 10, textTransform: "uppercase", color: C.headerText, fontWeight: 600, letterSpacing: 0.4 }}>Day avg</span>
              <span style={{ fontSize: 14, fontWeight: 600, color: "#212529" }}>{daySummary.avgValue}%</span>
            </div>
            <div style={{ width: 1, height: 28, background: C.border }} />
            <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11, color: C.textSec }}>
              <span style={{ fontSize: 10, textTransform: "uppercase", color: C.headerText, fontWeight: 600, letterSpacing: 0.4 }}>Minutes ≥</span>
              {[
                { th: 95, c: "#dc2626", v: daySummary.minutesAbove.t95 },
                { th: 90, c: "#ef4444", v: daySummary.minutesAbove.t90 },
                { th: 70, c: "#d97706", v: daySummary.minutesAbove.t70 },
              ].map((row) => (
                <span key={row.th} style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: row.c, display: "inline-block" }} />
                  {row.th}%: <strong style={{ color: row.v > 0 ? "#212529" : "#adb5bd", fontVariantNumeric: "tabular-nums" }}>{row.v}</strong>
                </span>
              ))}
            </div>
            <div style={{ width: 1, height: 28, background: C.border }} />
            <span style={{ fontSize: 10, color: "#94a3b8", fontStyle: "italic" }}>
              from {daySummary.samples} × 1-min samples of <code style={{ fontSize: 9, background: "#f1f3f5", padding: "0 4px", borderRadius: 3 }}>system.cpu.util</code>
            </span>
          </div>
        )}

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
              {/* Granularity selector — fixed presets, no custom (1m is the
                  native sample rate, anything below is aliasing). */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexShrink: 0, flexWrap: "wrap" }}>
                <span style={{ fontSize: 10, textTransform: "uppercase", color: C.headerText, fontWeight: 600, letterSpacing: 0.4 }}>Granularity</span>
                <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
                  {GRANULARITIES.map((g) => (
                    <button key={g.id} onClick={() => { setGranularity(g.id); setSelectedSlot(null); }} style={{
                      padding: "2px 8px", borderRadius: 10, fontSize: 11, cursor: "pointer",
                      border: granularity === g.id ? `1px solid ${C.pillActive}` : "1px solid #dee2e6",
                      background: granularity === g.id ? C.pillActive : "#fff",
                      color: granularity === g.id ? "#fff" : "#495057",
                      fontWeight: granularity === g.id ? 600 : 400,
                    }}>{g.label}</button>
                  ))}
                </div>
                <span style={{ fontSize: 10, color: "#c9cdd1" }}>
                  ({drillIntervals.length} intervals)
                </span>
              </div>

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
                    const tot = s.retellect + s.scoApp + s.db + s.system;
                    return (
                      <div key={s.slot}
                        onClick={() => setSelectedSlot(isSelected ? null : s.slot)}
                        style={{
                          flex: "1 1 0%", cursor: "pointer", position: "relative",
                          background: isSelected ? "rgba(0,112,201,0.06)" : "transparent",
                        }}
                        title={`${s.label}\nHost CPU: ${sysMax !== null ? Math.round(sysMax) + "% (max)" : "—"}${sysAvg !== null ? " · " + Math.round(sysAvg) + "% (avg)" : ""}\nMonitored processes: ${Math.round(tot)}%  (Retellect ${Math.round(s.retellect)}% · SCO ${Math.round(s.scoApp)}% · DB ${Math.round(s.db)}% · System ${Math.round(s.system)}%)`}
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
                <div style={{ display: "flex", gap: 14, fontSize: 12, color: C.textSec, flexWrap: "wrap" }}>
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
                </div>
                {!selSlotData && peakSlot && (
                  <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6, padding: "4px 12px" }}>
                    <span style={{ fontSize: 12, color: "#92400e" }}>
                      <strong>Process activity peak:</strong> {peakSlotNorm ? Math.round(peakSlotNorm.retellect + peakSlotNorm.scoApp + peakSlotNorm.db + peakSlotNorm.system) : 0}% at {peakSlot.label} · Retellect ~{peakSlotNorm ? Math.round(peakSlotNorm.retellect) : 0}% · Headroom ~{peakSlotNorm ? Math.round(peakSlotNorm.free) : 0}%
                    </span>
                    <span style={{ fontSize: 10, color: "#a16207", marginLeft: 8, fontStyle: "italic" }}>
                      ({granularity}min avg — timeline cell shows daily instantaneous max)
                    </span>
                  </div>
                )}
                {selSlotData && (
                  <button onClick={() => setSelectedSlot(null)} style={{
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

          {drillTab === "resources" && drillResources && (
            <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 14 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, flexShrink: 0 }}>
                {[
                  { l: "CPU", v: `${Math.round(drillResources.currentCpu * 10) / 10}%`, s: `${drillResources.cores} cores`, c: drillResources.currentCpu > 70 ? "#ef4444" : drillResources.currentCpu > 40 ? "#f59f00" : "#059669" },
                  { l: "MEMORY", v: `${Math.round(drillResources.currentMem)}%`, s: `${drillResources.totalRamGb} GB total`, c: drillResources.currentMem > 80 ? "#ef4444" : drillResources.currentMem > 60 ? "#f59f00" : "#059669" },
                  { l: "DISK", v: drillResources.currentDisk > 0 ? `${Math.round(drillResources.currentDisk)}%` : "N/A", s: drillResources.diskPath, c: drillResources.currentDisk > 80 ? "#ef4444" : drillResources.currentDisk > 60 ? "#f59f00" : "#059669" },
                ].map((card) => (
                  <div key={card.l} style={{ background: "#fff", borderRadius: 8, padding: "10px 14px", border: `1px solid ${C.border}` }}>
                    <div style={{ fontSize: 10, color: C.headerText, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600, marginBottom: 2 }}>{card.l}</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: card.c }}>{card.v}</div>
                    <div style={{ fontSize: 11, color: C.textSec }}>{card.s}</div>
                  </div>
                ))}
              </div>
              <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: "#fff", border: `1px dashed ${C.border}`, borderRadius: 8, padding: "20px 24px", minHeight: 80 }}>
                <div style={{ textAlign: "center", maxWidth: 480 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#495057", marginBottom: 4 }}>Hourly CPU / Memory / Disk history not available yet</div>
                  <div style={{ fontSize: 11, color: C.textSec, lineHeight: 1.5 }}>
                    Zabbix archives daily aggregates (max/avg/min) — those drive
                    the Timeline heatmap. Per-hour breakdown will be wired up
                    when we add a per-host single-day{" "}
                    <code style={{ fontSize: 10, background: "#f1f3f5", padding: "0 4px", borderRadius: 3 }}>history.get</code>{" "}
                    fetch for these metrics.
                  </div>
                </div>
              </div>
              {drillResources.currentMem > 80 && (
                <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6, padding: "6px 12px", flexShrink: 0 }}>
                  <p style={{ fontSize: 12, color: "#991b1b", margin: 0 }}><strong>Warning:</strong> {drill.displayName} — {Math.round(drillResources.currentMem)}% memory, {drillResources.totalRamGb} GB total.</p>
                </div>
              )}
            </div>
          )}
          {!drillResources && drillTab === "resources" && (
            <div style={{ textAlign: "center", padding: "32px 0", color: C.textSec, fontSize: 14 }}>No Zabbix data available for this host.</div>
          )}
        </div>
      </div>
    </div>
  );
}
