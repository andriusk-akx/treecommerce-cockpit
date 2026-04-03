import { getZabbixClient } from "@/lib/zabbix/client";
import { fetchSource } from "@/lib/data-source";
import DataSourceStatus from "@/app/components/DataSourceStatus";
import type { HostResources } from "@/lib/zabbix/types";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{}>;
}

export default async function ResourcesPage({ searchParams }: PageProps) {
  await searchParams;

  const resourceResult = await fetchSource("zabbix-resources", {
    source: "zabbix",
    label: "Zabbix Resursai",
    env: "prod",
    fetcher: async () => {
      const client = getZabbixClient();
      return client.getResourceMetrics();
    },
  });

  const resources: HostResources[] = resourceResult.data || [];

  // Calculate summary statistics
  const totalHosts = resources.length;
  const hostsUp = resources.filter((h) => h.status === "up").length;
  const hostsDown = totalHosts - hostsUp;

  const avgCpu =
    resources.filter((h) => h.cpu).length > 0
      ? Math.round((resources.filter((h) => h.cpu).reduce((s, h) => s + (h.cpu?.utilization || 0), 0) / resources.filter((h) => h.cpu).length) * 10) / 10
      : 0;

  const avgMemory =
    resources.filter((h) => h.memory).length > 0
      ? Math.round((resources.filter((h) => h.memory).reduce((s, h) => s + (h.memory?.utilization || 0), 0) / resources.filter((h) => h.memory).length) * 10) / 10
      : 0;

  const highCpuCount = resources.filter((h) => h.cpu && h.cpu.utilization > 80).length;
  const highDiskCount = resources.filter((h) => h.disk && h.disk.utilization > 90).length;

  return (
    <div>
      {/* Data source status */}
      <DataSourceStatus
        sources={[
          {
            source: resourceResult.source,
            label: resourceResult.label,
            env: resourceResult.env,
            status: resourceResult.status,
            cachedAt: resourceResult.cachedAt,
            error: resourceResult.error,
            fetchMs: resourceResult.fetchMs,
          },
        ]}
      />

      {/* Header */}
      <div className="mb-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-800">Resursai</h2>
          <p className="text-xs text-gray-400 mt-0.5">CPU, RAM, disko ir tinklo monitoringas visiem hostams</p>
        </div>
      </div>

      {/* KPI Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <KpiCard label="Visų hostų" value={String(totalHosts)} />
        <KpiCard label="Aktyvūs" value={String(hostsUp)} variant="success" />
        <KpiCard label="Neaktyvūs" value={String(hostsDown)} variant={hostsDown > 0 ? "danger" : "success"} />
        <KpiCard label="Vidutinis CPU" value={`${avgCpu}%`} variant={avgCpu > 80 ? "danger" : avgCpu > 60 ? "warning" : "success"} />
        <KpiCard label="Vidutinis RAM" value={`${avgMemory}%`} variant={avgMemory > 80 ? "danger" : avgMemory > 60 ? "warning" : "success"} />
      </div>

      {/* Risk Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <div className="bg-white rounded-lg border border-red-200 px-4 py-3">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">Aukštas CPU ({'>'}80%)</p>
          <p className={`text-2xl font-bold ${highCpuCount > 0 ? "text-red-600" : "text-green-600"}`}>{highCpuCount}</p>
        </div>
        <div className="bg-white rounded-lg border border-red-200 px-4 py-3">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">Pilnas diskas ({'>'}90%)</p>
          <p className={`text-2xl font-bold ${highDiskCount > 0 ? "text-red-600" : "text-green-600"}`}>{highDiskCount}</p>
        </div>
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
              <th className="px-4 py-3">Tinklas (in/out)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {resources.map((resource) => (
              <tr
                key={resource.hostId}
                className={`hover:bg-gray-50 ${resource.status === "down" ? "bg-red-50/40" : ""}`}
              >
                <td className="px-4 py-3 font-medium text-gray-900">{resource.hostName}</td>
                <td className="px-4 py-3">
                  {resource.status === "up" ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-500"></span> Aktyvus
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">
                      <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse"></span> Neaktyvus
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {resource.cpu ? <ResourceBar value={resource.cpu.utilization} suffix="%" /> : <span className="text-gray-400 text-xs">—</span>}
                </td>
                <td className="px-4 py-3">
                  {resource.memory ? <ResourceBar value={resource.memory.utilization} suffix="%" /> : <span className="text-gray-400 text-xs">—</span>}
                </td>
                <td className="px-4 py-3">
                  {resource.disk ? (
                    <div>
                      <ResourceBar value={resource.disk.utilization} suffix="%" />
                      <p className="text-xs text-gray-400 mt-1">{resource.disk.path}</p>
                    </div>
                  ) : (
                    <span className="text-gray-400 text-xs">—</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {resource.network ? (
                    <span className="text-xs text-gray-600">
                      {formatBps(resource.network.inBps)} / {formatBps(resource.network.outBps)}
                    </span>
                  ) : (
                    <span className="text-gray-400 text-xs">—</span>
                  )}
                </td>
              </tr>
            ))}
            {resources.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                  Resursų duomenys nepasiekiami. Patikrinkite Zabbix jungtį.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Helper Components

function ResourceBar({ value, suffix = "" }: { value: number; suffix?: string }) {
  let color = "bg-green-500";
  let textColor = "text-green-700";

  if (value >= 90) {
    color = "bg-red-500";
    textColor = "text-red-700";
  } else if (value >= 80) {
    color = "bg-orange-500";
    textColor = "text-orange-700";
  } else if (value >= 60) {
    color = "bg-yellow-500";
    textColor = "text-yellow-700";
  }

  const clampedValue = Math.min(100, Math.max(0, value));

  return (
    <div className="flex items-center gap-2">
      <div className="w-24 h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`} style={{ width: `${clampedValue}%` }} />
      </div>
      <span className={`text-xs font-medium ${textColor}`}>
        {Math.round(value * 10) / 10}
        {suffix}
      </span>
    </div>
  );
}

function formatBps(bps: number): string {
  if (bps === 0) return "0 b/s";
  if (bps < 1000) return `${Math.round(bps)} b/s`;
  if (bps < 1000000) return `${(bps / 1000).toFixed(1)} Kb/s`;
  if (bps < 1000000000) return `${(bps / 1000000).toFixed(1)} Mb/s`;
  return `${(bps / 1000000000).toFixed(1)} Gb/s`;
}

function KpiCard({ label, value, variant }: { label: string; value: string; variant?: "success" | "warning" | "danger" }) {
  let borderColor = "border-gray-200";
  let valueColor = "text-gray-900";

  if (variant === "success") {
    borderColor = "border-green-200";
    valueColor = "text-green-600";
  } else if (variant === "warning") {
    borderColor = "border-orange-200";
    valueColor = "text-orange-600";
  } else if (variant === "danger") {
    borderColor = "border-red-200";
    valueColor = "text-red-600";
  }

  return (
    <div className={`bg-white rounded-lg border ${borderColor} px-4 py-3`}>
      <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">{label}</p>
      <p className={`text-2xl font-bold ${valueColor}`}>{value}</p>
    </div>
  );
}
