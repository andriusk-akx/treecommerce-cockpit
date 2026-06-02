import { Suspense } from "react";
import { headers } from "next/headers";
import { after } from "next/server";
import { prisma } from "@/lib/db";
import { notFound, redirect } from "next/navigation";
import { RtPilotWorkspace } from "@/components/rt/RtPilotWorkspace";
import type { RtPilotData, ZabbixData } from "@/components/rt/RtPilotWorkspace";
import { getZabbixClient } from "@/lib/zabbix/client";
import { fetchSource } from "@/lib/data-source";
import type { ProcessCategory } from "@/lib/zabbix/types";
import { getCurrentUser } from "@/lib/auth/sessions";
import { canAccessPilot, allowedTabsFor } from "@/lib/auth/permissions";
import { fetchRolloutPerHostHybrid } from "@/lib/rollout-insights/fetcher";
import type { RolloutPerHostPayload } from "@/lib/rollout-insights/types";

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
  searchParams: Promise<{ tab?: string; period?: string; at?: string }>;
}

/**
 * Parse the period search param into a positive number of days, bounded
 * to the Zabbix trend retention window (1..365). Accepts both preset ids
 * ("14d", "30d", "90d") and bare numeric strings ("60"). Defaults to 14
 * when the param is missing or unparseable so existing deep-links keep
 * working unchanged.
 */
function parsePeriodDays(raw: string | undefined): number {
  if (!raw) return 14;
  const m = /^(\d+)d?$/.exec(raw.trim());
  if (!m) return 14;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n)) return 14;
  return Math.min(Math.max(1, n), 365);
}

/**
 * Default "active" threshold (percentage points above each host's
 * spss.cpu baseline). 2 pp is the value the team agreed on after
 * sampling several Rimi hosts and seeing typical diurnal swing was
 * 1.5–2.5 pp on quiet stores. Slider on the page can override this
 * (`?at=` URL param). Bounded 0..10 pp — values outside that range
 * either trivialise the classification (0 = every minute counts as
 * active) or collapse it to silence (10 pp threshold means only
 * Pentium-tier hosts under sustained busy load classify as active).
 */
const ACTIVE_THRESHOLD_PP_DEFAULT = 2.0;
function parseActiveThresholdPp(raw: string | undefined): number {
  if (!raw) return ACTIVE_THRESHOLD_PP_DEFAULT;
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return ACTIVE_THRESHOLD_PP_DEFAULT;
  return Math.min(Math.max(0, n), 10);
}

export default async function RetellectPilotPage({ params, searchParams }: Props) {
  const { pilotId } = await params;
  const { tab, period: periodParam, at: atParam } = await searchParams;
  const periodDays = parsePeriodDays(periodParam);
  const activeThresholdPp = parseActiveThresholdPp(atParam);

  // Cache-warming bypass.
  //
  // The /api/internal/warm-cache route fires server-side fetches against
  // this URL with header `x-warm-cache-secret` set to
  // `process.env.WARM_CACHE_SECRET`. The point is to populate the disk
  // cache for the heavy 30d/90d Zabbix paths BEFORE a real user hits the
  // page after a cold redeploy. Auth is bypassed here because there's no
  // user session attached to the warming request, and the response body
  // is thrown away — the page is rendered only for the side-effect of
  // running `loadZabbixDataPayload` and writing to `.cache/`.
  //
  // Security: only the same Node process holds the secret, so the bypass
  // is unreachable from outside the deployment. Pilot data still has to
  // exist (notFound otherwise) — the warm call cannot synthesise pilots.
  const reqHeaders = await headers();
  const warmSecret = reqHeaders.get("x-warm-cache-secret");
  const isWarmRequest = !!warmSecret && warmSecret === process.env.WARM_CACHE_SECRET;

  // For real requests, resolve the user once up front so we don't have to
  // call getCurrentUser twice (auth check + allowedTabs lookup). Warm
  // requests skip this entirely.
  const user = isWarmRequest ? null : await getCurrentUser();
  if (!isWarmRequest) {
    if (!user) redirect(`/login?next=/retellect/${pilotId}`);
    // 404 (not 403) for pilots the user can't see — avoids confirming the
    // pilot exists. Same rationale as the username-enumeration defence on login.
    if (!canAccessPilot(user, pilotId)) return notFound();
  }

  const pilot = await prisma.pilot.findUnique({
    where: { id: pilotId },
    include: {
      client: { select: { name: true, code: true } },
      devices: {
        include: { store: { select: { name: true, country: true } } },
        orderBy: { name: "asc" },
      },
      stores: { orderBy: { name: "asc" } },
      _count: { select: { devices: true, incidents: true, stores: true } },
    },
  });

  if (!pilot || pilot.productType !== "RETELLECT") return notFound();

  // allowedTabs depends on the user, which is null on warm requests —
  // warming doesn't render the workspace so the tabs list is moot.
  const allowedTabs = isWarmRequest || !user ? new Set<string>() : allowedTabsFor(user, pilotId);

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
  const zabbixDataPromise = loadZabbixDataPayload(pilotId, expectedHostKeys, periodDays, activeThresholdPp);

  // Background prefetch for adjacent window sizes the user is most likely
  // to switch into next. Fires AFTER the response is sent (Next.js
  // `after()`) so it doesn't block the user's first paint — when they
  // then click 30d the disk cache is already warm and the period switch
  // resolves in milliseconds instead of the 30–60 s cold-fetch wait.
  //
  // Heuristic:
  //   • 14d landing → prefetch 30d (most common upgrade).
  //   • 30d landing → prefetch 90d (next deeper window).
  //   • 90d already loaded → nothing larger to warm.
  //
  // Skip on warm requests so the warm-cache orchestrator doesn't
  // recursively trigger prefetches of windows it's already scheduled to
  // warm itself.
  if (!isWarmRequest) {
    const PREFETCH_NEXT: Record<number, number | undefined> = { 14: 30, 30: 90 };
    const nextPeriod = PREFETCH_NEXT[periodDays];
    if (nextPeriod) {
      after(async () => {
        try {
          await loadZabbixDataPayload(pilotId, expectedHostKeys, nextPeriod, activeThresholdPp);
        } catch {
          /* Prefetch failure is non-fatal — next user-driven fetch will
             retry naturally. We don't log either; the disk cache will
             stay cold and the next visit eats the latency. */
        }
      });
    }
  }

  // Warm-cache path: await the heavy promise (so fetchSource writes to
  // disk cache) and return a minimal response. Skip Suspense streaming
  // and JSX rendering of the workspace — neither matters when the body
  // is thrown away by the caller.
  if (isWarmRequest) {
    await zabbixDataPromise;
    return <span data-warmed-pilot={pilotId} data-period-days={periodDays} />;
  }

  return (
    <Suspense fallback={<ZabbixLoadingFallback pilot={pilotData} />}>
      <RtPilotPageContent
        pilot={pilotData}
        zabbixDataPromise={zabbixDataPromise}
        initialTab={tab || "overview"}
        initialPeriod={periodParam}
        initialActiveThresholdPp={activeThresholdPp}
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
  initialPeriod,
  initialActiveThresholdPp,
  allowedTabs,
}: {
  pilot: RtPilotData;
  zabbixDataPromise: Promise<ZabbixData>;
  initialTab: string;
  /**
   * Raw `?period=` URL value (e.g. "14d", "30d", "60") or undefined when the
   * caller hasn't set one. Passed straight through to RtPilotWorkspace →
   * RtFiltersProvider so server-side first render and client first render
   * both seed the filter context from the URL instead of falling back to
   * localStorage (unavailable on server) or defaults. Fixes the bug where
   * switching 14d→30d (or hard-reloading ?period=30d) painted a 14-day
   * heatmap axis until the client's URL-sync useEffect caught up.
   */
  initialPeriod: string | undefined;
  /**
   * Active threshold (percentage points above each host's baseline) used
   * by Rollout Insights to classify a minute as active vs idle. Threaded
   * from `?at=` URL param so the slider's URL persistence pattern works
   * end-to-end (SSR + client). See `parseActiveThresholdPp` for bounds.
   */
  initialActiveThresholdPp: number;
  allowedTabs: string[];
}) {
  const zabbix = await zabbixDataPromise;
  return (
    <RtPilotWorkspace
      pilot={pilot}
      zabbix={zabbix}
      initialTab={initialTab}
      initialPeriod={initialPeriod}
      initialActiveThresholdPp={initialActiveThresholdPp}
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
    cpuCores: number | null;
    cpuCoresSource: string | null;
    cpuCoresProbedAt: Date | null;
    ramGb: number | null;
    retellectEnabled: boolean;
    retellectConfidence: string | null;
    status: string;
    deviceType: string;
    os: string | null;
    store: { name: string; country: string | null } | null;
  }>;
  stores: Array<{ id: string; name: string; code: string; country: string | null }>;
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
      country: s.country ?? null,
    })),
    devices: pilot.devices.map((d) => ({
      id: d.id,
      name: d.name,
      sourceHostKey: d.sourceHostKey,
      storeName: d.store?.name ?? "—",
      // Two-letter country code joined from the device's Store row.
      // Drives the matrix's Country filter so the operator can slice
      // the fleet by LT / LV / EE without the Store dropdown having
      // to spell out all 311 stores in a single list.
      country: d.store?.country ?? null,
      cpuModel: d.cpuModel ?? "—",
      // cpuCores + provenance flow through to the timeline so the cpu_num
      // badge can be rendered alongside the cpu model column ("i3-6100 · 4c")
      // and the drill-down header can show real cores rather than a 0
      // placeholder. Null means resolveCoresForHost wasn't able to establish
      // a core count for this device — the UI renders "?c" with a tooltip.
      cpuCores: d.cpuCores,
      cpuCoresSource: d.cpuCoresSource,
      cpuCoresProbedAt: d.cpuCoresProbedAt,
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
//   30 min — CPU history (trend.get buckets are HOURLY — they don't change
//             minute-by-minute. Cold-fetching the 30d / 90d window for
//             ~110 hosts costs 30-60s; a 30-min cache keeps the user
//             landing on warm data through normal browsing while still
//             refreshing within a single business hour. The newest day's
//             freshest hour will only lag by up to 30 min, well within
//             the heatmap's day-level resolution. Was 5 min until
//             2026-05-25; the bump came after probe-confirmed Pavilnionys
//             30d data WAS available, but cold-start latency was the UX
//             pain point users actually felt.)
const FRESH_MS = {
  live: 60_000,
  registry: 300_000,
  history: 1_800_000,
};

async function loadZabbixDataPayload(
  pilotId: string,
  expectedHostKeys: Set<string>,
  /**
   * Number of days the CPU heatmap should cover. Threaded from the URL
   * (?period=30) so changing the period via the timeline selector triggers
   * a server-side refetch with the new window — without this, the period
   * lived only in client state and the wider date axis rendered against
   * a 14-day data payload (older cells dropped to "—").
   *
   * Bounded 1..365. Only the cpu-history fetcher reads it; the other 6
   * fetchers are per-poll-cycle data that doesn't depend on the window.
   */
  periodDays: number = 14,
  /**
   * Percentage points above each host's spss.cpu baseline used by
   * Rollout Insights to classify a bucket as active. Only the
   * rollout-per-host fetcher reads it. Underlying raw bucket data is
   * cached threshold-independently, so slider changes re-aggregate the
   * cached data instead of re-querying Zabbix.
   */
  activeThresholdPp: number = 2.0,
): Promise<ZabbixData> {
  const [
    zabbixResult,
    zabbixCpuDetailResult,
    zabbixProcResult,
    zabbixProcCpuResult,
    zabbixHistoryResult,
    zabbixAgentHealthResult,
    zabbixDeployedHostIds,
    zabbixActiveInPeriodHostIds,
    zabbixRolloutPerHostResult,
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
    // Cache key includes periodDays — changing the heatmap period must NOT
    // return the previous period's cached payload. Without this, switching
    // 14d -> 30d would either show stale 14d data (cache hit) or trigger
    // an "all empty" cell stretch when the cached entry was clipped.
    fetchSource(`zabbix-rt-cpu-history-${pilotId}-${periodDays}d`, {
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
        // Phase 4: switch from direct Zabbix call to hybrid reader so the
        // heatmap can render >29-day windows. For dates older than ~14d
        // the reader pulls from the CpuMetricDaily rollup table; recent
        // dates still come straight from Zabbix.
        const nowSec = Math.floor(Date.now() / 1000);
        const fromSec = nowSec - periodDays * 86400;
        const { readCpuHistoryHybrid } = await import("@/lib/cpu-rollup/reader");
        const { daily } = await readCpuHistoryHybrid({
          pilotId,
          itemIds,
          itemHostMap,
          fromSec,
          toSec: nowSec,
        });
        return daily;
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
    // Activity-in-period signal: hosts where python.cpu trend records show
    // value_max > 0.5% at any point in the last `periodDays` days. This is
    // the leadership-grade "did Retellect actually run here during the
    // window" signal — Rollout Insights uses it for the ON/OFF split so
    // intermittent hosts (canonical case: Pavilnonys SCO2, ran for a week
    // then went idle) end up on the correct side of the comparison. Cache
    // key includes periodDays so the 14d/30d/90d selector returns honest
    // numbers per window — see ZabbixClient.getRetellectActiveInPeriodHostIds.
    fetchSource(`zabbix-rt-active-in-period-hostids-${pilotId}-${periodDays}d`, {
      source: "zabbix",
      label: "Zabbix Retellect Activity Map (period)",
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
        const active = await client.getRetellectActiveInPeriodHostIds(
          Array.from(matchedHostIds),
          periodDays,
        );
        return Array.from(active);
      },
    }),
    // Phase 1 Rollout Insights aggregate: per-host minute-level analytics
    // with per-host adaptive baseline (median spss.cpu in 02-05h Vilnius
    // window). Used by the Decision Matrix to compute "avg CPU during
    // active minutes, split by Retellect ON/OFF" — see
    // src/lib/rollout-insights/. Cache key includes BOTH periodDays and
    // activeThresholdPp so changing either re-aggregates (raw Zabbix
    // payload is cached threshold-independently inside the fetcher).
    fetchSource(`zabbix-rt-rollout-perhost-${pilotId}-${periodDays}d-at${activeThresholdPp}`, {
      source: "zabbix",
      label: "Rollout Insights aggregate (per host)",
      env: "prod",
      freshFor: FRESH_MS.history,
      fetcher: async (): Promise<RolloutPerHostPayload> => {
        const client = getZabbixClient();
        const allHosts = (await client.getHosts()) as Array<{ hostid: string; name: string }>;
        const matchedHostIds = new Set<string>();
        for (const h of allHosts) {
          if (expectedHostKeys.has(h.name)) matchedHostIds.add(h.hostid);
        }
        if (matchedHostIds.size === 0) {
          return {
            activeThresholdPp,
            periodDays,
            generatedAt: new Date().toISOString(),
            perHost: [],
          };
        }
        return await fetchRolloutPerHostHybrid(
          client,
          pilotId,
          Array.from(matchedHostIds),
          periodDays,
          activeThresholdPp,
        );
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
  const activeInPeriodHostIds = zabbixActiveInPeriodHostIds.data || [];
  const rolloutPerHost: RolloutPerHostPayload | null = zabbixRolloutPerHostResult.data || null;

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
    retellectActiveInPeriodHostIds: activeInPeriodHostIds as string[],
    rolloutPerHost,
  };
}
