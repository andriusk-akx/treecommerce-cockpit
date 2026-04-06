import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import { getFullEventStream, type StreamEvent } from "@/lib/zabbix/incident-stream";
import { parsePeriodParams } from "@/lib/params";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ pilotId: string }>;
  searchParams: Promise<{ days?: string; hours?: string }>;
}

export default async function PilotIncidentsPage({ params, searchParams }: PageProps) {
  const { pilotId } = await params;
  const sp = await searchParams;

  const pilot = await prisma.pilot.findUnique({
    where: { id: pilotId },
    select: { id: true, name: true },
  });

  if (!pilot) return notFound();

  const { days, hoursParam, periodLabel } = parsePeriodParams(sp);

  let events: StreamEvent[] = [];
  try {
    events = await getFullEventStream(days);
  } catch {
    // Zabbix unavailable
  }

  const totalAll = events.length;
  const problemsAll = events.filter((e) => e.type === "PROBLEM").length;
  const resolvedAll = events.filter((e) => e.type === "RESOLVED").length;

  const baseUrl = `/pilots/${pilotId}/incidents`;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-800">Įvykiai — {pilot.name}</h2>
          <p className="text-xs text-gray-400 mt-0.5">Zabbix event stream — paskutinės {periodLabel} — {totalAll} viso</p>
        </div>
        <div className="flex gap-2">
          <a href={`${baseUrl}?hours=1`} className={`px-3 py-1.5 text-xs rounded font-medium ${hoursParam === 1 ? "bg-gray-800 text-white" : "bg-white text-gray-600 border border-gray-300 hover:bg-gray-50"}`}>1h</a>
          {[1, 7, 14, 30].map((d) => (
            <a key={d} href={`${baseUrl}?days=${d}`} className={`px-3 py-1.5 text-xs rounded font-medium ${!hoursParam && Math.round(days) === d ? "bg-gray-800 text-white" : "bg-white text-gray-600 border border-gray-300 hover:bg-gray-50"}`}>{d}d</a>
          ))}
        </div>
      </div>

      {/* KPI */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">Visi įvykiai</p>
          <p className="text-2xl font-bold text-gray-900">{totalAll}</p>
        </div>
        <div className={`bg-white rounded-lg border ${problemsAll > 0 ? "border-orange-200" : "border-gray-200"} px-4 py-3`}>
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">Problemos</p>
          <p className={`text-2xl font-bold ${problemsAll > 0 ? "text-orange-600" : "text-gray-900"}`}>{problemsAll}</p>
        </div>
        <div className="bg-white rounded-lg border border-green-200 px-4 py-3">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">Išspręsta</p>
          <p className="text-2xl font-bold text-green-600">{resolvedAll}</p>
        </div>
      </div>

      {/* Event table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-left text-xs uppercase tracking-wide">
            <tr>
              <th className="px-3 py-3">Laikas</th>
              <th className="px-3 py-3">Tipas</th>
              <th className="px-3 py-3">Įvykis</th>
              <th className="px-3 py-3">Sunkumas</th>
              <th className="px-3 py-3">Hostas</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {events.slice(0, 200).map((evt) => (
              <tr key={evt.id} className={`hover:bg-gray-50 ${evt.type === "PROBLEM" ? "bg-red-50/20" : ""}`}>
                <td className="px-3 py-2.5 text-gray-500 text-xs whitespace-nowrap">
                  {evt.time.toLocaleDateString("lt-LT")} {evt.time.toLocaleTimeString("lt-LT", { hour: "2-digit", minute: "2-digit" })}
                </td>
                <td className="px-3 py-2.5">
                  <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold ${evt.type === "PROBLEM" ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"}`}>
                    {evt.type === "PROBLEM" ? "PROBLEM" : "OK"}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-xs text-gray-900 font-medium">{evt.name}</td>
                <td className="px-3 py-2.5">
                  <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${
                    evt.severity === "Disaster" ? "bg-red-100 text-red-700" :
                    evt.severity === "High" ? "bg-orange-100 text-orange-700" :
                    evt.severity === "Average" ? "bg-yellow-100 text-yellow-700" :
                    "bg-gray-100 text-gray-500"
                  }`}>
                    {evt.severity}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-xs text-gray-600">{evt.hostName}</td>
              </tr>
            ))}
            {events.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">Įvykių nerasta šiam periodui.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-gray-400">Rodoma {Math.min(events.length, 200)} iš {events.length}</p>
    </div>
  );
}
