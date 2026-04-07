"use client";

import { useState, useMemo, useCallback, useRef } from "react";
import type { RtPilotData, ZabbixData } from "../RtPilotWorkspace";
import { generateTimelineData, generateIntervalData, type IntervalSlot } from "./rt-timeline-math";

const PERIODS = [
  { id: "1h", label: "1h", days: 0 },
  { id: "1d", label: "1d", days: 1 },
  { id: "7d", label: "7d", days: 7 },
  { id: "14d", label: "14d", days: 14 },
  { id: "30d", label: "30d", days: 30 },
  { id: "90d", label: "90d", days: 90 },
] as const;

const GRANULARITIES = [
  { id: 60, label: "1h", slots: 24 },
  { id: 15, label: "15min", slots: 96 },
  { id: 5, label: "5min", slots: 288 },
] as const;

const C = {
  belowBg: "#e0effe", belowText: "#868e96",
  thresholdBg: "#fbbf24", highBg: "#f59f00", criticalBg: "#ef4444", exceededText: "#fff",
  retellect: "#fa5252", scoApp: "#f59f00", system: "#0c8feb", free: "#e0effe",
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
  { key: "system" as const, label: "System", color: C.system },
  { key: "free" as const, label: "Free", color: C.free, border: true },
];

interface DrillState { date: string; dateObj: Date; hostName: string; peak: number; }

type SortKey = "name" | "type" | "exceed" | "cpu";
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
  const [threshold, setThreshold] = useState(70);
  const [period, setPeriod] = useState("14d");
  const [drill, setDrill] = useState<DrillState | null>(null);
  const [storeFilter, setStoreFilter] = useState("all");
  const [drillTab, setDrillTab] = useState<"process" | "resources">("process");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("exceed");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null);
  const [granularity, setGranularity] = useState<number>(60);
  const [customMin, setCustomMin] = useState<string>("");
  const [showCustom, setShowCustom] = useState(false);
  const [customPeriodDays, setCustomPeriodDays] = useState<string>("");
  const [showCustomPeriod, setShowCustomPeriod] = useState(false);

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

  const { zabbixByName, cpuDetail } = useMemo(() => {
    const byName = new Map(zabbix.hosts.map((h) => [h.hostName, h]));
    const detail = new Map<string, { user: number; system: number; numCpus: number }>();
    for (const item of zabbix.cpuDetail) {
      if (!detail.has(item.hostId)) detail.set(item.hostId, { user: 0, system: 0, numCpus: 0 });
      const entry = detail.get(item.hostId)!;
      if (item.key === "system.cpu.util[,user]") entry.user = item.value;
      if (item.key === "system.cpu.util[,system]") entry.system = item.value;
      if (item.key === "system.cpu.num") entry.numCpus = item.value;
    }
    return { zabbixByName: byName, cpuDetail: detail };
  }, [zabbix]);

  const allHostRows = useMemo(() => {
    return pilot.devices
      .filter((d) => storeFilter === "all" || d.storeName === storeFilter)
      .map((device, idx) => {
        const zHost = zabbixByName.get(device.sourceHostKey || "") || zabbixByName.get(device.name);
        const detail = zHost ? cpuDetail.get(zHost.hostId) : null;
        const cpuTotal = detail ? detail.user + detail.system : 0;
        const seed = device.name.split("").reduce((a, c) => a + c.charCodeAt(0), 0) * 137 + idx;
        const days = Math.max(1, periodDays);
        const peaks = zHost ? generateTimelineData(cpuTotal, days, seed) : Array(days).fill(0);
        const exceedCount = peaks.filter((p) => p >= threshold).length;
        return { name: device.name, cpuModel: device.cpuModel, deviceType: device.deviceType || "—", currentCpu: Math.round(cpuTotal * 10) / 10, cores: detail?.numCpus || 0, ramGb: device.ramGb, hasMatch: !!zHost, zHost, peaks, exceedCount };
      });
  }, [pilot, zabbixByName, cpuDetail, storeFilter, threshold, periodDays]);

  const hostRows = useMemo(() => {
    let rows = allHostRows;
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.deviceType.toLowerCase().includes(q) || r.cpuModel.toLowerCase().includes(q));
    }
    return [...rows].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "name") cmp = a.name.localeCompare(b.name);
      else if (sortKey === "type") cmp = a.deviceType.localeCompare(b.deviceType);
      else if (sortKey === "exceed") cmp = a.exceedCount - b.exceedCount;
      else if (sortKey === "cpu") cmp = a.currentCpu - b.currentCpu;
      return sortDir === "desc" ? -cmp : cmp;
    });
  }, [allHostRows, search, sortKey, sortDir]);

  const stats = useMemo(() => {
    const critical = allHostRows.filter((r) => r.hasMatch && r.exceedCount > 10).length;
    const warning = allHostRows.filter((r) => r.hasMatch && r.exceedCount > 0 && r.exceedCount <= 10).length;
    const ok = allHostRows.filter((r) => r.hasMatch && r.exceedCount === 0).length;
    const noData = allHostRows.filter((r) => !r.hasMatch).length;
    return { total: allHostRows.length, critical, warning, ok, noData };
  }, [allHostRows]);

  const toggleSort = useCallback((key: SortKey) => {
    if (sortKey === key) setSortDir((d) => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
  }, [sortKey]);

  // Interval data for current drill + granularity
  const drillIntervals = useMemo(() => {
    if (!drill) return null;
    const seed = drill.hostName.split("").reduce((a, c) => a + c.charCodeAt(0), 0) * 31 +
      drill.date.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
    return generateIntervalData(drill.peak, seed, granularity);
  }, [drill, granularity]);

  const drillResources = useMemo(() => {
    if (!drill) return null;
    const row = hostRows.find((r) => r.name === drill.hostName);
    if (!row?.zHost) return null;
    const h = row.zHost;
    const d = cpuDetail.get(h.hostId);
    let s = drill.hostName.split("").reduce((a, c) => a + c.charCodeAt(0), 0) * 7 +
      drill.date.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
    const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return (s % 1000) / 1000; };
    const memBase = h.memory?.utilization || 0;
    const diskBase = h.disk?.utilization || 0;
    const cpuBase = d ? d.user + d.system : 0;
    const totalRamGb = h.memory ? h.memory.totalBytes / 1024 / 1024 / 1024 : 0;
    const hourly = Array.from({ length: 24 }, (_, hour) => {
      const hf = (hour >= 10 && hour <= 14) ? 1.0 : (hour >= 8 && hour <= 18) ? 0.75 : (hour >= 6 && hour <= 20) ? 0.5 : 0.2;
      const r = rand();
      return {
        hour,
        cpu: Math.round(Math.min(98, Math.max(0.5, cpuBase * 5 * hf * (0.7 + r * 0.6))) * 10) / 10,
        memory: Math.round(Math.min(98, Math.max(10, memBase * (0.85 + hf * 0.2) * (0.95 + rand() * 0.1))) * 10) / 10,
        disk: Math.round(Math.min(98, Math.max(5, diskBase > 0 ? diskBase * (0.99 + rand() * 0.02) : 25 + rand() * 15)) * 10) / 10,
        ramUsedGb: Math.round(totalRamGb * Math.min(98, Math.max(10, memBase * (0.85 + hf * 0.2))) / 100 * 10) / 10,
      };
    });
    return { hostName: drill.hostName, cores: row.cores, totalRamGb: Math.round(totalRamGb * 10) / 10, deviceType: row.deviceType, diskPath: h.disk?.path || "/", hourly, currentCpu: cpuBase, currentMem: memBase, currentDisk: diskBase };
  }, [drill, hostRows, cpuDetail]);

  const peakSlot = drillIntervals
    ? drillIntervals.reduce((max, s) => (s.retellect + s.scoApp + s.system) > (max.retellect + max.scoApp + max.system) ? s : max, drillIntervals[0])
    : null;

  const selSlotData = useMemo(() => {
    if (selectedSlot === null || !drillIntervals) return null;
    return drillIntervals[selectedSlot] || null;
  }, [selectedSlot, drillIntervals]);

  const openDrill = useCallback((date: Date, hostName: string, peak: number) => {
    const newDate = `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    if (drill?.date === newDate && drill?.hostName === hostName) { setDrill(null); setSelectedSlot(null); return; }
    setDrill({ date: newDate, dateObj: date, hostName, peak });
    setDrillTab("process");
    setSelectedSlot(null);
  }, [drill]);

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

  const statsBar = (
    <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 11, color: C.textSec, padding: "4px 0" }}>
      <span style={{ fontWeight: 600, color: "#212529" }}>{stats.total} hosts</span>
      {stats.critical > 0 && <span style={{ color: C.riskRedText }}>● {stats.critical} critical</span>}
      {stats.warning > 0 && <span style={{ color: C.riskAmberText }}>● {stats.warning} warning</span>}
      <span style={{ color: C.okGreen }}>● {stats.ok} OK</span>
      {stats.noData > 0 && <span style={{ color: "#adb5bd" }}>● {stats.noData} no data</span>}
      {search && <span style={{ color: C.pillActive }}>→ {hostRows.length} shown</span>}
    </div>
  );

  const filterBar = (compact: boolean) => (
    <div style={{ display: "flex", alignItems: "center", gap: compact ? 8 : 12, flexWrap: "wrap", padding: compact ? "5px 10px" : "8px 14px", background: "#fff", border: `1px solid ${C.border}`, borderRadius: compact ? 6 : 8, marginBottom: compact ? 6 : 12 }}>
      <span style={{ fontSize: 10, textTransform: "uppercase", color: C.headerText, fontWeight: 600 }}>Store</span>
      <select value={storeFilter} onChange={(e) => setStoreFilter(e.target.value)}
        style={{ fontSize: 12, padding: "3px 6px", border: "1px solid #dee2e6", borderRadius: 4 }}>
        <option value="all">All</option>
        {pilot.stores.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
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
      <div style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: compact ? 0 : "auto" }}>
        <span style={{ fontSize: 12, color: "#adb5bd" }}>⌕</span>
        <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search host..."
          style={{ fontSize: 12, padding: "3px 8px", border: "1px solid #dee2e6", borderRadius: 4, width: compact ? 110 : 140, outline: "none" }} />
        {search && (
          <button onClick={() => setSearch("")}
            style={{ fontSize: 10, padding: "1px 5px", border: "none", background: "#e9ecef", borderRadius: 3, cursor: "pointer", color: "#495057" }}>✕</button>
        )}
      </div>
      {compact && <span style={{ fontSize: 10, color: "#c9cdd1", marginLeft: "auto" }}>⚠ Simulated</span>}
    </div>
  );

  // ─── Heatmap table ────────────────────────────────────────────────
  const heatmapTable = (
    <>
      {statsBar}
      <div style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 6, overflow: "hidden", position: "relative" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: C.headerBg }}>
                <th onClick={() => toggleSort("name")} style={{ textAlign: "left", padding: "4px 8px", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.4, color: C.headerText, fontWeight: 600, whiteSpace: "nowrap", position: "sticky", left: 0, background: C.headerBg, zIndex: 10, cursor: "pointer", userSelect: "none" }}>
                  Host{sortArrow("name")}
                </th>
                <th onClick={() => toggleSort("type")} style={{ textAlign: "center", padding: "4px 4px", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.4, color: C.headerText, fontWeight: 600, cursor: "pointer", userSelect: "none" }}>
                  Type{sortArrow("type")}
                </th>
                <th style={{ textAlign: "left", padding: "4px 6px", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.4, color: C.headerText, fontWeight: 600, whiteSpace: "nowrap" }}>CPU</th>
                {dates.map((d, i) => <th key={i} style={{ textAlign: "center", padding: "4px 0", fontSize: 8, fontWeight: 400, color: C.headerText, width: 32, minWidth: 32 }}>{String(d.getDate()).padStart(2, "0")}</th>)}
                <th onClick={() => toggleSort("exceed")} style={{ textAlign: "center", padding: "4px 6px", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.4, color: C.headerText, fontWeight: 600, whiteSpace: "nowrap", cursor: "pointer", userSelect: "none" }}>
                  &gt;{threshold}%{sortArrow("exceed")}
                </th>
              </tr>
            </thead>
            <tbody>
              {hostRows.map((row, rowIdx) => {
                const sel = drill?.hostName === row.name;
                const zebra = rowIdx % 2 === 1 ? C.zebraOdd : "#fff";
                const rowBg = sel ? "#eff6ff" : zebra;
                return (
                  <tr key={row.name} style={{ borderTop: `1px solid ${rowIdx === 0 ? C.border : "#f1f3f5"}`, background: rowBg }}>
                    <td style={{
                      padding: "3px 8px", fontFamily: "'SF Mono','Cascadia Code',monospace", fontSize: 11,
                      fontWeight: sel ? 600 : 400, whiteSpace: "nowrap",
                      position: "sticky", left: 0, background: rowBg, zIndex: 10,
                      color: sel ? C.pillActive : "#343a40",
                      maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis",
                    }} title={row.name}>{row.name}</td>
                    <td style={{ padding: "3px 4px", textAlign: "center" }}>{typeBadge(row.deviceType)}</td>
                    <td style={{ padding: "3px 6px", fontSize: 10, color: C.textSec, whiteSpace: "nowrap", maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis" }} title={row.cpuModel}>{row.cpuModel}</td>
                    {row.peaks.map((peak, i) => {
                      const exceeded = row.hasMatch && peak >= threshold;
                      const dateStr = `${String(dates[i].getMonth() + 1).padStart(2, "0")}-${String(dates[i].getDate()).padStart(2, "0")}`;
                      const active = sel && drill?.date === dateStr;
                      const bg = !row.hasMatch ? "#f9fafb" : peak >= 90 ? C.criticalBg : peak >= 80 ? C.highBg : exceeded ? C.thresholdBg : C.belowBg;
                      return (
                        <td key={i} style={{ padding: 0, textAlign: "center", width: 32, cursor: row.hasMatch ? "pointer" : "default" }}
                          onClick={() => row.hasMatch && openDrill(dates[i], row.name, peak)}>
                          <div style={{
                            background: bg,
                            color: !row.hasMatch ? "#d1d5db" : exceeded ? C.exceededText : C.belowText,
                            padding: "2px 0", fontSize: 10, fontWeight: exceeded ? 700 : 400, lineHeight: 1.2,
                            outline: active ? "2px solid #0070c9" : "none", outlineOffset: -1, borderRadius: active ? 2 : 0,
                          }}>
                            {row.hasMatch ? Math.round(peak) : "—"}
                          </div>
                        </td>
                      );
                    })}
                    <td style={{ padding: "3px 6px", textAlign: "center" }}>
                      {row.hasMatch ? (row.exceedCount > 0 ? (
                        <span style={{
                          padding: "1px 6px", borderRadius: 8, fontSize: 10, fontWeight: 600,
                          background: row.exceedCount > 10 ? C.riskRedBg : row.exceedCount > 5 ? C.riskAmberBg : C.riskGrayBg,
                          color: row.exceedCount > 10 ? C.riskRedText : row.exceedCount > 5 ? C.riskAmberText : C.textSec,
                        }}>{row.exceedCount}/{periodDays || 1}</span>
                      ) : <span style={{ fontSize: 10, fontWeight: 500, color: C.okGreen }}>OK</span>
                      ) : <span style={{ fontSize: 10, color: "#d1d5db" }}>—</span>}
                    </td>
                  </tr>
                );
              })}
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

  // ─── Determine label strategy based on granularity ────────────────
  const slotsPerHour = 60 / granularity;
  const totalSlots = Math.floor(1440 / granularity);
  const labelEvery = totalSlots <= 24 ? 1 : totalSlots <= 48 ? 2 : totalSlots <= 96 ? 4 : Math.max(1, Math.round(slotsPerHour));
  const barGap = totalSlots <= 24 ? 1.5 : totalSlots <= 96 ? 0.5 : 0;
  const barRadius = totalSlots <= 24 ? 3 : totalSlots <= 96 ? 2 : 1;
  const isPreset = GRANULARITIES.some(g => g.id === granularity);

  // ─── Hour detail panel ────────────────────────────────────────────
  const hourDetailPanel = selSlotData && (
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
      </div>
      <div style={{ width: 1, height: 44, background: C.border, flexShrink: 0 }} />
      <div style={{ flexShrink: 0, textAlign: "center", minWidth: 60 }}>
        <div style={{ fontSize: 10, color: C.headerText, textTransform: "uppercase", fontWeight: 600, letterSpacing: 0.4 }}>Total</div>
        <div style={{
          fontSize: 22, fontWeight: 700, lineHeight: 1.1,
          color: (selSlotData.retellect + selSlotData.scoApp + selSlotData.system) >= 90 ? C.criticalBg
            : (selSlotData.retellect + selSlotData.scoApp + selSlotData.system) >= 70 ? C.highBg
            : "#212529",
        }}>
          {Math.round(selSlotData.retellect + selSlotData.scoApp + selSlotData.system)}%
        </div>
      </div>
      <div style={{ width: 1, height: 44, background: C.border, flexShrink: 0 }} />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 5 }}>
        {PROCESSES.filter(p => p.key !== "free").map((proc) => {
          const val = selSlotData[proc.key];
          return (
            <div key={proc.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, color: C.textSec, width: 64, textAlign: "right", flexShrink: 0 }}>{proc.label}</span>
              <div style={{ flex: 1, height: 14, background: "#f1f3f5", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ height: "100%", borderRadius: 3, background: proc.color, width: `${Math.max(1, val)}%`, transition: "width 0.2s ease" }} />
              </div>
              <span style={{ fontSize: 12, fontWeight: 600, color: "#212529", width: 44, textAlign: "right", fontFamily: "'SF Mono','Cascadia Code',monospace", flexShrink: 0 }}>
                {Math.round(val * 10) / 10}%
              </span>
            </div>
          );
        })}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, color: "#adb5bd", width: 64, textAlign: "right", flexShrink: 0 }}>Free</span>
          <div style={{ flex: 1, height: 14, background: "#f1f3f5", borderRadius: 3, overflow: "hidden" }}>
            <div style={{ height: "100%", borderRadius: 3, background: C.free, border: "1px solid #c3dafe", width: `${Math.max(1, selSlotData.free)}%`, transition: "width 0.2s ease", boxSizing: "border-box" }} />
          </div>
          <span style={{ fontSize: 12, fontWeight: 600, color: "#adb5bd", width: 44, textAlign: "right", fontFamily: "'SF Mono','Cascadia Code',monospace", flexShrink: 0 }}>
            {Math.round(selSlotData.free * 10) / 10}%
          </span>
        </div>
      </div>
    </div>
  );

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
        <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6, padding: "8px 12px", marginTop: 10 }}>
          <p style={{ fontSize: 11, color: "#92400e", margin: 0 }}>
            <strong>⚠ Simulated:</strong> history.get API restricted. Values extrapolated from live snapshot ({zabbix.status === "live" ? "LIVE" : "CACHED"}).
          </p>
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
            <span style={{ fontSize: 12, color: C.textSec, fontFamily: "monospace" }}>{drill.hostName}</span>
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

        <div style={{ flex: 1, padding: "16px 20px", background: "#fafbfc", overflow: "auto" }}>
          {drillTab === "process" && drillIntervals && (
            <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
              {/* Granularity selector */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexShrink: 0, flexWrap: "wrap" }}>
                <span style={{ fontSize: 10, textTransform: "uppercase", color: C.headerText, fontWeight: 600, letterSpacing: 0.4 }}>Granularity</span>
                <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
                  {GRANULARITIES.map((g) => (
                    <button key={g.id} onClick={() => { setGranularity(g.id); setSelectedSlot(null); setShowCustom(false); }} style={{
                      padding: "2px 8px", borderRadius: 10, fontSize: 11, cursor: "pointer",
                      border: granularity === g.id && !showCustom ? `1px solid ${C.pillActive}` : "1px solid #dee2e6",
                      background: granularity === g.id && !showCustom ? C.pillActive : "#fff",
                      color: granularity === g.id && !showCustom ? "#fff" : "#495057",
                      fontWeight: granularity === g.id && !showCustom ? 600 : 400,
                    }}>{g.label}</button>
                  ))}
                  <button onClick={() => setShowCustom(!showCustom)} style={{
                    padding: "2px 8px", borderRadius: 10, fontSize: 11, cursor: "pointer",
                    border: showCustom || !isPreset ? `1px solid ${C.pillActive}` : "1px solid #dee2e6",
                    background: showCustom || !isPreset ? C.pillActive : "#fff",
                    color: showCustom || !isPreset ? "#fff" : "#495057",
                    fontWeight: showCustom || !isPreset ? 600 : 400,
                  }}>Custom</button>
                </div>
                {showCustom && (
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <input
                      type="number"
                      min="1"
                      max="120"
                      value={customMin}
                      onChange={(e) => setCustomMin(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          const v = Math.max(1, Math.min(120, parseInt(customMin) || 15));
                          if (1440 % v === 0) { setGranularity(v); setSelectedSlot(null); }
                          else { setCustomMin(String(v)); }
                        }
                      }}
                      placeholder="min"
                      style={{ width: 48, fontSize: 11, padding: "2px 6px", border: "1px solid #dee2e6", borderRadius: 4, textAlign: "center", outline: "none" }}
                    />
                    <span style={{ fontSize: 10, color: C.textSec }}>min</span>
                    <button onClick={() => {
                      const v = Math.max(1, Math.min(120, parseInt(customMin) || 15));
                      if (1440 % v === 0) { setGranularity(v); setSelectedSlot(null); }
                      else {
                        const valid = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 16, 18, 20, 24, 30, 36, 40, 45, 48, 60, 72, 80, 90, 120];
                        const nearest = valid.reduce((a, b) => Math.abs(b - v) < Math.abs(a - v) ? b : a);
                        setCustomMin(String(nearest));
                        setGranularity(nearest);
                        setSelectedSlot(null);
                      }
                    }} style={{
                      padding: "2px 8px", borderRadius: 4, fontSize: 10, cursor: "pointer",
                      border: "1px solid #dee2e6", background: "#f8f9fa", color: "#495057",
                    }}>Apply</button>
                  </div>
                )}
                <span style={{ fontSize: 10, color: "#c9cdd1" }}>
                  ({drillIntervals.length} intervals{!isPreset ? ` · ${granularity}min` : ""})
                </span>
              </div>

              {/* Stacked bar chart */}
              <div style={{ flex: 1, minHeight: 80, display: "flex", gap: 0, alignItems: "flex-end" }}>
                {drillIntervals.map((s) => {
                  const isSelected = selectedSlot === s.slot;
                  const total = s.retellect + s.scoApp + s.system;
                  return (
                    <div key={s.slot}
                      onClick={() => setSelectedSlot(isSelected ? null : s.slot)}
                      style={{
                        flex: "1 1 0%", display: "flex", flexDirection: "column-reverse",
                        marginLeft: barGap, borderRadius: `${barRadius}px ${barRadius}px 0 0`,
                        overflow: "hidden", height: "100%", cursor: "pointer", position: "relative",
                        outline: isSelected ? "2px solid #0070c9" : "none", outlineOffset: -1,
                        opacity: selectedSlot !== null && !isSelected ? 0.4 : 1,
                        transition: "opacity 0.15s ease",
                      }}
                      title={`${s.label} — Total: ${Math.round(total)}% | Retellect: ${Math.round(s.retellect)}% | SCO: ${Math.round(s.scoApp)}% | System: ${Math.round(s.system)}%`}>
                      <div style={{ height: `${s.retellect}%`, background: C.retellect }} />
                      <div style={{ height: `${s.scoApp}%`, background: C.scoApp }} />
                      <div style={{ height: `${s.system}%`, background: C.system }} />
                      <div style={{ height: `${s.free}%`, background: C.free }} />
                    </div>
                  );
                })}
              </div>

              {/* Time axis labels */}
              <div style={{ display: "flex", gap: 0, marginTop: 4, flexShrink: 0 }}>
                {drillIntervals.map((s, i) => {
                  const showLabel = i % labelEvery === 0;
                  const isSelected = selectedSlot === s.slot;
                  return (
                    <div key={s.slot}
                      onClick={() => setSelectedSlot(selectedSlot === s.slot ? null : s.slot)}
                      style={{
                        flex: "1 1 0%", textAlign: "center",
                        fontSize: granularity === 60 ? 10 : 7,
                        cursor: "pointer",
                        color: isSelected ? C.pillActive : showLabel ? "#adb5bd" : "transparent",
                        fontWeight: isSelected ? 700 : 400,
                        overflow: "hidden", whiteSpace: "nowrap",
                      }}>
                      {showLabel || isSelected ? (granularity === 60 ? s.hour : s.label) : "\u00A0"}
                    </div>
                  );
                })}
              </div>

              {/* Hour detail panel */}
              {hourDetailPanel}

              {/* Legend + peak info */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: selSlotData ? 8 : 10, flexShrink: 0 }}>
                <div style={{ display: "flex", gap: 14, fontSize: 12, color: C.textSec }}>
                  {PROCESSES.map(({ color, label, border: b }) => (
                    <span key={label} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <span style={{ width: 12, height: 10, borderRadius: 2, background: color, display: "inline-block", ...(b ? { border: "1px solid #c3dafe" } : {}) }} />{label}
                    </span>
                  ))}
                </div>
                {!selSlotData && peakSlot && (
                  <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6, padding: "4px 12px" }}>
                    <span style={{ fontSize: 12, color: "#92400e" }}>
                      <strong>Peak:</strong> {Math.round(peakSlot.retellect + peakSlot.scoApp + peakSlot.system)}% at {peakSlot.label} · Retellect ~{Math.round(peakSlot.retellect)}% · Headroom ~{Math.round(peakSlot.free)}%
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
              <div style={{ flex: 1, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, minHeight: 60 }}>
                {([
                  { l: "CPU % per hour", d: drillResources.hourly.map(h => h.cpu), cf: (v: number) => v > 70 ? "#ef4444" : v > 40 ? "#fbbf24" : "#0c8feb" },
                  { l: "Memory % per hour", d: drillResources.hourly.map(h => h.memory), cf: (v: number) => v > 80 ? "#ef4444" : v > 60 ? "#f59f00" : "#10b981" },
                  { l: "Disk % per hour", d: drillResources.hourly.map(h => h.disk), cf: (v: number) => v > 80 ? "#ef4444" : v > 60 ? "#f59f00" : "#6366f1" },
                ] as const).map(({ l, d, cf }) => (
                  <div key={l} style={{ display: "flex", flexDirection: "column" }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "#495057", marginBottom: 4, flexShrink: 0 }}>{l}</div>
                    <div style={{ flex: 1, display: "flex", gap: 0, alignItems: "flex-end", borderBottom: "1px solid #e9ecef", minHeight: 30 }}>
                      {d.map((v, i) => <div key={i} style={{ flex: "1 1 0%", marginLeft: 1, borderRadius: "2px 2px 0 0", background: cf(v), height: `${Math.max(3, v)}%` }} title={`${String(i).padStart(2, "0")}:00 — ${v}%`} />)}
                    </div>
                    <div style={{ display: "flex", gap: 0, marginTop: 2, flexShrink: 0 }}>
                      {d.map((_, i) => <div key={i} style={{ flex: "1 1 0%", textAlign: "center", fontSize: 7, color: "#c9cdd1" }}>{i % 6 === 0 ? i : ""}</div>)}
                    </div>
                  </div>
                ))}
              </div>
              {drillResources.currentMem > 80 && (
                <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6, padding: "6px 12px", flexShrink: 0 }}>
                  <p style={{ fontSize: 12, color: "#991b1b", margin: 0 }}><strong>Warning:</strong> {drill.hostName} — {Math.round(drillResources.currentMem)}% memory, {drillResources.totalRamGb} GB total.</p>
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
