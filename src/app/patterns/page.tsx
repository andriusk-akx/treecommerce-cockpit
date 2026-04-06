import { prisma } from "@/lib/db";
import { getPatternData, getAvailableHosts } from "@/lib/zabbix/patterns";
import { parsePeriodParams, sanitizeParam, validateHostFilter } from "@/lib/params";
import TimelineChart from "./TimelineChart";
import PilotRedirectBanner from "@/app/components/PilotRedirectBanner";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ days?: string; hours?: string; client?: string; host?: string }>;
}

export default async function PatternsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const { days, hoursParam, periodLabel } = parsePeriodParams(params);
  const clientFilter = sanitizeParam(params.client);
  // hostFilter is validated after we know the known hosts list (below)
  const rawHostFilter = sanitizeParam(params.host);

  // PERF-003: Parallelize store lookup and host fetching
  const [storeResult, hostsResult] = await Promise.allSettled([
    clientFilter
      ? prisma.store.findUnique({ where: { id: clientFilter } })
      : Promise.resolve(null),
    getAvailableHosts(),
  ]);

  let clientStoreName: string | null = null;
  if (storeResult.status === "fulfilled" && storeResult.value) {
    clientStoreName = storeResult.value.name || null;
  }

  const allHosts = hostsResult.status === "fulfilled" && hostsResult.value ? hostsResult.value : [];
  const knownHostNames = allHosts.map((h) => h.hostName);
  const hostFilter = validateHostFilter(rawHostFilter, knownHostNames);

  // Now fetch pattern data (depends on clientStoreName)
  const data = await getPatternData(days, clientStoreName, hostFilter || null);

  // Group hosts by client
  const hostsByClient = new Map<string, { hostId: string; hostName: string }[]>();
  for (const h of allHosts) {
    const key = h.clientName || "Kita";
    if (!hostsByClient.has(key)) hostsByClient.set(key, []);
    hostsByClient.get(key)!.push({ hostId: h.hostId, hostName: h.hostName });
  }

  // Filter hosts shown in picker: if client filter active, only show that client's hosts
  const visibleGroups: [string, { hostId: string; hostName: string }[]][] = [];
  if (clientStoreName) {
    const clientHosts = hostsByClient.get(clientStoreName) || [];
    if (clientHosts.length > 0) visibleGroups.push([clientStoreName, clientHosts]);
  } else {
    for (const [key, hosts] of hostsByClient) {
      visibleGroups.push([key, hosts]);
    }
  }

  // Sort groups: named clients first alphabetically, then "Kita"
  visibleGroups.sort((a, b) => {
    if (a[0] === "Kita") return 1;
    if (b[0] === "Kita") return -1;
    return a[0].localeCompare(b[0]);
  });

  const baseQ = (clientFilter ? `&client=${clientFilter}` : "") + (hostFilter ? `&host=${hostFilter}` : "");
  const baseQNoHost = clientFilter ? `&client=${clientFilter}` : "";
  const DAY_LABELS = ["Pr", "An", "Tr", "Ke", "Pe", "Še", "Se"];

  // Color scale function
  function heatColor(count: number): string {
    if (count === 0) return "#f9fafb";
    const intensity = Math.min(count / Math.max(data.maxCount, 1), 1);
    if (intensity < 0.25) return "#dbeafe";
    if (intensity < 0.5) return "#93c5fd";
    if (intensity < 0.75) return "#3b82f6";
    return "#1e40af";
  }

  function heatTextColor(count: number): string {
    if (count === 0) return "transparent";
    const intensity = Math.min(count / Math.max(data.maxCount, 1), 1);
    return intensity >= 0.5 ? "#ffffff" : "#1e3a5f";
  }

  const maxHourCount = data.hourSummary.length > 0 ? Math.max(...data.hourSummary.map((h) => h.count), 1) : 1;
  const maxDayCount = data.daySummary.length > 0 ? Math.max(...data.daySummary.map((d) => d.count), 1) : 1;

  // For short periods (<=7d), only show heatmap rows for days that have data
  const activeDays = days <= 7
    ? DAY_LABELS.map((label, idx) => ({ label, idx }))
        .filter(({ idx }) => data.daySummary[idx]?.count > 0)
    : DAY_LABELS.map((label, idx) => ({ label, idx }));


  return (
    <div>
      <PilotRedirectBanner subPage="patterns" />
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-800">
            Patterns{clientStoreName ? ` — ${clientStoreName}` : ""}{hostFilter ? ` — ${hostFilter}` : ""}
          </h2>
          <p className="text-xs text-gray-400 mt-0.5">
            {data.totalEvents} events — last {periodLabel} — downtime distribution
          </p>
        </div>
        <div className="flex gap-2">
          {/* Hours filter */}
          <a
            href={`/patterns?hours=1${baseQNoHost}${hostFilter ? `&host=${hostFilter}` : ""}`}
            className={`px-3 py-1.5 text-xs rounded font-medium ${
              hoursParam === 1
                ? "bg-gray-800 text-white"
                : "bg-white text-gray-600 border border-gray-300 hover:bg-gray-50"
            }`}
          >
            1h
          </a>
          {/* Days filters */}
          {[1, 7, 14, 30, 90].map((d) => (
            <a
              key={d}
              href={`/patterns?days=${d}${baseQNoHost}${hostFilter ? `&host=${hostFilter}` : ""}`}
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

      {/* Device filter */}
      <div className="mb-6">
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={`/patterns?days=${days}${baseQNoHost}`}
            className={`px-3 py-1.5 text-[11px] rounded-full font-medium transition-colors ${
              !hostFilter
                ? "bg-gray-800 text-white"
                : "bg-white text-gray-500 border border-gray-200 hover:border-gray-400"
            }`}
          >
            Visi įrenginiai
          </a>
          {visibleGroups.map(([groupName, hosts]) => (
            <span key={groupName} className="flex items-center gap-1.5">
              <span className="text-[9px] text-gray-300 font-medium uppercase tracking-wider ml-2">{groupName}</span>
              {hosts.map((h) => (
                <a
                  key={h.hostName}
                  href={`/patterns?days=${days}${baseQNoHost}&host=${encodeURIComponent(h.hostName)}`}
                  className={`px-2.5 py-1 text-[11px] rounded-full font-medium transition-colors ${
                    hostFilter === h.hostName
                      ? "bg-blue-600 text-white"
                      : "bg-white text-gray-500 border border-gray-200 hover:border-blue-300 hover:text-blue-600"
                  }`}
                >
                  {h.hostName.replace(/^(12eat_|widen_arena_|TreeCom_)/i, "")}
                </a>
              ))}
            </span>
          ))}
        </div>
      </div>

      {/* ===== INTERACTIVE TIMELINE: Events + Downtime (MAIN CHART — TOP) ===== */}
      {data.timeline.length > 0 && (
        <TimelineChart
          timeline={data.timeline}
          totalDowntimeMinutes={data.totalDowntimeMinutes}
        />
      )}

      {/* ===== HEATMAP: Day of week × Hour ===== */}
      <div className="bg-white rounded-lg border border-gray-200 p-5 mb-6">
        <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
          Savaitės diena × Valanda
        </h3>
        <p className="text-[10px] text-gray-400 mb-3">Kiekviena celė rodo kiek įvykių užfiksuota tą savaitės dieną ir valandą. Tamsesnė spalva — daugiau įvykių. Padeda pastebėti pasikartojančius laiko šablonus.</p>

        <div className="overflow-x-auto">
          <div className="min-w-[700px]">
            {/* Hour labels */}
            <div className="flex ml-[38px] mb-1">
              {Array.from({ length: 24 }, (_, i) => (
                <div key={i} className="flex-1 text-center text-[9px] text-gray-400 font-medium">
                  {i % 2 === 0 ? String(i).padStart(2, "0") : ""}
                </div>
              ))}
            </div>

            {/* Grid rows — only days with data for short periods */}
            {activeDays.map(({ label: dayLabel, idx: dayIdx }) => (
              <div key={dayIdx} className="flex items-center mb-[2px]">
                <div className="w-[38px] text-[10px] font-semibold text-gray-500 text-right pr-2">
                  {dayLabel}
                </div>
                <div className="flex flex-1 gap-[2px]">
                  {Array.from({ length: 24 }, (_, hourIdx) => {
                    const cell = data.heatmap.find(
                      (c) => c.day === dayIdx && c.hour === hourIdx
                    );
                    const count = cell?.count || 0;
                    return (
                      <div
                        key={hourIdx}
                        className="flex-1 aspect-square rounded-[3px] flex items-center justify-center transition-all"
                        style={{
                          backgroundColor: heatColor(count),
                          minHeight: "24px",
                        }}
                        title={`${dayLabel} ${String(hourIdx).padStart(2, "0")}:00 — ${count} events`}
                      >
                        <span
                          className="text-[8px] font-bold"
                          style={{ color: heatTextColor(count) }}
                        >
                          {count > 0 ? count : ""}
                        </span>
                      </div>
                    );
                  })}
                </div>
                {/* Day total */}
                <div className="w-[40px] text-right pl-2">
                  <span className="text-[10px] font-semibold text-gray-500">
                    {data.daySummary[dayIdx]?.count || 0}
                  </span>
                </div>
              </div>
            ))}

            {/* Legend */}
            <div className="flex items-center justify-between mt-4 ml-[38px]">
              <div className="flex items-center gap-1.5">
                <span className="text-[9px] text-gray-400">Mažiau</span>
                {[0, 0.25, 0.5, 0.75, 1].map((intensity, i) => (
                  <div
                    key={i}
                    className="w-3 h-3 rounded-[2px]"
                    style={{
                      backgroundColor:
                        intensity === 0
                          ? "#f9fafb"
                          : intensity < 0.3
                            ? "#dbeafe"
                            : intensity < 0.6
                              ? "#93c5fd"
                              : intensity < 0.8
                                ? "#3b82f6"
                                : "#1e40af",
                    }}
                  />
                ))}
                <span className="text-[9px] text-gray-400">Daugiau</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Key insights */}
      <p className="text-[11px] text-gray-400 mb-2">Kada sistema patiria daugiausiai ir mažiausiai įvykių</p>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard label="Peak valanda" value={`${String(data.peakHour).padStart(2, "0")}:00`} sub={`${data.hourSummary[data.peakHour].count} events`} />
        <StatCard label="Rami valanda" value={`${String(data.quietHour).padStart(2, "0")}:00`} sub={`${data.hourSummary[data.quietHour].count} events`} variant="success" />
        <StatCard label="Peak diena" value={data.peakDay} sub={`${data.daySummary.find((d) => d.count === Math.max(...data.daySummary.map((x) => x.count)))?.count || 0} events`} />
        <StatCard label="Rami diena" value={data.quietDay} sub={`${data.daySummary.find((d) => d.count === Math.min(...data.daySummary.map((x) => x.count)))?.count || 0} events`} variant="success" />
      </div>

      {/* ===== TWO COLUMNS: Hour distribution + Day distribution ===== */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Hour of day distribution */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
            Pasiskirstymas per dieną
          </h3>
          <p className="text-[10px] text-gray-400 mb-3">Kuriomis paros valandomis (00–23) vyksta daugiausiai įvykių. Aukštesnis stulpelis — daugiau problemų tą valandą.</p>
          <div className="flex items-end gap-[3px] h-[120px]">
            {data.hourSummary.map((h) => {
              const pct = (h.count / maxHourCount) * 100;
              const isPeak = h.hour === data.peakHour;
              return (
                <div
                  key={h.hour}
                  className="flex-1 flex flex-col items-center justify-end h-full"
                  title={`${String(h.hour).padStart(2, "0")}:00 — ${h.count} events (${h.problems} problems)`}
                >
                  <div
                    className={`w-full rounded-t-[2px] transition-all ${isPeak ? "bg-blue-600" : "bg-blue-300"}`}
                    style={{ height: `${Math.max(pct, h.count > 0 ? 3 : 0)}%` }}
                  />
                </div>
              );
            })}
          </div>
          <div className="flex gap-[3px] mt-1">
            {data.hourSummary.map((h) => (
              <div key={h.hour} className="flex-1 text-center text-[8px] text-gray-400">
                {h.hour % 3 === 0 ? String(h.hour).padStart(2, "0") : ""}
              </div>
            ))}
          </div>
        </div>

        {/* Day of week distribution */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
            Pasiskirstymas per savaitę
          </h3>
          <p className="text-[10px] text-gray-400 mb-3">Kuriomis savaitės dienomis vyksta daugiausiai įvykių. Ilgesnė juosta — daugiau problemų tą dieną.</p>
          <div className="space-y-2">
            {data.daySummary.map((d) => {
              const pct = (d.count / maxDayCount) * 100;
              const isWeekend = d.day >= 5;
              return (
                <div key={d.day} className="flex items-center gap-3">
                  <span className={`w-[24px] text-[10px] font-semibold ${isWeekend ? "text-blue-500" : "text-gray-500"}`}>
                    {d.dayLabel}
                  </span>
                  <div className="flex-1 h-[18px] bg-gray-50 rounded-[3px] overflow-hidden">
                    <div
                      className={`h-full rounded-[3px] ${isWeekend ? "bg-blue-400" : "bg-blue-500"}`}
                      style={{ width: `${Math.max(pct, d.count > 0 ? 2 : 0)}%` }}
                    />
                  </div>
                  <span className="w-[32px] text-right text-[10px] font-semibold text-gray-500">
                    {d.count}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Helpers ---

function formatMinutes(min: number): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return `${h}h ${m}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function StatCard({
  label,
  value,
  sub,
  variant,
}: {
  label: string;
  value: string;
  sub: string;
  variant?: "success";
}) {
  return (
    <div className={`bg-white rounded-lg border ${variant === "success" ? "border-green-200" : "border-gray-200"} px-4 py-3`}>
      <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">{label}</p>
      <p className={`text-xl font-bold ${variant === "success" ? "text-green-600" : "text-gray-900"}`}>{value}</p>
      <p className="text-[10px] text-gray-400 mt-0.5">{sub}</p>
    </div>
  );
}
