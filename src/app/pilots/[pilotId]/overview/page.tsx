import { prisma } from "@/lib/db";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ pilotId: string }>;
}

export default async function PilotOverviewPage({ params }: PageProps) {
  const { pilotId } = await params;

  const pilot = await prisma.pilot.findUnique({
    where: { id: pilotId },
    include: {
      client: true,
      _count: { select: { devices: true, incidents: true, stores: true, dataSources: true, noteEntries: true } },
    },
  });

  if (!pilot) return notFound();

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

  // Count open incidents
  let openIncidents = 0;
  try {
    openIncidents = await prisma.incident.count({
      where: { pilotId, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
    });
  } catch {}

  return (
    <div>
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-xs text-gray-400 mb-4">
        <Link href="/pilots" className="hover:text-gray-600">Pilotai</Link>
        <span>/</span>
        <span className="text-gray-600">{pilot.name}</span>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-gray-800">{pilot.name}</h2>
            <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium ${typeColors[pilot.productType] || typeColors.OTHER}`}>
              {pilot.productType}
            </span>
            <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium ${statusColors[pilot.status]}`}>
              {pilot.status}
            </span>
          </div>
          <p className="text-xs text-gray-400 mt-1">
            <Link href={`/clients/${pilot.clientId}`} className="hover:text-gray-600">{pilot.client.name}</Link>
            {" "}&mdash; {pilot.shortCode}
          </p>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
        <KpiCard label="Atviri incidentai" value={openIncidents} highlight={openIncidents > 0} />
        <KpiCard label="Visi incidentai" value={pilot._count.incidents} />
        <KpiCard label="Įrenginiai" value={pilot._count.devices} />
        <KpiCard label="Parduotuvės" value={pilot._count.stores} />
        <KpiCard label="Pastabos" value={pilot._count.noteEntries} />
      </div>

      {/* Goal Summary */}
      {pilot.goalSummary && (
        <div className="bg-white rounded-lg border border-gray-200 p-5 mb-6">
          <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-2">Piloto tikslas</h3>
          <p className="text-sm text-gray-700 whitespace-pre-wrap">{pilot.goalSummary}</p>
        </div>
      )}

      {/* Info Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-3">Informacija</h3>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-500">Klientas</dt>
              <dd className="text-gray-900 font-medium">{pilot.client.name}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Produkto tipas</dt>
              <dd className="text-gray-900">{pilot.productType}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Statusas</dt>
              <dd className="text-gray-900">{pilot.status}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Matomumas</dt>
              <dd className="text-gray-900">{pilot.visibility}</dd>
            </div>
            {pilot.internalOwner && (
              <div className="flex justify-between">
                <dt className="text-gray-500">Atsakingas</dt>
                <dd className="text-gray-900">{pilot.internalOwner}</dd>
              </div>
            )}
            {pilot.startDate && (
              <div className="flex justify-between">
                <dt className="text-gray-500">Pradžia</dt>
                <dd className="text-gray-900">{pilot.startDate.toLocaleDateString("lt-LT")}</dd>
              </div>
            )}
            {pilot.endDate && (
              <div className="flex justify-between">
                <dt className="text-gray-500">Pabaiga</dt>
                <dd className="text-gray-900">{pilot.endDate.toLocaleDateString("lt-LT")}</dd>
              </div>
            )}
          </dl>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-3">Duomenų šaltiniai</h3>
          {pilot._count.dataSources === 0 ? (
            <p className="text-sm text-gray-400">Šaltinių dar nėra.</p>
          ) : (
            <p className="text-sm text-gray-600">{pilot._count.dataSources} šaltiniai sukonfigūruoti</p>
          )}
          <Link
            href={`/pilots/${pilot.id}/data-sources`}
            className="inline-block mt-3 text-xs text-blue-600 hover:text-blue-800 font-medium"
          >
            Peržiūrėti šaltinius →
          </Link>
        </div>
      </div>

      {/* Notes */}
      {pilot.notes && (
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-2">Pastabos</h3>
          <p className="text-sm text-gray-600 whitespace-pre-wrap">{pilot.notes}</p>
        </div>
      )}

      {/* TODO: Add quick actions, recent activity, key findings */}
    </div>
  );
}

function KpiCard({ label, value, highlight = false }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className={`bg-white rounded-lg border ${highlight ? "border-amber-300" : "border-gray-200"} px-4 py-3`}>
      <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">{label}</p>
      <p className={`text-2xl font-bold ${highlight ? "text-amber-600" : "text-gray-900"}`}>{value}</p>
    </div>
  );
}
