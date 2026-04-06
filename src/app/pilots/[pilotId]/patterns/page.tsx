import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import { getPatternData, getAvailableHosts } from "@/lib/zabbix/patterns";
import { parsePeriodParams, sanitizeParam, validateHostFilter } from "@/lib/params";
import TimelineChart from "@/app/patterns/TimelineChart";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ pilotId: string }>;
  searchParams: Promise<{ days?: string; hours?: string; host?: string }>;
}

export default async function PilotPatternsPage({ params, searchParams }: PageProps) {
  const { pilotId } = await params;
  const sp = await searchParams;
  const { days, hoursParam, periodLabel } = parsePeriodParams(sp);
  const rawHostFilter = sanitizeParam(sp.host);

  const pilot = await prisma.pilot.findUnique({
    where: { id: pilotId },
    include: { client: { select: { name: true } } },
  });

  if (!pilot) return notFound();

  const clientStoreName = pilot.client.name;

  const allHosts = await getAvailableHosts();
  const knownHostNames = allHosts.map((h) => h.hostName);
  const hostFilter = validateHostFilter(rawHostFilter, knownHostNames);

  const data = await getPatternData(days, clientStoreName, hostFilter || null);

  // Filter hosts relevant to this pilot's client
  const pilotHosts = allHosts.filter((h) => h.clientName === clientStoreName);

  const basePath = `/pilots/${pilotId}/patterns`;
  const DAY_LABELS = ["Pr", "An", "Tr", "Ke", "Pe", "Še", "Se"];

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

  const activeDays = days <= 7
    ? DAY_LABELS.map((label, idx) => ({ label, idx })).filter(({ idx }) => data.daySummary[idx]?.count > 0)
    : DAY_LABELS.map((label, idx) => ({ label, idx }));

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-800">
            Šablonai — {pilot.name}{hostFilter ? ` — ${hostFilter}` : ""}
          </h2>
          <p className="text-xs text-gray-400 mt-0.5">
            {data.totalEvents} įvykiai — {periodLabel} — prastovų pasiskirstymas
          </p>
        </div>
        <div className="flex gap-2">
          <a
            href={`${basePath}?hours=1${hostFilter ? `&host=${hostFilter}` : ""}`}
            className={`px-3 py-1.5 text-xs rounded font-medium ${
              hoursParam === 1 ? "bg-gray-800 text-white" : "bg-white text-gray-600 border border-gray-300 hover:bg-gray-50"
            }`}
          >
            1h
          </a>
          {[1, 7, 14, 30, 90].map((d) => (
            <a
              key={d}
              href={`${basePath}?days=${d}${hostFilter ? `&host=${hostFilter}` : ""}`}
              className={`px-3 py-1.5 text-xs rounded font-medium ${
                !hoursParam && Math.round(days) === d ? "bg-gray-800 text-white" : "bg-white text-gray-600 border border-gray-300 hover:bg-gray-50"
              }`}
            >
              {d}d
            </a>
          ))}
        </div>
      </div>

      {/* Device filter */}
      {pilotHosts.length > 0 && (
        <div className="mb-6">
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={`${basePath}?days=${days}`}
              className={`px-3 py-1.5 text-[11px] rounded-full font-medium transition-colors ${
                !hostFilter ? "bg-gray-800 text-white" : "bg-white text-gray-500 border border-gray-200 hover:border-gray-400"
              }`}
            >
              Visi įrenginiai
            </a>
            {pilotHosts.map((h) => (
              <a
                key={h.hostName}
                href={`${basePath}?days=${days}&host=${encodeURIComponent(h.hostName)}`}
                className={`px-2.5 py-1 text-[11px] rounded-full font-medium transition-colors ${
                  hostFilter === h.hostName
                    ? "bg-blue-600 text-white"
                    : "bg-white text-gray-500 border border-gray-200 hover:border-blue-300 hover:text-blue-600"
                }`}
              >
                {h.hostName.replace(/^(12eat_|widen_arena_|TreeCom_)/i, "")}
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Timeline */}
      {data.timeline.length > 0 && (
        <TimelineChart timeline={data.timeline} totalDowntimeMinutes={data.totalDowntimeMinutes} />
      )}

      {/* Heatmap */}
      <div className="bg-white rounded-lg border border-gray-200 p-5 mb-6">
        <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
          Savaitės diena x Valanda
        </h3>
        <p className="text-[10px] text-gray-400 mb-3">Įvykių pasiskirstymas pagal laiką</p>
        <div className="overflow-x-auto">
          <div className="min-w-[700px]">
            <div className="flex ml-[38px] mb-1">
              {Array.from({ length: 24 }, (_, i) => (
                <div key={i} className="flex-1 text-center text-[9px] text-gray-400 font-medium">
                  {i % 2 === 0 ? String(i).padStart(2, "0") : ""}
                </div>
              ))}
            </div>
            {activeDays.map(({ label: dayLabel, idx: dayIdx }) => (
              <div key={dayIdx} className="flex items-center mb-[2px]">
                <div className="w-[38px] text-[10px] font-semibold text-gray-500 text-right pr-2">{dayLabel}</div>
                <div className="flex flex-1 gap-[2px]">
                  {Array.from({ length: 24 }, (_, hourIdx) => {
                    const cell = data.heatmap.find((c) => c.day === dayIdx && c.hour === hourIdx);
                    const count = cell?.count || 0;
                    return (
                      <div
                        key={hourIdx}
                        className="flex-1 aspect-square rounded-[3px] flex items-center justify-center"
                        style={{ backgroundColor: heatColor(count), minHeight: "24px" }}
                        title={`${dayLabel} ${String(hourIdx).padStart(2, "0")}:00 — ${count} įvykiai`}
                      >
                        <span className="text-[8px] font-bold" style={{ color: heatTextColor(count) }}>
                          {count > 0 ? count : ""}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <div className="w-[40px] text-right pl-2">
                  <span className="text-[10px] font-semibold text-gray-500">{data.daySummary[dayIdx]?.count || 0}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Peak insights */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard label="Peak valanda" value={`${String(data.peakHour).padStart(2, "0")}:00`} sub={`${data.hourSummary[data.peakHour]?.count || 0} įvykiai`} />
        <StatCard label="Rami valanda" value={`${String(data.quietHour).padStart(2, "0")}:00`} sub={`${data.hourSummary[data.quietHour]?.count || 0} įvykiai`} variant="success" />
        <StatCard label="Peak diena" value={data.peakDay} sub={`${data.daySummary.find((d) => d.count === Math.max(...data.daySummary.map((x) => x.count)))?.count || 0} įvykiai`} />
        <StatCard label="Rami diena" value={data.quietDay} sub={`${data.daySummary.find((d) => d.count === Math.min(...data.daySummary.map((x) => x.count)))?.count || 0} įvykiai`} variant="success" />
      </div>

      {/* Hour + Day distribution */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Pasiskirstymas per dieną</h3>
          <div className="flex items-end gap-[3px] h-[120px]">
            {data.hourSummary.map((h) => {
              const pct = (h.count / maxHourCount) * 100;
              const isPeak = h.hour === data.peakHour;
              return (
                <div key={h.hour} className="flex-1 flex flex-col items-center justify-end h-full" title={`${String(h.hour).padStart(2, "0")}:00 — ${h.count} įvykiai`}>
                  <div className={`w-full rounded-t-[2px] ${isPeak ? "bg-blue-600" : "bg-blue-300"}`} style={{ height: `${Math.max(pct, h.count > 0 ? 3 : 0)}%` }} />
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

        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Pasiskirstymas per savaitę</h3>
          <div className="space-y-2">
            {data.daySummary.map((d) => {
              const pct = (d.count / maxDayCount) * 100;
              const isWeekend = d.day >= 5;
              return (
                <div key={d.day} className="flex items-center gap-3">
                  <span className={`w-[24px] text-[10px] font-semibold ${isWeekend ? "text-blue-500" : "text-gray-500"}`}>{d.dayLabel}</span>
                  <div className="flex-1 h-[18px] bg-gray-50 rounded-[3px] overflow-hidden">
                    <div className={`h-full rounded-[3px] ${isWeekend ? "bg-blue-400" : "bg-blue-500"}`} style={{ width: `${Math.max(pct, d.count > 0 ? 2 : 0)}%` }} />
                  </div>
                  <span className="w-[32px] text-right text-[10px] font-semibold text-gray-500">{d.count}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, variant }: { label: string; value: string; sub: string; variant?: "success" }) {
  return (
    <div className={`bg-white rounded-lg border ${variant === "success" ? "border-green-200" : "border-gray-200"} px-4 py-3`}>
      <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">{label}</p>
      <p className={`text-xl font-bold ${variant === "success" ? "text-green-600" : "text-gray-900"}`}>{value}</p>
      <p className="text-[10px] text-gray-400 mt-0.5">{sub}</p>
    </div>
  );
}
