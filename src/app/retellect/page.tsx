import { prisma } from "@/lib/db";
import Link from "next/link";

// RT hub lists pilots from DB (no live Zabbix); ISR 5-min is sufficient.
export const revalidate = 300;

export default async function RetellectHubPage() {
  let pilots: any[] = [];
  try {
    pilots = await prisma.pilot.findMany({
      where: { productType: "RETELLECT" },
      orderBy: { name: "asc" },
      include: {
        client: { select: { name: true } },
        _count: { select: { devices: true, stores: true } },
      },
    });
  } catch {
    // DB not ready
  }

  // Mock enrichment for MVP (will come from real metrics later)
  const pilotEnrichment: Record<string, { hosts: number; cpuClasses: number; highRisk: number; refStore: string; finding: string; lastSync: string }> = {
    "SP-RETELLECT": {
      hosts: 47, cpuClasses: 3, highRisk: 8,
      refStore: "Rimi Žirmūnai #12",
      finding: "CPU bottleneck on Celeron J6412 hosts under peak load",
      lastSync: "2026-04-04 09:10",
    },
  };

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="text-xs text-gray-400 mb-1">
            <Link href="/" className="hover:text-gray-600">Home</Link>
            <span className="mx-1">/</span>
            <span className="text-gray-600">Retellect</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Retellect Pilots</h1>
        </div>
        <button className="bg-blue-600 text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-blue-700 transition">
          + New Pilot
        </button>
      </div>

      <div className="flex items-center gap-2 mb-6">
        <div className="relative flex-1 max-w-sm">
          <input
            type="text"
            placeholder="Search pilots by name, client..."
            className="w-full pl-9 text-sm border border-gray-200 rounded-lg py-2 px-3 bg-white"
          />
          <span className="absolute left-3 top-2.5 text-gray-400 text-sm">🔍</span>
        </div>
        <span className="px-3 py-1.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 cursor-pointer">All</span>
        <span className="px-3 py-1.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600 cursor-pointer hover:bg-gray-200">Active</span>
        <span className="px-3 py-1.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600 cursor-pointer hover:bg-gray-200">Pending</span>
      </div>

      <div className="grid grid-cols-1 gap-4">
        {pilots.map((pilot) => {
          const enrichment = pilotEnrichment[pilot.shortCode];
          const hosts = enrichment?.hosts ?? pilot._count.devices;
          const cpuClasses = enrichment?.cpuClasses ?? 0;
          const highRisk = enrichment?.highRisk ?? 0;
          const finding = enrichment?.finding ?? "—";

          return (
            <Link
              key={pilot.id}
              href={`/retellect/${pilot.id}`}
              className="bg-white rounded-lg border border-gray-200 p-5 hover:shadow-md transition-shadow cursor-pointer block"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div>
                    <div className="font-semibold text-base text-gray-900">{pilot.name}</div>
                    <div className="text-xs text-gray-500">{pilot.client.name}</div>
                  </div>
                  <StatusBadge status={pilot.status} />
                </div>
                <div className="flex items-center gap-6 text-sm">
                  <div className="text-center">
                    <div className="font-semibold text-gray-900">{hosts}</div>
                    <div className="text-xs text-gray-500">Hosts</div>
                  </div>
                  <div className="text-center">
                    <div className="font-semibold text-gray-900">{cpuClasses}</div>
                    <div className="text-xs text-gray-500">CPU Classes</div>
                  </div>
                  <div className="text-center">
                    <div className={`font-semibold ${highRisk > 5 ? "text-red-600" : "text-amber-600"}`}>{highRisk}</div>
                    <div className="text-xs text-gray-500">High Risk</div>
                  </div>
                  <div className="text-center max-w-48">
                    <div className="text-xs text-gray-700 truncate">{finding}</div>
                    <div className="text-xs text-gray-500">Key Finding</div>
                  </div>
                  <span className="text-gray-400 text-lg">→</span>
                </div>
              </div>
            </Link>
          );
        })}

        {pilots.length === 0 && (
          <div className="bg-white rounded-lg border border-gray-200 px-5 py-12 text-center">
            <p className="text-gray-400 mb-2">No Retellect pilots yet.</p>
            <Link href="/pilots" className="text-blue-600 hover:text-blue-800 text-sm">View all pilots →</Link>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    ACTIVE: "bg-emerald-50 text-emerald-700 border-emerald-200",
    PLANNED: "bg-blue-50 text-blue-700 border-blue-200",
    PAUSED: "bg-amber-50 text-amber-700 border-amber-200",
    COMPLETED: "bg-gray-100 text-gray-500 border-gray-200",
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded border text-[10px] font-medium ${styles[status] || styles.PLANNED}`}>
      {status.toLowerCase()}
    </span>
  );
}
