import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import { getDeviceUptimeData, type HostUptime } from "@/lib/zabbix/uptime";
import { parsePeriodParams, sanitizeParam } from "@/lib/params";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ pilotId: string }>;
  searchParams: Promise<{
    days?: string;
    hours?: string;
    host?: string;
  }>;
}

export default async function PilotUptimePage({ params, searchParams }: PageProps) {
  const { pilotId } = await params;
  const sp = await searchParams;
  const { days, hoursParam, periodLabel } = parsePeriodParams(sp);
  const hostFilter = sanitizeParam(sp.host);

  const pilot = await prisma.pilot.findUnique({
    where: { id: pilotId },
    include: {
      client: { select: { name: true } },
    },
  });

  if (!pilot) return notFound();

  // Use client name for Zabbix host filtering
  const clientStoreName = pilot.client.name;

  let hostData: HostUptime[] = [];
  try {
    hostData = await getDeviceUptimeData(days, clientStoreName);
  } catch (e) {
    return (
      <div>
        <h2 className="text-lg font-semibold text-gray-800 mb-6">Uptime — {pilot.name}</h2>
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
          Nepavyko gauti uptime duomenų: {String(e)}
        </div>
      </div>
    );
  }

  const totalHosts = hostData.length;
  const hostsDown = hostData.filter((h) => h.status === "down").length;
  const hostsUp = totalHosts - hostsDown;
  const avgUptime =
    hostData.length > 0
      ? Math.round((hostData.reduce((s, h) => s + h.uptimePercent, 0) / hostData.length) * 100) / 100
      : 100;
  const totalIncidents = hostData.reduce((s, h) => s + h.incidentCount, 0);

  const basePath = `/pilots/${pilotId}/uptime`;
  const selectedHost = hostFilter ? hostData.find((h) => h.hostId === hostFilter) : null;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-800">Uptime — {pilot.name}</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Prastovos per įrenginį — {periodLabel}
          </p>
        </div>
        <div className="flex gap-2">
          <a
            href={`${basePath}?hours=1`}
            className={`px-3 py-1.5 text-xs rounded font-medium ${
              hoursParam === 1
                ? "bg-gray-800 text-white"
                : "bg-white text-gray-600 border border-gray-300 hover:bg-gray-50"
            }`}
          >
            1h
          </a>
          {[1, 7, 14, 30, 90].map((d) => (
            <a
              key={d}
              href={`${basePath}?days=${d}`}
              className={`px-3 py-1.5 text-xs rounded font-medium ${
                !hoursParam && Math.round(days) === d
                  ? "bg-gray-800 text-white"
                  : "bg-white text-gray-600 border border-gray-300 hover:bg-gray-50"
              }`}
            >
              {d}d
            </a>
          ))}
        </div>
      </div>

      {/* KPI Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <MiniCard label="Įrenginiai" value={String(totalHosts)} />
        <MiniCard label="Online" value={String(hostsUp)} variant="success" />
        <MiniCard label="Problemos" value={String(hostsDown)} variant={hostsDown > 0 ? "danger" : "success"} />
        <MiniCard label="Vid. uptime" value={`${avgUptime}%`} variant={avgUptime >= 99 ? "success" : avgUptime >= 95 ? "warning" : "danger"} />
        <MiniCard label="Incidentai" value={String(totalIncidents)} />
      </div>

      {/* Host List */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden mb-6">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-left text-xs uppercase tracking-wide">
            <tr>
              <th className="px-4 py-3">Įrenginys</th>
              <th className="px-4 py-3">Statusas</th>
              <th className="px-4 py-3">Uptime</th>
              <th className="px-4 py-3">Prastova</th>
              <th className="px-4 py-3">Incidentai</th>
              <th className="px-4 py-3">MTTR</th>
              <th className="px-4 py-3">Ilgiausia</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {hostData.map((host) => (
              <tr
                key={host.hostId}
                className={`hover:bg-gray-50 ${host.status === "down" ? "bg-red-50/40" : ""} ${
                  hostFilter === host.hostId ? "bg-blue-50/50 border-l-2 border-l-blue-500" : ""
                }`}
              >
                <td className="px-4 py-3 font-medium text-gray-900">{host.hostName}</td>
                <td className="px-4 py-3">
                  {host.status === "down" ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">
                      <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse"></span> DOWN
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-500"></span> UP
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <UptimeBar percent={host.uptimePercent} />
                </td>
                <td className="px-4 py-3 text-gray-600 text-xs">{formatDuration(host.totalDowntimeMinutes)}</td>
                <td className="px-4 py-3 text-gray-600 text-xs">{host.incidentCount}</td>
                <td className="px-4 py-3 text-gray-600 text-xs">{host.mttrMinutes > 0 ? formatDuration(host.mttrMinutes) : "—"}</td>
                <td className="px-4 py-3 text-gray-600 text-xs">{host.longestOutageMinutes > 0 ? formatDuration(host.longestOutageMinutes) : "—"}</td>
                <td className="px-4 py-3">
                  {host.downtimePeriods.length > 0 && (
                    <a
                      href={`${basePath}?days=${days}&host=${host.hostId}`}
                      className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                    >
                      {hostFilter === host.hostId ? "Slėpti" : "Detalės"}
                    </a>
                  )}
                </td>
              </tr>
            ))}
            {hostData.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-gray-400">
                  Nerasta stebimų įrenginių šiam pilotui.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Downtime Detail for Selected Host */}
      {selectedHost && selectedHost.downtimePeriods.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
            <h3 className="text-sm font-semibold text-gray-800">
              Prastovos — {selectedHost.hostName}
            </h3>
            <p className="text-xs text-gray-400 mt-0.5">
              {selectedHost.downtimePeriods.length} incidentas(-ai) per {periodLabel}
            </p>
          </div>
          {selectedHost.downtimePeriods.map((period, i) => (
            <div key={i} className={`border-b border-gray-100 last:border-b-0 ${!period.end ? "bg-red-50/20" : ""}`}>
              <div className="px-4 py-3 flex items-start gap-6">
                <div className="min-w-[140px]">
                  <div className="text-xs font-medium text-gray-900">
                    {period.start.toLocaleDateString("lt-LT")} {period.start.toLocaleTimeString("lt-LT", { hour: "2-digit", minute: "2-digit" })}
                  </div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    {period.end ? (
                      <>→ {period.end.toLocaleDateString("lt-LT")} {period.end.toLocaleTimeString("lt-LT", { hour: "2-digit", minute: "2-digit" })}</>
                    ) : (
                      <span className="text-red-600 font-medium">→ Vis dar vyksta</span>
                    )}
                  </div>
                </div>
                <div className="min-w-[70px]">
                  <span className={`text-sm font-bold ${!period.end ? "text-red-600" : "text-gray-700"}`}>
                    {formatDuration(period.durationMinutes)}
                  </span>
                </div>
                <div className="flex-1">
                  <div className="text-sm font-medium text-gray-900">{period.problemName}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatDuration(minutes: number): string {
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24) return `${hours}h ${mins}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function MiniCard({ label, value, variant }: { label: string; value: string; variant?: "success" | "warning" | "danger" }) {
  let valueColor = "text-gray-900";
  let borderColor = "border-gray-200";
  if (variant === "success") { valueColor = "text-green-600"; borderColor = "border-green-200"; }
  else if (variant === "warning") { valueColor = "text-orange-600"; borderColor = "border-orange-200"; }
  else if (variant === "danger") { valueColor = "text-red-600"; borderColor = "border-red-200"; }
  return (
    <div className={`bg-white rounded-lg border ${borderColor} px-4 py-3`}>
      <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">{label}</p>
      <p className={`text-2xl font-bold ${valueColor}`}>{value}</p>
    </div>
  );
}

function UptimeBar({ percent }: { percent: number }) {
  let color = "bg-green-500";
  let textColor = "text-green-700";
  if (percent < 95) { color = "bg-red-500"; textColor = "text-red-700"; }
  else if (percent < 99) { color = "bg-orange-500"; textColor = "text-orange-700"; }
  else if (percent < 99.9) { color = "bg-yellow-500"; textColor = "text-yellow-700"; }
  return (
    <div className="flex items-center gap-2">
      <div className="w-20 h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`} style={{ width: `${Math.min(100, percent)}%` }} />
      </div>
      <span className={`text-xs font-medium ${textColor}`}>{percent}%</span>
    </div>
  );
}
