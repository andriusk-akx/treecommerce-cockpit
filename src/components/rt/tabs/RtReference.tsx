"use client";

import { useMemo } from "react";
import type { RtPilotData, ZabbixData } from "../RtPilotWorkspace";

export function RtReference({ pilot, zabbix }: { pilot: RtPilotData; zabbix: ZabbixData }) {
  // Build per-device resource overview from live data
  const hostResources = useMemo(() => {
    const cpuDetail = new Map<string, { user: number; system: number; numCpus: number }>();
    for (const item of zabbix.cpuDetail) {
      if (!cpuDetail.has(item.hostId)) cpuDetail.set(item.hostId, { user: 0, system: 0, numCpus: 0 });
      const entry = cpuDetail.get(item.hostId)!;
      if (item.key === "system.cpu.util[,user]") entry.user = item.value;
      if (item.key === "system.cpu.util[,system]") entry.system = item.value;
      if (item.key === "system.cpu.num") entry.numCpus = item.value;
    }

    const zabbixByName = new Map(zabbix.hosts.map((h) => [h.hostName, h]));

    return pilot.devices
      .map((device) => {
        const zHost = zabbixByName.get(device.sourceHostKey || "") || zabbixByName.get(device.name);
        const detail = zHost ? cpuDetail.get(zHost.hostId) : null;
        const cpuUser = detail?.user || 0;
        const cpuSystem = detail?.system || 0;
        const cpuTotal = cpuUser + cpuSystem;
        const cpuFree = 100 - cpuTotal;
        const memUsed = zHost?.memory?.utilization || 0;
        const memFree = 100 - memUsed;
        const ramGb = zHost?.memory ? zHost.memory.totalBytes / 1024 / 1024 / 1024 : device.ramGb;
        const diskUsed = zHost?.disk?.utilization || 0;

        return {
          name: device.name,
          cores: detail?.numCpus || 0,
          ramGb: Math.round(ramGb * 10) / 10,
          cpuUser: Math.round(cpuUser * 10) / 10,
          cpuSystem: Math.round(cpuSystem * 10) / 10,
          cpuFree: Math.round(cpuFree * 10) / 10,
          memUsed: Math.round(memUsed * 10) / 10,
          memFree: Math.round(memFree * 10) / 10,
          diskUsed: Math.round(diskUsed * 10) / 10,
          hasMatch: !!zHost,
        };
      });
  }, [pilot, zabbix]);

  // Filter to matched hosts only for the summary
  const matchedResources = hostResources.filter((h) => h.hasMatch);

  return (
    <>
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-gray-800">Resource Overview — Matched Hosts</h2>
        <p className="text-xs text-gray-400 mt-0.5">
          Live resource utilization snapshot for DB devices with Zabbix match. Reference store comparison requires historical data (Zabbix history.get).
        </p>
      </div>

      {/* Stacked resource bars per host */}
      <div className="bg-white rounded-lg border border-gray-200 p-5 mb-6">
        <h3 className="font-semibold text-gray-900 mb-4">CPU Resource Distribution (live)</h3>
        <div className="space-y-4">
          {hostResources.map((h) => (
            <div key={h.name}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-gray-700 font-mono">{h.name}</span>
                {h.hasMatch ? (
                  <span className="text-xs text-gray-400">{h.cores} cores, {h.ramGb} GB RAM</span>
                ) : (
                  <span className="text-xs text-gray-400">no Zabbix match</span>
                )}
              </div>
              {h.hasMatch ? (
                <>
                  {/* CPU stacked bar */}
                  <div className="h-6 bg-gray-100 rounded flex overflow-hidden mb-1">
                    <div className="bg-blue-500 h-full flex items-center justify-center" style={{ width: `${h.cpuUser}%` }}>
                      {h.cpuUser > 5 && <span className="text-[9px] text-white font-medium">{h.cpuUser}%</span>}
                    </div>
                    <div className="bg-amber-500 h-full flex items-center justify-center" style={{ width: `${h.cpuSystem}%` }}>
                      {h.cpuSystem > 5 && <span className="text-[9px] text-white font-medium">{h.cpuSystem}%</span>}
                    </div>
                  </div>
                  {/* Memory bar */}
                  <div className="h-3 bg-gray-100 rounded flex overflow-hidden">
                    <div
                      className={`h-full ${h.memUsed > 80 ? "bg-red-400" : h.memUsed > 60 ? "bg-amber-400" : "bg-emerald-400"}`}
                      style={{ width: `${h.memUsed}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-[10px] text-gray-400 mt-0.5">
                    <span>CPU: user {h.cpuUser}% + sys {h.cpuSystem}% = {Math.round((h.cpuUser + h.cpuSystem) * 10) / 10}%</span>
                    <span>RAM: {h.memUsed}% used, disk: {h.diskUsed}%</span>
                  </div>
                </>
              ) : (
                <div className="h-6 bg-gray-100 rounded flex items-center justify-center">
                  <span className="text-[9px] text-gray-500">no data</span>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Legend */}
        <div className="flex gap-4 mt-4 pt-3 border-t border-gray-100 text-xs text-gray-500">
          <span className="flex items-center gap-1"><span className="w-3 h-2 bg-blue-500 rounded" /> CPU User</span>
          <span className="flex items-center gap-1"><span className="w-3 h-2 bg-amber-500 rounded" /> CPU System</span>
          <span className="flex items-center gap-1"><span className="w-3 h-2 bg-emerald-400 rounded" /> Memory</span>
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {matchedResources.length > 0 && (() => {
          const avgCpu = matchedResources.reduce((s, h) => s + h.cpuUser + h.cpuSystem, 0) / matchedResources.length;
          const maxCpu = Math.max(...matchedResources.map((h) => h.cpuUser + h.cpuSystem));
          const avgMem = matchedResources.reduce((s, h) => s + h.memUsed, 0) / matchedResources.length;
          return (
            <>
              <div className="bg-white rounded-lg border border-gray-200 p-4 text-center">
                <div className={`text-2xl font-bold ${avgCpu > 50 ? "text-amber-600" : "text-emerald-600"}`}>{avgCpu.toFixed(1)}%</div>
                <div className="text-xs text-gray-500">Avg CPU across hosts</div>
              </div>
              <div className="bg-white rounded-lg border border-gray-200 p-4 text-center">
                <div className={`text-2xl font-bold ${maxCpu > 80 ? "text-red-600" : "text-gray-900"}`}>{maxCpu.toFixed(1)}%</div>
                <div className="text-xs text-gray-500">Peak CPU (any host)</div>
              </div>
              <div className="bg-white rounded-lg border border-gray-200 p-4 text-center">
                <div className={`text-2xl font-bold ${avgMem > 70 ? "text-amber-600" : "text-emerald-600"}`}>{avgMem.toFixed(1)}%</div>
                <div className="text-xs text-gray-500">Avg Memory utilization</div>
              </div>
            </>
          );
        })()}
      </div>

      {/* Note */}
      <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
        <p className="text-xs text-amber-700">
          <strong>Note:</strong> Reference store workload shape (24h pattern, hourly trends) requires Zabbix history.get API access.
          Currently showing live snapshot for matched DB devices only. Request history.get permission from Zabbix admin for full reference analysis.
        </p>
      </div>
    </>
  );
}
