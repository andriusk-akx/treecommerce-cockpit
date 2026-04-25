"use client";

import { useMemo } from "react";
import type { RtPilotData, ZabbixData } from "../RtPilotWorkspace";

export function RtCapacityRisk({ pilot, zabbix }: { pilot: RtPilotData; zabbix: ZabbixData }) {
  const analysis = useMemo(() => {
    const cpuDetail = new Map<string, { user: number; system: number; numCpus: number }>();
    for (const item of zabbix.cpuDetail) {
      if (!cpuDetail.has(item.hostId)) cpuDetail.set(item.hostId, { user: 0, system: 0, numCpus: 0 });
      const entry = cpuDetail.get(item.hostId)!;
      if (item.key === "system.cpu.util[,user]") entry.user = item.value;
      if (item.key === "system.cpu.util[,system]") entry.system = item.value;
      if (item.key === "system.cpu.num") entry.numCpus = item.value;
    }

    const zabbixByName = new Map(zabbix.hosts.map((h) => [h.hostName, h]));

    // Group DB devices by CPU model
    const byGroup = new Map<string, { hosts: string[]; cpuValues: number[]; cores: number; ramValues: number[] }>();
    for (const device of pilot.devices) {
      const zHost = zabbixByName.get(device.sourceHostKey || "") || zabbixByName.get(device.name);
      const detail = zHost ? cpuDetail.get(zHost.hostId) : null;
      const cores = detail?.numCpus || 0;
      const cpuTotal = detail ? detail.user + detail.system : 0;
      const ramGb = zHost?.memory ? zHost.memory.totalBytes / 1024 / 1024 / 1024 : device.ramGb;

      const groupKey = device.cpuModel || "Unknown";

      if (!byGroup.has(groupKey)) byGroup.set(groupKey, { hosts: [], cpuValues: [], cores, ramValues: [] });
      const group = byGroup.get(groupKey)!;
      group.hosts.push(device.name);
      if (cpuTotal > 0) group.cpuValues.push(cpuTotal);
      if (ramGb > 0) group.ramValues.push(ramGb);
    }

    // Build scenarios
    const groups = Array.from(byGroup.entries()).map(([name, data]) => {
      const currentPeak = data.cpuValues.length > 0 ? Math.max(...data.cpuValues) : 0;
      const avgCpu = data.cpuValues.length > 0 ? data.cpuValues.reduce((s, v) => s + v, 0) / data.cpuValues.length : 0;
      const avgRam = data.ramValues.length > 0 ? data.ramValues.reduce((s, v) => s + v, 0) / data.ramValues.length : 0;
      return {
        name,
        hostCount: data.hosts.length,
        cores: data.cores,
        avgRam: Math.round(avgRam * 10) / 10,
        currentCpu: Math.round(avgCpu * 10) / 10,
        currentPeak: Math.round(currentPeak * 10) / 10,
        // Simulate volume increases
        at120: Math.round(currentPeak * 1.2 * 10) / 10,
        at150: Math.round(currentPeak * 1.5 * 10) / 10,
        at200: Math.round(currentPeak * 2.0 * 10) / 10,
      };
    }).sort((a, b) => b.currentCpu - a.currentCpu);

    return groups;
  }, [pilot, zabbix]);

  const scenarios = [
    { label: "Current load", factor: 1.0 },
    { label: "+20% volume", factor: 1.2 },
    { label: "+50% volume", factor: 1.5 },
    { label: "2x peak (holiday)", factor: 2.0 },
  ];

  return (
    <>
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-gray-800">Capacity Risk Analysis</h2>
        <p className="text-xs text-gray-400 mt-0.5">
          Projected CPU utilization under volume growth scenarios based on current live Zabbix data for DB devices
        </p>
      </div>

      {/* Volume Scenario Table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden mb-6">
        <div className="px-5 py-3 bg-gray-50 border-b border-gray-200">
          <h3 className="font-semibold text-gray-900">Volume Growth Scenarios</h3>
          <p className="text-xs text-gray-400">Extrapolated from current peak CPU values</p>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="text-left py-3 px-4 text-xs font-semibold text-gray-500 uppercase">Scenario</th>
              {analysis.map((g) => (
                <th key={g.name} className="text-center py-3 px-4 text-xs font-semibold text-gray-500 uppercase">
                  {g.name}
                  <div className="text-[10px] font-normal text-gray-400">{g.hostCount} hosts</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {scenarios.map((scenario) => (
              <tr key={scenario.label} className="border-t border-gray-100">
                <td className="py-3 px-4 font-medium text-gray-700">{scenario.label}</td>
                {analysis.map((g) => {
                  const projected = Math.round(g.currentPeak * scenario.factor * 10) / 10;
                  const danger = projected > 90;
                  const warn = projected > 70;
                  return (
                    <td key={g.name} className={`py-3 px-4 text-center font-medium ${
                      danger ? "text-red-600 bg-red-50" : warn ? "text-amber-600 bg-amber-50" : "text-emerald-600"
                    }`}>
                      {g.currentPeak > 0 ? (
                        <>
                          {projected}%
                          {danger && <span className="block text-[10px]">RISK</span>}
                        </>
                      ) : "—"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Risk Summary */}
      <div className="bg-white rounded-lg border border-gray-200 p-5 mb-6">
        <h3 className="font-semibold text-gray-900 mb-3">Risk Summary</h3>
        <div className="space-y-2 text-sm">
          {analysis.map((g) => {
            const hasData = g.currentPeak > 0;
            const at150 = g.currentPeak * 1.5;
            // Only compute risk when we actually have peak CPU data. Without a peak value
            // the math collapses to zero and would falsely show "low" — show "insufficient
            // data" instead so demo viewers don't mistake missing data for a clean bill of health.
            const risk = !hasData
              ? "insufficient-data"
              : at150 > 100 ? "critical"
              : at150 > 80 ? "high"
              : at150 > 60 ? "medium"
              : "low";
            return (
              <div key={g.name} className="flex items-center gap-3">
                <span className={`w-2 h-2 rounded-full ${
                  risk === "critical" ? "bg-red-500" :
                  risk === "high" ? "bg-amber-500" :
                  risk === "medium" ? "bg-yellow-500" :
                  risk === "low" ? "bg-emerald-500" :
                  "bg-gray-300"
                }`} />
                <span className="font-medium text-gray-700 w-48">{g.name}</span>
                <span className="text-gray-500">
                  {hasData
                    ? <>Current: {g.currentCpu}% avg, {g.currentPeak}% peak — at +50% volume: {Math.round(at150)}%</>
                    : <>No peak CPU data — needs Zabbix history/trends</>
                  }
                </span>
                <span className={`ml-auto text-xs font-medium px-2 py-0.5 rounded ${
                  risk === "critical" ? "bg-red-50 text-red-700" :
                  risk === "high" ? "bg-amber-50 text-amber-700" :
                  risk === "medium" ? "bg-yellow-50 text-yellow-700" :
                  risk === "low" ? "bg-emerald-50 text-emerald-700" :
                  "bg-gray-100 text-gray-600"
                }`}>
                  {risk === "insufficient-data" ? "insufficient data" : risk}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Disclaimer */}
      <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
        <p className="text-xs text-amber-700">
          <strong>Note:</strong> Projections are linear extrapolations from current live CPU values.
          For accurate capacity planning, historical peak data (from Zabbix history/trends API) is needed.
          Current data shows a single snapshot, not sustained peak load patterns.
        </p>
      </div>
    </>
  );
}
