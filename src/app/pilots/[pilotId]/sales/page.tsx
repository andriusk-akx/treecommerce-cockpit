import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import { getRecentSalesWithCache, getApiInfo } from "@/lib/12eat/client";
import PromoAnalyticsPanel from "@/app/sales/PromoAnalytics";
import DataSourceStatus from "@/app/components/DataSourceStatus";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ pilotId: string }>;
}

export default async function PilotSalesPage({ params }: PageProps) {
  const { pilotId } = await params;

  const pilot = await prisma.pilot.findUnique({
    where: { id: pilotId },
    select: { id: true, name: true, productType: true },
  });

  if (!pilot) return notFound();

  if (pilot.productType !== "TREECOMMERCE") {
    return (
      <div className="bg-white rounded-lg border border-gray-200 px-5 py-12 text-center">
        <p className="text-gray-400">Pardavimų puslapis prieinamas tik TreeCommerce tipo pilotams.</p>
      </div>
    );
  }

  const apiInfo = getApiInfo();
  const result = await getRecentSalesWithCache(500);
  const { analytics: a, sourceResult } = result;

  const sourceSummary = [{
    source: sourceResult.source,
    label: sourceResult.label,
    env: sourceResult.env,
    status: sourceResult.status,
    cachedAt: sourceResult.cachedAt,
    error: sourceResult.error,
    fetchMs: sourceResult.fetchMs,
  }];

  if (!a) {
    return (
      <div>
        <DataSourceStatus sources={sourceSummary} />
        <h2 className="text-lg font-semibold text-gray-800 mb-2">Pardavimai — {pilot.name}</h2>
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
          <span className="font-semibold">Nėra duomenų.</span> 12eat API nepasiekiamas ir nėra išsaugotų duomenų.
          <p className="text-xs text-red-400 mt-1">
            Prisijunkite prie tinklo ({apiInfo.baseUrl}) kad gauti pirminius duomenis.
          </p>
        </div>
      </div>
    );
  }

  const maxHourRev = Math.max(...a.hourlyDistribution.map((h) => h.revenue), 1);

  return (
    <div>
      <DataSourceStatus sources={sourceSummary} />

      {/* Header + env badge */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-800">Pardavimai — {pilot.name}</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            {a.timeRange.from.slice(0, 10)} — {a.timeRange.to.slice(0, 10)} · {a.totalSales} pardavimai · Cursor: {a.latestCursor}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`px-3 py-1 text-[10px] font-bold uppercase rounded-full tracking-wider ${
              a.isTestData
                ? "bg-yellow-100 text-yellow-700 border border-yellow-300"
                : "bg-green-100 text-green-700 border border-green-300"
            }`}
          >
            {a.isTestData ? "TEST" : "PROD"}
          </span>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <SummaryCard label="Pajamos" value={formatEur(a.totalRevenue)} sub={`${a.totalSales} pardavimai`} />
        <SummaryCard label="Vid. čekis" value={formatEur(a.avgTransactionValue)} sub={`${a.totalItems} prekės iš viso`} />
        <SummaryCard label="Grynaisiais" value={formatEur(a.cashAmount)} sub={`${a.cashCount} tranzakcijos`} />
        <SummaryCard label="Kortele" value={formatEur(a.cardAmount)} sub={`${a.cardCount} tranzakcijos`} />
      </div>

      {/* Hourly + Terminals */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
            Pardavimai per parą
          </h3>
          <p className="text-[10px] text-gray-400 mb-3">Pajamų pasiskirstymas pagal valandą</p>
          <div className="flex items-end gap-[3px] h-[120px]">
            {a.hourlyDistribution.map((h) => {
              const pct = (h.revenue / maxHourRev) * 100;
              return (
                <div
                  key={h.hour}
                  className="flex-1 flex flex-col items-center justify-end h-full"
                  title={`${String(h.hour).padStart(2, "0")}:00 — ${h.count} pardav. / ${formatEur(h.revenue)}`}
                >
                  <div
                    className={`w-full rounded-t-[2px] ${h.count > 0 ? "bg-emerald-400" : "bg-gray-100"}`}
                    style={{ height: `${Math.max(pct, h.count > 0 ? 3 : 0)}%` }}
                  />
                </div>
              );
            })}
          </div>
          <div className="flex gap-[3px] mt-1">
            {a.hourlyDistribution.map((h) => (
              <div key={h.hour} className="flex-1 text-center text-[8px] text-gray-400">
                {h.hour % 3 === 0 ? String(h.hour).padStart(2, "0") : ""}
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
            Terminalai
          </h3>
          <p className="text-[10px] text-gray-400 mb-3">Pardavimų skaičius ir pajamos pagal terminalą</p>
          <div className="space-y-2">
            {a.terminalStats.map((t) => {
              const pct = a.terminalStats[0] ? (t.revenue / a.terminalStats[0].revenue) * 100 : 0;
              return (
                <div key={t.terminalId} className="flex items-center gap-3">
                  <span className="w-[50px] text-[11px] font-semibold text-gray-500">T-{t.terminalId}</span>
                  <div className="flex-1 h-[18px] bg-gray-50 rounded-[3px] overflow-hidden">
                    <div
                      className="h-full rounded-[3px] bg-emerald-400"
                      style={{ width: `${Math.max(pct, 2)}%` }}
                    />
                  </div>
                  <span className="w-[70px] text-right text-[10px] text-gray-500">
                    <span className="font-semibold">{t.count}</span>
                    <span className="text-gray-300 mx-1">·</span>
                    {formatEur(t.revenue)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Top products + Recent transactions */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-3">
            Top produktai
          </h3>
          <div className="space-y-1.5">
            {a.topProducts.map((p, i) => (
              <div key={p.name} className="flex items-center gap-2 text-[11px]">
                <span className="w-[18px] text-gray-300 font-mono text-right">{i + 1}.</span>
                <span className="flex-1 text-gray-700 truncate font-medium">{p.name}</span>
                <span className="text-gray-400">{p.qty} vnt.</span>
                <span className="w-[60px] text-right font-semibold text-gray-600">{formatEur(p.revenue)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-3">
            Paskutinės tranzakcijos
          </h3>
          <div className="space-y-1">
            {a.recentTransactions.map((t, i) => (
              <div key={i} className="flex items-center gap-2 text-[11px] px-2 py-1 rounded hover:bg-gray-50">
                <span className="text-gray-400 font-mono w-[46px] flex-shrink-0">
                  {t.time.slice(11, 16)}
                </span>
                <span
                  className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded flex-shrink-0 ${
                    t.paymentType === "CASH"
                      ? "bg-green-100 text-green-700"
                      : "bg-blue-100 text-blue-700"
                  }`}
                >
                  {t.paymentType === "CASH" ? "GRN" : "KORT"}
                </span>
                <span className="text-gray-400 text-[10px]">T-{t.terminalId}</span>
                <span className="text-gray-400 text-[10px]">{t.items} prek.</span>
                <span className="ml-auto font-semibold text-gray-700">{formatEur(t.amount)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Promo analytics */}
      <PromoAnalyticsPanel promo={a.promo} totalSales={a.totalSales} totalRevenue={a.totalRevenue} />

      {/* Test data warning */}
      {a.isTestData && (
        <div className="mt-4 bg-yellow-50 border border-yellow-200 rounded-lg px-4 py-3 text-[11px] text-yellow-700">
          <span className="font-semibold">Testiniai duomenys.</span> Šie duomenys gaunami iš test API ({apiInfo.baseUrl}).
          Norint matyti realius kliento duomenis, reikia prieigos prie PROD API (10.100.39.16:9051).
          Nustatymuose galima perjungti API aplinką.
        </div>
      )}
    </div>
  );
}

function formatEur(cents: number): string {
  return `${(cents / 100).toFixed(2)}€`;
}

function SummaryCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
      <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">{label}</p>
      <p className="text-xl font-bold text-gray-900">{value}</p>
      <p className="text-[10px] text-gray-400 mt-0.5">{sub}</p>
    </div>
  );
}
