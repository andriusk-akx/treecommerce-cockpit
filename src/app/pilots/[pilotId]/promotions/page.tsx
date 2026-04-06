import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import { getRecentSalesWithCache, getApiInfo } from "@/lib/12eat/client";
import PromoDashboard from "@/app/promotions/PromoDashboard";
import DataSourceStatus from "@/app/components/DataSourceStatus";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ pilotId: string }>;
}

export default async function PilotPromotionsPage({ params }: PageProps) {
  const { pilotId } = await params;

  const pilot = await prisma.pilot.findUnique({
    where: { id: pilotId },
    select: { id: true, name: true, productType: true },
  });

  if (!pilot) return notFound();

  if (pilot.productType !== "TREECOMMERCE") {
    return (
      <div className="bg-white rounded-lg border border-gray-200 px-5 py-12 text-center">
        <p className="text-gray-400">Akcijų puslapis prieinamas tik TreeCommerce tipo pilotams.</p>
      </div>
    );
  }

  const apiInfo = getApiInfo();
  const result = await getRecentSalesWithCache(500);
  const { analytics, sourceResult } = result;

  const sourceSummary = [{
    source: sourceResult.source,
    label: sourceResult.label,
    env: sourceResult.env,
    status: sourceResult.status,
    cachedAt: sourceResult.cachedAt,
    error: sourceResult.error,
    fetchMs: sourceResult.fetchMs,
  }];

  if (!analytics) {
    return (
      <div>
        <DataSourceStatus sources={sourceSummary} />
        <h2 className="text-lg font-semibold text-gray-800 mb-2">Akcijos — {pilot.name}</h2>
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
          <span className="font-semibold">Nėra duomenų.</span> 12eat API nepasiekiamas ir nėra išsaugotų duomenų.
          <p className="text-xs text-red-400 mt-1">
            Prisijunkite prie tinklo ({apiInfo.baseUrl}) kad gauti pirminius duomenis.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <DataSourceStatus sources={sourceSummary} />
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-gray-800">Akcijos — {pilot.name}</h2>
        <p className="text-xs text-gray-400 mt-0.5">Reklaminių kampanijų analitika</p>
      </div>
      <PromoDashboard
        promo={analytics.promo}
        totalSales={analytics.totalSales}
        totalRevenue={analytics.totalRevenue}
        hourlyDistribution={analytics.hourlyDistribution}
        topProducts={analytics.topProducts}
        timeRange={analytics.timeRange}
        isTestData={analytics.isTestData}
        apiEnv={analytics.apiEnv}
        isLive={result.isLive}
        cachedAt={result.cachedAt}
      />
    </div>
  );
}
