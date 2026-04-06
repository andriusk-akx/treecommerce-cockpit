import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import { getZabbixClient } from "@/lib/zabbix/client";
import { fetchSource } from "@/lib/data-source";
import DataSourceStatus from "@/app/components/DataSourceStatus";
import type { HostResources } from "@/lib/zabbix/types";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ pilotId: string }>;
}

interface CpuModelGroup {
  model: string;
  hostCount: number;
  hosts: { name: string; cpu: number; ram: number; retellect: boolean }[];
  avgCpu: number;
  p95Cpu: number;
  peakCpu: number;
  headroom: number;
}

export default async function PilotCpuAnalysisPage({ params }: PageProps) {
  const { pilotId } = await params;

  const pilot = await prisma.pilot.findUnique({
    where: { id: pilotId },
    include: {
      devices: { include: { store: { select: { name: true } } } },
    },
  });

  if (!pilot) return notFound();

  // Fetch Zabbix resource metrics
  const resourceResult = await fetchSource(`zabbix-resources-cpu-${pilotId}`, {
    source: "zabbix",
    label: "Zabbix CPU Metrikos",
    env: "prod",
    fetcher: async () => {
      const client = getZabbixClient();
      return client.getResourceMetrics();
    },
  });

  const resources: HostResources[] = resourceResult.data || [];
  const resourceMap = new Map(resources.map((r) => [r.hostName, r]));

  // Build CPU model groups by joining device DB data with Zabbix metrics
  const modelGroups = new Map<string, CpuModelGroup>();

  for (const device of pilot.devices) {
    const model = device.cpuModel || "Nežinomas";
    const zabbixData = resourceMap.get(device.name);
    const cpuUtil = zabbixData?.cpu?.utilization || 0;
    const ramUtil = zabbixData?.memory?.utilization || 0;

    if (!modelGroups.has(model)) {
      modelGroups.set(model, {
        model,
        hostCount: 0,
        hosts: [],
        avgCpu: 0,
        p95Cpu: 0,
        peakCpu: 0,
        headroom: 0,
      });
    }

    const group = modelGroups.get(model)!;
    group.hostCount++;
    group.hosts.push({
      name: device.name,
      cpu: cpuUtil,
      ram: ramUtil,
      retellect: device.retellectEnabled,
    });
  }

  // Calculate aggregated metrics per model
  const groups = Array.from(modelGroups.values()).map((group) => {
    const cpuValues = group.hosts.map((h) => h.cpu).filter((v) => v > 0).sort((a, b) => a - b);
    if (cpuValues.length > 0) {
      group.avgCpu = Math.round((cpuValues.reduce((s, v) => s + v, 0) / cpuValues.length) * 10) / 10;
      group.peakCpu = Math.round(cpuValues[cpuValues.length - 1] * 10) / 10;
      const p95Index = Math.floor(cpuValues.length * 0.95);
      group.p95Cpu = Math.round(cpuValues[Math.min(p95Index, cpuValues.length - 1)] * 10) / 10;
      group.headroom = Math.round((100 - group.p95Cpu) * 10) / 10;
    } else {
      group.headroom = 100;
    }
    return group;
  }).sort((a, b) => b.avgCpu - a.avgCpu);

  // Overall summary
  const allCpuValues = groups.flatMap((g) => g.hosts.map((h) => h.cpu)).filter((v) => v > 0);
  const overallAvg = allCpuValues.length > 0 ? Math.round((allCpuValues.reduce((s, v) => s + v, 0) / allCpuValues.length) * 10) / 10 : 0;
  const overallPeak = allCpuValues.length > 0 ? Math.round(Math.max(...allCpuValues) * 10) / 10 : 0;
  const highCpuHosts = allCpuValues.filter((v) => v > 80).length;

  return (
    <div>
      <DataSourceStatus
        sources={[{
          source: resourceResult.source,
          label: resourceResult.label,
          env: resourceResult.env,
          status: resourceResult.status,
          cachedAt: resourceResult.cachedAt,
          error: resourceResult.error,
          fetchMs: resourceResult.fetchMs,
        }]}
      />

      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-800">CPU analizė — {pilot.name}</h2>
        <p className="text-xs text-gray-400 mt-0.5">CPU apkrovos analizė pagal procesoriaus modelį</p>
      </div>

      {/* KPI Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">CPU modeliai</p>
          <p className="text-2xl font-bold text-gray-900">{groups.length}</p>
        </div>
        <div className={`bg-white rounded-lg border ${overallAvg > 80 ? "border-red-200" : overallAvg > 60 ? "border-orange-200" : "border-green-200"} px-4 py-3`}>
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">Vid. CPU</p>
          <p className={`text-2xl font-bold ${overallAvg > 80 ? "text-red-600" : overallAvg > 60 ? "text-orange-600" : "text-green-600"}`}>{overallAvg}%</p>
        </div>
        <div className={`bg-white rounded-lg border ${overallPeak > 90 ? "border-red-200" : "border-gray-200"} px-4 py-3`}>
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">Pikas CPU</p>
          <p className={`text-2xl font-bold ${overallPeak > 90 ? "text-red-600" : "text-gray-900"}`}>{overallPeak}%</p>
        </div>
        <div className={`bg-white rounded-lg border ${highCpuHosts > 0 ? "border-red-200" : "border-green-200"} px-4 py-3`}>
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">CPU &gt;80%</p>
          <p className={`text-2xl font-bold ${highCpuHosts > 0 ? "text-red-600" : "text-green-600"}`}>{highCpuHosts}</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">Visi įrenginiai</p>
          <p className="text-2xl font-bold text-gray-900">{pilot.devices.length}</p>
        </div>
      </div>

      {/* CPU Model Groups */}
      <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-3">Analizė pagal CPU modelį</h3>

      {groups.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 px-5 py-12 text-center">
          <p className="text-gray-400">Įrenginių su CPU informacija dar nėra.</p>
          <p className="text-xs text-gray-300 mt-1">Pridėkite įrenginius su cpuModel lauku per duomenų bazę.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <div key={group.model} className="bg-white rounded-lg border border-gray-200 p-5">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h4 className="font-semibold text-gray-900">{group.model}</h4>
                  <p className="text-xs text-gray-400">{group.hostCount} įrenginių</p>
                </div>
                <div className="flex gap-6 text-right">
                  <div>
                    <p className="text-[10px] text-gray-400 uppercase">Vid. CPU</p>
                    <p className={`text-lg font-bold ${cpuColor(group.avgCpu)}`}>{group.avgCpu}%</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-gray-400 uppercase">P95 CPU</p>
                    <p className={`text-lg font-bold ${cpuColor(group.p95Cpu)}`}>{group.p95Cpu}%</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-gray-400 uppercase">Pikas</p>
                    <p className={`text-lg font-bold ${cpuColor(group.peakCpu)}`}>{group.peakCpu}%</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-gray-400 uppercase">Atsarga</p>
                    <p className={`text-lg font-bold ${
                      group.headroom < 10 ? "text-red-600" :
                      group.headroom < 20 ? "text-orange-600" :
                      "text-green-600"
                    }`}>{group.headroom}%</p>
                  </div>
                </div>
              </div>

              {/* Individual hosts */}
              <div className="border-t border-gray-100 pt-3 mt-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {group.hosts.map((host) => (
                    <div key={host.name} className="flex items-center gap-2 text-xs">
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                        host.retellect ? "bg-blue-500" : "bg-gray-300"
                      }`} />
                      <span className="text-gray-700 truncate flex-1">{host.name}</span>
                      <div className="flex items-center gap-1">
                        <div className="w-16 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${
                            host.cpu >= 90 ? "bg-red-500" :
                            host.cpu >= 80 ? "bg-orange-500" :
                            host.cpu >= 60 ? "bg-yellow-500" :
                            "bg-green-500"
                          }`} style={{ width: `${Math.min(100, host.cpu)}%` }} />
                        </div>
                        <span className={`w-10 text-right font-medium ${cpuColor(host.cpu)}`}>{host.cpu}%</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Disclaimer */}
      <div className="mt-6 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
        <p className="text-xs text-amber-700">
          <strong>Pastaba:</strong> CPU metrikos rodomos realiu laiku iš Zabbix. P95 ir pikas apskaičiuoti iš dabartinių
          momentinių reikšmių, ne iš istorinių duomenų. Tikslesnei analizei reikėtų Zabbix trend duomenų.
        </p>
      </div>
    </div>
  );
}

function cpuColor(value: number): string {
  if (value >= 90) return "text-red-600";
  if (value >= 80) return "text-orange-600";
  if (value >= 60) return "text-yellow-600";
  return "text-green-600";
}
