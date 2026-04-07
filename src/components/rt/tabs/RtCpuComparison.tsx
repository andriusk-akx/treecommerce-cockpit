"use client";

import { useMemo } from "react";
import type { RtPilotData, ZabbixData } from "../RtPilotWorkspace";

interface CpuGroup {
  model: string;
  hostCount: number;
  cores: number;
  hosts: { name: string; cpuTotal: number; memUtil: number; retellect: boolean }[];
  avgCpu: number;
  peakCpu: number;
  headroom: number;
  risk: "critical" | "high" | "low";
}

export function RtCpuComparison({ pilot, zabbix }: { pilot: RtPilotData; zabbix: ZabbixData }) {
  const groups = useMemo(() => {
    const zabbixByName = new Map(zabbix.hosts.map((h) => [h.hostName, h]));
    const cpuDetail = new Map<string, { user: number; system: number; numCpus: number }>();
    for (const item of zabbix.cpuDetail) {
      if (!cpuDetail.has(item.hostId)) cpuDetail.set(item.hostId, { user: 0, system: 0, numCpus: 0 });
      const entry = cpuDetail.get(item.hostId)!;
      if (item.key === "system.cpu.util[,user]") entry.user = item.value;
      if (item.key === "system.cpu.util[,system]") entry.system = item.value;
      if (item.key === "system.cpu.num") entry.numCpus = item.value;
    }

    const modelMap = new Map<string, CpuGroup>();

    // DB devices with CPU model info only
    for (const device of pilot.devices) {
      const model = device.cpuModel || "Unknown";
      if (!modelMap.has(model)) {
        modelMap.set(model, { model, hostCount: 0, cores: 0, hosts: [], avgCpu: 0, peakCpu: 0, headroom: 100, risk: "low" });
      }
      const group = modelMap.get(model)!;
      group.hostCount++;
      const zHost = zabbixByName.get(device.sourceHostKey || "") || zabbixByName.get(device.name);
      const detail = zHost ? cpuDetail.get(zHost.hostId) : null;
      const cpuTotal = detail ? Math.round((detail.user + detail.system) * 10) / 10 : 0;
      if (detail?.numCpus) group.cores = detail.numCpus;
      group.hosts.push({
        name: device.name,
        cpuTotal,
        memUtil: zHost?.memory?.utilization ? Math.round(zHost.memory.utilization * 10) / 10 : 0,
        retellect: device.retellectEnabled,
      });
    }

    // Calculate aggregates
    return Array.from(modelMap.values()).map((group) => {
      const cpuValues = group.hosts.map((h) => h.cpuTotal).filter((v) => v > 0);
      if (cpuValues.length > 0) {
        group.avgCpu = Math.round(cpuValues.reduce((s, v) => s + v, 0) / cpuValues.length * 10) / 10;
        group.peakCpu = Math.round(Math.max(...cpuValues) * 10) / 10;
        group.headroom = Math.round((100 - group.peakCpu) * 10) / 10;
      }
      group.risk = group.peakCpu >= 80 ? "critical" : group.peakCpu >= 60 ? "high" : "low";
      return group;
    }).sort((a, b) => b.avgCpu - a.avgCpu);
  }, [pilot, zabbix]);

  return (
    <>
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-gray-800">CPU Comparison by Hardware Class</h2>
        <p className="text-xs text-gray-400 mt-0.5">
          Live Zabbix data for DB devices grouped by CPU model
        </p>
      </div>

      {/* Summary Table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden mb-6">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50">
              <th className="text-left py-3 px-4 text-xs font-semibold text-gray-500 uppercase">Hardware Class</th>
              <th className="text-center py-3 px-4 text-xs font-semibold text-gray-500 uppercase">Hosts</th>
              <th className="text-center py-3 px-4 text-xs font-semibold text-gray-500 uppercase">Cores</th>
              <th className="text-right py-3 px-4 text-xs font-semibold text-gray-500 uppercase">Avg CPU</th>
              <th className="text-right py-3 px-4 text-xs font-semibold text-gray-500 uppercase">Peak CPU</th>
              <th className="text-right py-3 px-4 text-xs font-semibold text-gray-500 uppercase">Headroom</th>
              <th className="text-center py-3 px-4 text-xs font-semibold text-gray-500 uppercase">Risk</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.model} className="border-t border-gray-100">
                <td className="py-3 px-4 font-medium">{g.model}</td>
                <td className="py-3 px-4 text-center">{g.hostCount}</td>
                <td className="py-3 px-4 text-center text-gray-500">{g.cores > 0 ? g.cores : "—"}</td>
                <td className={`py-3 px-4 text-right font-medium ${cpuColor(g.avgCpu)}`}>
                  {g.avgCpu > 0 ? `${g.avgCpu}%` : "—"}
                </td>
                <td className={`py-3 px-4 text-right font-medium ${cpuColor(g.peakCpu)}`}>
                  {g.peakCpu > 0 ? `${g.peakCpu}%` : "—"}
                </td>
                <td className={`py-3 px-4 text-right font-medium ${
                  g.headroom < 15 ? "text-red-600" : g.headroom < 30 ? "text-amber-600" : "text-emerald-600"
                }`}>
                  {g.peakCpu > 0 ? `${g.headroom}%` : "—"}
                </td>
                <td className="py-3 px-4 text-center">
                  <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium ${
                    g.risk === "critical" ? "bg-red-50 text-red-700" :
                    g.risk === "high" ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"
                  }`}>
                    {g.risk}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Per-group detail cards */}
      <div className="space-y-4">
        {groups.map((g) => (
          <div key={g.model} className="bg-white rounded-lg border border-gray-200 p-5">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h4 className="font-semibold text-gray-900">{g.model}</h4>
                <p className="text-xs text-gray-400">{g.hostCount} hosts, {g.cores > 0 ? `${g.cores} cores` : "cores unknown"}</p>
              </div>
              <div className="flex gap-4 text-right">
                <div>
                  <div className="text-[10px] text-gray-400 uppercase">Avg</div>
                  <div className={`text-lg font-bold ${cpuColor(g.avgCpu)}`}>{g.avgCpu > 0 ? `${g.avgCpu}%` : "—"}</div>
                </div>
                <div>
                  <div className="text-[10px] text-gray-400 uppercase">Peak</div>
                  <div className={`text-lg font-bold ${cpuColor(g.peakCpu)}`}>{g.peakCpu > 0 ? `${g.peakCpu}%` : "—"}</div>
                </div>
                <div>
                  <div className="text-[10px] text-gray-400 uppercase">Headroom</div>
                  <div className={`text-lg font-bold ${g.headroom < 15 ? "text-red-600" : g.headroom < 30 ? "text-amber-600" : "text-emerald-600"}`}>
                    {g.peakCpu > 0 ? `${g.headroom}%` : "—"}
                  </div>
                </div>
              </div>
            </div>
            <div className="border-t border-gray-100 pt-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {g.hosts.map((host) => (
                  <div key={host.name} className="flex items-center gap-2 text-xs">
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      host.retellect ? "bg-blue-500" : "bg-gray-300"
                    }`} />
                    <span className="text-gray-700 truncate flex-1 font-mono">{host.name}</span>
                    <div className="flex items-center gap-1">
                      <div className="w-12 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${
                          host.cpuTotal >= 10 ? "bg-red-500" :
                          host.cpuTotal >= 5 ? "bg-amber-500" :
                          host.cpuTotal > 0 ? "bg-emerald-500" : "bg-gray-200"
                        }`} style={{ width: `${Math.min(100, Math.max(host.cpuTotal, 1))}%` }} />
                      </div>
                      <span className={`w-10 text-right font-medium ${cpuColor(host.cpuTotal)}`}>
                        {host.cpuTotal > 0 ? `${host.cpuTotal}%` : "—"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>

      {groups.length === 0 && (
        <div className="bg-white rounded-lg border border-gray-200 px-5 py-12 text-center">
          <p className="text-gray-400">No CPU data available. Check Zabbix connection.</p>
        </div>
      )}
    </>
  );
}

function cpuColor(value: number): string {
  if (value >= 80) return "text-red-600";
  if (value >= 60) return "text-amber-600";
  if (value >= 40) return "text-yellow-600";
  if (value > 0) return "text-emerald-600";
  return "text-gray-400";
}
