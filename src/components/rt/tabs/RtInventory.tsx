"use client";

import { Fragment, useState, useMemo, useEffect } from "react";
import type { RtPilotData, ZabbixData } from "../RtPilotWorkspace";
import {
  determineRtStatus,
  buildProcByHost,
  buildRetellectProcsByHost,
  compareHosts,
  formatAgeShort,
  computeCpuTotal,
  bytesToGb,
  computeConnectionStats,
  RT_FRESHNESS_THRESHOLD_SEC,
  RT_STALE_THRESHOLD_SEC,
  type RtProcessStatus,
  type RetellectProcSample,
  type HostSortKey,
  type HostSortDir,
} from "./rt-inventory-helpers";
import { DataCoverageBanner } from "./DataCoverageBanner";

type RiskLevel = "critical" | "high" | "medium" | "low" | "unknown";

interface HostRow {
  id: string;
  name: string;
  store: string;
  cpuModel: string;
  ramGb: string;
  retellectEnabled: boolean;
  rtProcessStatus: RtProcessStatus;
  rtProcessCount: number;
  cpuUser: number;
  cpuSystem: number;
  cpuTotal: number;
  memUtil: number;
  memTotalGb: number;
  diskUtil: number;
  numCpus: number;
  ip: string;
  groups: string[];
  status: string;
  risk: RiskLevel;
  lastClock: string | null;
  /** True when the DB device is resolvable to a Zabbix host (used by connection header) */
  zabbixMatched: boolean;
  /** Python process telemetry samples for this host (for drill-down) */
  pythonProcs: RetellectProcSample[];
  /** Age of the freshest Python sample in seconds, or null if no samples */
  freshestAgeSec: number | null;
  /** Sum of all Python CPU % readings — Retellect's contribution to host CPU */
  retellectCpuTotal: number;
}

const riskColors: Record<string, string> = {
  critical: "text-red-600 font-semibold",
  high: "text-amber-600 font-medium",
  medium: "text-amber-500",
  low: "text-emerald-600",
  unknown: "text-gray-400",
};

function getRisk(cpuTotal: number): RiskLevel {
  if (cpuTotal >= 90) return "critical";
  if (cpuTotal >= 70) return "high";
  if (cpuTotal >= 50) return "medium";
  if (cpuTotal > 0) return "low";
  return "unknown";
}

// Sort types re-exported from helpers for local terseness
type SortKey = HostSortKey;
type SortDir = HostSortDir;

export function RtInventory({ pilot, zabbix }: { pilot: RtPilotData; zabbix: ZabbixData }) {
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  // Client-only clock for freshness badges — start at 0 so SSR and first
  // client render match (no badge on either), then update on mount. Refreshed
  // every 30s so badges age in place.
  const [nowMs, setNowMs] = useState<number>(0);
  useEffect(() => {
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Numeric columns default to descending (highest first is usually what you want)
      const numericKeys: SortKey[] = ["ramGb", "cpuUser", "cpuSystem", "cpuTotal"];
      setSortDir(numericKeys.includes(key) ? "desc" : "asc");
    }
  }


  // Build host rows from DB devices only
  const allHosts = useMemo(() => {
    const rows: HostRow[] = [];
    const zabbixByName = new Map(zabbix.hosts.map((h) => [h.hostName, h]));
    const zabbixByHostId = new Map(zabbix.hosts.map((h) => [h.hostId, h]));

    // CPU detail map
    const cpuDetail = new Map<string, { user: number; system: number; total: number; numCpus: number; lastClock: string | null }>();
    for (const item of zabbix.cpuDetail) {
      if (!cpuDetail.has(item.hostId)) {
        cpuDetail.set(item.hostId, { user: 0, system: 0, total: 0, numCpus: 0, lastClock: null });
      }
      const entry = cpuDetail.get(item.hostId)!;
      if (item.key === "system.cpu.util[,user]") { entry.user = item.value; entry.lastClock = item.lastClock; }
      if (item.key === "system.cpu.util[,system]") entry.system = item.value;
      // Handle system.cpu.util[,,avg1] as total CPU utilization (real Rimi API)
      if (item.key === "system.cpu.util[,,avg1]" || item.key === "system.cpu.util") {
        entry.total = item.value; entry.lastClock = item.lastClock;
      }
      if (item.key === "system.cpu.num") entry.numCpus = item.value;
    }

    // Legacy proc.num map (empty on the Rimi deployment, kept as fallback)
    const procByHost = buildProcByHost(
      (zabbix.procItems || []).map(p => ({ hostId: p.hostId, key: p.key, name: p.name, value: p.value }))
    );

    // Python process telemetry — authoritative Retellect liveness signal (HI-6)
    const retellectProcsByHost = buildRetellectProcsByHost(
      (zabbix.procCpu || []).map(p => ({
        hostId: p.hostId,
        key: p.key,
        name: p.name,
        procName: p.procName,
        category: p.category,
        cpuValue: p.cpuValue,
        lastClockUnix: p.lastClockUnix,
      }))
    );
    const hasProcCpuFeed = (zabbix.procCpu?.length ?? 0) > 0;

    // DB devices only
    for (const device of pilot.devices) {
      const zHost = zabbixByName.get(device.sourceHostKey || "") || zabbixByName.get(device.name);
      const detail = zHost ? cpuDetail.get(zHost.hostId) : null;

      const cpuUser = detail?.user || 0;
      const cpuSystem = detail?.system || 0;
      // Use user+system if available, otherwise fall back to total utilization (system.cpu.util[,,avg1])
      const cpuTotal = computeCpuTotal(cpuUser, cpuSystem, detail?.total || 0);
      const memUtil = zHost?.memory?.utilization || 0;
      const memTotalGb = zHost?.memory?.totalBytes
        ? bytesToGb(zHost.memory.totalBytes)
        : device.ramGb;

      // Determine Retellect process status — Python telemetry is authoritative
      const procEntry = zHost ? procByHost.get(zHost.hostId) : undefined;
      const pythonProcs = zHost ? retellectProcsByHost.get(zHost.hostId) : undefined;
      // If the feed is live, pass [] for hosts with no python items so
      // `determineRtStatus` can honestly conclude not-installed / unknown.
      const retellectProcsForStatus = hasProcCpuFeed && zHost
        ? (pythonProcs ?? [])
        : undefined;
      const rtResult = determineRtStatus({
        retellectEnabled: device.retellectEnabled,
        zabbixHostExists: !!zHost,
        procMatch: procEntry ? { count: procEntry.count } : null,
        retellectProcs: retellectProcsForStatus,
      });
      const rtProcessStatus = rtResult.status;
      const rtProcessCount = rtResult.processCount;
      const freshestAgeSec = rtResult.freshestAgeSec;
      const retellectCpuTotal = rtResult.retellectCpuTotal;

      rows.push({
        id: device.id,
        name: device.name,
        store: device.storeName,
        zabbixMatched: !!zHost,
        cpuModel: device.cpuModel || "—",
        // Prefer Zabbix-live RAM (vm.memory.size) when available; fall back to DB ramGb; show "—" if unknown
        ramGb: memTotalGb > 0
          ? `${memTotalGb.toFixed(1)} GB`
          : device.ramGb > 0
            ? `${device.ramGb} GB`
            : "—",
        retellectEnabled: device.retellectEnabled,
        rtProcessStatus,
        rtProcessCount,
        cpuUser,
        cpuSystem,
        cpuTotal,
        memUtil: Math.round(memUtil * 10) / 10,
        memTotalGb: Math.round(memTotalGb * 10) / 10,
        diskUtil: zHost?.disk?.utilization ? Math.round(zHost.disk.utilization * 10) / 10 : 0,
        numCpus: detail?.numCpus || 0,
        ip: zHost?.ip || "",
        groups: zHost?.groups || [],
        status: zHost ? zHost.status : device.status,
        risk: getRisk(cpuTotal),
        lastClock: detail?.lastClock || null,
        pythonProcs: pythonProcs ?? [],
        freshestAgeSec,
        retellectCpuTotal,
      });
    }

    return rows;
  }, [pilot, zabbix]);

  // Apply filters + sort
  const filteredHosts = useMemo(() => {
    let result = allHosts;
    if (filter === "high-risk") result = result.filter((h) => h.risk === "critical" || h.risk === "high");
    if (filter === "retellect") result = result.filter((h) => h.retellectEnabled);
    if (filter === "db-only") result = result.filter((h) => h.status !== "up");
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((h) => h.name.toLowerCase().includes(q) || h.store.toLowerCase().includes(q) || h.cpuModel.toLowerCase().includes(q));
    }
    return [...result].sort((a, b) => compareHosts(a, b, sortKey, sortDir));
  }, [allHosts, filter, search, sortKey, sortDir]);

  // Connection status counts — answers „kiek hostu pajungta ir kiek gaunam duomenis“
  const connectionStats = useMemo(() => {
    // Wall-clock freshness is intentional on a live dashboard.
    // eslint-disable-next-line react-hooks/purity
    const nowUnix = Math.floor(Date.now() / 1000);
    return computeConnectionStats(allHosts, nowUnix);
  }, [allHosts]);

  const procCpuMeta = zabbix.procCpuMeta;
  const hasProcCpuFeed = (zabbix.procCpu?.length ?? 0) > 0;

  return (
    <>
      {/* Connection status header */}
      <div className="mb-4 grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatusTile
          label="DB devices"
          value={connectionStats.total}
          hint="Total hosts configured in pilot"
          tone="neutral"
        />
        <StatusTile
          label="Zabbix matched"
          value={`${connectionStats.matched} / ${connectionStats.total} `}
          hint="DB host key matches a monitored Zabbix host"
          tone={connectionStats.matched === connectionStats.total ? "ok" : "warn"}
        />
        <StatusTile
          label="Reporting CPU (<5 min)"
          value={`${connectionStats.reportingCpu} / ${connectionStats.matched} `}
          hint="Matched hosts with fresh system.cpu.util samples"
          tone={connectionStats.reportingCpu === connectionStats.matched && connectionStats.matched > 0 ? "ok" : "warn"}
        />
        <StatusTile
          label="Retellect running"
          value={`${connectionStats.retellectRunning} / ${connectionStats.retellectExpected} `}
          hint={
            hasProcCpuFeed
              ? "Hosts with fresh python.cpu telemetry vs. DB retellectEnabled flag"
              : procCpuMeta?.error
                ? `Python telemetry unavailable: ${procCpuMeta.error}`
                : "Python telemetry feed is empty — check Zabbix connection"
          }
          tone={
            !hasProcCpuFeed
              ? "warn"
              : connectionStats.retellectRunning === connectionStats.retellectExpected
                ? "ok"
                : "warn"
          }
        />
      </div>

      {/* Data Coverage banner — explains which columns will be populated vs "—" */}
      <DataCoverageBanner
        title={INVENTORY_COVERAGE.title}
        available={INVENTORY_COVERAGE.available}
        missing={INVENTORY_COVERAGE.missing}
        footer={INVENTORY_COVERAGE.footer}
      />

      {/* Filters */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <input
            type="text"
            placeholder="Search hosts..."
            className="w-48 text-sm border border-gray-200 rounded-lg py-1.5 px-3 bg-white"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {[
            { id: "all", label: "All" },
            { id: "high-risk", label: "High Risk" },
            { id: "retellect", label: "Retellect" },
          ].map((f) => (
            <span
              key={f.id}
              className={`px-3 py-1 rounded-full text-xs font-medium cursor-pointer ${
                filter === f.id ? "bg-blue-50 text-blue-700" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </span>
          ))}
          <span className="text-xs text-gray-500 ml-2">{filteredHosts.length} hosts</span>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50">
              <th className="py-3 px-3 w-7" />
              <SortableTh label="Host"    sortKey="name"     currentKey={sortKey} dir={sortDir} onClick={toggleSort} />
              <SortableTh label="Store"   sortKey="store"    currentKey={sortKey} dir={sortDir} onClick={toggleSort} />
              <SortableTh label="CPU Model" sortKey="cpuModel" currentKey={sortKey} dir={sortDir} onClick={toggleSort} />
              <SortableTh label="RAM (GB)"  sortKey="ramGb"    currentKey={sortKey} dir={sortDir} onClick={toggleSort} />
              <SortableTh label="RT Status" sortKey="rtStatus" align="center" currentKey={sortKey} dir={sortDir} onClick={toggleSort} />
              <SortableTh label="CPU User %" sortKey="cpuUser" align="right" currentKey={sortKey} dir={sortDir} onClick={toggleSort} />
              <SortableTh label="CPU Sys %"  sortKey="cpuSystem" align="right" currentKey={sortKey} dir={sortDir} onClick={toggleSort} />
              <SortableTh label="CPU Total %" sortKey="cpuTotal" align="right" currentKey={sortKey} dir={sortDir} onClick={toggleSort} />
            </tr>
          </thead>
          <tbody>
            {filteredHosts.map((h) => (
              <Fragment key={h.id}>
                <tr
                  className={`border-t border-gray-100 hover:bg-gray-50 cursor-pointer ${h.status === "down" || h.status === "inactive" ? "opacity-50" : ""}`}
                  onClick={() => setExpandedRow(expandedRow === h.id ? null : h.id)}
                >
                  <td className="py-2 px-3">
                    <span className={`text-xs text-gray-400 transition-transform inline-block ${expandedRow === h.id ? "rotate-90" : ""}`}>▶</span>
                  </td>
                  <td className="py-2 px-3">
                    <div className="font-medium font-mono text-xs">{h.name}</div>
                    {h.ip && <div className="text-[10px] text-gray-400">{h.ip}</div>}
                  </td>
                  <td className="py-2 px-3 text-gray-500 text-xs">{h.store}</td>
                  <td className="py-2 px-3 text-xs">{h.cpuModel}</td>
                  <td className="py-2 px-3 text-xs">{h.ramGb}</td>
                  <td className="py-2 px-3 text-center">
                    {h.status === "down" || h.status === "inactive" ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-gray-100 text-gray-500" title="Zabbix monitoring disabled for this host">
                        <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />Disabled
                      </span>
                    ) : h.rtProcessStatus === "running" ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700" title={`${h.rtProcessCount} process(es)`}>
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />Running
                      </span>
                    ) : h.rtProcessStatus === "stopped" ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-red-50 text-red-600" title="Process not running">
                        <span className="w-1.5 h-1.5 rounded-full bg-red-400" />Stopped
                      </span>
                    ) : h.rtProcessStatus === "not-installed" ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-gray-50 text-gray-400">
                        <span className="w-1.5 h-1.5 rounded-full bg-gray-300" />N/A
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-amber-50 text-amber-600" title="No process monitoring data">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />Unknown
                      </span>
                    )}
                  </td>
                  <td className={`py-2 px-3 text-right text-xs ${h.cpuUser > 3 ? "text-amber-600" : ""}`}>
                    {h.cpuUser > 0 ? `${h.cpuUser.toFixed(1)}%` : "—"}
                  </td>
                  <td className={`py-2 px-3 text-right text-xs ${h.cpuSystem > 3 ? "text-amber-600" : ""}`}>
                    {h.cpuSystem > 0 ? `${h.cpuSystem.toFixed(1)}%` : "—"}
                  </td>
                  <CpuTotalCell cpuTotal={h.cpuTotal} lastClock={h.lastClock} nowMs={nowMs} />
                </tr>
                {expandedRow === h.id && (
                  <tr>
                    <td colSpan={9} className="p-0">
                      <div className="bg-gray-50 p-4 border-t border-gray-200">
                        <div className="grid grid-cols-4 gap-3 mb-3">
                          <DetailCard label="CPU Cores" value={h.numCpus > 0 ? String(h.numCpus) : "—"} />
                          <DetailCard label="Memory Usage" value={h.memUtil > 0 ? `${h.memUtil}%` : "—"} warn={h.memUtil > 80} />
                          <DetailCard label="Disk Usage" value={h.diskUtil > 0 ? `${h.diskUtil}%` : "—"} warn={h.diskUtil > 80} />
                          <DetailCard label="Status" value={h.status === "up" ? "Monitored" : h.status === "active" ? "Active (DB)" : h.status} good={h.status === "up"} />
                        </div>
                        <div className="grid grid-cols-3 gap-3 mb-3">
                          <DetailCard label="Groups" value={h.groups.length > 0 ? h.groups.join(", ") : "—"} />
                          <DetailCard label="Last Data" value={h.lastClock ? new Date(h.lastClock).toLocaleString("lt-LT") : "—"} />
                          <DetailCard label="Total RAM" value={h.memTotalGb > 0 ? `${h.memTotalGb} GB` : "—"} />
                        </div>
                        <PythonProcessDrilldown host={h} feedAvailable={hasProcCpuFeed} feedError={procCpuMeta?.error ?? undefined} />
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {filteredHosts.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-gray-400">
                  {search ? `No hosts matching "${search}"` : "No hosts found"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div className="mt-4 flex gap-4 text-xs text-gray-400">
        <span><span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1" /> Running — Retellect process detected</span>
        <span><span className="inline-block w-1.5 h-1.5 rounded-full bg-red-400 mr-1" /> Stopped — process not running</span>
        <span><span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 mr-1" /> Unknown — no proc monitoring</span>
        <span><span className="inline-block w-1.5 h-1.5 rounded-full bg-gray-300 mr-1" /> N/A — not installed</span>
      </div>
    </>
  );
}

function DetailCard({ label, value, warn, good }: { label: string; value: string; warn?: boolean; good?: boolean }) {
  return (
    <div className="bg-white p-3 rounded border border-gray-200">
      <div className="text-xs text-gray-500 mb-0.5">{label}</div>
      <div className={`text-sm font-medium ${warn ? "text-amber-600" : good ? "text-emerald-600" : "text-gray-900"}`}>{value}</div>
    </div>
  );
}

/**
 * Per-host Python process CPU breakdown (HI-7).
 *
 * Answers: „which python workers are running on this host, how much CPU each
 * is burning, and how fresh is the signal?“ Source: Zabbix <proc>.cpu items.
 */
function PythonProcessDrilldown({
  host,
  feedAvailable,
  feedError,
}: {
  host: HostRow;
  feedAvailable: boolean;
  feedError?: string;
}) {
  // Dashboard reflects "now" vs. Zabbix last-clock — wall-clock freshness is
  // the whole point; purity rule does not apply here.
  // eslint-disable-next-line react-hooks/purity
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = host.pythonProcs;
  const total = host.retellectCpuTotal;

  // Narrative label based on current status
  let banner: { tone: "ok" | "warn" | "neutral"; text: string } | null = null;
  if (!feedAvailable) {
    banner = {
      tone: "warn",
      text: feedError
        ? `Python telemetry unavailable: ${feedError}`
        : "Python telemetry feed is empty — Zabbix connection required.",
    };
  } else if (host.rtProcessStatus === "not-installed") {
    banner = {
      tone: "neutral",
      text: "No python.cpu items configured for this host in Zabbix — Retellect is not deployed here.",
    };
  } else if (host.rtProcessStatus === "unknown") {
    banner = {
      tone: "warn",
      text: "DB žymi `retellectEnabled = true`, bet Zabbix nepublikuoja python.cpu — patikrinkite template'ą.",
    };
  } else if (host.rtProcessStatus === "stopped" && host.freshestAgeSec !== null) {
    banner = {
      tone: "warn",
      text: `Naujausias python.cpu mėginys — prieš ${formatAgeShort(host.freshestAgeSec)}. Procesas nešiunčia duomenų ≥ 5 min.`,
    };
  }

  const bannerBg =
    banner?.tone === "ok"
      ? "bg-emerald-50 border-emerald-200 text-emerald-700"
      : banner?.tone === "warn"
        ? "bg-amber-50 border-amber-200 text-amber-700"
        : "bg-gray-50 border-gray-200 text-gray-600";

  return (
    <div className="bg-white rounded border border-gray-200">
      <div className="px-3 py-2 border-b border-gray-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Retellect Python processes</span>
          <span className="text-[10px] text-gray-400">source: Zabbix &lt;proc&gt;.cpu (1-min avg)</span>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <span className="text-gray-500">
            Workers: <span className="font-medium text-gray-900">{rows.length}</span>
          </span>
          <span className="text-gray-500">
            Retellect CPU total:{" "}
            <span className={`font-medium ${total >= 10 ? "text-red-600" : total >= 5 ? "text-amber-600" : "text-gray-900"}`}>
              {rows.length > 0 ? `${total.toFixed(1)}%` : "—"}
            </span>
          </span>
        </div>
      </div>

      {banner && (
        <div className={`px-3 py-2 text-xs border-b ${bannerBg}`}>{banner.text}</div>
      )}

      {rows.length === 0 ? (
        <div className="px-3 py-4 text-xs text-gray-400 text-center">
          {feedAvailable
            ? "No python.cpu items for this host."
            : "—"}
        </div>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-gray-50 text-gray-500">
              <th className="text-left py-1.5 px-3 font-medium">Process</th>
              <th className="text-right py-1.5 px-3 font-medium">CPU %</th>
              <th className="text-right py-1.5 px-3 font-medium">Share of host</th>
              <th className="text-right py-1.5 px-3 font-medium">Last sample</th>
              <th className="text-center py-1.5 px-3 font-medium">Fresh?</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const ageSec = p.lastClockUnix > 0 ? Math.max(0, nowSec - p.lastClockUnix) : null;
              const fresh = ageSec !== null && ageSec < 300;
              const shareOfHost =
                host.cpuTotal > 0 ? Math.round((p.cpuValue / host.cpuTotal) * 1000) / 10 : null;
              return (
                <tr key={p.procName} className="border-t border-gray-100">
                  <td className="py-1.5 px-3 font-mono text-[11px]">{p.procName}</td>
                  <td
                    className={`py-1.5 px-3 text-right font-medium ${
                      p.cpuValue >= 10 ? "text-red-600" : p.cpuValue >= 5 ? "text-amber-600" : "text-gray-900"
                    }`}
                  >
                    {p.cpuValue.toFixed(1)}%
                  </td>
                  <td className="py-1.5 px-3 text-right text-gray-500">
                    {shareOfHost !== null ? `${shareOfHost.toFixed(1)}%` : "—"}
                  </td>
                  <td className="py-1.5 px-3 text-right text-gray-500">
                    {ageSec !== null ? `${formatAgeShort(ageSec)} ago` : "never"}
                  </td>
                  <td className="py-1.5 px-3 text-center">
                    {fresh ? (
                      <span className="inline-flex items-center gap-1 text-emerald-600">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />live
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-amber-600">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />stale
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SortableTh({
  label,
  sortKey,
  currentKey,
  dir,
  align = "left",
  onClick,
}: {
  label: string;
  sortKey: SortKey;
  currentKey: SortKey;
  dir: SortDir;
  align?: "left" | "right" | "center";
  onClick: (key: SortKey) => void;
}) {
  const active = currentKey === sortKey;
  const alignClass =
    align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
  const justifyClass =
    align === "right" ? "justify-end" : align === "center" ? "justify-center" : "justify-start";
  return (
    <th
      onClick={() => onClick(sortKey)}
      className={`${alignClass} py-3 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wide cursor-pointer select-none hover:bg-gray-100 transition-colors`}
      title={`Sort by ${label}`}
    >
      <span className={`inline-flex items-center gap-1 ${justifyClass} w-full`}>
        <span className={active ? "text-gray-800" : ""}>{label}</span>
        <span className={`text-[10px] ${active ? "text-blue-600" : "text-gray-300"}`}>
          {active ? (dir === "asc" ? "▲" : "▼") : "▵"}
        </span>
      </span>
    </th>
  );
}

/**
 * Data Coverage banner — explains which columns are populated vs empty,
 * and why. Collapsible so it stays out of the way once the user knows.
 */
// Host-Inventory-specific copy for the shared DataCoverageBanner.
const INVENTORY_COVERAGE = {
  title: "Data coverage: Rimi Zabbix šiuo metu publikuoja tik agreguotą CPU",
  available: (
    <>
      CPU Cores (system.cpu.num), CPU Load (system.cpu.load[,avg1]), CPU Total %
      (system.cpu.util[,,avg1]), 14-day history, Python proc telemetry (python.cpu).
    </>
  ),
  missing: (
    <>
      CPU Model, RAM (total + utilization), CPU User %, CPU Sys %, disk usage,
      per-process SCO CPU/RAM. Šituose stulpeliuose rodoma „—“.
    </>
  ),
  footer: (
    <>
      Todėl TOTAL % rodo duomenis, bet User/Sys stulpeliai tušti — ne bug&apos;as,
      o template-level trukumas. Kai Rimi atnaujins monitoring template&apos;ą,
      stulpeliai užsipildys automatiškai.
    </>
  ),
};

/**
 * CPU Total cell with stale-age indicator.
 * nowMs=0 on SSR and first client render → no badge (prevents hydration
 * mismatch). After mount, parent useEffect sets nowMs to Date.now() and the
 * badge fades in.
 */
function CpuTotalCell({
  cpuTotal,
  lastClock,
  nowMs,
}: {
  cpuTotal: number;
  lastClock: string | null;
  nowMs: number;
}) {
  if (cpuTotal <= 0) {
    return <td className="py-2 px-3 text-right font-medium text-xs text-gray-400">—</td>;
  }
  const lastClockMs = lastClock ? new Date(lastClock).getTime() : NaN;
  const ageSec =
    nowMs > 0 && Number.isFinite(lastClockMs)
      ? Math.max(0, Math.floor((nowMs - lastClockMs) / 1000))
      : null;
  const isStale = ageSec !== null && ageSec >= RT_STALE_THRESHOLD_SEC;
  const isLive = ageSec !== null && ageSec < RT_FRESHNESS_THRESHOLD_SEC;
  const showBadge = ageSec !== null && !isLive;
  const colorClass = isStale
    ? "text-gray-400"
    : cpuTotal >= 10
      ? "text-red-600"
      : cpuTotal >= 5
        ? "text-amber-600"
        : "text-emerald-600";
  return (
    <td className={`py-2 px-3 text-right font-medium text-xs ${colorClass}`}>
      <span className="inline-flex items-center gap-1 justify-end">
        <span>{cpuTotal}%</span>
        {showBadge && (
          <span
            className={`text-[10px] font-normal ${isStale ? "text-gray-400" : "text-amber-500"}`}
            title={isStale ? "Stale: Zabbix data older than 30 min" : "Zabbix data older than 5 min"}
          >
            {formatAgeShort(ageSec!)}
          </span>
        )}
      </span>
    </td>
  );
}

function StatusTile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string | number;
  hint: string;
  tone: "ok" | "warn" | "neutral";
}) {
  const border =
    tone === "ok" ? "border-emerald-200 bg-emerald-50/40"
    : tone === "warn" ? "border-amber-200 bg-amber-50/40"
    : "border-gray-200 bg-white";
  const valueColor =
    tone === "ok" ? "text-emerald-700"
    : tone === "warn" ? "text-amber-700"
    : "text-gray-900";
  return (
    <div className={`rounded-lg border px-4 py-3 ${border}`} title={hint}>
      <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">{label}</div>
      <div className={`text-lg font-semibold ${valueColor}`}>{value}</div>
      <div className="text-[11px] text-gray-500 mt-1 leading-tight">{hint}</div>
    </div>
  );
}
