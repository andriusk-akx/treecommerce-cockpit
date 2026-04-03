"use client";

import { useState, useMemo } from "react";
import type {
  PromoAnalytics,
  PromoDetail,
  DailyPromoTrend,
  PromoInsight,
} from "@/lib/12eat/client";

// ─── Props ──────────────────────────────────────────────────────────

interface Props {
  promo: PromoAnalytics;
  totalSales: number;
  totalRevenue: number;
  hourlyDistribution: { hour: number; count: number; revenue: number }[];
  topProducts: { name: string; qty: number; revenue: number }[];
  timeRange: { from: string; to: string };
  isTestData: boolean;
  isLive: boolean;
  cachedAt: string | null;
  apiEnv: string;
}

type Tab = "overview" | "promos" | "behavior" | "trends";
type SortField = keyof PromoDetail;

// ─── Main Dashboard ─────────────────────────────────────────────────

export default function PromoDashboard({
  promo,
  totalSales,
  totalRevenue,
  hourlyDistribution,
  topProducts,
  timeRange,
  isTestData,
  apiEnv,
  isLive,
  cachedAt,
}: Props) {
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [sortField, setSortField] = useState<SortField>("totalRevenue");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [expandedPromo, setExpandedPromo] = useState<number | null>(null);
  const [compareIds, setCompareIds] = useState<Set<number>>(new Set());

  const sortedPromos = useMemo(() => {
    return [...promo.promos].sort((a, b) => {
      const av = a[sortField];
      const bv = b[sortField];
      if (typeof av === "number" && typeof bv === "number") {
        return sortDir === "desc" ? bv - av : av - bv;
      }
      return sortDir === "desc"
        ? String(bv).localeCompare(String(av))
        : String(av).localeCompare(String(bv));
    });
  }, [promo.promos, sortField, sortDir]);

  function toggleSort(field: SortField) {
    if (sortField === field) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else { setSortField(field); setSortDir("desc"); }
  }

  const sortIcon = (field: SortField) =>
    sortField === field ? (sortDir === "desc" ? " ▾" : " ▴") : "";

  function toggleCompare(promoId: number) {
    setCompareIds((prev) => {
      const next = new Set(prev);
      if (next.has(promoId)) next.delete(promoId);
      else if (next.size < 4) next.add(promoId);
      return next;
    });
  }

  const comparedPromos = useMemo(
    () => promo.promos.filter((p) => compareIds.has(p.promoId)),
    [promo.promos, compareIds]
  );

  // ── Derived metrics for executive summary ──
  const promoRevenueShare = totalRevenue > 0
    ? ((promo.withPromoRevenue / totalRevenue) * 100).toFixed(1)
    : "0";
  const discountToRevenue = promo.withPromoRevenue > 0
    ? ((promo.totalDiscountAmount / promo.withPromoRevenue) * 100).toFixed(1)
    : "0";
  const overallROI = promo.totalDiscountAmount > 0
    ? (promo.withPromoRevenue / promo.totalDiscountAmount).toFixed(1)
    : "—";

  // Best & worst promos
  const bestPromo = promo.promos.length > 0
    ? promo.promos.reduce((a, b) => a.revenuePerDiscountEuro > b.revenuePerDiscountEuro ? a : b)
    : null;
  const worstPromo = promo.promos.filter(p => p.revenuePerDiscountEuro > 0 && p.txnCount >= 3).length > 0
    ? promo.promos.filter(p => p.revenuePerDiscountEuro > 0 && p.txnCount >= 3)
        .reduce((a, b) => a.revenuePerDiscountEuro < b.revenuePerDiscountEuro ? a : b)
    : null;

  // Peak promo hours
  const promoHourMap = new Map<number, number>();
  // We approximate from daily trend + hourly distribution
  const peakHour = hourlyDistribution.reduce((max, h) => h.revenue > max.revenue ? h : max, hourlyDistribution[0]);

  // ── No data state ──
  if (promo.withPromoCount === 0) {
    return (
      <div>
        <DashboardHeader timeRange={timeRange} isTestData={isTestData} apiEnv={apiEnv} isLive={true} cachedAt={null} />
        <div className="mt-8 bg-gray-50 border border-gray-200 rounded-xl px-6 py-8 text-center">
          <div className="text-3xl mb-3">📊</div>
          <p className="text-sm text-gray-500">
            Akcijų duomenų nerasta. Kai bus aktyvių akcijų — čia atsiras detali analitika.
          </p>
        </div>
      </div>
    );
  }

  const tabs: { key: Tab; label: string; icon: string }[] = [
    { key: "overview", label: "Apžvalga", icon: "📊" },
    { key: "promos", label: "Akcijos", icon: "🏷" },
    { key: "behavior", label: "Pirkėjų elgsena", icon: "👥" },
    { key: "trends", label: "Tendencijos", icon: "📈" },
  ];

  return (
    <div>
      <DashboardHeader timeRange={timeRange} isTestData={isTestData} apiEnv={apiEnv} isLive={isLive} cachedAt={cachedAt} />

      {/* ── Tab navigation ── */}
      <div className="flex items-center gap-1 mt-6 mb-6 border-b border-gray-200">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2.5 text-[12px] font-medium transition-colors border-b-2 -mb-px ${
              activeTab === tab.key
                ? "border-purple-600 text-purple-700 bg-purple-50/50"
                : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
            }`}
          >
            <span className="mr-1.5">{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Tab content ── */}
      {activeTab === "overview" && (
        <OverviewTab
          promo={promo}
          totalSales={totalSales}
          totalRevenue={totalRevenue}
          promoRevenueShare={promoRevenueShare}
          discountToRevenue={discountToRevenue}
          overallROI={overallROI}
          bestPromo={bestPromo}
          worstPromo={worstPromo}
          peakHour={peakHour}
          sortedPromos={sortedPromos}
        />
      )}
      {activeTab === "promos" && (
        <PromosTab
          promo={promo}
          totalRevenue={totalRevenue}
          sortedPromos={sortedPromos}
          sortField={sortField}
          sortDir={sortDir}
          toggleSort={toggleSort}
          sortIcon={sortIcon}
          expandedPromo={expandedPromo}
          setExpandedPromo={setExpandedPromo}
          compareIds={compareIds}
          toggleCompare={toggleCompare}
          comparedPromos={comparedPromos}
        />
      )}
      {activeTab === "behavior" && (
        <BehaviorTab promo={promo} topProducts={topProducts} hourlyDistribution={hourlyDistribution} />
      )}
      {activeTab === "trends" && (
        <TrendsTab promo={promo} totalSales={totalSales} />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// HEADER
// ═══════════════════════════════════════════════════════════════════════

function DashboardHeader({
  timeRange,
  isTestData,
  apiEnv,
  isLive,
  cachedAt,
}: {
  timeRange: { from: string; to: string };
  isTestData: boolean;
  apiEnv: string;
  isLive: boolean;
  cachedAt: string | null;
}) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <h2 className="text-xl font-bold text-gray-900">Akcijų Dashboard</h2>
        <p className="text-xs text-gray-400 mt-0.5">
          Strateginė ir operatyvinė akcijų analitika · {timeRange.from.slice(0, 10)} — {timeRange.to.slice(0, 10)}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {!isLive && cachedAt && (
          <span className="px-3 py-1 text-[10px] font-bold uppercase rounded-full tracking-wider bg-amber-100 text-amber-700 border border-amber-300">
            CACHED · {new Date(cachedAt).toLocaleString("lt-LT", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
        {isLive && (
          <span className="px-3 py-1 text-[10px] font-bold uppercase rounded-full tracking-wider bg-emerald-100 text-emerald-700 border border-emerald-300">
            LIVE
          </span>
        )}
        <span
          className={`px-3 py-1 text-[10px] font-bold uppercase rounded-full tracking-wider ${
            isTestData
              ? "bg-yellow-100 text-yellow-700 border border-yellow-300"
              : "bg-green-100 text-green-700 border border-green-300"
          }`}
        >
          {isTestData ? "TEST" : "PROD"}
        </span>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// TAB 1: OVERVIEW — Executive summary for management + marketers
// ═══════════════════════════════════════════════════════════════════════

function OverviewTab({
  promo,
  totalSales,
  totalRevenue,
  promoRevenueShare,
  discountToRevenue,
  overallROI,
  bestPromo,
  worstPromo,
  peakHour,
  sortedPromos,
}: {
  promo: PromoAnalytics;
  totalSales: number;
  totalRevenue: number;
  promoRevenueShare: string;
  discountToRevenue: string;
  overallROI: string;
  bestPromo: PromoDetail | null;
  worstPromo: PromoDetail | null;
  peakHour: { hour: number; count: number; revenue: number };
  sortedPromos: PromoDetail[];
}) {
  return (
    <div>
      {/* ── Executive KPIs ── */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
        <KpiCard
          label="Akcijų pardavimai"
          value={String(promo.withPromoCount)}
          sub={`iš ${promo.withPromoCount + promo.withoutPromoCount} · ${promo.promoSharePercent}%`}
          accent="purple"
        />
        <KpiCard
          label="Akcijų pajamos"
          value={fmtEur(promo.withPromoRevenue)}
          sub={`${promoRevenueShare}% visų pajamų`}
          accent="green"
        />
        <KpiCard
          label="Suteikta nuolaidų"
          value={fmtEur(promo.totalDiscountAmount)}
          sub={`${discountToRevenue}% nuo akcijų pajamų`}
          accent="orange"
        />
        <KpiCard
          label="Bendra ROI"
          value={`${overallROI}x`}
          sub="pajamos / nuolaidos"
          accent="blue"
        />
        <KpiCard
          label="Čekio pokytis"
          value={`${promo.upliftPercent >= 0 ? "+" : ""}${promo.upliftPercent}%`}
          sub={`${fmtEur(promo.withPromoAvgCheck)} vs ${fmtEur(promo.withoutPromoAvgCheck)}`}
          accent={promo.upliftPercent >= 0 ? "green" : "red"}
        />
      </div>

      {/* ── Strategic Insights ── */}
      {promo.insights.length > 0 && (
        <div className="mb-6">
          <SectionTitle title="Strateginės įžvalgos" subtitle="Automatinės rekomendacijos sprendimų priėmimui" />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {promo.insights.map((insight, i) => (
              <InsightCard key={i} insight={insight} />
            ))}
          </div>
        </div>
      )}

      {/* ── Two columns: Best/Worst + Quick ranking ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Performance highlights */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <SectionTitle title="Efektyvumo akcentai" />
          <div className="space-y-4">
            {bestPromo && (
              <HighlightCard
                type="best"
                name={bestPromo.name}
                roi={bestPromo.revenuePerDiscountEuro}
                revenue={bestPromo.totalRevenue}
                discount={bestPromo.totalDiscount}
                txnCount={bestPromo.txnCount}
              />
            )}
            {worstPromo && worstPromo.promoId !== bestPromo?.promoId && (
              <HighlightCard
                type="worst"
                name={worstPromo.name}
                roi={worstPromo.revenuePerDiscountEuro}
                revenue={worstPromo.totalRevenue}
                discount={worstPromo.totalDiscount}
                txnCount={worstPromo.txnCount}
              />
            )}
          </div>
        </div>

        {/* Quick promo ranking */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <SectionTitle title="Akcijų reitingas pagal pajamas" />
          <div className="space-y-2">
            {sortedPromos.slice(0, 6).map((p, i) => {
              const share = totalRevenue > 0 ? (p.totalRevenue / totalRevenue) * 100 : 0;
              return (
                <div key={p.promoId} className="flex items-center gap-3">
                  <span className={`text-[11px] font-bold w-5 text-center ${
                    i === 0 ? "text-purple-600" : i === 1 ? "text-purple-400" : "text-gray-400"
                  }`}>
                    #{i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-medium text-gray-800 truncate">{p.name}</span>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${roiBadgeColor(p.revenuePerDiscountEuro)}`}>
                        {p.revenuePerDiscountEuro > 0 ? `${p.revenuePerDiscountEuro}x` : "—"}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <div className="flex-1 h-[4px] bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-purple-400 rounded-full"
                          style={{ width: `${Math.min(share, 100)}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-gray-500 w-[55px] text-right">{fmtEur(p.totalRevenue)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Mini daily trend ── */}
      {promo.dailyTrend.length > 1 && (
        <div className="mb-6">
          <DailyTrendChart trend={promo.dailyTrend} />
        </div>
      )}

      {/* ── Discount type distribution ── */}
      {promo.byApplyOn.length > 0 && (
        <div className="mb-6">
          <SectionTitle title="Nuolaidų struktūra" subtitle="Pagal taikymo tipą ir metodą" />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {promo.byApplyOn.map((ao) => {
              const total = promo.byApplyOn.reduce((s, a) => s + a.count, 0);
              const pct = total > 0 ? ((ao.count / total) * 100).toFixed(0) : "0";
              return (
                <div key={ao.type} className="bg-white rounded-xl border border-gray-200 px-4 py-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className={`text-[9px] font-bold uppercase px-2 py-0.5 rounded ${applyOnColor(ao.type)}`}>
                      {ao.type}
                    </span>
                    <span className="text-[10px] text-gray-400">{pct}%</span>
                  </div>
                  <div className="text-lg font-bold text-gray-800">{ao.count}</div>
                  <div className="text-[10px] text-gray-400">Nuolaida: {fmtEur(ao.discountAmount)}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// TAB 2: PROMOS — Detailed per-promo analysis + comparison
// ═══════════════════════════════════════════════════════════════════════

function PromosTab({
  promo,
  totalRevenue,
  sortedPromos,
  sortField,
  sortDir,
  toggleSort,
  sortIcon,
  expandedPromo,
  setExpandedPromo,
  compareIds,
  toggleCompare,
  comparedPromos,
}: {
  promo: PromoAnalytics;
  totalRevenue: number;
  sortedPromos: PromoDetail[];
  sortField: SortField;
  sortDir: "asc" | "desc";
  toggleSort: (f: SortField) => void;
  sortIcon: (f: SortField) => string;
  expandedPromo: number | null;
  setExpandedPromo: (id: number | null) => void;
  compareIds: Set<number>;
  toggleCompare: (id: number) => void;
  comparedPromos: PromoDetail[];
}) {
  return (
    <div>
      {/* ── Comparison panel ── */}
      {comparedPromos.length >= 2 && (
        <div className="bg-purple-50 border border-purple-200 rounded-xl p-5 mb-6">
          <div className="flex items-center justify-between mb-4">
            <SectionTitle title="Akcijų palyginimas" subtitle={`${comparedPromos.length} akcijos lyginamos`} />
            <button
              onClick={() => {
                // Clear all compared
                comparedPromos.forEach((p) => toggleCompare(p.promoId));
              }}
              className="text-[10px] text-purple-600 hover:text-purple-800 font-medium"
            >
              Valyti
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b border-purple-200 text-left">
                  <th className="pb-2 text-purple-500 font-semibold">Metrika</th>
                  {comparedPromos.map((p) => (
                    <th key={p.promoId} className="pb-2 text-purple-700 font-semibold text-right">{p.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="text-gray-700">
                <CompareRow label="Pardavimai" values={comparedPromos.map((p) => String(p.txnCount))} highlight="max" />
                <CompareRow label="Pajamos" values={comparedPromos.map((p) => fmtEur(p.totalRevenue))} highlight="max" rawValues={comparedPromos.map(p => p.totalRevenue)} />
                <CompareRow label="Vid. čekis" values={comparedPromos.map((p) => fmtEur(p.avgCheck))} highlight="max" rawValues={comparedPromos.map(p => p.avgCheck)} />
                <CompareRow label="Nuolaida" values={comparedPromos.map((p) => fmtEur(p.totalDiscount))} highlight="min" rawValues={comparedPromos.map(p => p.totalDiscount)} />
                <CompareRow label="ROI" values={comparedPromos.map((p) => p.revenuePerDiscountEuro > 0 ? `${p.revenuePerDiscountEuro}x` : "—")} highlight="max" rawValues={comparedPromos.map(p => p.revenuePerDiscountEuro)} />
                <CompareRow label="Vid. prekių" values={comparedPromos.map((p) => String(p.avgItems))} highlight="max" rawValues={comparedPromos.map(p => p.avgItems)} />
                <CompareRow label="Tipas" values={comparedPromos.map((p) => p.applyOn)} />
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Promo performance table ── */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-3">
          <SectionTitle title="Akcijų efektyvumas" subtitle="Spauskite eilutę detalėms · Pažymėkite ☐ palyginimui (iki 4)" />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-gray-200 text-left">
                <th className="pb-2 w-6"></th>
                <th className="pb-2 text-gray-400 font-semibold cursor-pointer hover:text-gray-600" onClick={() => toggleSort("name")}>
                  Akcija{sortIcon("name")}
                </th>
                <th className="pb-2 text-gray-400 font-semibold text-right cursor-pointer hover:text-gray-600" onClick={() => toggleSort("applyOn")}>
                  Tipas{sortIcon("applyOn")}
                </th>
                <th className="pb-2 text-gray-400 font-semibold text-right cursor-pointer hover:text-gray-600" onClick={() => toggleSort("txnCount")}>
                  Pardav.{sortIcon("txnCount")}
                </th>
                <th className="pb-2 text-gray-400 font-semibold text-right cursor-pointer hover:text-gray-600" onClick={() => toggleSort("totalRevenue")}>
                  Pajamos{sortIcon("totalRevenue")}
                </th>
                <th className="pb-2 text-gray-400 font-semibold text-right cursor-pointer hover:text-gray-600" onClick={() => toggleSort("avgCheck")}>
                  Vid. čekis{sortIcon("avgCheck")}
                </th>
                <th className="pb-2 text-gray-400 font-semibold text-right cursor-pointer hover:text-gray-600" onClick={() => toggleSort("totalDiscount")}>
                  Nuolaida{sortIcon("totalDiscount")}
                </th>
                <th className="pb-2 text-gray-400 font-semibold text-right cursor-pointer hover:text-gray-600" onClick={() => toggleSort("revenuePerDiscountEuro")}>
                  ROI{sortIcon("revenuePerDiscountEuro")}
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedPromos.map((p) => {
                const roiColor = roiTextColor(p.revenuePerDiscountEuro);
                const isExpanded = expandedPromo === p.promoId;
                const isCompared = compareIds.has(p.promoId);
                const revenueShare = totalRevenue > 0 ? ((p.totalRevenue / totalRevenue) * 100).toFixed(1) : "0";

                return (
                  <tr key={p.promoId} className="border-b border-gray-50">
                    <td colSpan={8} className="p-0">
                      <div className="flex items-center">
                        {/* Compare checkbox */}
                        <div
                          className="w-6 flex items-center justify-center cursor-pointer py-2"
                          onClick={(e) => { e.stopPropagation(); toggleCompare(p.promoId); }}
                          title="Pažymėti palyginimui"
                        >
                          <span className={`text-[12px] ${isCompared ? "text-purple-600" : "text-gray-300"}`}>
                            {isCompared ? "☑" : "☐"}
                          </span>
                        </div>

                        {/* Main row */}
                        <div
                          className={`flex-1 flex items-center gap-0 px-0 py-2 cursor-pointer transition-colors ${
                            isExpanded ? "bg-purple-50" : "hover:bg-gray-50"
                          }`}
                          onClick={() => setExpandedPromo(isExpanded ? null : p.promoId)}
                        >
                          <div className="flex-1 pr-3 min-w-0">
                            <div className="font-medium text-gray-800 truncate max-w-[200px]">
                              {isExpanded ? "▾ " : "▸ "}{p.name}
                            </div>
                            {p.code && <div className="text-[9px] text-gray-400 font-mono ml-3">{p.code}</div>}
                          </div>
                          <div className="w-[60px] text-right flex-shrink-0">
                            <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${applyOnColor(p.applyOn)}`}>
                              {p.applyOn}
                            </span>
                          </div>
                          <div className="w-[50px] text-right font-semibold text-gray-700 flex-shrink-0">{p.txnCount}</div>
                          <div className="w-[70px] text-right font-semibold text-gray-700 flex-shrink-0">{fmtEur(p.totalRevenue)}</div>
                          <div className="w-[65px] text-right text-gray-600 flex-shrink-0">{fmtEur(p.avgCheck)}</div>
                          <div className="w-[65px] text-right text-orange-600 flex-shrink-0">{fmtEur(p.totalDiscount)}</div>
                          <div className={`w-[50px] text-right font-bold flex-shrink-0 ${roiColor}`}>
                            {p.revenuePerDiscountEuro > 0 ? `${p.revenuePerDiscountEuro}x` : "—"}
                          </div>
                        </div>
                      </div>

                      {/* Expanded detail */}
                      {isExpanded && (
                        <PromoDetailPanel p={p} revenueShare={revenueShare} roiColor={roiColor} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* ROI legend */}
        <div className="flex items-center gap-4 mt-3 pt-3 border-t border-gray-100 text-[9px]">
          <span className="text-gray-400">ROI spalvos:</span>
          <span className="text-green-600 font-semibold">10x+ puiku</span>
          <span className="text-yellow-600 font-semibold">5-10x gerai</span>
          <span className="text-orange-600 font-semibold">&lt;5x peržiūrėti</span>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// TAB 3: BEHAVIOR — Buyer behavior deep dive
// ═══════════════════════════════════════════════════════════════════════

function BehaviorTab({
  promo,
  topProducts,
  hourlyDistribution,
}: {
  promo: PromoAnalytics;
  topProducts: { name: string; qty: number; revenue: number }[];
  hourlyDistribution: { hour: number; count: number; revenue: number }[];
}) {
  const maxHourRev = Math.max(...hourlyDistribution.map((h) => h.revenue), 1);

  return (
    <div>
      {/* ── Side-by-side behavior comparison ── */}
      <SectionTitle title="Pirkėjų elgsena: su akcija vs be akcijos" subtitle="Kaip nuolaidos keičia pirkimo elgseną" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <BehaviorCard
          title="Su akcija"
          color="purple"
          count={promo.withPromoCount}
          revenue={promo.withPromoRevenue}
          avgCheck={promo.withPromoAvgCheck}
          avgItems={promo.withPromoAvgItems}
          isHighlighted
        />
        <BehaviorCard
          title="Be akcijos"
          color="gray"
          count={promo.withoutPromoCount}
          revenue={promo.withoutPromoRevenue}
          avgCheck={promo.withoutPromoAvgCheck}
          avgItems={promo.withoutPromoAvgItems}
        />
      </div>

      {/* ── Uplift analysis ── */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
        <SectionTitle title="Poveikio analizė" subtitle="Kiek akcijos keičia pagrindinius rodiklius" />
        <div className="grid grid-cols-3 gap-4">
          <UpliftMetric
            label="Vidutinis čekis"
            withPromo={promo.withPromoAvgCheck}
            withoutPromo={promo.withoutPromoAvgCheck}
            format="eur"
          />
          <UpliftMetric
            label="Vidutinis prekių skaičius"
            withPromo={promo.withPromoAvgItems}
            withoutPromo={promo.withoutPromoAvgItems}
            format="num"
          />
          <UpliftMetric
            label="Pajamos per pardavimą"
            withPromo={promo.withPromoCount > 0 ? Math.round(promo.withPromoRevenue / promo.withPromoCount) : 0}
            withoutPromo={promo.withoutPromoCount > 0 ? Math.round(promo.withoutPromoRevenue / promo.withoutPromoCount) : 0}
            format="eur"
          />
        </div>
      </div>

      {/* ── Nuolaidu metodų pasiskirstymas ── */}
      {promo.byMethod.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
          <SectionTitle title="Nuolaidų metodai" subtitle="Procentinės vs fiksuotos nuolaidos efektyvumas" />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {promo.byMethod.map((m) => {
              const totalCount = promo.byMethod.reduce((s, x) => s + x.count, 0);
              const pct = totalCount > 0 ? ((m.count / totalCount) * 100).toFixed(0) : "0";
              return (
                <div key={m.method} className="flex items-center gap-4 bg-gray-50 rounded-lg px-4 py-3">
                  <div className="flex-1">
                    <div className="text-[11px] font-semibold text-gray-800">{m.method}</div>
                    <div className="text-[10px] text-gray-400">{m.count} taikymai · {fmtEur(m.discountAmount)} nuolaida</div>
                  </div>
                  <div className="text-right">
                    <div className="text-lg font-bold text-gray-800">{pct}%</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Pardavimų pasiskirstymas per parą ── */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
        <SectionTitle title="Pardavimų pasiskirstymas per parą" subtitle="Kuriomis valandomis daugiausiai pajamų" />
        <div className="flex items-end gap-[3px] h-[120px]">
          {hourlyDistribution.map((h) => {
            const pct = (h.revenue / maxHourRev) * 100;
            return (
              <div
                key={h.hour}
                className="flex-1 flex flex-col items-center justify-end h-full group relative"
                title={`${String(h.hour).padStart(2, "0")}:00 — ${h.count} pardav. / ${fmtEur(h.revenue)}`}
              >
                <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-[9px] px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-10">
                  {String(h.hour).padStart(2, "0")}:00 · {h.count} pard. · {fmtEur(h.revenue)}
                </div>
                <div
                  className={`w-full rounded-t-[2px] ${h.count > 0 ? "bg-emerald-400" : "bg-gray-100"}`}
                  style={{ height: `${Math.max(pct, h.count > 0 ? 3 : 0)}%` }}
                />
              </div>
            );
          })}
        </div>
        <div className="flex gap-[3px] mt-1">
          {hourlyDistribution.map((h) => (
            <div key={h.hour} className="flex-1 text-center text-[8px] text-gray-400">
              {h.hour % 3 === 0 ? String(h.hour).padStart(2, "0") : ""}
            </div>
          ))}
        </div>
      </div>

      {/* ── Top produktai ── */}
      {topProducts.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <SectionTitle title="Top 10 produktų" subtitle="Pagal pajamas — kurie produktai daugiausiai prisideda prie akcijų rezultatų" />
          <div className="space-y-2">
            {topProducts.map((prod, i) => {
              const maxRev = topProducts[0]?.revenue || 1;
              const pct = (prod.revenue / maxRev) * 100;
              return (
                <div key={prod.name} className="flex items-center gap-3">
                  <span className="text-[10px] text-gray-400 w-4 text-right">{i + 1}.</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[11px] text-gray-700 truncate">{prod.name}</span>
                      <span className="text-[9px] text-gray-400">{prod.qty} vnt.</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-[3px] bg-gray-100 rounded-full overflow-hidden">
                        <div className="h-full bg-emerald-400 rounded-full" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-[10px] text-gray-500 w-[50px] text-right">{fmtEur(prod.revenue)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// TAB 4: TRENDS — Daily promo trends + patterns
// ═══════════════════════════════════════════════════════════════════════

function TrendsTab({
  promo,
  totalSales,
}: {
  promo: PromoAnalytics;
  totalSales: number;
}) {
  const trend = promo.dailyTrend;

  if (trend.length < 2) {
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-xl p-6 text-center text-sm text-gray-500">
        Reikia bent 2 dienų duomenų tendencijoms atvaizduoti.
      </div>
    );
  }

  // Compute trend stats
  const avgPromoPercent = trend.length > 0
    ? (trend.reduce((s, d) => s + d.promoPercent, 0) / trend.length).toFixed(1)
    : "0";
  const avgDiscount = trend.length > 0
    ? Math.round(trend.reduce((s, d) => s + d.avgDiscount, 0) / trend.length)
    : 0;

  // Trend direction (last 3 days vs first 3 days)
  const firstDays = trend.slice(0, Math.min(3, Math.floor(trend.length / 2)));
  const lastDays = trend.slice(-Math.min(3, Math.floor(trend.length / 2)));
  const firstAvgPct = firstDays.length > 0 ? firstDays.reduce((s, d) => s + d.promoPercent, 0) / firstDays.length : 0;
  const lastAvgPct = lastDays.length > 0 ? lastDays.reduce((s, d) => s + d.promoPercent, 0) / lastDays.length : 0;
  const trendDirection = lastAvgPct > firstAvgPct + 5 ? "up" : lastAvgPct < firstAvgPct - 5 ? "down" : "stable";

  // Best & worst days
  const bestDay = trend.reduce((a, b) => a.promoRevenue > b.promoRevenue ? a : b);
  const worstDay = trend.filter(d => d.promoSales > 0).reduce((a, b) => a.promoRevenue < b.promoRevenue ? a : b, trend[0]);

  return (
    <div>
      {/* ── Trend KPIs ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <KpiCard
          label="Vidutinė akcijų dalis"
          value={`${avgPromoPercent}%`}
          sub={`per ${trend.length} dienų`}
          accent="purple"
        />
        <KpiCard
          label="Vid. nuolaida"
          value={fmtEur(avgDiscount)}
          sub="per akcijinį pardavimą"
          accent="orange"
        />
        <KpiCard
          label="Geriausia diena"
          value={bestDay.date.slice(5)}
          sub={`${fmtEur(bestDay.promoRevenue)} · ${bestDay.promoSales} pard.`}
          accent="green"
        />
        <KpiCard
          label="Tendencija"
          value={trendDirection === "up" ? "Kyla" : trendDirection === "down" ? "Krenta" : "Stabili"}
          sub={`${firstAvgPct.toFixed(0)}% → ${lastAvgPct.toFixed(0)}%`}
          accent={trendDirection === "up" ? "green" : trendDirection === "down" ? "red" : "blue"}
        />
      </div>

      {/* ── Main daily trend chart ── */}
      <DailyTrendChart trend={trend} />

      {/* ── Day-by-day table ── */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 mt-6">
        <SectionTitle title="Dienos detalės" subtitle="Kiekvienos dienos pardavimų ir akcijų statistika" />
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-gray-200 text-left">
                <th className="pb-2 text-gray-400 font-semibold">Data</th>
                <th className="pb-2 text-gray-400 font-semibold text-right">Pardavimai</th>
                <th className="pb-2 text-gray-400 font-semibold text-right">Su akcija</th>
                <th className="pb-2 text-gray-400 font-semibold text-right">Akcijų %</th>
                <th className="pb-2 text-gray-400 font-semibold text-right">Pajamos</th>
                <th className="pb-2 text-gray-400 font-semibold text-right">Akcijų pajamos</th>
                <th className="pb-2 text-gray-400 font-semibold text-right">Vid. nuolaida</th>
              </tr>
            </thead>
            <tbody>
              {[...trend].reverse().map((d) => (
                <tr key={d.date} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="py-1.5 font-medium text-gray-800">{d.date}</td>
                  <td className="py-1.5 text-right text-gray-600">{d.totalSales}</td>
                  <td className="py-1.5 text-right text-purple-600 font-medium">{d.promoSales}</td>
                  <td className="py-1.5 text-right">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                      d.promoPercent > 50 ? "bg-purple-100 text-purple-700"
                        : d.promoPercent > 20 ? "bg-purple-50 text-purple-600"
                          : "text-gray-500"
                    }`}>
                      {d.promoPercent}%
                    </span>
                  </td>
                  <td className="py-1.5 text-right text-gray-700 font-medium">{fmtEur(d.totalRevenue)}</td>
                  <td className="py-1.5 text-right text-purple-600 font-medium">{fmtEur(d.promoRevenue)}</td>
                  <td className="py-1.5 text-right text-orange-500">{fmtEur(d.avgDiscount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// SHARED SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════════

function SectionTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-3">
      <h3 className="text-[12px] font-bold text-gray-700 uppercase tracking-wider">{title}</h3>
      {subtitle && <p className="text-[10px] text-gray-400 mt-0.5">{subtitle}</p>}
    </div>
  );
}

function KpiCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub: string;
  accent: "purple" | "green" | "orange" | "blue" | "red";
}) {
  const accentColors = {
    purple: "border-l-purple-500 bg-white",
    green: "border-l-green-500 bg-white",
    orange: "border-l-orange-500 bg-white",
    blue: "border-l-blue-500 bg-white",
    red: "border-l-red-500 bg-white",
  };
  const valueColors = {
    purple: "text-purple-700",
    green: "text-green-700",
    orange: "text-orange-700",
    blue: "text-blue-700",
    red: "text-red-700",
  };
  return (
    <div className={`rounded-lg border border-gray-200 border-l-4 ${accentColors[accent]} px-4 py-3`}>
      <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">{label}</p>
      <p className={`text-xl font-bold ${valueColors[accent]}`}>{value}</p>
      <p className="text-[10px] text-gray-400 mt-0.5">{sub}</p>
    </div>
  );
}

function InsightCard({ insight }: { insight: PromoInsight }) {
  const styles = {
    success: { bg: "bg-green-50", border: "border-green-200", icon: "✓", iconColor: "text-green-600", titleColor: "text-green-800" },
    warning: { bg: "bg-amber-50", border: "border-amber-200", icon: "⚠", iconColor: "text-amber-600", titleColor: "text-amber-800" },
    opportunity: { bg: "bg-blue-50", border: "border-blue-200", icon: "→", iconColor: "text-blue-600", titleColor: "text-blue-800" },
    info: { bg: "bg-gray-50", border: "border-gray-200", icon: "i", iconColor: "text-gray-500", titleColor: "text-gray-700" },
  };
  const s = styles[insight.type];
  return (
    <div className={`${s.bg} ${s.border} border rounded-xl px-4 py-3`}>
      <div className="flex items-start gap-2">
        <span className={`${s.iconColor} text-sm font-bold flex-shrink-0 mt-0.5`}>{s.icon}</span>
        <div className="min-w-0">
          <div className={`text-[11px] font-semibold ${s.titleColor}`}>{insight.title}</div>
          <div className="text-[10px] text-gray-600 mt-0.5 leading-relaxed">{insight.description}</div>
        </div>
        {insight.metric && (
          <span className={`text-sm font-bold ${s.titleColor} flex-shrink-0 ml-auto`}>{insight.metric}</span>
        )}
      </div>
    </div>
  );
}

function HighlightCard({
  type,
  name,
  roi,
  revenue,
  discount,
  txnCount,
}: {
  type: "best" | "worst";
  name: string;
  roi: number;
  revenue: number;
  discount: number;
  txnCount: number;
}) {
  const isBest = type === "best";
  return (
    <div className={`rounded-lg border px-4 py-3 ${
      isBest ? "bg-green-50 border-green-200" : "bg-amber-50 border-amber-200"
    }`}>
      <div className="flex items-center gap-2 mb-1">
        <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${
          isBest ? "bg-green-200 text-green-800" : "bg-amber-200 text-amber-800"
        }`}>
          {isBest ? "Geriausia" : "Peržiūrėti"}
        </span>
        <span className="text-[11px] font-semibold text-gray-800 truncate">{name}</span>
      </div>
      <div className="grid grid-cols-4 gap-2 text-[10px] mt-2">
        <div>
          <span className="text-gray-400 block">ROI</span>
          <span className={`font-bold ${isBest ? "text-green-700" : "text-amber-700"}`}>{roi}x</span>
        </div>
        <div>
          <span className="text-gray-400 block">Pajamos</span>
          <span className="font-bold text-gray-800">{fmtEur(revenue)}</span>
        </div>
        <div>
          <span className="text-gray-400 block">Nuolaida</span>
          <span className="font-bold text-orange-600">{fmtEur(discount)}</span>
        </div>
        <div>
          <span className="text-gray-400 block">Pardavimai</span>
          <span className="font-bold text-gray-800">{txnCount}</span>
        </div>
      </div>
    </div>
  );
}

function BehaviorCard({
  title,
  color,
  count,
  revenue,
  avgCheck,
  avgItems,
  isHighlighted,
}: {
  title: string;
  color: "purple" | "gray";
  count: number;
  revenue: number;
  avgCheck: number;
  avgItems: number;
  isHighlighted?: boolean;
}) {
  const bg = color === "purple" ? "bg-purple-50 border-purple-200" : "bg-gray-50 border-gray-200";
  const label = color === "purple" ? "text-purple-600" : "text-gray-500";
  return (
    <div className={`rounded-xl border p-5 ${bg}`}>
      <div className={`text-[11px] font-bold uppercase mb-3 ${label}`}>{title}</div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <span className="text-[10px] text-gray-400 block">Pardavimai</span>
          <span className="text-xl font-bold text-gray-800">{count}</span>
        </div>
        <div>
          <span className="text-[10px] text-gray-400 block">Pajamos</span>
          <span className="text-xl font-bold text-gray-800">{fmtEur(revenue)}</span>
        </div>
        <div>
          <span className="text-[10px] text-gray-400 block">Vid. čekis</span>
          <span className={`text-xl font-bold ${isHighlighted ? "text-green-600" : "text-gray-800"}`}>{fmtEur(avgCheck)}</span>
        </div>
        <div>
          <span className="text-[10px] text-gray-400 block">Vid. prekių</span>
          <span className="text-xl font-bold text-gray-800">{avgItems}</span>
        </div>
      </div>
    </div>
  );
}

function UpliftMetric({
  label,
  withPromo,
  withoutPromo,
  format,
}: {
  label: string;
  withPromo: number;
  withoutPromo: number;
  format: "eur" | "num";
}) {
  const diff = withoutPromo > 0 ? ((withPromo - withoutPromo) / withoutPromo * 100) : 0;
  const isPositive = diff >= 0;
  const fmt = format === "eur" ? fmtEur : (v: number) => v.toFixed(1);

  return (
    <div className="text-center">
      <div className="text-[10px] text-gray-400 mb-1">{label}</div>
      <div className={`text-2xl font-bold ${isPositive ? "text-green-600" : "text-red-600"}`}>
        {isPositive ? "+" : ""}{diff.toFixed(1)}%
      </div>
      <div className="flex items-center justify-center gap-3 mt-1.5 text-[10px]">
        <span className="text-purple-600">Su: {fmt(withPromo)}</span>
        <span className="text-gray-400">vs</span>
        <span className="text-gray-500">Be: {fmt(withoutPromo)}</span>
      </div>
    </div>
  );
}

function PromoDetailPanel({
  p,
  revenueShare,
  roiColor,
}: {
  p: PromoDetail;
  revenueShare: string;
  roiColor: string;
}) {
  return (
    <div className="bg-purple-50 border-t border-purple-100 px-4 py-3">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-[10px]">
        <div>
          <span className="text-gray-400 block">Pajamų dalis</span>
          <span className="font-bold text-gray-800 text-sm">{revenueShare}%</span>
          <span className="text-gray-400 block">nuo visų pajamų</span>
        </div>
        <div>
          <span className="text-gray-400 block">Pritaikymo kartai</span>
          <span className="font-bold text-gray-800 text-sm">{p.applicationCount}</span>
          <span className="text-gray-400 block">
            {p.applicationCount > p.txnCount
              ? `~${(p.applicationCount / p.txnCount).toFixed(1)}x per tranz.`
              : "1x per tranzakciją"}
          </span>
        </div>
        <div>
          <span className="text-gray-400 block">Nuolaida per tranz.</span>
          <span className="font-bold text-gray-800 text-sm">
            {fmtEur(p.txnCount > 0 ? Math.round(p.totalDiscount / p.txnCount) : 0)}
          </span>
          <span className="text-gray-400 block">vidutinė</span>
        </div>
        <div>
          <span className="text-gray-400 block">Efektyvumas</span>
          <span className={`font-bold text-sm ${roiColor}`}>
            {p.revenuePerDiscountEuro >= 10 ? "Puiku" : p.revenuePerDiscountEuro >= 5 ? "Gerai" : p.revenuePerDiscountEuro > 0 ? "Peržiūrėti" : "Nėra duomenų"}
          </span>
          <span className="text-gray-400 block">
            {p.revenuePerDiscountEuro > 0
              ? `1€ nuolaidos → ${p.revenuePerDiscountEuro}€ pajamų`
              : "—"}
          </span>
        </div>
      </div>
      <div className="mt-3">
        <div className="flex items-center gap-2">
          <span className="text-[9px] text-gray-400 w-[80px]">Pajamų dalis</span>
          <div className="flex-1 h-[6px] bg-gray-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-purple-500 rounded-full"
              style={{ width: `${Math.min(Number(revenueShare), 100)}%` }}
            />
          </div>
          <span className="text-[9px] font-semibold text-gray-600 w-[40px] text-right">{revenueShare}%</span>
        </div>
      </div>
    </div>
  );
}

function CompareRow({
  label,
  values,
  highlight,
  rawValues,
}: {
  label: string;
  values: string[];
  highlight?: "max" | "min";
  rawValues?: number[];
}) {
  let bestIdx = -1;
  if (highlight && rawValues && rawValues.length > 0) {
    if (highlight === "max") bestIdx = rawValues.indexOf(Math.max(...rawValues));
    if (highlight === "min") bestIdx = rawValues.indexOf(Math.min(...rawValues.filter(v => v > 0)));
  }
  return (
    <tr className="border-b border-purple-50">
      <td className="py-1.5 text-gray-500 font-medium">{label}</td>
      {values.map((v, i) => (
        <td key={i} className={`py-1.5 text-right ${i === bestIdx ? "font-bold text-purple-700" : "text-gray-700"}`}>
          {v}
        </td>
      ))}
    </tr>
  );
}

function DailyTrendChart({ trend }: { trend: DailyPromoTrend[] }) {
  const maxPromoPercent = Math.max(...trend.map((d) => d.promoPercent), 1);
  const maxRevenue = Math.max(...trend.map((d) => d.totalRevenue), 1);

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <SectionTitle
        title="Akcijų tendencija pagal dieną"
        subtitle="Violetinė — akcijų pardavimų dalis (%), žalia — bendra dienos apyvarta"
      />
      <div className="flex items-end gap-[2px] h-[120px]">
        {trend.map((d) => {
          const promoPct = (d.promoPercent / maxPromoPercent) * 100;
          const revPct = (d.totalRevenue / maxRevenue) * 100;
          return (
            <div
              key={d.date}
              className="flex-1 flex flex-col items-center justify-end h-full relative group"
            >
              <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-[9px] px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-10">
                <div className="font-semibold">{d.date.slice(5)}</div>
                <div>Pardav.: {d.totalSales} (akcijų: {d.promoSales})</div>
                <div>Akcijų %: {d.promoPercent}%</div>
                <div>Pajamos: {fmtEur(d.totalRevenue)}</div>
                <div>Vid. nuolaida: {fmtEur(d.avgDiscount)}</div>
              </div>
              <div
                className="w-full rounded-t-[2px] bg-emerald-100 absolute bottom-0"
                style={{ height: `${Math.max(revPct, 2)}%` }}
              />
              <div
                className="w-full rounded-t-[2px] bg-purple-400 relative z-[1]"
                style={{ height: `${Math.max(promoPct, d.promoPercent > 0 ? 3 : 0)}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex gap-[2px] mt-1">
        {trend.map((d, i) => (
          <div key={d.date} className="flex-1 text-center text-[7px] text-gray-400">
            {i % Math.max(1, Math.floor(trend.length / 7)) === 0 ? d.date.slice(5) : ""}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-4 mt-2 text-[9px] text-gray-400">
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded bg-purple-400" /> Akcijų dalis %
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded bg-emerald-100 border border-emerald-200" /> Dienos apyvarta
        </span>
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────

function fmtEur(cents: number): string {
  return `${(cents / 100).toFixed(2)}€`;
}

function roiTextColor(roi: number): string {
  if (roi >= 10) return "text-green-600";
  if (roi >= 5) return "text-yellow-600";
  if (roi > 0) return "text-orange-600";
  return "text-gray-400";
}

function roiBadgeColor(roi: number): string {
  if (roi >= 10) return "bg-green-100 text-green-700";
  if (roi >= 5) return "bg-yellow-100 text-yellow-700";
  if (roi > 0) return "bg-orange-100 text-orange-700";
  return "bg-gray-100 text-gray-400";
}

function applyOnColor(type: string): string {
  switch (type) {
    case "BASKET": return "bg-blue-50 text-blue-600";
    case "TOTAL": return "bg-purple-50 text-purple-600";
    case "ITEM": return "bg-green-50 text-green-600";
    case "GROUP": return "bg-amber-50 text-amber-600";
    default: return "bg-gray-50 text-gray-500";
  }
}
