"use client";

import type { RtPilotData, ZabbixData } from "../RtPilotWorkspace";

export function RtOverview({ pilot, zabbix }: { pilot: RtPilotData; zabbix: ZabbixData }) {
  // Build CPU model groups from DB devices + Zabbix live metrics
  const cpuModelMap = new Map<string, { hosts: number; cpuValues: number[] }>();
  const zabbixByName = new Map(zabbix.hosts.map((h) => [h.hostName, h]));

  // Also build CPU detail map (user/system per host)
  const cpuDetailByHostId = new Map<string, { user: number; system: number; numCpus: number }>();
  for (const item of zabbix.cpuDetail) {
    if (!cpuDetailByHostId.has(item.hostId)) {
      cpuDetailByHostId.set(item.hostId, { user: 0, system: 0, numCpus: 0 });
    }
    const entry = cpuDetailByHostId.get(item.hostId)!;
    if (item.key === "system.cpu.util[,user]") entry.user = item.value;
    if (item.key === "system.cpu.util[,system]") entry.system = item.value;
    if (item.key === "system.cpu.num") entry.numCpus = item.value;
  }

  for (const device of pilot.devices) {
    const model = device.cpuModel || "Unknown";
    if (!cpuModelMap.has(model)) cpuModelMap.set(model, { hosts: 0, cpuValues: [] });
    const group = cpuModelMap.get(model)!;
    group.hosts++;
    // Try to find matching Zabbix host by sourceHostKey or name
    const zHost = zabbixByName.get(device.sourceHostKey || "") || zabbixByName.get(device.name);
    if (zHost?.cpu) {
      group.cpuValues.push(zHost.cpu.utilization);
    }
  }

  const cpuByClass = Array.from(cpuModelMap.entries()).map(([name, data]) => {
    const avg = data.cpuValues.length > 0 ? Math.round(data.cpuValues.reduce((s, v) => s + v, 0) / data.cpuValues.length * 10) / 10 : 0;
    return { name, hosts: data.hosts, avgCpu: avg, risk: avg > 70 ? "critical" : "low" };
  }).sort((a, b) => b.avgCpu - a.avgCpu);

  // Calculate totals from DB devices only (only those with Zabbix matches)
  const matchedZabbixNames = new Set(
    pilot.devices.map((d) => d.sourceHostKey || d.name).filter(Boolean)
  );
  const matchedHosts = zabbix.hosts.filter((h) => matchedZabbixNames.has(h.hostName) && h.status === "up");
  const highCpuHosts = matchedHosts.filter((h) => {
    const detail = cpuDetailByHostId.get(h.hostId);
    const totalCpu = detail ? detail.user + detail.system : (h.cpu?.utilization || 0);
    return totalCpu > 70;
  });

  const allCpuValues = matchedHosts.map((h) => {
    const detail = cpuDetailByHostId.get(h.hostId);
    return detail ? detail.user + detail.system : (h.cpu?.utilization || 0);
  }).filter((v) => v > 0);
  const avgCpuAll = allCpuValues.length > 0 ? Math.round(allCpuValues.reduce((s, v) => s + v, 0) / allCpuValues.length * 10) / 10 : 0;
  const peakCpuAll = allCpuValues.length > 0 ? Math.round(Math.max(...allCpuValues) * 10) / 10 : 0;

  return (
    <>
      {/* Project Card */}
      <div className="bg-white rounded-lg border border-gray-200 border-l-4 border-l-blue-400 p-5 mb-6">
        <div className="flex items-center gap-2 mb-2">
          <h3 className="font-semibold text-gray-900">Project: {pilot.name}</h3>
          <span className="px-2 py-0.5 rounded bg-blue-50 text-blue-700 text-xs font-medium">{pilot.clientName}</span>
        </div>
        <p className="text-sm text-gray-600">
          {pilot.goalSummary || "Determine whether existing SCO hardware can sustain the Retellect workload. Identify which hosts need replacement, which configurations are viable, and what the deployment recommendation should be."}
        </p>
      </div>

      {/* KPIs — from live data */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <KpiCard label="Matched Hosts" value={String(matchedHosts.length)} subtitle={`of ${pilot.deviceCount} devices`} />
        <KpiCard label="DB Devices" value={String(pilot.deviceCount)} subtitle={`${pilot.storeCount} stores`} />
        <KpiCard
          label="Avg CPU (live)"
          value={`${avgCpuAll}%`}
          className={avgCpuAll > 70 ? "text-red-600" : avgCpuAll > 50 ? "text-amber-600" : "text-emerald-600"}
        />
        <KpiCard
          label="Peak CPU (live)"
          value={`${peakCpuAll}%`}
          className={peakCpuAll > 80 ? "text-red-600" : "text-gray-900"}
        />
      </div>

      {/* Two-column: Investigation + Risks */}
      <div className="grid grid-cols-2 gap-6 mb-6">
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="font-semibold text-gray-900 mb-3">Live CPU Summary (Zabbix)</h3>
          <div className="space-y-2 text-sm">
            {matchedHosts.map((host) => {
              const detail = cpuDetailByHostId.get(host.hostId);
              const totalCpu = detail ? Math.round((detail.user + detail.system) * 10) / 10 : 0;
              const ramGb = host.memory ? (host.memory.totalBytes / 1024 / 1024 / 1024).toFixed(1) : "?";
              return (
                <div key={host.hostId} className="flex justify-between items-center">
                  <div>
                    <span className="text-gray-700 font-medium">{host.hostName}</span>
                    <span className="text-gray-400 ml-2 text-xs">{ramGb} GB RAM</span>
                  </div>
                  <span className={`font-medium ${totalCpu > 5 ? "text-amber-600" : "text-emerald-600"}`}>
                    CPU {totalCpu}%
                  </span>
                </div>
              );
            })}
            {matchedHosts.length === 0 && (
              <p className="text-gray-400">No Zabbix match for DB devices</p>
            )}
          </div>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="font-semibold text-gray-900 mb-3">Key Observations</h3>
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${highCpuHosts.length > 0 ? "bg-red-500" : "bg-emerald-500"} flex-shrink-0`} />
              <span>{highCpuHosts.length} hosts with CPU  {">"} 70% right now</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0" />
              <span>{pilot.deviceCount} devices configured in pilot DB</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0" />
              <span>{pilot.devices.filter((d) => d.retellectEnabled).length} devices with Retellect enabled</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-gray-400 flex-shrink-0" />
              <span>History API unavailable — showing current snapshots only</span>
            </div>
          </div>
        </div>
      </div>

      {/* CPU by Hardware Class */}
      {cpuByClass.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-5 mb-6">
          <h3 className="font-semibold text-gray-900 mb-3">CPU by Hardware Class (DB devices)</h3>
          <div className="space-y-3">
            {cpuByClass.map((c) => (
              <div key={c.name}>
                <div className="flex justify-between text-sm mb-1">
                  <span>{c.name} ({c.hosts} devices)</span>
                  <span className={`font-medium ${c.avgCpu > 0 ? (c.risk === "critical" ? "text-red-600" : "text-gray-700") : "text-gray-400"}`}>
                    {c.avgCpu > 0 ? `${c.avgCpu}% avg CPU` : "no Zabbix match"}
                  </span>
                </div>
                <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${c.risk === "critical" ? "bg-red-500" : c.avgCpu > 0 ? "bg-emerald-500" : "bg-gray-300"}`}
                    style={{ width: `${Math.max(c.avgCpu, 2)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Data Sources */}
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <h3 className="font-semibold text-gray-900 mb-3">Data Sources</h3>
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs">
            <span className={`w-2 h-2 rounded-full ${zabbix.status === "live" ? "bg-emerald-500" : zabbix.status === "cached" ? "bg-amber-500" : "bg-red-500"}`} />
            <span className="text-gray-700 font-medium">Zabbix Monitoring</span>
            <span className={`font-semibold ${zabbix.status === "live" ? "text-emerald-600" : "text-amber-600"}`}>
              {zabbix.status.toUpperCase()}
            </span>
            <span className="text-gray-400">{zabbix.fetchMs}ms</span>
            <span className="text-gray-400">— {zabbix.hosts.length} hosts total, {matchedHosts.length} matched to DB devices</span>
          </div>
          {zabbix.error && (
            <div className="text-xs text-red-500 ml-4">{zabbix.error}</div>
          )}
          <div className="flex items-center gap-2 text-xs">
            <span className="w-2 h-2 rounded-full bg-blue-500" />
            <span className="text-gray-700 font-medium">Pilot DB</span>
            <span className="text-blue-600 font-semibold">OK</span>
            <span className="text-gray-400">— {pilot.deviceCount} devices, {pilot.storeCount} stores</span>
          </div>
          <div className="flex items-center gap-2 text-xs mt-2">
            <span className="w-2 h-2 rounded-full bg-gray-400" />
            <span className="text-gray-500">Zabbix history.get / trend.get — restricted by API token permissions</span>
          </div>
        </div>
      </div>
    </>
  );
}

function KpiCard({ label, value, className, subtitle }: { label: string; value: string; className?: string; subtitle?: string }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className={`text-2xl font-bold ${className || "text-gray-900"}`}>{value}</div>
      <div className="text-xs text-gray-500 mt-0.5">{label}</div>
      {subtitle && <div className="text-[10px] text-gray-400">{subtitle}</div>}
    </div>
  );
}
