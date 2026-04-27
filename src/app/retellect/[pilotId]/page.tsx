import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import { RtPilotWorkspace } from "@/components/rt/RtPilotWorkspace";
import { getZabbixClient } from "@/lib/zabbix/client";
import { fetchSource } from "@/lib/data-source";
import type { ProcessCategory } from "@/lib/zabbix/types";

type ProcCpuPayload = {
  itemId: string;
  hostId: string;
  name: string;
  key: string;
  procName: string;
  category: ProcessCategory;
  cpuValue: number;
  lastClock: string | null;
  lastClockUnix: number;
  units: string;
};

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

  // Fetch all 5 independent Zabbix payloads in parallel.
  // The client caches getHosts() in-process + dedupes in-flight, so these
  // fetchers effectively share a single host.get round-trip instead of five.
  // History was previously sequential after Phase 1 — moving it into the
  // parallel group saves ~400ms on cold load (history wall is ~1800ms with
  // concurrency=24, Phase 1 wall is ~450ms; before it was 1800+450, now max).
  const expectedHostKeys = new Set(
    pilot.devices.map((d) => d.sourceHostKey).filter((k): k is string => !!k),
  );
  const [
    zabbixResult,
    zabbixCpuDetailResult,
    zabbixProcResult,
    zabbixProcCpuResult,
    zabbixHistoryResult,
  ] = await Promise.all([
    fetchSource(`zabbix-rt-resources-${pilotId}`, {
      source: "zabbix",
      label: "Zabbix CPU/RAM Metrikos",
      env: "prod",
      fetcher: async () => {
        const client = getZabbixClient();
        const [resources, hosts] = await Promise.all([
          client.getResourceMetrics(),
          client.getHosts(),
        ]);
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
    }),
    fetchSource(`zabbix-rt-cpu-detail-${pilotId}`, {
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
    }),
    fetchSource(`zabbix-rt-proc-${pilotId}`, {
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
    }),
    fetchSource(`zabbix-rt-proc-cpu-${pilotId}`, {
      source: "zabbix",
      label: "Zabbix Process CPU",
      env: "prod",
      fetcher: async () => {
        const client = getZabbixClient();
        const allHosts = (await client.getHosts()) as Array<{ hostid: string }>;
        const hostIds = allHosts.map((h) => h.hostid);
        if (hostIds.length === 0) return [];
        const items = await client.getProcessCpuItems(hostIds);
        return items.map((it) => ({
          itemId: it.itemId,
          hostId: it.hostId,
          name: it.name,
          key: it.key,
          procName: it.procName,
          category: it.category,
          cpuValue: it.cpuValue,
          lastClock: it.lastClock ? new Date(it.lastClock * 1000).toISOString() : null,
          lastClockUnix: it.lastClock,
          units: it.units,
        }));
      },
    }),
    fetchSource(`zabbix-rt-cpu-history-${pilotId}`, {
      source: "zabbix",
      label: "Zabbix CPU History",
      env: "prod",
      fetcher: async () => {
        const client = getZabbixClient();
        const allHosts = (await client.getHosts()) as Array<{ hostid: string; name: string }>;
        // Restrict to hosts that match DB devices, by sourceHostKey == hostName.
        const matchedHostIds = new Set<string>();
        for (const h of allHosts) {
          if (expectedHostKeys.has(h.name)) matchedHostIds.add(h.hostid);
        }
        if (matchedHostIds.size === 0) return [];
        // Narrow item.get for system.cpu.util only — small payload (~108 items
        // for Rimi vs 333 for the broader system.cpu search). This lets the
        // history fetch run in parallel with Phase 1 instead of waiting for
        // it.
        const items = (await client.getItems(Array.from(matchedHostIds), "system.cpu.util")) as Array<{
          itemid: string; hostid: string; key_: string;
        }>;
        const cpuUtilItems = items.filter(
          (i) => i.key_ === "system.cpu.util[,,avg1]" || i.key_ === "system.cpu.util"
        );
        if (cpuUtilItems.length === 0) return [];
        const itemIds = cpuUtilItems.map((i) => i.itemid);
        const itemHostMap = new Map(cpuUtilItems.map((i) => [i.itemid, i.hostid]));
        const result = await client.getCpuHistoryDaily(itemIds, itemHostMap, 14);
        return result;
      },
    }),
  ]);

  const zabbixHosts = zabbixResult.data || [];
  const cpuDetailItems = zabbixCpuDetailResult.data || [];
  const procItems = zabbixProcResult.data || [];
  const procCpuItems = zabbixProcCpuResult.data || [];
  const cpuHistory = zabbixHistoryResult.data || [];

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
      retellectConfidence: d.retellectConfidence,
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
    procCpu: (procCpuItems as ProcCpuPayload[]).map((item) => ({
      hostId: item.hostId,
      key: item.key,
      name: item.name,
      procName: item.procName,
      category: item.category,
      cpuValue: item.cpuValue,
      lastClock: item.lastClock,
      lastClockUnix: item.lastClockUnix,
      units: item.units,
    })),
    procCpuMeta: {
      status: zabbixProcCpuResult.status,
      fetchMs: zabbixProcCpuResult.fetchMs,
      error: zabbixProcCpuResult.error,
    },
    cpuTrends: cpuHistory,
  };

  return <RtPilotWorkspace pilot={pilotData} zabbix={zabbixData} initialTab={tab || "overview"} />;
}
