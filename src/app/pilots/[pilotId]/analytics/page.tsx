import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import { getAnalytics } from "@/lib/zabbix/analytics";
import { parsePeriodParams } from "@/lib/params";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ pilotId: string }>;
  searchParams: Promise<{ days?: string; hours?: string }>;
}

export default async function PilotAnalyticsPage({ params, searchParams }: PageProps) {
  const { pilotId } = await params;
  const sp = await searchParams;
  const { days, hoursParam, periodLabel } = parsePeriodParams(sp);

  const pilot = await prisma.pilot.findUnique({
    where: { id: pilotId },
    include: { client: { select: { name: true } } },
  });

  if (!pilot) return notFound();

  const clientStoreName = pilot.client.name;
  const basePath = `/pilots/${pilotId}/analytics`;

  let analytics;
  try {
    analytics = await getAnalytics(days, clientStoreName);
  } catch (e) {
    return (
      <div>
        <h2 className="text-lg font-semibold text-gray-800 mb-6">Analitika — {pilot.name}</h2>
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
          Nepavyko gauti analitikos: {String(e)}
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-800">Analitika — {pilot.name}</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            {periodLabel} — {analytics.totalEvents} įvykiai analizuota
          </p>
        </div>
        <div className="flex gap-2">
          <a
            href={`${basePath}?hours=1`}
            className={`px-3 py-1.5 text-xs rounded font-medium ${
              hoursParam === 1 ? "bg-gray-800 text-white" : "bg-white text-gray-600 border border-gray-300 hover:bg-gray-50"
            }`}
          >
            1h
          </a>
          {[1, 7, 14, 30, 90].map((d) => (
            <a
              key={d}
              href={`${basePath}?days=${d}`}
              className={`px-3 py-1.5 text-xs rounded font-medium ${
                !hoursParam && Math.round(days) === d ? "bg-gray-800 text-white" : "bg-white text-gray-600 border border-gray-300 hover:bg-gray-50"
              }`}
            >
              {d}d
            </a>
          ))}
        </div>
      </div>

      {/* Summary KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <SummaryCard label="Problemos" value={analytics.totalProblems} />
        <SummaryCard label="Išspręsta" value={analytics.totalResolved} variant="success" />
        <SummaryCard label="Vid. sprendimo laikas" value={formatMinutes(analytics.avgResolutionMinutes)} isText />
        <SummaryCard
          label="Neišspręsta"
          value={analytics.totalProblems - analytics.totalResolved}
          variant={analytics.totalProblems - analytics.totalResolved > 0 ? "warning" : "success"}
        />
      </div>

      {/* Daily Trend */}
      <div className="bg-white rounded-lg border border-gray-200 p-5 mb-8">
        <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-4">Incidentų tendencija</h3>
        <div className="flex items-end gap-1 h-32">
          {analytics.dailyCounts.map((day) => {
            const maxCount = Math.max(...analytics.dailyCounts.map((d) => d.count), 1);
            const height = Math.max((day.count / maxCount) * 100, day.count > 0 ? 4 : 0);
            const isToday = day.date === new Date().toISOString().slice(0, 10);
            return (
              <div key={day.date} className="flex-1 flex flex-col items-center justify-end group relative">
                <div className="absolute -top-6 hidden group-hover:block bg-gray-800 text-white text-xs rounded px-2 py-1 whitespace-nowrap z-10">
                  {day.date}: {day.count} problemos, {day.resolved} išspręsta
                </div>
                <div
                  className={`w-full rounded-t ${isToday ? "bg-blue-500" : day.count > 0 ? "bg-orange-400" : "bg-gray-100"}`}
                  style={{ height: `${height}%`, minHeight: "2px" }}
                />
              </div>
            );
          })}
        </div>
        <div className="flex justify-between text-xs text-gray-400 mt-2">
          <span>{analytics.dailyCounts[0]?.date}</span>
          <span>Šiandien</span>
        </div>
      </div>

      {/* Two column */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* Top Problems */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-4">Dažniausios problemos</h3>
          {analytics.topProblems.length === 0 ? (
            <p className="text-sm text-green-600 font-medium py-4 text-center">Problemų nėra!</p>
          ) : (
            <div className="space-y-3">
              {analytics.topProblems.map((prob, i) => (
                <div key={i} className="border-b border-gray-50 pb-3 last:border-0">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium text-gray-800 leading-tight">{prob.name}</span>
                    <span className="bg-gray-100 text-gray-700 text-xs font-bold px-2 py-0.5 rounded shrink-0">{prob.count}x</span>
                  </div>
                  <div className="flex gap-3 mt-1 text-xs text-gray-400">
                    <span className={severityColor(prob.severity)}>{prob.severity}</span>
                    <span>Vid.: {formatMinutes(prob.avgDurationMinutes)}</span>
                    <span>{prob.hosts.join(", ")}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Host Reliability */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-4">Patikimumas</h3>
          {analytics.hostDowntimes.length === 0 ? (
            <p className="text-sm text-green-600 font-medium py-4 text-center">100% uptime!</p>
          ) : (
            <div className="space-y-3">
              {analytics.hostDowntimes.map((host) => (
                <div key={host.hostName}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="font-medium text-gray-700">{host.hostName}</span>
                    <span className={`font-bold ${host.uptimePercent >= 99.9 ? "text-green-600" : host.uptimePercent >= 99 ? "text-yellow-600" : "text-red-600"}`}>
                      {host.uptimePercent}%
                    </span>
                  </div>
                  <div className="w-full bg-gray-100 rounded-full h-2 mb-1">
                    <div
                      className={`h-2 rounded-full ${host.uptimePercent >= 99.9 ? "bg-green-500" : host.uptimePercent >= 99 ? "bg-yellow-400" : "bg-red-500"}`}
                      style={{ width: `${host.uptimePercent}%` }}
                    />
                  </div>
                  <div className="flex gap-4 text-xs text-gray-400">
                    <span>{host.incidentCount} incidentai</span>
                    <span>Prastova: {formatMinutes(host.totalDowntimeMinutes)}</span>
                    <span>MTTR: {formatMinutes(host.avgResolutionMinutes)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Monitoring Coverage */}
      <div className="bg-white rounded-lg border border-gray-200 p-5 mb-8">
        <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-4">Stebėjimo aprėptis</h3>
        <table className="w-full text-sm">
          <thead className="text-gray-500 text-left text-xs uppercase tracking-wide">
            <tr>
              <th className="pb-2">Hostas</th>
              <th className="pb-2">Trigeriai</th>
              <th className="pb-2">Aktyvios problemos</th>
              <th className="pb-2">Statusas</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {analytics.activeTriggersByHost.map((host) => (
              <tr key={host.hostName}>
                <td className="py-2 font-medium text-gray-800">{host.hostName}</td>
                <td className="py-2 text-gray-600">{host.triggerCount}</td>
                <td className="py-2">
                  <span className={`font-medium ${host.activeProblemCount > 0 ? "text-red-600" : "text-green-600"}`}>
                    {host.activeProblemCount}
                  </span>
                </td>
                <td className="py-2">
                  {host.activeProblemCount === 0 ? (
                    <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">OK</span>
                  ) : (
                    <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">PROBLEMA</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatMinutes(minutes: number): string {
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24) return `${hours}h ${mins}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function severityColor(severity: string): string {
  const map: Record<string, string> = {
    Disaster: "text-red-600 font-medium",
    High: "text-orange-600 font-medium",
    Average: "text-yellow-600",
    Warning: "text-amber-600",
    Info: "text-blue-500",
  };
  return map[severity] || "text-gray-500";
}

function SummaryCard({ label, value, variant, isText }: {
  label: string; value: number | string; variant?: "success" | "warning"; isText?: boolean;
}) {
  let valueColor = "text-gray-900";
  let borderColor = "border-gray-200";
  if (variant === "success") { valueColor = "text-green-600"; borderColor = "border-green-200"; }
  else if (variant === "warning") { valueColor = "text-orange-600"; borderColor = "border-orange-200"; }
  return (
    <div className={`bg-white rounded-lg border ${borderColor} px-5 py-4`}>
      <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">{label}</p>
      <p className={`${isText ? "text-xl" : "text-2xl"} font-bold ${valueColor}`}>{value}</p>
    </div>
  );
}
