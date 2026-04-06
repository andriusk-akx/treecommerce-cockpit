import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import { getZabbixClient } from "@/lib/zabbix/client";
import { fetchSource } from "@/lib/data-source";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ pilotId: string }>;
}

export default async function PilotDevicesPage({ params }: PageProps) {
  const { pilotId } = await params;

  const pilot = await prisma.pilot.findUnique({
    where: { id: pilotId },
    include: {
      devices: {
        orderBy: { name: "asc" },
        include: { store: { select: { name: true, code: true } } },
      },
    },
  });

  if (!pilot) return notFound();

  // Also fetch live Zabbix host data to enrich device info
  const zabbixResult = await fetchSource(`zabbix-hosts-${pilotId}`, {
    source: "zabbix",
    label: "Zabbix Hostai",
    env: "prod",
    fetcher: async () => {
      const client = getZabbixClient();
      return client.getHosts();
    },
  });

  const zabbixHosts: any[] = zabbixResult.data || [];
  const hostMap = new Map(zabbixHosts.map((h: any) => [h.name, h]));

  // Group by CPU model for summary
  const cpuModels = new Map<string, number>();
  for (const device of pilot.devices) {
    const model = device.cpuModel || "Nežinomas";
    cpuModels.set(model, (cpuModels.get(model) || 0) + 1);
  }

  const totalDevices = pilot.devices.length;
  const retellectEnabled = pilot.devices.filter((d) => d.retellectEnabled).length;
  const uniqueStores = new Set(pilot.devices.filter((d) => d.storeId).map((d) => d.storeId)).size;

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-800">Įrenginiai — {pilot.name}</h2>
        <p className="text-xs text-gray-400 mt-0.5">SCO ir POS įrenginių inventorius</p>
      </div>

      {/* KPI Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">Visi įrenginiai</p>
          <p className="text-2xl font-bold text-gray-900">{totalDevices}</p>
        </div>
        <div className="bg-white rounded-lg border border-green-200 px-4 py-3">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">Retellect įjungta</p>
          <p className="text-2xl font-bold text-green-600">{retellectEnabled}</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">Parduotuvės</p>
          <p className="text-2xl font-bold text-gray-900">{uniqueStores}</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">CPU modeliai</p>
          <p className="text-2xl font-bold text-gray-900">{cpuModels.size}</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">Zabbix hostai</p>
          <p className="text-2xl font-bold text-blue-600">{zabbixHosts.length}</p>
        </div>
      </div>

      {/* CPU Model Distribution */}
      {cpuModels.size > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-5 mb-6">
          <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-3">CPU modelių pasiskirstymas</h3>
          <div className="space-y-2">
            {Array.from(cpuModels.entries())
              .sort((a, b) => b[1] - a[1])
              .map(([model, count]) => (
                <div key={model} className="flex items-center gap-3">
                  <div className="w-48 text-xs text-gray-700 font-medium truncate">{model}</div>
                  <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full bg-blue-500 rounded-full" style={{ width: `${(count / totalDevices) * 100}%` }} />
                  </div>
                  <span className="text-xs text-gray-500 w-12 text-right">{count}</span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Devices Table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-left text-xs uppercase tracking-wide">
            <tr>
              <th className="px-4 py-3">Pavadinimas</th>
              <th className="px-4 py-3">Tipas</th>
              <th className="px-4 py-3">Parduotuvė</th>
              <th className="px-4 py-3">CPU modelis</th>
              <th className="px-4 py-3">RAM</th>
              <th className="px-4 py-3">OS</th>
              <th className="px-4 py-3">Retellect</th>
              <th className="px-4 py-3">Statusas</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {pilot.devices.map((device) => {
              const zHost = hostMap.get(device.name);
              return (
                <tr key={device.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">{device.name}</div>
                    {zHost && (
                      <div className="text-[10px] text-gray-400">Zabbix: {zHost.status === "0" ? "monitored" : "unmonitored"}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium ${
                      device.deviceType === "SCO" ? "bg-blue-100 text-blue-700" :
                      device.deviceType === "POS" ? "bg-green-100 text-green-700" :
                      device.deviceType === "SERVER" ? "bg-purple-100 text-purple-700" :
                      "bg-gray-100 text-gray-600"
                    }`}>
                      {device.deviceType}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600 text-xs">{device.store?.name || "—"}</td>
                  <td className="px-4 py-3 text-xs text-gray-700">{device.cpuModel || "—"}</td>
                  <td className="px-4 py-3 text-xs text-gray-600">{device.ramGb ? `${device.ramGb} GB` : "—"}</td>
                  <td className="px-4 py-3 text-xs text-gray-600">{device.os || "—"}</td>
                  <td className="px-4 py-3">
                    {device.retellectEnabled ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500"></span> Taip
                      </span>
                    ) : (
                      <span className="text-xs text-gray-400">Ne</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium ${
                      device.status === "active" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
                    }`}>
                      {device.status}
                    </span>
                  </td>
                </tr>
              );
            })}
            {pilot.devices.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-gray-400">
                  Įrenginių dar nėra. Pridėkite per duomenų bazę arba importuokite iš Zabbix.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
