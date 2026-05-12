import { Suspense } from "react";
import { prisma } from "@/lib/db";
import { notFound, redirect } from "next/navigation";
import { RtPilotWorkspace } from "@/components/rt/RtPilotWorkspace";
import type { RtPilotData, ZabbixData } from "@/components/rt/RtPilotWorkspace";
import { getZabbixClient } from "@/lib/zabbix/client";
import { fetchSource } from "@/lib/data-source";
import type { ProcessCategory } from "@/lib/zabbix/types";
import { getCurrentUser } from "@/lib/auth/sessions";
import { canAccessPilot, allowedTabsFor } from "@/lib/auth/permissions";

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

  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=/retellect/${pilotId}`);
  // 404 (not 403) for pilots the user can't see — avoids confirming the
  // pilot exists. Same rationale as the username-enumeration defence on login.
  if (!canAccessPilot(user, pilotId)) return notFound();
  const allowedTabs = allowedTabsFor(user, pilotId);

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
  // Build the set of Zabbix host names we expect to find. We look at BOTH
  // sourceHostKey (the canonical Zabbix display name set during seed) AND the
  // device's plain `name` — the latter is the fallback the workspace header's
  // "matched" counter already uses, so the two now agree. Without this fallback
  // a production DB whose sourceHostKey column is unset (legacy seed) leaves
  // the CPU history fetcher with an empty matchedHostIds set — the fetch
  // returns [] and the Timeline shows blank cells even though the header says
  // "115/115 matched".
  const expectedHostKeys = new Set<string>();
  for (const d of pilot.devices) {
    if (d.sourceHostKey) expectedHostKeys.add(d.sourceHostKey);
    if (d.name) expectedHostKeys.add(d.name);
  }

  // ── Streaming split (perf pass 2026-05-07) ──────────────────────────
  //
  // The 6 parallel Zabbix fetches below (resources, cpu detail, proc
  // items, proc cpu, cpu history, agent health) are the slow path —
  // 1.5–3 s on a fully cold cache. Previously the page awaited them all
  // before returning ANY HTML, leaving the user staring at the previous
  // route for the whole window.
  //
  // We now build the pilot client payload first (no Zabbix dependency),
  // kick off `loadZabbixDataPayload` WITHOUT awaiting, and render a
  // Suspense boundary whose async child awaits the promise. Next.js
  // streams the page shell to the client immediately and the workspace
  // content swaps in when the data resolves. The route also has a
  // sibling `loading.tsx` covering the Phase 1 (auth + DB pilot fetch)
  // window so the user sees a populated layout from click 0.
  const pilotData: RtPilotData = buildPilotData(pilot);
  const zabbixDataPromise = loadZabbixDataPayload(pilotId, expectedHostKeys);

  return (
    <Suspense fallback={<ZabbixLoadingFallback pilot={pilotData} />}>
      <RtPilotPageContent
        pilot={pilotData}
        zabbixDataPromise={zabbixDataPromise}
        initialTab={tab || "overview"}
        allowedTabs={Array.from(allowedTabs)}
      />
    </Suspense>
  );
}

// ─── Phase 2 child: awaits the heavy zabbix promise, mounts workspace ──
async function RtPilotPageContent({
  pilot,
  zabbixDataPromise,
  initialTab,
  allowedTabs,
}: {
  pilot: RtPilotData;
  zabbixDataPromise: Promise<ZabbixData>;
  initialTab: string;
  allowedTabs: string[];
}) {
  const zabbix = await zabbixDataPromise;
  return (
    <RtPilotWorkspace
      pilot={pilot}
      zabbix={zabbix}
      initialTab={initialTab}
      allowedTabs={allowedTabs}
    />
  );
}

// ─── Suspense fallback while zabbix data is loading ────────────────────
//
// Distinct from loading.tsx: that fires during the FULL transition
// (auth + DB pilot fetch). This one fires once the page shell has
// streamed and only the zabbix-dependent chunk is still pending. Showing
// the pilot header here gives users confirmation they landed on the
// right page even before the heavy data lands.
function ZabbixLoadingFallback({ pilot }: { pilot: RtPilotData }) {
  return (
    <div>
      <div style={{ background: "#fff", borderBottom: "1px solid #e5e7eb", padding: "16px 24px" }}>
        <div style={{ maxWidth: 1152, margin: "0 auto" }}>
          <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 8 }}>
            Home / Retellect /{" "}
            <span style={{ color: "#475569", fontWeight: 500 }}>{pilot.name}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h1 style={{ fontSize: 20, fontWeight: 700, color: "#111827", margin: 0 }}>
              {pilot.name}
            </h1>
            <span
              style={{
                fontSize: 11,
                padding: "3px 10px",
                borderRadius: 10,
                background: "#fef3c7",
                color: "#92400e",
                fontWeight: 500,
              }}
            >
              loading data…
            </span>
          </div>
        </div>
      </div>
      <div style={{ padding: 24, textAlign: "center", color: "#94a3b8", fontSize: 13 }}>
        Fetching live Zabbix data for {pilot.deviceCount}{" "}
        {pilot.deviceCount === 1 ? "device" : "devices"}…
      </div>
    </div>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────

// Define the Prisma pilot row shape inline — pulling Prisma generated types
// here would need a regenerate after every schema change for marginal value.
// The shape matches the `include` block above; if that changes, this
// signature changes too.
type PrismaPilotRow = NonNullable<Awaited<ReturnType<typeof prisma.pilot.findUnique>>> & {
  client: { name: string; code: string };
  devices: Array<{
    id: string;
    name: string;
    sourceHostKey: string | null;
    cpuModel: string | null;
    ramGb: number | null;
    retellectEnabled: boolean;
    retellectConfidence: string | null;
    status: string;
    deviceType: string;
    os: string | null;
    store: { name: string } | null;
  }>;
  stores: Array<{ id: string; name: string; code: string }>;
  _count: { devices: number; incidents: number; stores: number };
};

function buildPilotData(pilot: PrismaPilotRow): RtPilotData {
  return {
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
}

// Per-call freshness windows. Login → first paint was bottlenecked by the
// 7 parallel Zabbix fetches all going live every time, even when an entry
// from 10 seconds earlier sat on disk. With stale-while-revalidate the
// hot cache path returns in <50 ms and the background revalidation keeps
// the cache warm for the next visitor.
//
// Values reflect how often the underlying data legitimately moves:
//   60 s    — live CPU / RAM / process telemetry (Zabbix polls these
//             at 1-min cadence anyway, so a fresher TTL just wastes
//             round-trips with no UX benefit)
//   300 s   — process-item registry, deployed-hostId set (these change
//             only when SP admin redeploys the template — minutes-scale)
//   300 s   — 14-day CPU history (trend.get bucket is hourly, so reading
//             the same 14-day window twice within 5 minutes returns the
//             same numbers)
const FRESH_MS = {
  live: 60_000,
  registry: 300_000,
  history: 300_000,
};

async function loadZabbixDataPayload(pilotId: string, expectedHostKeys: Set<string>): Promise<ZabbixData> {
  const [
    zabbixResult,
    zabbixCpuDetailResult,
    zabbixProcResult,
    zabbixProcCpuResult,
    zabbixHistoryResult,
    zabbixAgentHealthResult,
    zabbixDeployedHostIds,
  ] = await Promise.all([
    fetchSource(`zabbix-rt-resources-${pilotId}`, {
      source: "zabbix",
      label: "Zabbix CPU/RAM Metrikos",
      env: "prod",
      freshFor: FRESH_MS.live,
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
      freshFor: FRESH_MS.live,
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
      freshFor: FRESH_MS.registry,
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
      freshFor: FRESH_MS.live,
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
      freshFor: FRESH_MS.history,
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
        return await client.getCpuHistoryDaily(itemIds, itemHostMap, 14);
      },
    }),
    fetchSource(`zabbix-rt-agent-health-${pilotId}`, {
      source: "zabbix",
      label: "Zabbix Agent Health",
      env: "prod",
      freshFor: FRESH_MS.live,
      fetcher: async () => {
        // Per-host count of supported / unsupported items so the dashboard
        // can distinguish "agent broken" from "process idle". Restricted to
        // hosts matching DB devices to avoid pulling 1000+ unrelated hosts.
        const client = getZabbixClient();
        const allHosts = (await client.getHosts()) as Array<{ hostid: string; name: string }>;
        const matchedHostIds = new Set<string>();
        for (const h of allHosts) {
          if (expectedHostKeys.has(h.name)) matchedHostIds.add(h.hostid);
        }
        if (matchedHostIds.size === 0) return [];
        return await client.getAgentHealthSummary(Array.from(matchedHostIds));
      },
    }),
    // Strict registry signal: which hosts have Retellect items registered
    // in their Zabbix template, regardless of whether those items are
    // currently collecting samples. Drives the "Deploy" indicator dot, which
    // must light up for hosts where Retellect was deployed but the agent
    // can no longer read perf-counters (e.g. Pavilnonys SCO2 — 8 python
    // items, all state=ZBX_NOTSUPPORTED, lastclock=0).
    fetchSource(`zabbix-rt-deployed-hostids-${pilotId}`, {
      source: "zabbix",
      label: "Zabbix Retellect Deployment Map",
      env: "prod",
      freshFor: FRESH_MS.registry,
      fetcher: async (): Promise<string[]> => {
        const client = getZabbixClient();
        const allHosts = (await client.getHosts()) as Array<{ hostid: string; name: string }>;
        const matchedHostIds = new Set<string>();
        for (const h of allHosts) {
          if (expectedHostKeys.has(h.name)) matchedHostIds.add(h.hostid);
        }
        if (matchedHostIds.size === 0) return [];
        const deployed = await client.getRetellectDeployedHostIds(Array.from(matchedHostIds));
        // Serialise as array — JSON-friendly so the disk cache layer in
        // fetchSource can persist it.
        return Array.from(deployed);
      },
    }),
  ]);

  const zabbixHosts = zabbixResult.data || [];
  const cpuDetailItems = zabbixCpuDetailResult.data || [];
  const procItems = zabbixProcResult.data || [];
  const procCpuItems = zabbixProcCpuResult.data || [];
  const cpuHistory = zabbixHistoryResult.data || [];
  const agentHealth = zabbixAgentHealthResult.data || [];
  const deployedHostIds = zabbixDeployedHostIds.data || [];

  // Build Zabbix live data payload
  return {
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
      // RT-CPUMODEL phase 1: forward Zabbix `host.inventory` (already
      // normalised in ZabbixClient.getHosts via mapHostInventory). Null here
      // means either inventory_mode=-1 on this host or every requested
      // inventory field is empty — Rimi's current state for most SCOs.
      inventory: h.inventory ?? null,
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
    cpuTrendsMeta: {
      status: zabbixHistoryResult.status,
      fetchMs: zabbixHistoryResult.fetchMs,
      error: zabbixHistoryResult.error,
    },
    agentHealth: agentHealth as Array<{
      hostId: string;
      totalEnabled: number;
      supported: number;
      unsupported: number;
      sampleErrors: string[];
    }>,
    // Strict-registry "Retellect deployed" set — hostIds with python items
    // configured in the Zabbix template, regardless of whether those items
    // are currently collecting samples. The Timeline's Deploy column reads
    // this so deployed-but-broken hosts (perfcounter not readable, agent
    // misconfigured) still show as deployed instead of looking identical
    // to never-deployed hosts.
    retellectDeployedHostIds: deployedHostIds as string[],
  };
}
