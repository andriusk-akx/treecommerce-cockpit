import { prisma } from "@/lib/db";
import SyncButton from "./components/SyncButton";
import AutoSync from "./components/AutoSync";
import { getZabbixClient } from "@/lib/zabbix/client";
import { generateInsights, type Insight } from "@/lib/zabbix/insights";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ client?: string }>;
}

export default async function DashboardPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const clientFilter = params.client || "";

  // Build where clause for client filtering
  const storeWhere = clientFilter ? { storeId: clientFilter } : {};
  const openWhere = { ...storeWhere, status: { in: ["OPEN", "ACKNOWLEDGED"] as const } };

  const [
    totalIncidents,
    openIncidents,
    criticalIncidents,
    highIncidents,
    resolvedIncidents,
    notesCount,
    incidentsByStore,
  ] = await Promise.all([
    prisma.incident.count({ where: storeWhere }),
    prisma.incident.count({ where: openWhere }),
    prisma.incident.count({ where: { ...openWhere, severity: "CRITICAL" } }),
    prisma.incident.count({ where: { ...openWhere, severity: "HIGH" } }),
    prisma.incident.count({ where: { ...storeWhere, status: "RESOLVED" } }),
    prisma.note.count({ where: clientFilter ? { storeId: clientFilter } : {} }),
    prisma.incident.groupBy({
      by: ["storeId"],
      where: openWhere,
      _count: true,
    }),
  ]);

  const stores = await prisma.store.findMany();
  const storeMap = new Map(stores.map((s) => [s.id, s.name]));

  const recentIncidents = await prisma.incident.findMany({
    take: 10,
    where: storeWhere,
    orderBy: { startedAt: "desc" },
    include: { store: true },
  });

  const severityCounts = await prisma.incident.groupBy({
    by: ["severity"],
    where: openWhere,
    _count: true,
  });
  const severityMap: Record<string, number> = {};
  for (const s of severityCounts) {
    severityMap[s.severity] = s._count;
  }

  // PERF-004: Fetch Zabbix data once, share with insights to avoid duplicate API calls
  let zabbixData: { version: string; problems: any[]; hosts: any[] } | null = null;
  let insights: Insight[] = [];
  try {
    const zClient = getZabbixClient();
    const [version, problems, hosts] = await Promise.all([
      zClient.getVersion(),
      zClient.getProblems() as Promise<any[]>,
      zClient.getHosts() as Promise<any[]>,
    ]);
    zabbixData = { version, problems, hosts };
    // Pass pre-fetched data to insights — avoids 2 redundant API calls
    insights = await generateInsights({ problems, hosts });
  } catch (e) {
    // Zabbix unavailable
  }

  // Current client name for header
  const currentClientName = clientFilter ? storeMap.get(clientFilter) : null;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-800">
            Overview{currentClientName ? ` — ${currentClientName}` : ""}
          </h2>
          {zabbixData && (
            <p className="text-xs text-gray-400 mt-0.5">
              Zabbix v{zabbixData.version} — {zabbixData.hosts.length} hosts monitored
            </p>
          )}
        </div>
        <SyncButton />
      </div>
      <AutoSync intervalMs={300000} />

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
        <KpiCard label="Open Incidents" value={openIncidents} highlight={openIncidents > 0} />
        <KpiCard label="Critical" value={criticalIncidents} highlight={criticalIncidents > 0} variant="critical" />
        <KpiCard label="High" value={highIncidents} highlight={highIncidents > 0} variant="warning" />
        <KpiCard label="Resolved" value={resolvedIncidents} variant="success" />
        <KpiCard label="Notes" value={notesCount} />
      </div>

      {/* AI Insights */}
      {insights.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-5 mb-8">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-sm">🔍</span>
            <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide">AI Įžvalgos</h3>
            <span className="text-[10px] text-gray-400 ml-auto">Auto-generated from Zabbix data</span>
          </div>
          <div className="space-y-2">
            {insights.map((insight, i) => (
              <InsightRow key={i} insight={insight} />
            ))}
          </div>
        </div>
      )}

      {/* Two column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* Severity Breakdown */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-4">Open by Severity</h3>
          <div className="space-y-3">
            {(["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const).map((sev) => {
              const count = severityMap[sev] || 0;
              const maxCount = Math.max(openIncidents, 1);
              const pct = Math.round((count / maxCount) * 100);
              return (
                <div key={sev}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="font-medium text-gray-700">{sev}</span>
                    <span className="text-gray-500">{count}</span>
                  </div>
                  <div className="w-full bg-gray-100 rounded-full h-2">
                    <div className={`h-2 rounded-full ${severityBarColor(sev)}`} style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Incidents by Client */}
        {!clientFilter && (
          <div className="bg-white rounded-lg border border-gray-200 p-5">
            <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-4">Open by Client</h3>
            {incidentsByStore.length === 0 ? (
              <p className="text-sm text-green-600 font-medium py-4 text-center">All clear!</p>
            ) : (
              <div className="space-y-3">
                {incidentsByStore.map((item) => {
                  const name = item.storeId ? storeMap.get(item.storeId) || "Unknown" : "Unassigned";
                  const pct = Math.round((item._count / Math.max(openIncidents, 1)) * 100);
                  return (
                    <div key={item.storeId || "null"}>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="font-medium text-gray-700">{name}</span>
                        <span className="text-gray-500">{item._count}</span>
                      </div>
                      <div className="w-full bg-gray-100 rounded-full h-2">
                        <div className="h-2 rounded-full bg-blue-500" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Client-specific: show category breakdown instead */}
        {clientFilter && (
          <div className="bg-white rounded-lg border border-gray-200 p-5">
            <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-4">
              {currentClientName} — Open Incidents
            </h3>
            {openIncidents === 0 ? (
              <p className="text-sm text-green-600 font-medium py-4 text-center">All clear!</p>
            ) : (
              <div className="space-y-2">
                {recentIncidents.filter((i) => i.status === "OPEN" || i.status === "ACKNOWLEDGED").map((i) => (
                  <div key={i.id} className="flex items-center gap-2 text-sm">
                    <SeverityBadge severity={i.severity} />
                    <span className="text-gray-800 truncate">{i.title}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Zabbix Live Problems */}
      {zabbixData && (
        <div className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide">
              Zabbix Live — {zabbixData.problems.length} active problem{zabbixData.problems.length !== 1 ? "s" : ""}
            </h3>
            <StatusDot active={zabbixData.problems.length === 0} />
          </div>
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-left text-xs uppercase tracking-wide">
                <tr>
                  <th className="px-4 py-3">Problem</th>
                  <th className="px-4 py-3">Severity</th>
                  <th className="px-4 py-3">Duration</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {zabbixData.problems.map((p: any) => {
                  const started = new Date(parseInt(p.clock) * 1000);
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
                  <tr><td colSpan={3} className="px-4 py-6 text-center text-green-600 font-medium">All clear — no active problems!</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Zabbix Hosts */}
      {zabbixData && zabbixData.hosts.length > 0 && (
        <div className="mb-8">
          <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-3">
            Monitored Hosts ({zabbixData.hosts.length})
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

      {/* Recent Incidents */}
      <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-3">Recent Incidents</h3>
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-left text-xs uppercase tracking-wide">
            <tr>
              <th className="px-4 py-3">Title</th>
              <th className="px-4 py-3">Severity</th>
              <th className="px-4 py-3">Category</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Started</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {recentIncidents.map((incident) => (
              <tr key={incident.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-900">{incident.title}</td>
                <td className="px-4 py-3"><SeverityBadge severity={incident.severity} /></td>
                <td className="px-4 py-3 text-gray-600 text-xs">{incident.category}</td>
                <td className="px-4 py-3"><StatusBadge status={incident.status} /></td>
                <td className="px-4 py-3 text-gray-600">{incident.store?.name ?? "\u2014"}</td>
                <td className="px-4 py-3 text-gray-500 text-xs">{formatDate(incident.startedAt)}</td>
              </tr>
            ))}
            {recentIncidents.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-400">No incidents yet. Press Sync Zabbix to import.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("lt-LT", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function severityBarColor(severity: string): string {
  const colors: Record<string, string> = { CRITICAL: "bg-red-500", HIGH: "bg-orange-500", MEDIUM: "bg-yellow-400", LOW: "bg-gray-400" };
  return colors[severity] ?? "bg-gray-400";
}

function KpiCard({ label, value, highlight = false, variant }: {
  label: string; value: number; highlight?: boolean; variant?: "critical" | "warning" | "success";
}) {
  let borderColor = "border-gray-200";
  let valueColor = "text-gray-900";
  if (variant === "critical" && highlight) { borderColor = "border-red-300"; valueColor = "text-red-600"; }
  else if (variant === "warning" && highlight) { borderColor = "border-orange-300"; valueColor = "text-orange-600"; }
  else if (variant === "success") { borderColor = "border-green-200"; valueColor = "text-green-600"; }
  else if (highlight) { borderColor = "border-amber-300"; }
  return (
    <div className={`bg-white rounded-lg border ${borderColor} px-5 py-4`}>
      <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">{label}</p>
      <p className={`text-2xl font-bold ${valueColor}`}>{value}</p>
    </div>
  );
}

function StatusDot({ active }: { active: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full ${active ? "bg-green-500" : "bg-red-500"} animate-pulse`} />
      <span className={`text-xs font-medium ${active ? "text-green-600" : "text-red-600"}`}>
        {active ? "All Clear" : "Issues Detected"}
      </span>
    </div>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const colors: Record<string, string> = { CRITICAL: "bg-red-100 text-red-700", HIGH: "bg-orange-100 text-orange-700", MEDIUM: "bg-yellow-100 text-yellow-700", LOW: "bg-gray-100 text-gray-600" };
  return <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${colors[severity] ?? "bg-gray-100 text-gray-600"}`}>{severity}</span>;
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = { OPEN: "bg-blue-100 text-blue-700", ACKNOWLEDGED: "bg-purple-100 text-purple-700", RESOLVED: "bg-green-100 text-green-700", CLOSED: "bg-gray-100 text-gray-500" };
  return <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${colors[status] ?? "bg-gray-100 text-gray-500"}`}>{status}</span>;
}

function InsightRow({ insight }: { insight: Insight }) {
  const styles: Record<string, { icon: string; bg: string; border: string; title: string }> = {
    critical: { icon: "🔴", bg: "bg-red-50", border: "border-red-200", title: "text-red-800" },
    warning: { icon: "🟡", bg: "bg-amber-50", border: "border-amber-200", title: "text-amber-800" },
    info: { icon: "🔵", bg: "bg-blue-50", border: "border-blue-200", title: "text-blue-800" },
    success: { icon: "🟢", bg: "bg-green-50", border: "border-green-200", title: "text-green-800" },
  };
  const s = styles[insight.type] || styles.info;
  return (
    <div className={`${s.bg} border ${s.border} rounded-lg px-4 py-2.5 flex items-start gap-3`}>
      <span className="text-sm mt-0.5 flex-shrink-0">{s.icon}</span>
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
