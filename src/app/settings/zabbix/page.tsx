import { getZabbixClient } from "@/lib/zabbix/client";

export const dynamic = "force-dynamic";

export default async function ZabbixSettingsPage() {
  let status = "unknown";
  let version = "";
  let hostCount = 0;
  let latency = 0;
  let error = "";

  try {
    const t0 = Date.now();
    const client = getZabbixClient();
    version = await client.getVersion();
    const hosts = await client.getHosts();
    hostCount = hosts.length;
    latency = Date.now() - t0;
    status = "connected";
  } catch (e) {
    status = "error";
    error = String(e);
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-800">Zabbix nustatymai</h2>
        <p className="text-xs text-gray-400 mt-0.5">Zabbix API konfigūracija ir sveikatos patikrinimas</p>
      </div>

      {/* Connection Status */}
      <div className="bg-white rounded-lg border border-gray-200 p-5 mb-6">
        <div className="flex items-center gap-2 mb-4">
          <span className={`w-2.5 h-2.5 rounded-full ${status === "connected" ? "bg-green-500" : "bg-red-500"}`} />
          <h3 className="text-sm font-semibold text-gray-800">Prisijungimo statusas</h3>
          <span className={`text-xs font-medium ${status === "connected" ? "text-green-600" : "text-red-600"}`}>
            {status === "connected" ? "Prisijungta" : "Klaida"}
          </span>
        </div>

        {status === "connected" ? (
          <div className="grid grid-cols-3 gap-4">
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Versija</p>
              <p className="text-sm font-medium text-gray-900">v{version}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Hostai</p>
              <p className="text-sm font-medium text-gray-900">{hostCount}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Latency</p>
              <p className="text-sm font-medium text-gray-900">{latency}ms</p>
            </div>
          </div>
        ) : (
          <div className="bg-red-50 rounded-lg p-3">
            <p className="text-xs text-red-700">{error}</p>
          </div>
        )}
      </div>

      {/* Configuration */}
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-3">Konfigūracija</h3>
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-gray-500">API URL</dt>
            <dd className="text-gray-900 font-mono text-xs">{process.env.ZABBIX_URL || "Nenustatytas"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-gray-500">Token</dt>
            <dd className="text-gray-900 font-mono text-xs">{process.env.ZABBIX_TOKEN ? "••••••••" : "Nenustatytas"}</dd>
          </div>
        </dl>
        <p className="text-[10px] text-gray-400 mt-3">Konfigūracija valdoma per .env.local failą</p>
      </div>
    </div>
  );
}
