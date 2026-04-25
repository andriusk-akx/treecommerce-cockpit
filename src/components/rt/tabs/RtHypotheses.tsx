"use client";

import { useMemo } from "react";
import type { RtPilotData, ZabbixData } from "../RtPilotWorkspace";

export function RtHypotheses({ pilot, zabbix }: { pilot: RtPilotData; zabbix: ZabbixData }) {
  // Generate data-driven hypotheses from live data for DB devices only
  const insights = useMemo(() => {
    const cpuDetail = new Map<string, { user: number; system: number; numCpus: number }>();
    for (const item of zabbix.cpuDetail) {
      if (!cpuDetail.has(item.hostId)) cpuDetail.set(item.hostId, { user: 0, system: 0, numCpus: 0 });
      const entry = cpuDetail.get(item.hostId)!;
      if (item.key === "system.cpu.util[,user]") entry.user = item.value;
      if (item.key === "system.cpu.util[,system]") entry.system = item.value;
      if (item.key === "system.cpu.num") entry.numCpus = item.value;
    }

    const zabbixByName = new Map(zabbix.hosts.map((h) => [h.hostName, h]));

    // Build insights from DB devices only
    const hostCpu = pilot.devices
      .map((device) => {
        const zHost = zabbixByName.get(device.sourceHostKey || "") || zabbixByName.get(device.name);
        const d = zHost ? cpuDetail.get(zHost.hostId) : null;
        return {
          name: device.name,
          total: d ? d.user + d.system : 0,
          cores: d?.numCpus || 0,
          memUtil: zHost?.memory?.utilization || 0,
          ramGb: zHost?.memory ? zHost.memory.totalBytes / 1024 / 1024 / 1024 : device.ramGb,
          hasMatch: !!zHost,
        };
      });

    const matchedDevices = hostCpu.filter((h) => h.hasMatch);
    const highCpu = matchedDevices.filter((h) => h.total > 50);
    // Only consider hosts with a known RAM value for RAM hypotheses; unknown ≠ sufficient
    const hostsWithRam = matchedDevices.filter((h) => h.ramGb > 0);
    const hostsWithoutRam = matchedDevices.filter((h) => h.ramGb <= 0);
    const lowRam = hostsWithRam.filter((h) => h.ramGb < 5);
    // Memory utilization is only valid when Zabbix reports a value (>0 means we have it)
    const hostsWithMem = matchedDevices.filter((h) => h.memUtil > 0);
    const highMem = hostsWithMem.filter((h) => h.memUtil > 80);
    const lowCoreHosts = matchedDevices.filter((h) => h.cores > 0 && h.cores <= 4);
    const retellectDevices = pilot.devices.filter((d) => d.retellectEnabled);
    const nonRetellect = pilot.devices.filter((d) => !d.retellectEnabled);

    return {
      highCpu,
      lowRam,
      hostsWithRam,
      hostsWithoutRam,
      highMem,
      hostsWithMem,
      lowCoreHosts,
      retellectDevices,
      nonRetellect,
      matchedCount: matchedDevices.length,
    };
  }, [pilot, zabbix]);

  const hypotheses = [
    {
      id: "H1",
      title: "Low-core hosts may bottleneck under Retellect",
      confidence: insights.lowCoreHosts.length > 0 ? "high" : "low",
      evidence: insights.lowCoreHosts.length > 0
        ? `${insights.lowCoreHosts.length} hosts with ≤4 cores detected: ${insights.lowCoreHosts.map((h) => h.name).join(", ")}`
        : "No low-core hosts detected in matched inventory",
      recommendation: insights.lowCoreHosts.length > 0
        ? "Monitor these hosts during peak hours. Consider hardware upgrade or Retellect throttling."
        : "Current hardware appears adequate for core count.",
    },
    {
      id: "H2",
      title: "Memory-constrained hosts risk swap pressure with Retellect",
      // Cannot claim "sufficient RAM" when we have no RAM data for most hosts
      confidence: insights.lowRam.length > 0
        ? "medium"
        : insights.hostsWithRam.length === 0
        ? "unknown"
        : "low",
      evidence: insights.lowRam.length > 0
        ? `${insights.lowRam.length} hosts with <5 GB RAM: ${insights.lowRam.map((h) => `${h.name} (${h.ramGb.toFixed(1)} GB)`).join(", ")}`
        : insights.hostsWithRam.length === 0
        ? `No RAM data available — ${insights.hostsWithoutRam.length} matched hosts lack vm.memory.size in Zabbix and ramGb in DB`
        : `${insights.hostsWithRam.length}/${insights.matchedCount} matched hosts have RAM data, all ≥5 GB; remaining ${insights.hostsWithoutRam.length} unknown`,
      recommendation: insights.lowRam.length > 0
        ? "Upgrade RAM on these hosts before enabling Retellect. Minimum 8 GB recommended."
        : insights.hostsWithRam.length === 0
        ? "Collect RAM specs before making capacity claims: enable vm.memory.size in Zabbix or populate Device.ramGb in DB."
        : "RAM capacity appears sufficient across hosts with known specs; verify unknowns before rollout.",
    },
    {
      id: "H3",
      title: "High memory utilization may indicate resource pressure",
      confidence: insights.highMem.length > 0
        ? "high"
        : insights.hostsWithMem.length === 0
        ? "unknown"
        : "low",
      evidence: insights.highMem.length > 0
        ? `${insights.highMem.length} hosts with memory >80%: ${insights.highMem.map((h) => `${h.name} (${Math.round(h.memUtil)}%)`).join(", ")}`
        : insights.hostsWithMem.length === 0
        ? "No memory utilization data — vm.memory items not configured on matched hosts"
        : `${insights.hostsWithMem.length}/${insights.matchedCount} matched hosts report memory utilization, none above 80%`,
      recommendation: insights.highMem.length > 0
        ? "Investigate memory-heavy processes. Adding Retellect to these hosts may cause OOM issues."
        : insights.hostsWithMem.length === 0
        ? "Enable vm.memory.size and vm.memory.utilization in Zabbix to assess memory headroom."
        : "Memory headroom appears adequate for Retellect on hosts that report utilization.",
    },
    {
      id: "H4",
      title: "Device mapping needed for full monitoring integration",
      confidence: insights.matchedCount < pilot.deviceCount ? "medium" : "low",
      evidence: `${pilot.deviceCount} DB devices, ${insights.matchedCount} with Zabbix match. ${insights.retellectDevices.length} with Retellect enabled.`,
      recommendation: "Map DB device sourceHostKey to Zabbix host names for automated monitoring integration.",
    },
  ];

  const recommendations = [
    {
      priority: "high",
      title: "Configure proc.num[retellect] items on Rimi SCO WIN hosts",
      description: "Retellect process monitoring items (proc.num[retellect] or proc.num[rtagent]) are not yet present on the 109 Rimi SCO WIN hosts in Zabbix. Without them, RT Status shows 'Unknown' for every RT-enabled device because we have no evidence the process is actually running.",
      action: "StrongPoint / Rimi Zabbix admin to add proc.num[retellect] (or proc.num[rtagent]) to the Rimi SCO WIN host template.",
    },
    {
      priority: "high",
      title: "Map remaining DB devices to Zabbix hosts",
      description: `${pilot.deviceCount - insights.matchedCount} devices in the pilot DB have empty sourceHostKey fields or no Zabbix match. Without mapping, live metrics can't be correlated to specific devices.`,
      action: "Update Device.sourceHostKey with corresponding Zabbix host names.",
    },
    {
      priority: "medium",
      title: "Establish 2-week CPU history baseline",
      description: "Capacity projections and peak-vs-average analysis require sustained history. Current views use live item snapshots; heatmap and capacity tabs will only be fully accurate once history.get returns at least 2 weeks of system.cpu.util samples.",
      action: "Enable Zabbix history collection on CPU items and revisit capacity analysis after a 2-week baseline.",
    },
  ];

  return (
    <>
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-gray-800">Hypotheses & Recommendations</h2>
        <p className="text-xs text-gray-400 mt-0.5">
          Data-driven insights from live Zabbix metrics (matched DB devices) and pilot configuration
        </p>
      </div>

      {/* Hypotheses */}
      <div className="space-y-4 mb-8">
        {hypotheses.map((h) => (
          <div key={h.id} className="bg-white rounded-lg border border-gray-200 p-5">
            <div className="flex items-start justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-gray-400">{h.id}</span>
                <h4 className="font-semibold text-gray-900">{h.title}</h4>
              </div>
              <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                h.confidence === "high" ? "bg-red-50 text-red-700" :
                h.confidence === "medium" ? "bg-amber-50 text-amber-700" :
                h.confidence === "unknown" ? "bg-gray-100 text-gray-600" :
                "bg-gray-100 text-gray-500"
              }`}>
                {h.confidence === "unknown" ? "insufficient data" : `${h.confidence} confidence`}
              </span>
            </div>
            <div className="text-sm text-gray-600 mb-2">
              <span className="text-xs font-medium text-gray-500 uppercase">Evidence: </span>
              {h.evidence}
            </div>
            <div className="text-sm text-blue-700 bg-blue-50 rounded px-3 py-2">
              <span className="text-xs font-medium text-blue-500 uppercase">Recommendation: </span>
              {h.recommendation}
            </div>
          </div>
        ))}
      </div>

      {/* Action Items */}
      <h3 className="font-semibold text-gray-900 mb-3">Recommended Actions</h3>
      <div className="space-y-3">
        {recommendations.map((r, i) => (
          <div key={i} className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center gap-2 mb-1">
              <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                r.priority === "high" ? "bg-red-50 text-red-700" :
                r.priority === "medium" ? "bg-amber-50 text-amber-700" : "bg-blue-50 text-blue-700"
              }`}>
                {r.priority}
              </span>
              <h4 className="font-medium text-gray-900">{r.title}</h4>
            </div>
            <p className="text-sm text-gray-600 mb-1">{r.description}</p>
            <p className="text-sm text-emerald-700 bg-emerald-50 rounded px-3 py-1.5">{r.action}</p>
          </div>
        ))}
      </div>
    </>
  );
}
