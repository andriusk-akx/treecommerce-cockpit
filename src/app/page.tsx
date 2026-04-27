import { prisma } from "@/lib/db";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getZabbixClient } from "@/lib/zabbix/client";
import { generateInsights, type Insight } from "@/lib/zabbix/insights";
import { fetchSource } from "@/lib/data-source";
import DataSourceStatus from "@/app/components/DataSourceStatus";
import { getCurrentUser } from "@/lib/auth/sessions";
import { landingPath, visiblePilotIds } from "@/lib/auth/permissions";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  // The home dashboard is admin-flavoured (cross-pilot stats). Non-admins
  // get bounced to their pilot directly — no point showing them aggregate
  // numbers for clients/pilots they can't even see.
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!user.isAdmin) {
    const ids = visiblePilotIds(user);
    const list = ids === "all" ? [] : Array.from(ids);
    redirect(landingPath(user, list));
  }
  // Fetch pilots, clients, and core stats
  let pilots: any[] = [];
  let clients: any[] = [];
  let totalIncidents = 0;
  let openIncidents = 0;
  let totalDevices = 0;
  let totalStores = 0;

  try {
    [pilots, clients, totalIncidents, openIncidents, totalDevices, totalStores] = await Promise.all([
      prisma.pilot.findMany({
        orderBy: { name: "asc" },
        include: {
          client: { select: { name: true } },
          _count: { select: { devices: true, incidents: true, stores: true } },
        },
      }),
      prisma.client.findMany({
        include: { _count: { select: { pilots: true } } },
      }),
      prisma.incident.count(),
      prisma.incident.count({ where: { status: { in: ["OPEN", "ACKNOWLEDGED"] } } }),
      prisma.device.count(),
      prisma.store.count(),
    ]);
  } catch {
    // DB not ready
  }

  // Zabbix live data via universal data-source
  const [zabbixResult, insightsResult] = await Promise.all([
    fetchSource("zabbix-dashboard", {
      source: "zabbix",
      label: "Zabbix Monitoringas",
      env: "prod",
      fetcher: async () => {
        const zClient = getZabbixClient();
        const [version, problems, hosts] = await Promise.all([
          zClient.getVersion(),
          zClient.getProblems() as Promise<any[]>,
          zClient.getHosts() as Promise<any[]>,
        ]);
        return { version, problems, hosts };
      },
    }),
    fetchSource("zabbix-insights", {
      source: "zabbix",
      label: "AI Įžvalgos",
      env: "prod",
      fetcher: () => generateInsights(),
    }),
  ]);

  const zabbixData = zabbixResult.data as { version: string; problems: any[]; hosts: any[] } | null;
  const insights: Insight[] = (insightsResult.data as Insight[]) || [];

  const sourceSummary = [zabbixResult, insightsResult].map((r) => ({
    source: r.source, label: r.label, env: r.env, status: r.status,
    cachedAt: r.cachedAt, error: r.error, fetchMs: r.fetchMs,
  }));

  const activePilots = pilots.filter((p) => p.status === "ACTIVE");
  const typeColors: Record<string, string> = {
    TREECOMMERCE: "bg-green-100 text-green-700 border-green-200",
    RETELLECT: "bg-blue-100 text-blue-700 border-blue-200",
    OTHER: "bg-gray-100 text-gray-600 border-gray-200",
  };

  return (
    <div>
      <DataSourceStatus sources={sourceSummary} />

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-800">Apžvalga</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            AKpilot — visų pilotų ir klientų suvestinė
            {zabbixData && ` | Zabbix v${zabbixData.version}`}
          </p>
        </div>
      </div>

      {/* Global KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-4 mb-8">
        <KpiCard label="Klientai" value={clients.length} />
        <KpiCard label="Aktyvūs pilotai" value={activePilots.length} />
        <KpiCard label="Atviri incidentai" value={openIncidents} highlight={openIncidents > 0} />
        <KpiCard label="Visi incidentai" value={totalIncidents} />
        <KpiCard label="Įrenginiai" value={totalDevices} />
        <KpiCard label="Parduotuvės" value={totalStores} />
      </div>

      {/* Active Pilots */}
      <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-3">Aktyvūs pilotai</h3>
      {activePilots.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 px-5 py-8 text-center text-gray-400 text-sm mb-8">
          Aktyvių pilotų nėra. <Link href="/pilots" className="text-blue-600 hover:text-blue-800">Peržiūrėti visus →</Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
          {activePilots.map((pilot) => (
            <Link
              key={pilot.id}
              href={`/pilots/${pilot.id}/overview`}
              className="bg-white rounded-lg border border-gray-200 px-5 py-4 hover:border-gray-300 transition-colors"
            >
              <div className="flex items-center gap-2 mb-1">
                <h4 className="font-semibold text-gray-900">{pilot.name}</h4>
                <span className={`inline-block px-2 py-0.5 rounded border text-[10px] font-medium ${typeColors[pilot.productType] || typeColors.OTHER}`}>
                  {pilot.productType}
                </span>
              </div>
              <p className="text-xs text-gray-500 mb-2">{pilot.client.name}</p>
              <div className="flex gap-4 text-xs text-gray-400">
                <span>{pilot._count.devices} įrenginių</span>
                <span>{pilot._count.stores} parduotuvių</span>
                <span>{pilot._count.incidents} incidentų</span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* AI Insights */}
      {insights.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-5 mb-8">
          <div className="flex items-center gap-2 mb-3">
            <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide">AI Įžvalgos</h3>
            <span className="text-[10px] text-gray-400 ml-auto">Automatiškai iš Zabbix</span>
          </div>
          <div className="space-y-2">
            {insights.map((insight, i) => (
              <InsightRow key={i} insight={insight} />
            ))}
          </div>
        </div>
      )}

      {/* Zabbix Live Problems */}
      {zabbixData && (
        <div className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide">
              Zabbix Live — {zabbixData.problems.length} aktyvių problemų
            </h3>
            <StatusDot active={zabbixData.problems.length === 0} />
          </div>
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-left text-xs uppercase tracking-wide">
                <tr>
                  <th className="px-4 py-3">Problema</th>
                  <th className="px-4 py-3">Sunkumas</th>
                  <th className="px-4 py-3">Trukmė</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {zabbixData.problems.map((p: any) => {
                  const clockVal = parseInt(p.clock);
                  if (!Number.isFinite(clockVal) || clockVal <= 0) return null;
                  const started = new Date(clockVal * 1000);
                  const duration = formatDuration(Date.now() - started.getTime());
                  return (
                    <tr key={p.eventid} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-gray-900">{p.name}</td>
                      <td className="px-4 py-3"><ZabbixSeverity level={p.severity} /></td>
                      <td className="px-4 py-3 text-gray-500 text-xs">{duration}</td>
                    </tr>
                  );
                })}
                {zabbixData.problems.length === 0 && (
                  <tr><td colSpan={3} className="px-4 py-6 text-center text-green-600 font-medium">Viskas tvarkoje — aktyvių problemų nėra!</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Monitored Hosts */}
      {zabbixData && zabbixData.hosts.length > 0 && (
        <div className="mb-8">
          <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-3">
            Stebimi hostai ({zabbixData.hosts.length})
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {zabbixData.hosts.map((h: any) => (
              <div key={h.hostid} className="bg-white rounded-lg border border-gray-200 px-4 py-3 flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${h.status === "0" ? "bg-green-500" : "bg-red-500"}`} />
                <span className="text-sm font-medium text-gray-800 truncate">{h.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Helper Components ─────────────────────────────────────────────

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function KpiCard({ label, value, highlight = false }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className={`bg-white rounded-lg border ${highlight ? "border-amber-300" : "border-gray-200"} px-5 py-4`}>
      <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">{label}</p>
      <p className={`text-2xl font-bold ${highlight ? "text-amber-600" : "text-gray-900"}`}>{value}</p>
    </div>
  );
}

function StatusDot({ active }: { active: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full ${active ? "bg-green-500" : "bg-red-500"} animate-pulse`} />
      <span className={`text-xs font-medium ${active ? "text-green-600" : "text-red-600"}`}>
        {active ? "Viskas tvarkoje" : "Aptikta problemų"}
      </span>
    </div>
  );
}

function InsightRow({ insight }: { insight: Insight }) {
  const styles: Record<string, { bg: string; border: string; title: string }> = {
    critical: { bg: "bg-red-50", border: "border-red-200", title: "text-red-800" },
    warning: { bg: "bg-amber-50", border: "border-amber-200", title: "text-amber-800" },
    info: { bg: "bg-blue-50", border: "border-blue-200", title: "text-blue-800" },
    success: { bg: "bg-green-50", border: "border-green-200", title: "text-green-800" },
  };
  const s = styles[insight.type] || styles.info;
  return (
    <div className={`${s.bg} border ${s.border} rounded-lg px-4 py-2.5 flex items-start gap-3`}>
      <div className="min-w-0">
        <p className={`text-sm font-semibold ${s.title}`}>{insight.title}</p>
        <p className="text-xs text-gray-600 mt-0.5 leading-relaxed">{insight.detail}</p>
      </div>
    </div>
  );
}

function ZabbixSeverity({ level }: { level: string }) {
  const map: Record<string, { label: string; color: string }> = {
    "5": { label: "Disaster", color: "bg-red-100 text-red-700" },
    "4": { label: "High", color: "bg-orange-100 text-orange-700" },
    "3": { label: "Average", color: "bg-yellow-100 text-yellow-700" },
    "2": { label: "Warning", color: "bg-amber-100 text-amber-700" },
    "1": { label: "Info", color: "bg-blue-100 text-blue-600" },
    "0": { label: "N/A", color: "bg-gray-100 text-gray-500" },
  };
  const s = map[level] || map["0"];
  return <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${s.color}`}>{s.label}</span>;
}
