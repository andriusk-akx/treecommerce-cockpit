import { prisma } from "@/lib/db";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ clientId: string }>;
}

export default async function ClientDetailPage({ params }: PageProps) {
  const { clientId } = await params;

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    include: {
      pilots: {
        orderBy: { name: "asc" },
        include: { _count: { select: { devices: true, incidents: true, stores: true } } },
      },
      stores: { orderBy: { name: "asc" } },
      dataSources: true,
      _count: { select: { incidents: true, noteEntries: true } },
    },
  });

  if (!client) return notFound();

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

  return (
    <div>
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-xs text-gray-400 mb-4">
        <Link href="/clients" className="hover:text-gray-600">Klientai</Link>
        <span>/</span>
        <span className="text-gray-600">{client.name}</span>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-800">{client.name}</h2>
          <div className="flex items-center gap-3 mt-1">
            <span className="text-xs text-gray-400 font-mono">{client.code}</span>
            <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium ${client.status === "ACTIVE" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
              {client.status}
            </span>
            <span className="text-xs text-gray-400">{client.type}</span>
          </div>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">Pilotai</p>
          <p className="text-2xl font-bold text-gray-900">{client.pilots.length}</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">Parduotuvės</p>
          <p className="text-2xl font-bold text-gray-900">{client.stores.length}</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">Incidentai</p>
          <p className="text-2xl font-bold text-gray-900">{client._count.incidents}</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">Pastabos</p>
          <p className="text-2xl font-bold text-gray-900">{client._count.noteEntries}</p>
        </div>
      </div>

      {/* Pilots */}
      <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-3">Pilotai</h3>
      {client.pilots.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 px-5 py-8 text-center text-gray-400 text-sm mb-8">
          Šiam klientui pilotų dar nėra.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
          {client.pilots.map((pilot) => (
            <Link
              key={pilot.id}
              href={`/pilots/${pilot.id}/overview`}
              className="bg-white rounded-lg border border-gray-200 px-5 py-4 hover:border-gray-300 transition-colors"
            >
              <div className="flex items-center gap-2 mb-2">
                <h4 className="font-semibold text-gray-900">{pilot.name}</h4>
                <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium ${typeColors[pilot.productType] || typeColors.OTHER}`}>
                  {pilot.productType}
                </span>
                <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium ${statusColors[pilot.status] || statusColors.PLANNED}`}>
                  {pilot.status}
                </span>
              </div>
              {pilot.goalSummary && (
                <p className="text-xs text-gray-500 mb-2">{pilot.goalSummary}</p>
              )}
              <div className="flex gap-4 text-xs text-gray-400">
                <span>{pilot._count.devices} įrenginių</span>
                <span>{pilot._count.stores} parduotuvių</span>
                <span>{pilot._count.incidents} incidentų</span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* Stores */}
      {client.stores.length > 0 && (
        <>
          <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-3">Parduotuvės</h3>
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden mb-8">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-left text-xs uppercase tracking-wide">
                <tr>
                  <th className="px-4 py-3">Pavadinimas</th>
                  <th className="px-4 py-3">Kodas</th>
                  <th className="px-4 py-3">Miestas</th>
                  <th className="px-4 py-3">Statusas</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {client.stores.map((store) => (
                  <tr key={store.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">{store.name}</td>
                    <td className="px-4 py-3 text-gray-500 font-mono text-xs">{store.code}</td>
                    <td className="px-4 py-3 text-gray-600">{store.city || "—"}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium ${store.status === "active" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                        {store.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Notes */}
      {client.notes && (
        <div className="bg-white rounded-lg border border-gray-200 px-5 py-4">
          <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-2">Pastabos</h3>
          <p className="text-sm text-gray-600 whitespace-pre-wrap">{client.notes}</p>
        </div>
      )}
    </div>
  );
}
