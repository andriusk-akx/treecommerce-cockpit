import { prisma } from "@/lib/db";
import { getDeviceUptimeData, type HostUptime } from "@/lib/zabbix/uptime";
import { parsePeriodParams, sanitizeParam } from "@/lib/params";
import PilotRedirectBanner from "@/app/components/PilotRedirectBanner";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{
    days?: string;
    hours?: string;
    client?: string;
    host?: string;
  }>;
}

export default async function UptimePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const { days, hoursParam, periodLabel } = parsePeriodParams(params);
  const clientFilter = sanitizeParam(params.client);
  const hostFilter = sanitizeParam(params.host);

  // PERF-002: Parallelize store lookup and uptime data fetch
  let clientStoreName: string | null = null;
  let hostData: HostUptime[] = [];

  // PERF: Single store query, then parallel Zabbix fetch
  if (clientFilter) {
    try {
      const store = await prisma.store.findUnique({ where: { id: clientFilter } });
      clientStoreName = store?.name || null;
    } catch { /* DB unavailable */ }
  }

  try {
    hostData = await getDeviceUptimeData(days, clientStoreName);
  } catch (e) {
    return (
      <div>
        <h2 className="text-lg font-semibold text-gray-800 mb-6">Device Uptime</h2>
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
          Failed to load uptime data: {String(e)}
        </div>
      </div>
    );
  }

  // Summary stats
  const totalHosts = hostData.length;
  const hostsDown = hostData.filter((h) => h.status === "down").length;
  const hostsUp = totalHosts - hostsDown;
  const avgUptime =
    hostData.length > 0
      ? Math.round((hostData.reduce((s, h) => s + h.uptimePercent, 0) / hostData.length) * 100) / 100
      : 100;
  const totalIncidents = hostData.reduce((s, h) => s + h.incidentCount, 0);

  const baseQuery = clientFilter ? `&client=${clientFilter}` : "";
  const selectedHost = hostFilter ? hostData.find((h) => h.hostId === hostFilter) : null;

  return (
    <div>
      <PilotRedirectBanner subPage="uptime" />
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-800">
            Device Uptime{clientStoreName ? ` — ${clientStoreName}` : ""}
          </h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Downtime periods per device — last {periodLabel}
          </p>
        </div>
        <div className="flex gap-2">
          <a
            href={`/uptime?hours=1${baseQuery}`}
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
              href={`/uptime?days=${d}${baseQuery}`}
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
        <MiniCard label="Total Devices" value={String(totalHosts)} />
        <MiniCard label="Online Now" value={String(hostsUp)} variant="success" />
        <MiniCard label="Issues Now" value={String(hostsDown)} variant={hostsDown > 0 ? "danger" : "success"} />
        <MiniCard label="Avg Uptime" value={`${avgUptime}%`} variant={avgUptime >= 99 ? "success" : avgUptime >= 95 ? "warning" : "danger"} />
        <MiniCard label="Total Incidents" value={String(totalIncidents)} />
      </div>

      {/* Host List */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden mb-6">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-left text-xs uppercase tracking-wide">
            <tr>
              <th className="px-4 py-3">Device</th>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Uptime</th>
              <th className="px-4 py-3">Total Downtime</th>
              <th className="px-4 py-3">Incidents</th>
              <th className="px-4 py-3">MTTR</th>
              <th className="px-4 py-3">Longest Outage</th>
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
                <td className="px-4 py-3 text-gray-600 text-xs">{host.clientName || "—"}</td>
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
                      href={`/uptime?days=${days}&host=${host.hostId}${baseQuery}`}
                      className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                    >
                      {hostFilter === host.hostId ? "▲ Hide" : "▼ Details"}
                    </a>
                  )}
                </td>
              </tr>
            ))}
            {hostData.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-gray-400">
                  No monitored devices found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Downtime Detail for Selected Host */}
      {selectedHost && selectedHost.downtimePeriods.length > 0 && (
        <div className="space-y-4">
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
              <h3 className="text-sm font-semibold text-gray-800">
                Downtime Periods — {selectedHost.hostName}
              </h3>
              <p className="text-xs text-gray-400 mt-0.5">
                {selectedHost.downtimePeriods.length} incident{selectedHost.downtimePeriods.length !== 1 ? "s" : ""} in last {days} days
              </p>
            </div>

            {selectedHost.downtimePeriods.map((period, i) => (
              <div key={i} className={`border-b border-gray-100 last:border-b-0 ${!period.end ? "bg-red-50/20" : ""}`}>
                {/* Main row */}
                <div className="px-4 py-3 flex items-start gap-6">
                  {/* Time */}
                  <div className="min-w-[140px]">
                    <div className="text-xs font-medium text-gray-900">
                      {period.start.toLocaleDateString("lt-LT")} {period.start.toLocaleTimeString("lt-LT", { hour: "2-digit", minute: "2-digit" })}
                    </div>
                    <div className="text-xs text-gray-400 mt-0.5">
                      {period.end ? (
                        <>→ {period.end.toLocaleDateString("lt-LT")} {period.end.toLocaleTimeString("lt-LT", { hour: "2-digit", minute: "2-digit" })}</>
                      ) : (
                        <span className="text-red-600 font-medium">→ Still ongoing</span>
                      )}
                    </div>
                  </div>
                  {/* Duration */}
                  <div className="min-w-[70px]">
                    <span className={`text-sm font-bold ${!period.end ? "text-red-600" : "text-gray-700"}`}>
                      {formatDuration(period.durationMinutes)}
                    </span>
                  </div>
                  {/* Severity + source */}
                  <div className="min-w-[70px] flex items-center gap-1.5">
                    <SeverityBadge severity={period.severity} level={period.severityLevel} />
                    {(period.source === "agent_unavailable" || period.source === "event_gap") && (
                      <span className="inline-block px-1.5 py-0.5 rounded text-[9px] font-semibold bg-red-100 text-red-700">OFFLINE</span>
                    )}
                  </div>
                  {/* Problem name + tags */}
                  <div className="flex-1">
                    <div className="text-sm font-medium text-gray-900">{period.problemName}</div>
                    {period.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {period.tags.map((tag, ti) => (
                          <span key={ti} className="inline-block px-1.5 py-0.5 rounded text-[10px] bg-gray-100 text-gray-500">
                            {tag.tag}={tag.value}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Context details */}
                <div className="px-4 pb-3 grid grid-cols-1 lg:grid-cols-3 gap-3">
                  {/* Trigger condition */}
                  {(period.triggerExpression || period.triggerComment) && (
                    <div className="bg-gray-50 rounded px-3 py-2">
                      <p className="text-[10px] uppercase tracking-wide text-gray-400 mb-1 font-medium">Trigger Condition</p>
                      {period.triggerComment && (
                        <p className="text-xs text-gray-700 mb-1">{period.triggerComment}</p>
                      )}
                      {period.triggerExpression && (
                        <code className="text-[10px] text-gray-500 break-all block leading-relaxed">{period.triggerExpression}</code>
                      )}
                    </div>
                  )}

                  {/* Related metrics */}
                  {period.relatedItems.length > 0 && (
                    <div className="bg-gray-50 rounded px-3 py-2">
                      <p className="text-[10px] uppercase tracking-wide text-gray-400 mb-1 font-medium">Related Metrics</p>
                      {period.relatedItems.map((item, ii) => (
                        <div key={ii} className="flex justify-between text-xs mb-0.5">
                          <span className="text-gray-600">{item.name}</span>
                          <span className="text-gray-900 font-medium">{formatMetricValue(item.lastValue, item.units)}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Preceding events */}
                  {period.precedingEvents.length > 0 && (
                    <div className="bg-gray-50 rounded px-3 py-2">
                      <p className="text-[10px] uppercase tracking-wide text-gray-400 mb-1 font-medium">Events Before (24h)</p>
                      {period.precedingEvents.map((ev, ei) => (
                        <div key={ei} className="text-xs mb-0.5 flex items-start gap-1.5">
                          <span className={`inline-block w-1.5 h-1.5 rounded-full mt-1 flex-shrink-0 ${ev.type === "PROBLEM" ? "bg-red-400" : "bg-green-400"}`}></span>
                          <span className="text-gray-400 whitespace-nowrap">{ev.time.toLocaleTimeString("lt-LT", { hour: "2-digit", minute: "2-digit" })}</span>
                          <span className="text-gray-700 leading-tight">{ev.name}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// --- Helper Components ---

function formatMetricValue(value: string, units: string): string {
  const num = parseFloat(value);
  if (isNaN(num)) return value || "—";
  if (units === "B") {
    if (num >= 1073741824) return `${(num / 1073741824).toFixed(1)} GB`;
    if (num >= 1048576) return `${(num / 1048576).toFixed(1)} MB`;
    if (num >= 1024) return `${(num / 1024).toFixed(0)} KB`;
    return `${num} B`;
  }
  if (units === "uptime") {
    const days = Math.floor(num / 86400);
    const hours = Math.floor((num % 86400) / 3600);
    const mins = Math.floor((num % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  }
  if (units === "%") return `${num.toFixed(1)}%`;
  if (num > 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num > 1000) return `${(num / 1000).toFixed(1)}K`;
  return String(num) + (units ? ` ${units}` : "");
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

function SeverityBadge({ severity, level }: { severity: string; level: number }) {
  const colors: Record<string, string> = {
    Disaster: "bg-red-100 text-red-700",
    High: "bg-orange-100 text-orange-700",
    Average: "bg-yellow-100 text-yellow-700",
    Warning: "bg-amber-100 text-amber-700",
    Info: "bg-blue-100 text-blue-600",
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${colors[severity] || "bg-gray-100 text-gray-500"}`}>
      {severity}
    </span>
  );
}
