import { getZabbixClient } from "@/lib/zabbix/client";
import { fetchSource } from "@/lib/data-source";
import DataSourceStatus from "@/app/components/DataSourceStatus";

export const dynamic = "force-dynamic";

export default async function SourceExplorerPage() {
  // Fetch raw Zabbix data for exploration
  const hostsResult = await fetchSource("wb-zabbix-hosts", {
    source: "zabbix",
    label: "Zabbix Hostai",
    env: "prod",
    fetcher: async () => {
      const client = getZabbixClient();
      return client.getHosts();
    },
  });

  const groupsResult = await fetchSource("wb-zabbix-groups", {
    source: "zabbix",
    label: "Zabbix Grupės",
    env: "prod",
    fetcher: async () => {
      const client = getZabbixClient();
      return client.getHostGroups();
    },
  });

  const hosts: any[] = hostsResult.data || [];
  const groups: any[] = groupsResult.data || [];

  return (
    <div>
      <DataSourceStatus
        sources={[
          { source: hostsResult.source, label: hostsResult.label, env: hostsResult.env, status: hostsResult.status, cachedAt: hostsResult.cachedAt, error: hostsResult.error, fetchMs: hostsResult.fetchMs },
          { source: groupsResult.source, label: groupsResult.label, env: groupsResult.env, status: groupsResult.status, cachedAt: groupsResult.cachedAt, error: groupsResult.error, fetchMs: groupsResult.fetchMs },
        ]}
      />

      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-800">Šaltinių naršyklė</h2>
        <p className="text-xs text-gray-400 mt-0.5">Raw Zabbix API atsakymų peržiūra</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Hosts */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-3">
            Zabbix Hostai ({hosts.length})
          </h3>
          <pre className="bg-gray-50 rounded-lg p-3 text-[10px] text-gray-600 overflow-auto max-h-[400px] font-mono">
            {JSON.stringify(hosts, null, 2)}
          </pre>
        </div>

        {/* Groups */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-3">
            Zabbix Grupės ({groups.length})
          </h3>
          <pre className="bg-gray-50 rounded-lg p-3 text-[10px] text-gray-600 overflow-auto max-h-[400px] font-mono">
            {JSON.stringify(groups, null, 2)}
          </pre>
        </div>
      </div>

      {/* TODO */}
      <div className="mt-6 bg-gray-50 border border-gray-200 rounded-lg px-4 py-3">
        <p className="text-xs text-gray-500">
          <strong>TODO:</strong> Pridėti TreeCommerce API naršyklę. Pridėti Items/Triggers/Problems naršymą.
          Pridėti payload palyginimą tarp live ir cached. Pridėti mapping vizualizaciją.
        </p>
      </div>
    </div>
  );
}
