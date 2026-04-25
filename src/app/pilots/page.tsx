import { prisma } from "@/lib/db";
import Link from "next/link";

// Pilot list is DB-only; ISR with 5-min revalidation is sufficient.
export const revalidate = 300;

export default async function PilotsPage() {
  let pilots: any[] = [];
  try {
    pilots = await prisma.pilot.findMany({
      orderBy: [{ status: "asc" }, { name: "asc" }],
      include: {
        client: { select: { name: true, code: true } },
        _count: { select: { devices: true, incidents: true, stores: true, dataSources: true } },
      },
    });
  } catch {
    // DB not ready
  }

  const typeColors: Record<string, string> = {
    TREECOMMERCE: "bg-green-100 text-green-700",
    RETELLECT: "bg-blue-100 text-blue-700",
    OTHER: "bg-gray-100 text-gray-600",
  };

  const statusColors: Record<string, string> = {
    ACTIVE: "bg-green-100 text-green-700",
    PLANNED: "bg-blue-100 text-blue-700",
    PAUSED: "bg-yellow-100 text-yellow-700",
    COMPLETED: "bg-gray-100 text-gray-500",
  };

  const statusOrder = ["ACTIVE", "PLANNED", "PAUSED", "COMPLETED"];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-800">Pilotai</h2>
          <p className="text-xs text-gray-400 mt-0.5">Visi pilotai visose klientų organizacijose</p>
        </div>
        <span className="text-xs text-gray-400">{pilots.length} pilotų</span>
      </div>

      {pilots.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 px-5 py-12 text-center">
          <p className="text-gray-400 mb-2">Pilotų dar nėra.</p>
          <p className="text-xs text-gray-300">Naudokite seed komandą arba pridėkite per duomenų bazę.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {statusOrder.map((status) => {
            const group = pilots.filter((p) => p.status === status);
            if (group.length === 0) return null;
            return (
              <div key={status}>
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                  {status} ({group.length})
                </h3>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-6">
                  {group.map((pilot) => (
                    <Link
                      key={pilot.id}
                      href={`/pilots/${pilot.id}/overview`}
                      className="bg-white rounded-lg border border-gray-200 px-5 py-4 hover:border-gray-300 transition-colors"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <h4 className="font-semibold text-gray-900">{pilot.name}</h4>
                        <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium ${typeColors[pilot.productType] || typeColors.OTHER}`}>
                          {pilot.productType}
                        </span>
                        <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium ${statusColors[pilot.status]}`}>
                          {pilot.status}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 mb-2">
                        {pilot.client.name} <span className="text-gray-400">({pilot.client.code})</span>
                      </p>
                      {pilot.goalSummary && (
                        <p className="text-xs text-gray-400 mb-2 line-clamp-2">{pilot.goalSummary}</p>
                      )}
                      <div className="flex gap-4 text-xs text-gray-400">
                        <span>{pilot._count.devices} įrenginių</span>
                        <span>{pilot._count.stores} parduotuvių</span>
                        <span>{pilot._count.incidents} incidentų</span>
                        <span>{pilot._count.dataSources} šaltinių</span>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
