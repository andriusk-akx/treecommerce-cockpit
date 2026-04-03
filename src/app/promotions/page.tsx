import { getRecentSalesWithCache, getApiInfo } from "@/lib/12eat/client";
import PromoDashboard from "./PromoDashboard";
import DataSourceStatus from "@/app/components/DataSourceStatus";

export const dynamic = "force-dynamic";

export default async function PromotionsPage() {
  const apiInfo = getApiInfo();
  const result = await getRecentSalesWithCache(500);

  const { analytics, isLive, cachedAt, sourceResult } = result;

  // Always show status bar
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
        <h2 className="text-lg font-semibold text-gray-800 mb-2">Akcijų Dashboard</h2>
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
      <PromoDashboard
        promo={analytics.promo}
        totalSales={analytics.totalSales}
        totalRevenue={analytics.totalRevenue}
        hourlyDistribution={analytics.hourlyDistribution}
        topProducts={analytics.topProducts}
        timeRange={analytics.timeRange}
        isTestData={analytics.isTestData}
        apiEnv={analytics.apiEnv}
        isLive={isLive}
        cachedAt={cachedAt}
      />
    </div>
  );
}
