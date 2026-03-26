import { prisma } from "@/lib/db";
import { getFullEventStream, type StreamEvent } from "@/lib/zabbix/incident-stream";
import { parsePeriodParams, sanitizeParam } from "@/lib/params";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{
    days?: string;
    hours?: string;
    category?: string;
    type?: string;
    host?: string;
    client?: string;
  }>;
}

const ALL_CATEGORIES = [
  "VMI / Fiscal", "Service", "Payment", "Restart", "Memory",
  "CPU / Load", "Disk", "Network", "Agent", "System Change", "Other",
];

const VALID_TYPES = ["", "PROBLEM", "RESOLVED"];

export default async function IncidentsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const { days, hoursParam, periodLabel } = parsePeriodParams(params);
  const categoryFilter = ALL_CATEGORIES.includes(params.category || "") ? params.category! : "";
  const typeFilter = VALID_TYPES.includes(params.type || "") ? (params.type || "") : "";
  const hostFilter = sanitizeParam(params.host);
  const clientFilter = sanitizeParam(params.client);

  let clientStoreName: string | null = null;
  if (clientFilter) {
    const store = await prisma.store.findUnique({ where: { id: clientFilter } });
    clientStoreName = store?.name || null;
  }

  let events: StreamEvent[];
  try {
    events = await getFullEventStream(days, clientStoreName);
  } catch (e) {
    return (
      <div>
        <h2 className="text-lg font-semibold text-gray-800 mb-6">Event Stream</h2>
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
          Failed to load events: {String(e)}
        </div>
      </div>
    );
  }

  // Compute stats before filtering
  const totalAll = events.length;
  const problemsAll = events.filter((e) => e.type === "PROBLEM").length;
  const resolvedAll = events.filter((e) => e.type === "RESOLVED").length;

  // Category breakdown (before filtering)
  const categoryStats = new Map<string, { total: number; problems: number }>();
  for (const e of events) {
    const cat = e.category;
    const existing = categoryStats.get(cat) || { total: 0, problems: 0 };
    existing.total++;
    if (e.type === "PROBLEM") existing.problems++;
    categoryStats.set(cat, existing);
  }

  // Host breakdown (before filtering)
  const hostStats = new Map<string, number>();
  for (const e of events) {
    hostStats.set(e.hostName, (hostStats.get(e.hostName) || 0) + 1);
  }

  // Apply filters
  let filtered = events;
  if (categoryFilter) filtered = filtered.filter((e) => e.category === categoryFilter);
  if (typeFilter) filtered = filtered.filter((e) => e.type === typeFilter);
  if (hostFilter) filtered = filtered.filter((e) => e.hostName === hostFilter);

  const baseQ = [
    `days=${days}`,
    clientFilter ? `client=${clientFilter}` : "",
  ].filter(Boolean).join("&");

  function buildUrl(extra: Record<string, string> = {}) {
    const parts = [baseQ];
    if (extra.category || categoryFilter) parts.push(`category=${extra.category ?? categoryFilter}`);
    if (extra.type || typeFilter) parts.push(`type=${extra.type ?? typeFilter}`);
    if (extra.host || hostFilter) parts.push(`host=${extra.host ?? hostFilter}`);
    // Remove empty parts and duplicates
    return `/incidents?${parts.filter(Boolean).join("&")}`;
  }

  const clearUrl = `/incidents?${baseQ}`;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-800">
            Event Stream{clientStoreName ? ` — ${clientStoreName}` : ""}
          </h2>
          <p className="text-xs text-gray-400 mt-0.5">
            All Zabbix events — last {periodLabel} — {totalAll} total
          </p>
        </div>
        <div className="flex gap-2">
          <a
            href={`/incidents?hours=1${clientFilter ? `&client=${clientFilter}` : ""}`}
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
              href={`/incidents?days=${d}${clientFilter ? `&client=${clientFilter}` : ""}`}
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

      {/* KPI row */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <KpiCard label="Total Events" value={totalAll} />
        <KpiCard label="Problems" value={problemsAll} variant={problemsAll > 0 ? "warning" : "default"} />
        <KpiCard label="Resolutions" value={resolvedAll} variant="success" />
      </div>

      {/* Category breakdown */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
        <p className="text-[10px] uppercase tracking-wide text-gray-400 font-medium mb-2">By Category</p>
        <div className="flex flex-wrap gap-2">
          <a
            href={clearUrl}
            className={`px-2.5 py-1 text-xs rounded font-medium ${
              !categoryFilter ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            All ({totalAll})
          </a>
          {Array.from(categoryStats.entries())
            .sort((a, b) => b[1].total - a[1].total)
            .map(([cat, stats]) => (
              <a
                key={cat}
                href={`/incidents?${baseQ}&category=${encodeURIComponent(cat)}${typeFilter ? `&type=${typeFilter}` : ""}${hostFilter ? `&host=${encodeURIComponent(hostFilter)}` : ""}`}
                className={`px-2.5 py-1 text-xs rounded font-medium ${
                  categoryFilter === cat
                    ? "bg-gray-800 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {cat} ({stats.total})
              </a>
            ))}
        </div>
      </div>

      {/* Type + Host filters */}
      <div className="flex flex-wrap gap-2 mb-4">
        <span className="text-xs text-gray-400 py-1">Type:</span>
        {["", "PROBLEM", "RESOLVED"].map((t) => (
          <a
            key={t}
            href={`/incidents?${baseQ}${categoryFilter ? `&category=${encodeURIComponent(categoryFilter)}` : ""}${t ? `&type=${t}` : ""}${hostFilter ? `&host=${encodeURIComponent(hostFilter)}` : ""}`}
            className={`px-2.5 py-1 text-xs rounded font-medium ${
              typeFilter === t ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {t || "All"}
          </a>
        ))}

        {hostFilter && (
          <>
            <span className="text-gray-300 py-1">|</span>
            <span className="text-xs text-gray-400 py-1">Host: {hostFilter}</span>
            <a
              href={`/incidents?${baseQ}${categoryFilter ? `&category=${encodeURIComponent(categoryFilter)}` : ""}${typeFilter ? `&type=${typeFilter}` : ""}`}
              className="px-2 py-1 text-xs text-red-600 hover:text-red-800 font-medium"
            >
              Clear host
            </a>
          </>
        )}
      </div>

      {/* Event Stream Table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-left text-xs uppercase tracking-wide">
            <tr>
              <th className="px-3 py-3 w-[130px]">Time</th>
              <th className="px-3 py-3 w-[70px]">Type</th>
              <th className="px-3 py-3">Event</th>
              <th className="px-3 py-3 w-[90px]">Category</th>
              <th className="px-3 py-3 w-[80px]">Severity</th>
              <th className="px-3 py-3 w-[120px]">Host</th>
              <th className="px-3 py-3 w-[90px]">Duration</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.slice(0, 500).map((evt) => (
              <tr key={evt.id} className={`hover:bg-gray-50 ${evt.type === "PROBLEM" ? "bg-red-50/20" : ""}`}>
                <td className="px-3 py-2.5 text-gray-500 text-xs whitespace-nowrap">
                  <div>{evt.time.toLocaleDateString("lt-LT")}</div>
                  <div className="text-gray-400">{evt.time.toLocaleTimeString("lt-LT", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</div>
                </td>
                <td className="px-3 py-2.5">
                  {evt.type === "PROBLEM" ? (
                    <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-100 text-red-700">PROBLEM</span>
                  ) : (
                    <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-green-100 text-green-700">OK</span>
                  )}
                </td>
                <td className="px-3 py-2.5">
                  <div className="text-gray-900 leading-tight text-xs font-medium">{evt.name}</div>
                  {evt.opdata && (
                    <div className="text-[10px] text-gray-400 mt-0.5">{evt.opdata}</div>
                  )}
                  {evt.tags.length > 0 && (
                    <div className="flex flex-wrap gap-0.5 mt-1">
                      {evt.tags.map((tag, ti) => (
                        <span key={ti} className="inline-block px-1 py-0 rounded text-[9px] bg-gray-100 text-gray-400">
                          {tag.tag}{tag.value ? `=${tag.value}` : ""}
                        </span>
                      ))}
                    </div>
                  )}
                  {evt.type === "PROBLEM" && evt.durationMinutes !== null && (
                    <div className="text-[10px] text-green-600 mt-0.5">
                      Resolved after {formatDuration(evt.durationMinutes)}
                    </div>
                  )}
                  {evt.type === "PROBLEM" && evt.durationMinutes === null && (
                    <div className="text-[10px] text-red-500 font-medium mt-0.5">
                      Still open
                    </div>
                  )}
                </td>
                <td className="px-3 py-2.5">
                  <a
                    href={`/incidents?${baseQ}&category=${encodeURIComponent(evt.category)}${typeFilter ? `&type=${typeFilter}` : ""}${hostFilter ? `&host=${encodeURIComponent(hostFilter)}` : ""}`}
                    className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-50 text-blue-600 hover:bg-blue-100"
                  >
                    {evt.category}
                  </a>
                </td>
                <td className="px-3 py-2.5">
                  <SeverityBadge severity={evt.severity} level={evt.severityLevel} />
                </td>
                <td className="px-3 py-2.5">
                  <a
                    href={`/incidents?${baseQ}&host=${encodeURIComponent(evt.hostName)}${categoryFilter ? `&category=${encodeURIComponent(categoryFilter)}` : ""}${typeFilter ? `&type=${typeFilter}` : ""}`}
                    className="text-xs text-gray-600 hover:text-blue-600"
                  >
                    {evt.hostName}
                  </a>
                </td>
                <td className="px-3 py-2.5 text-xs text-gray-500">
                  {evt.type === "PROBLEM" && evt.durationMinutes !== null && formatDuration(evt.durationMinutes)}
                  {evt.type === "PROBLEM" && evt.durationMinutes === null && (
                    <span className="text-red-500 font-medium">ongoing</span>
                  )}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-400">
                  No events found for this period and filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-gray-400">
        Showing {Math.min(filtered.length, 500)} of {filtered.length} events
        {filtered.length !== totalAll ? ` (filtered from ${totalAll})` : ""}
      </p>
    </div>
  );
}

// --- Helpers ---

function formatDuration(minutes: number): string {
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24) return `${hours}h ${mins}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function KpiCard({ label, value, variant }: { label: string; value: number; variant?: "success" | "warning" | "default" }) {
  let color = "text-gray-900";
  let border = "border-gray-200";
  if (variant === "success") { color = "text-green-600"; border = "border-green-200"; }
  if (variant === "warning") { color = "text-orange-600"; border = "border-orange-200"; }
  return (
    <div className={`bg-white rounded-lg border ${border} px-4 py-3`}>
      <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">{label}</p>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
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
    "N/A": "bg-gray-100 text-gray-400",
  };
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${colors[severity] || "bg-gray-100 text-gray-500"}`}>
      {severity}
    </span>
  );
}
