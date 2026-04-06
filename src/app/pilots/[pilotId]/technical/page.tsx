import { getZabbixClient } from "@/lib/zabbix/client";
import { fetchSource } from "@/lib/data-source";
import DataSourceStatus from "@/app/components/DataSourceStatus";
import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import Link from "next/link";
import type { HostResources } from "@/lib/zabbix/types";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ pilotId: string }>;
}

export default async function PilotTechnicalPage({ params }: PageProps) {
  const { pilotId } = await params;

  const pilot = await prisma.pilot.findUnique({
    where: { id: pilotId },
    select: { id: true, name: true, shortCode: true, productType: true },
  });

  if (!pilot) return notFound();

  const resourceResult = await fetchSource(`zabbix-resources-${pilotId}`, {
    source: "zabbix",
    label: "Zabbix Resursai",
    env: "prod",
    fetcher: async () => {
      const client = getZabbixClient();
      return client.getResourceMetrics();
    },
  });

  const resources: HostResources[] = resourceResult.data || [];

  const totalHosts = resources.length;
  const hostsUp = resources.filter((h) => h.status === "up").length;
  const hostsDown = totalHosts - hostsUp;
  const avgCpu = resources.filter((h) => h.cpu).length > 0
    ? Math.round((resources.filter((h) => h.cpu).reduce((s, h) => s + (h.cpu?.utilization || 0), 0) / resources.filter((h) => h.cpu).length) * 10) / 10
    : 0;
  const avgMemory = resources.filter((h) => h.memory).length > 0
    ? Math.round((resources.filter((h) => h.memory).reduce((s, h) => s + (h.memory?.utilization || 0), 0) / resources.filter((h) => h.memory).length) * 10) / 10
    : 0;
  const highCpuCount = resources.filter((h) => h.cpu && h.cpu.utilization > 80).length;

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
        <h2 className="text-lg font-semibold text-gray-800">Techninė apžvalga</h2>
        <p className="text-xs text-gray-400 mt-0.5">CPU, RAM, disko ir tinklo monitoringas — {pilot.name}</p>
      </div>

      {/* KPI Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <MiniCard label="Visų hostų" value={String(totalHosts)} />
        <MiniCard label="Aktyvūs" value={String(hostsUp)} variant="success" />
        <MiniCard label="Neaktyvūs" value={String(hostsDown)} variant={hostsDown > 0 ? "danger" : "success"} />
        <MiniCard label="Vidutinis CPU" value={`${avgCpu}%`} variant={avgCpu > 80 ? "danger" : avgCpu > 60 ? "warning" : "success"} />
        <MiniCard label="Vidutinis RAM" value={`${avgMemory}%`} variant={avgMemory > 80 ? "danger" : avgMemory > 60 ? "warning" : "success"} />
      </div>

      {/* Resources Table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-left text-xs uppercase tracking-wide">
            <tr>
              <th className="px-4 py-3">Hostas</th>
              <th className="px-4 py-3">Statusas</th>
              <th className="px-4 py-3">CPU</th>
              <th className="px-4 py-3">RAM</th>
              <th className="px-4 py-3">Diskas</th>
              <th className="px-4 py-3">Tinklas</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {resources.map((resource) => (
              <tr key={resource.hostId} className={`hover:bg-gray-50 ${resource.status === "down" ? "bg-red-50/40" : ""}`}>
                <td className="px-4 py-3 font-medium text-gray-900">{resource.hostName}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${
                    resource.status === "up" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${resource.status === "up" ? "bg-green-500" : "bg-red-500"}`}></span>
                    {resource.status === "up" ? "Aktyvus" : "Neaktyvus"}
                  </span>
                </td>
                <td className="px-4 py-3">
                  {resource.cpu ? <ResourceBar value={resource.cpu.utilization} suffix="%" /> : <span className="text-gray-400 text-xs">—</span>}
                </td>
                <td className="px-4 py-3">
                  {resource.memory ? <ResourceBar value={resource.memory.utilization} suffix="%" /> : <span className="text-gray-400 text-xs">—</span>}
                </td>
                <td className="px-4 py-3">
                  {resource.disk ? <ResourceBar value={resource.disk.utilization} suffix="%" /> : <span className="text-gray-400 text-xs">—</span>}
                </td>
                <td className="px-4 py-3">
                  {resource.network ? (
                    <span className="text-xs text-gray-600">
                      {formatBps(resource.network.inBps)} / {formatBps(resource.network.outBps)}
                    </span>
                  ) : <span className="text-gray-400 text-xs">—</span>}
                </td>
              </tr>
            ))}
            {resources.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">Resursų duomenys nepasiekiami.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ResourceBar({ value, suffix = "" }: { value: number; suffix?: string }) {
  let color = "bg-green-500";
  let textColor = "text-green-700";
  if (value >= 90) { color = "bg-red-500"; textColor = "text-red-700"; }
  else if (value >= 80) { color = "bg-orange-500"; textColor = "text-orange-700"; }
  else if (value >= 60) { color = "bg-yellow-500"; textColor = "text-yellow-700"; }
  return (
    <div className="flex items-center gap-2">
      <div className="w-24 h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`} style={{ width: `${Math.min(100, value)}%` }} />
      </div>
      <span className={`text-xs font-medium ${textColor}`}>{Math.round(value * 10) / 10}{suffix}</span>
    </div>
  );
}

function formatBps(bps: number): string {
  if (bps === 0) return "0 b/s";
  if (bps < 1000) return `${Math.round(bps)} b/s`;
  if (bps < 1000000) return `${(bps / 1000).toFixed(1)} Kb/s`;
  return `${(bps / 1000000).toFixed(1)} Mb/s`;
}

function MiniCard({ label, value, variant }: { label: string; value: string; variant?: "success" | "warning" | "danger" }) {
  let borderColor = "border-gray-200";
  let valueColor = "text-gray-900";
  if (variant === "success") { borderColor = "border-green-200"; valueColor = "text-green-600"; }
  else if (variant === "warning") { borderColor = "border-orange-200"; valueColor = "text-orange-600"; }
  else if (variant === "danger") { borderColor = "border-red-200"; valueColor = "text-red-600"; }
  return (
    <div className={`bg-white rounded-lg border ${borderColor} px-4 py-3`}>
      <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">{label}</p>
      <p className={`text-2xl font-bold ${valueColor}`}>{value}</p>
    </div>
  );
}
