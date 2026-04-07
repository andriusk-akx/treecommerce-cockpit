import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import { RtPilotWorkspace } from "@/components/rt/RtPilotWorkspace";
import { getZabbixClient } from "@/lib/zabbix/client";
import { fetchSource } from "@/lib/data-source";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ pilotId: string }>;
  searchParams: Promise<{ tab?: string }>;
}

export default async function RetellectPilotPage({ params, searchParams }: Props) {
  const { pilotId } = await params;
  const { tab } = await searchParams;

  const pilot = await prisma.pilot.findUnique({
    where: { id: pilotId },
    include: {
      client: { select: { name: true, code: true } },
      devices: {
        include: { store: { select: { name: true } } },
        orderBy: { name: "asc" },
      },
      stores: { orderBy: { name: "asc" } },
      _count: { select: { devices: true, incidents: true, stores: true } },
    },
  });

  if (!pilot || pilot.productType !== "RETELLECT") return notFound();

  // Fetch live Zabbix resource metrics
  const zabbixResult = await fetchSource(`zabbix-rt-resources-${pilotId}`, {
    source: "zabbix",
    label: "Zabbix CPU/RAM Metrikos",
    env: "prod",
    fetcher: async () => {
      const client = getZabbixClient();
      const [resources, hosts] = await Promise.all([
        client.getResourceMetrics(),
        client.getHosts(),
      ]);
      // Enrich resources with host metadata
      const hostMap = new Map(hosts.map((h: any) => [h.hostid, h]));
      return resources.map((r: any) => {
        const hostMeta = hostMap.get(r.hostId);
        return {
          ...r,
          groups: hostMeta?.groups?.map((g: any) => g.name) || [],
          interfaces: hostMeta?.interfaces || [],
          maintenanceStatus: hostMeta?.maintenance_status,
        };
      });
    },
  });

  const zabbixHosts = zabbixResult.data || [];

  // Fetch Zabbix CPU detail items per host for user/system breakdown
  const zabbixCpuDetailResult = await fetchSource(`zabbix-rt-cpu-detail-${pilotId}`, {
    source: "zabbix",
    label: "Zabbix CPU Detail",
    env: "prod",
    fetcher: async () => {
      const client = getZabbixClient();
      const allHosts = await client.getHosts();
      const hostIds = allHosts.map((h: any) => h.hostid);
      if (hostIds.length === 0) return [];
      const items = await client.getItems(hostIds, "system.cpu");
      return items.map((item: any) => ({
        itemId: item.itemid,
        hostId: item.hostid,
        key: item.key_,
        name: item.name,
        lastValue: parseFloat(item.lastvalue) || 0,
        lastClock: item.lastclock ? new Date(parseInt(item.lastclock) * 1000).toISOString() : null,
        units: item.units,
      }));
    },
  });

  const cpuDetailItems = zabbixCpuDetailResult.data || [];

  // Fetch Zabbix process items (proc.num) to detect running Retellect
  const zabbixProcResult = await fetchSource(`zabbix-rt-proc-${pilotId}`, {
    source: "zabbix",
    label: "Zabbix Process Items",
    env: "prod",
    fetcher: async () => {
      const client = getZabbixClient();
      const allHosts = await client.getHosts();
      const hostIds = allHosts.map((h: any) => h.hostid);
      if (hostIds.length === 0) return [];
      const items = await client.getItems(hostIds, "proc");
      return items.map((item: any) => ({
        itemId: item.itemid,
        hostId: item.hostid,
        key: item.key_,
        name: item.name,
        lastValue: parseFloat(item.lastvalue) || 0,
        lastClock: item.lastclock ? new Date(parseInt(item.lastclock) * 1000).toISOString() : null,
        units: item.units,
      }));
    },
  });

  const procItems = zabbixProcResult.data || [];

  // Serialize pilot data for client component
  const pilotData = {
    id: pilot.id,
    name: pilot.name,
    shortCode: pilot.shortCode,
    status: pilot.status,
    clientName: pilot.client.name,
    goalSummary: pilot.goalSummary,
    notes: pilot.notes,
    deviceCount: pilot._count.devices,
    incidentCount: pilot._count.incidents,
    storeCount: pilot._count.stores,
    stores: pilot.stores.map((s) => ({
      id: s.id,
      name: s.name,
      code: s.code,
    })),
    devices: pilot.devices.map((d) => ({
      id: d.id,
      name: d.name,
      sourceHostKey: d.sourceHostKey,
      storeName: d.store?.name ?? "—",
      cpuModel: d.cpuModel ?? "—",
      ramGb: d.ramGb ?? 0,
      retellectEnabled: d.retellectEnabled,
      status: d.status,
      deviceType: d.deviceType,
      os: d.os,
    })),
  };

  // Build Zabbix live data payload
  const zabbixData = {
    status: zabbixResult.status,
    fetchMs: zabbixResult.fetchMs,
    cachedAt: zabbixResult.cachedAt,
    error: zabbixResult.error,
    hosts: zabbixHosts.map((h: any) => ({
      hostId: h.hostId,
      hostName: h.hostName,
      status: h.status,
      groups: h.groups || [],
      ip: h.interfaces?.[0]?.ip || null,
      cpu: h.cpu ? {
        utilization: h.cpu.utilization || 0,
        load: h.cpu.load || 0,
      } : null,
      memory: h.memory ? {
        utilization: h.memory.utilization || 0,
        totalBytes: h.memory.total || 0,
        availableBytes: h.memory.available || 0,
      } : null,
      disk: h.disk ? {
        utilization: h.disk.utilization || 0,
        path: h.disk.path || "/",
      } : null,
    })),
    cpuDetail: cpuDetailItems.map((item: any) => ({
      hostId: item.hostId,
      key: item.key,
      name: item.name,
      value: item.lastValue,
      lastClock: item.lastClock,
      units: item.units,
    })),
    procItems: procItems.map((item: any) => ({
      hostId: item.hostId,
      key: item.key,
      name: item.name,
      value: item.lastValue,
      lastClock: item.lastClock,
    })),
  };

  return <RtPilotWorkspace pilot={pilotData} zabbix={zabbixData} initialTab={tab || "overview"} />;
}
