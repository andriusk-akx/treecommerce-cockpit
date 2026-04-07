"use client";

import { Fragment, useState, useMemo } from "react";
import type { RtPilotData, ZabbixData } from "../RtPilotWorkspace";
import { determineRtStatus, buildProcByHost, type RtProcessStatus } from "./rt-inventory-helpers";

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

export function RtInventory({ pilot, zabbix }: { pilot: RtPilotData; zabbix: ZabbixData }) {
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  // Build host rows from DB devices only
  const allHosts = useMemo(() => {
    const rows: HostRow[] = [];
    const zabbixByName = new Map(zabbix.hosts.map((h) => [h.hostName, h]));
    const zabbixByHostId = new Map(zabbix.hosts.map((h) => [h.hostId, h]));

    // CPU detail map
    const cpuDetail = new Map<string, { user: number; system: number; numCpus: number; lastClock: string | null }>();
    for (const item of zabbix.cpuDetail) {
      if (!cpuDetail.has(item.hostId)) {
        cpuDetail.set(item.hostId, { user: 0, system: 0, numCpus: 0, lastClock: null });
      }
      const entry = cpuDetail.get(item.hostId)!;
      if (item.key === "system.cpu.util[,user]") { entry.user = item.value; entry.lastClock = item.lastClock; }
      if (item.key === "system.cpu.util[,system]") entry.system = item.value;
      if (item.key === "system.cpu.num") entry.numCpus = item.value;
    }

    // Process items map: hostId -> retellect process info
    const procByHost = buildProcByHost(
      (zabbix.procItems || []).map(p => ({ hostId: p.hostId, key: p.key, name: p.name, value: p.value }))
    );

    // DB devices only
    for (const device of pilot.devices) {
      const zHost = zabbixByName.get(device.sourceHostKey || "") || zabbixByName.get(device.name);
      const detail = zHost ? cpuDetail.get(zHost.hostId) : null;

      const cpuUser = detail?.user || 0;
      const cpuSystem = detail?.system || 0;
      const cpuTotal = Math.round((cpuUser + cpuSystem) * 10) / 10;
      const memUtil = zHost?.memory?.utilization || 0;
      const memTotalGb = zHost?.memory?.totalBytes ? zHost.memory.totalBytes / 1024 / 1024 / 1024 : device.ramGb;

      // Determine Retellect process status
      const procEntry = zHost ? procByHost.get(zHost.hostId) : undefined;
      const rtResult = determineRtStatus({
        retellectEnabled: device.retellectEnabled,
        zabbixHostExists: !!zHost,
        procMatch: procEntry ? { count: procEntry.count } : null,
      });
      const rtProcessStatus = rtResult.status;
      const rtProcessCount = rtResult.processCount;

      rows.push({
        id: device.id,
        name: device.name,
        store: device.storeName,
        cpuModel: device.cpuModel,
        ramGb: `${memTotalGb > 0 ? memTotalGb.toFixed(1) : device.ramGb} GB`,
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
      });
    }

    return rows;
  }, [pilot, zabbix]);

  // Apply filters
  const filteredHosts = useMemo(() => {
    let result = allHosts;
    if (filter === "high-risk") result = result.filter((h) => h.risk === "critical" || h.risk === "high");
    if (filter === "retellect") result = result.filter((h) => h.retellectEnabled);
    if (filter === "db-only") result = result.filter((h) => h.status !== "up");
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((h) => h.name.toLowerCase().includes(q) || h.store.toLowerCase().includes(q) || h.cpuModel.toLowerCase().includes(q));
    }
    return result;
  }, [allHosts, filter, search]);

  return (
    <>
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
              <th className="text-left py-3 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Host</th>
              <th className="text-left py-3 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Store</th>
              <th className="text-left py-3 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">CPU</th>
              <th className="text-left py-3 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">RAM</th>
              <th className="text-center py-3 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">RT Status</th>
              <th className="text-right py-3 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">CPU User</th>
              <th className="text-right py-3 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">CPU Sys</th>
              <th className="text-right py-3 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Total</th>
            </tr>
          </thead>
          <tbody>
            {filteredHosts.map((h) => (
              <Fragment key={h.id}>
                <tr
                  className="border-t border-gray-100 hover:bg-gray-50 cursor-pointer"
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
                    {h.rtProcessStatus === "running" ? (
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
                  <td className={`py-2 px-3 text-right font-medium text-xs ${
                    h.cpuTotal >= 10 ? "text-red-600" : h.cpuTotal >= 5 ? "text-amber-600" : h.cpuTotal > 0 ? "text-emerald-600" : "text-gray-400"
                  }`}>
                    {h.cpuTotal > 0 ? `${h.cpuTotal}%` : "—"}
                  </td>
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
