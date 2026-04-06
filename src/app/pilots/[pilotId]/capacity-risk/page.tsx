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

export default async function PilotCapacityRiskPage({ params }: PageProps) {
  const { pilotId } = await params;

  const pilot = await prisma.pilot.findUnique({
    where: { id: pilotId },
    include: {
      devices: { include: { store: { select: { name: true } } } },
    },
  });

  if (!pilot) return notFound();

  // Fetch current resource metrics
  const resourceResult = await fetchSource(`zabbix-resources-cap-${pilotId}`, {
    source: "zabbix",
    label: "Zabbix Resursai",
    env: "prod",
    fetcher: async () => {
      const client = getZabbixClient();
      return client.getResourceMetrics();
    },
  });

  const resources: HostResources[] = resourceResult.data || [];
  const resourceMap = new Map(resources.map((r) => [r.hostName, r]));

  // Estimate capacity risk per device
  const riskAssessments = pilot.devices.map((device) => {
    const zabbix = resourceMap.get(device.name);
    const currentCpu = zabbix?.cpu?.utilization || 0;
    const currentRam = zabbix?.memory?.utilization || 0;
    const currentDisk = zabbix?.disk?.utilization || 0;

    // Simple risk model: estimate Retellect overhead at 15-25% CPU, 10-15% RAM
    const retellectCpuOverhead = device.retellectEnabled ? 0 : 20; // Expected additional load
    const retellectRamOverhead = device.retellectEnabled ? 0 : 12;
    const projectedCpu = currentCpu + retellectCpuOverhead;
    const projectedRam = currentRam + retellectRamOverhead;

    let riskLevel: "low" | "medium" | "high" | "critical" = "low";
    if (projectedCpu > 95 || projectedRam > 95 || currentDisk > 95) riskLevel = "critical";
    else if (projectedCpu > 85 || projectedRam > 85 || currentDisk > 90) riskLevel = "high";
    else if (projectedCpu > 70 || projectedRam > 70 || currentDisk > 80) riskLevel = "medium";

    return {
      device,
      currentCpu,
      currentRam,
      currentDisk,
      projectedCpu: Math.min(100, projectedCpu),
      projectedRam: Math.min(100, projectedRam),
      retellectCpuOverhead,
      retellectRamOverhead,
      riskLevel,
      hasZabbixData: !!zabbix,
    };
  }).sort((a, b) => {
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    return order[a.riskLevel] - order[b.riskLevel];
  });

  const criticalCount = riskAssessments.filter((r) => r.riskLevel === "critical").length;
  const highCount = riskAssessments.filter((r) => r.riskLevel === "high").length;
  const mediumCount = riskAssessments.filter((r) => r.riskLevel === "medium").length;
  const safeCount = riskAssessments.filter((r) => r.riskLevel === "low").length;

  const riskColors: Record<string, string> = {
    critical: "bg-red-100 text-red-700 border-red-200",
    high: "bg-orange-100 text-orange-700 border-orange-200",
    medium: "bg-yellow-100 text-yellow-700 border-yellow-200",
    low: "bg-green-100 text-green-700 border-green-200",
  };

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
        <h2 className="text-lg font-semibold text-gray-800">Talpos rizika — {pilot.name}</h2>
        <p className="text-xs text-gray-400 mt-0.5">Retellect diegimo talpos vertinimas pagal dabartinę apkrovą</p>
      </div>

      {/* Disclaimer */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 mb-6">
        <p className="text-xs text-blue-700">
          <strong>Modelio aprašymas:</strong> Šis vertinimas remiasi prielaida, kad Retellect prideda ~20% CPU ir ~12% RAM apkrovos
          prie esamos. Tai yra <em>grubi prognozė</em>, ne tikslus matavimas. Tikslesniam vertinimui reikia Retellect piloto
          duomenų iš referencinio įrenginio.
        </p>
      </div>

      {/* Risk Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div className={`bg-white rounded-lg border ${criticalCount > 0 ? "border-red-300" : "border-gray-200"} px-4 py-3`}>
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">Kritinė rizika</p>
          <p className={`text-2xl font-bold ${criticalCount > 0 ? "text-red-600" : "text-gray-900"}`}>{criticalCount}</p>
        </div>
        <div className={`bg-white rounded-lg border ${highCount > 0 ? "border-orange-300" : "border-gray-200"} px-4 py-3`}>
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">Aukšta rizika</p>
          <p className={`text-2xl font-bold ${highCount > 0 ? "text-orange-600" : "text-gray-900"}`}>{highCount}</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">Vidutinė</p>
          <p className="text-2xl font-bold text-yellow-600">{mediumCount}</p>
        </div>
        <div className="bg-white rounded-lg border border-green-200 px-4 py-3">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">Saugu</p>
          <p className="text-2xl font-bold text-green-600">{safeCount}</p>
        </div>
      </div>

      {/* Risk Assessment Table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-left text-xs uppercase tracking-wide">
            <tr>
              <th className="px-4 py-3">Įrenginys</th>
              <th className="px-4 py-3">Parduotuvė</th>
              <th className="px-4 py-3">CPU modelis</th>
              <th className="px-4 py-3">Dabartinis CPU</th>
              <th className="px-4 py-3">Prognozuojamas CPU</th>
              <th className="px-4 py-3">Dabartinis RAM</th>
              <th className="px-4 py-3">Rizika</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {riskAssessments.map((assessment) => (
              <tr key={assessment.device.id} className={`hover:bg-gray-50 ${
                assessment.riskLevel === "critical" ? "bg-red-50/30" :
                assessment.riskLevel === "high" ? "bg-orange-50/30" : ""
              }`}>
                <td className="px-4 py-3">
                  <div className="font-medium text-gray-900">{assessment.device.name}</div>
                  {assessment.device.retellectEnabled && (
                    <span className="text-[10px] text-blue-600 font-medium">Retellect aktyvus</span>
                  )}
                  {!assessment.hasZabbixData && (
                    <span className="text-[10px] text-gray-400">Nėra Zabbix duomenų</span>
                  )}
                </td>
                <td className="px-4 py-3 text-xs text-gray-600">{assessment.device.store?.name || "—"}</td>
                <td className="px-4 py-3 text-xs text-gray-700">{assessment.device.cpuModel || "—"}</td>
                <td className="px-4 py-3">
                  <CpuBar value={assessment.currentCpu} />
                </td>
                <td className="px-4 py-3">
                  {!assessment.device.retellectEnabled ? (
                    <div className="flex items-center gap-1">
                      <CpuBar value={assessment.projectedCpu} />
                      <span className="text-[10px] text-gray-400">+{assessment.retellectCpuOverhead}%</span>
                    </div>
                  ) : (
                    <span className="text-xs text-gray-400">Jau aktyvus</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <CpuBar value={assessment.currentRam} />
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold ${riskColors[assessment.riskLevel]}`}>
                    {assessment.riskLevel === "critical" ? "KRITINĖ" :
                     assessment.riskLevel === "high" ? "AUKŠTA" :
                     assessment.riskLevel === "medium" ? "VIDUTINĖ" : "SAUGU"}
                  </span>
                </td>
              </tr>
            ))}
            {riskAssessments.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-400">
                  Įrenginių dar nėra. Pridėkite per duomenų bazę.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Methodology Note */}
      <div className="mt-6 bg-gray-50 border border-gray-200 rounded-lg px-4 py-3">
        <p className="text-[10px] text-gray-500 uppercase tracking-wide font-medium mb-1">Metodologija</p>
        <p className="text-xs text-gray-600">
          Prognozuojamas CPU = dabartinis CPU + ~20% Retellect prieaugis. RAM prognozė = dabartinis + ~12%.
          Rizikos lygiai: Kritinė (&gt;95%), Aukšta (&gt;85%), Vidutinė (&gt;70%), Saugu (&lt;70%).
          Šie skaičiai yra orientaciniai — tiksliam vertinimui rekomenduojame pilotinį diegimą referenciniame įrenginyje.
        </p>
      </div>
    </div>
  );
}

function CpuBar({ value }: { value: number }) {
  let color = "bg-green-500";
  let textColor = "text-green-700";
  if (value >= 90) { color = "bg-red-500"; textColor = "text-red-700"; }
  else if (value >= 80) { color = "bg-orange-500"; textColor = "text-orange-700"; }
  else if (value >= 60) { color = "bg-yellow-500"; textColor = "text-yellow-700"; }
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-16 h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`} style={{ width: `${Math.min(100, value)}%` }} />
      </div>
      <span className={`text-xs font-medium ${textColor}`}>{Math.round(value)}%</span>
    </div>
  );
}
