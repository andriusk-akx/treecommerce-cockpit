import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function DataSourcesSettingsPage() {
  let dataSources: any[] = [];
  try {
    dataSources = await prisma.dataSource.findMany({
      orderBy: { name: "asc" },
      include: {
        client: { select: { name: true } },
        pilot: { select: { name: true, shortCode: true } },
      },
    });
  } catch {}

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-800">Duomenų šaltiniai</h2>
        <p className="text-xs text-gray-400 mt-0.5">Visi konfigūruoti duomenų šaltiniai</p>
      </div>

      {dataSources.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 px-5 py-12 text-center">
          <p className="text-gray-400">Šaltinių dar nėra.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {dataSources.map((ds) => (
            <div key={ds.id} className="bg-white rounded-lg border border-gray-200 px-5 py-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <h3 className="font-medium text-gray-900">{ds.name}</h3>
                  <span className="inline-block px-2 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-600">{ds.type}</span>
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium ${ds.isActive ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${ds.isActive ? "bg-green-500" : "bg-red-500"}`}></span>
                    {ds.isActive ? "Aktyvus" : "Išjungtas"}
                  </span>
                </div>
              </div>
              <div className="text-xs text-gray-500 flex gap-4">
                <span className="font-mono">{ds.baseUrl}</span>
                <span>Klientas: {ds.client.name}</span>
                {ds.pilot && <span>Pilotas: {ds.pilot.shortCode}</span>}
                <span>Sinch.: {ds.syncMode}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
