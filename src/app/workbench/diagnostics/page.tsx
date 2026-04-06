import { listCacheEntries, type CacheInfo } from "@/lib/data-source";
import { getZabbixClient } from "@/lib/zabbix/client";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function DiagnosticsPage() {
  // Gather diagnostic info
  let dbStatus = "unknown";
  let dbCounts: Record<string, number> = {};
  try {
    const [clients, pilots, incidents, notes, devices, dataSources] = await Promise.all([
      prisma.client.count(),
      prisma.pilot.count(),
      prisma.incident.count(),
      prisma.note.count(),
      prisma.device.count(),
      prisma.dataSource.count(),
    ]);
    dbStatus = "connected";
    dbCounts = { clients, pilots, incidents, notes, devices, dataSources };
  } catch (e) {
    dbStatus = `error: ${String(e)}`;
  }

  let zabbixStatus = "unknown";
  let zabbixVersion = "";
  let zabbixLatency = 0;
  try {
    const t0 = Date.now();
    const client = getZabbixClient();
    zabbixVersion = await client.getVersion();
    zabbixLatency = Date.now() - t0;
    zabbixStatus = "connected";
  } catch (e) {
    zabbixStatus = `error: ${String(e)}`;
  }

  let cacheEntries: CacheInfo[] = [];
  try {
    cacheEntries = await listCacheEntries();
  } catch {}

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-800">Diagnostika</h2>
        <p className="text-xs text-gray-400 mt-0.5">Sistemos sveikata ir šaltinių statusas</p>
      </div>

      <div className="space-y-6">
        {/* Database Status */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <div className="flex items-center gap-2 mb-3">
            <span className={`w-2 h-2 rounded-full ${dbStatus === "connected" ? "bg-green-500" : "bg-red-500"}`} />
            <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide">PostgreSQL</h3>
            <span className={`text-xs ${dbStatus === "connected" ? "text-green-600" : "text-red-600"}`}>{dbStatus}</span>
          </div>
          {dbStatus === "connected" && (
            <div className="grid grid-cols-3 lg:grid-cols-6 gap-3">
              {Object.entries(dbCounts).map(([key, count]) => (
                <div key={key} className="text-center">
                  <p className="text-xs text-gray-400 capitalize">{key}</p>
                  <p className="text-lg font-bold text-gray-900">{count}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Zabbix Status */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <div className="flex items-center gap-2 mb-3">
            <span className={`w-2 h-2 rounded-full ${zabbixStatus === "connected" ? "bg-green-500" : "bg-red-500"}`} />
            <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide">Zabbix</h3>
            <span className={`text-xs ${zabbixStatus === "connected" ? "text-green-600" : "text-red-600"}`}>{zabbixStatus}</span>
          </div>
          {zabbixStatus === "connected" && (
            <div className="flex gap-8 text-sm">
              <div>
                <span className="text-gray-500">Versija: </span>
                <span className="font-medium text-gray-900">v{zabbixVersion}</span>
              </div>
              <div>
                <span className="text-gray-500">Latency: </span>
                <span className="font-medium text-gray-900">{zabbixLatency}ms</span>
              </div>
            </div>
          )}
        </div>

        {/* Cache Status */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-3">
            Cache ({cacheEntries.length} įrašų)
          </h3>
          {cacheEntries.length === 0 ? (
            <p className="text-sm text-gray-400">Cache tuščias.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-gray-400 text-left uppercase">
                  <tr>
                    <th className="py-2 pr-4">Raktas</th>
                    <th className="py-2 pr-4">Šaltinis</th>
                    <th className="py-2 pr-4">Aplinka</th>
                    <th className="py-2 pr-4">Cache laikas</th>
                    <th className="py-2 pr-4">Dydis</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {cacheEntries.map((entry) => (
                    <tr key={entry.key}>
                      <td className="py-2 pr-4 font-mono text-gray-700">{entry.key}</td>
                      <td className="py-2 pr-4 text-gray-600">{entry.label}</td>
                      <td className="py-2 pr-4 text-gray-500">{entry.env}</td>
                      <td className="py-2 pr-4 text-gray-500">{new Date(entry.cachedAt).toLocaleString("lt-LT")}</td>
                      <td className="py-2 pr-4 text-gray-500">{formatBytes(entry.sizeBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
