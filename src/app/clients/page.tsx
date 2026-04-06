import { prisma } from "@/lib/db";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  let clients: any[] = [];
  try {
    clients = await prisma.client.findMany({
      orderBy: { name: "asc" },
      include: {
        pilots: { select: { id: true, name: true, productType: true, status: true } },
        _count: { select: { stores: true, incidents: true } },
      },
    });
  } catch {
    // DB not ready
  }

  const statusColors: Record<string, string> = {
    ACTIVE: "bg-green-100 text-green-700",
    INACTIVE: "bg-gray-100 text-gray-500",
    PROSPECT: "bg-blue-100 text-blue-700",
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-800">Klientai</h2>
          <p className="text-xs text-gray-400 mt-0.5">Visi registruoti klientai ir jų pilotai</p>
        </div>
        <span className="text-xs text-gray-400">{clients.length} klientų</span>
      </div>

      {clients.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 px-5 py-12 text-center">
          <p className="text-gray-400 mb-2">Klientų dar nėra.</p>
          <p className="text-xs text-gray-300">Naudokite seed komandą arba pridėkite per duomenų bazę.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {clients.map((client) => (
            <Link
              key={client.id}
              href={`/clients/${client.id}`}
              className="block bg-white rounded-lg border border-gray-200 px-5 py-4 hover:border-gray-300 transition-colors"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                  <h3 className="font-semibold text-gray-900">{client.name}</h3>
                  <span className="text-xs text-gray-400 font-mono">{client.code}</span>
                  <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium ${statusColors[client.status] || "bg-gray-100 text-gray-500"}`}>
                    {client.status}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-xs text-gray-400">
                  <span>{client._count.stores} parduotuvių</span>
                  <span>{client._count.incidents} incidentų</span>
                </div>
              </div>
              {client.pilots.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {client.pilots.map((pilot: any) => {
                    const typeColors: Record<string, string> = {
                      TREECOMMERCE: "bg-green-50 text-green-700 border-green-200",
                      RETELLECT: "bg-blue-50 text-blue-700 border-blue-200",
                      OTHER: "bg-gray-50 text-gray-600 border-gray-200",
                    };
                    return (
                      <span
                        key={pilot.id}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded border text-xs font-medium ${typeColors[pilot.productType] || typeColors.OTHER}`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${
                          pilot.status === "ACTIVE" ? "bg-green-500" :
                          pilot.status === "PAUSED" ? "bg-yellow-500" : "bg-gray-400"
                        }`} />
                        {pilot.name}
                      </span>
                    );
                  })}
                </div>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
