import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ pilotId: string }>;
}

export default async function PilotDataSourcesPage({ params }: PageProps) {
  const { pilotId } = await params;

  const pilot = await prisma.pilot.findUnique({
    where: { id: pilotId },
    include: {
      dataSources: { orderBy: { name: "asc" } },
    },
  });

  if (!pilot) return notFound();

  const typeLabels: Record<string, string> = {
    ZABBIX: "Zabbix",
    TREECOMMERCE_SALES_API: "TreeCommerce Sales API",
    RETELLECT_API: "Retellect API",
    CSV: "CSV Import",
    MANUAL: "Rankinis",
  };

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-800">Duomenų šaltiniai — {pilot.name}</h2>
        <p className="text-xs text-gray-400 mt-0.5">Konfigūruoti duomenų šaltiniai šiam pilotui</p>
      </div>

      {pilot.dataSources.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 px-5 py-12 text-center">
          <p className="text-gray-400 mb-2">Šaltinių dar nėra.</p>
          <p className="text-xs text-gray-300">Pridėkite duomenų šaltinį per duomenų bazę.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {pilot.dataSources.map((ds) => (
            <div key={ds.id} className="bg-white rounded-lg border border-gray-200 px-5 py-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <h3 className="font-medium text-gray-900">{ds.name}</h3>
                  <span className="inline-block px-2 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-600">
                    {typeLabels[ds.type] || ds.type}
                  </span>
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium ${
                    ds.isActive ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${ds.isActive ? "bg-green-500" : "bg-red-500"}`}></span>
                    {ds.isActive ? "Aktyvus" : "Išjungtas"}
                  </span>
                </div>
                <span className="text-xs text-gray-400">{ds.syncMode}</span>
              </div>
              <div className="text-xs text-gray-500">
                <span className="font-mono">{ds.baseUrl}</span>
                {ds.lastSyncAt && (
                  <span className="ml-4">Pask. sinch.: {ds.lastSyncAt.toLocaleDateString("lt-LT", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
