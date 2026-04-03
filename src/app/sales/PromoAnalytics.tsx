"use client";

import { useState, useMemo } from "react";
import type { PromoAnalytics, PromoDetail, DailyPromoTrend, PromoInsight } from "@/lib/12eat/client";

// ─── Props ──────────────────────────────────────────────────────────

interface Props {
  promo: PromoAnalytics;
  totalSales: number;
  totalRevenue: number;
}

// ─── Main Component ─────────────────────────────────────────────────

export default function PromoAnalyticsPanel({ promo, totalSales, totalRevenue }: Props) {
  const [sortField, setSortField] = useState<keyof PromoDetail>("totalRevenue");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [expandedPromo, setExpandedPromo] = useState<number | null>(null);

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

  function toggleSort(field: keyof PromoDetail) {
    if (sortField === field) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  }

  const sortIcon = (field: keyof PromoDetail) =>
    sortField === field ? (sortDir === "desc" ? " ▾" : " ▴") : "";

  if (promo.withPromoCount === 0) {
    return (
      <div className="mt-6 bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 text-[11px] text-gray-500">
        Akcijų duomenų nerasta. Kai bus aktyvių akcijų — čia atsiras detali analitika.
      </div>
    );
  }

  return (
    <div className="mt-8">
      {/* Section header */}
      <div className="mb-4 flex items-center gap-3">
        <h2 className="text-[13px] font-bold text-gray-700 uppercase tracking-wider">
          Akcijų analitika
        </h2>
        <div className="flex-1 h-px bg-gray-200" />
        <span className="text-[10px] text-gray-400">
          {promo.withPromoCount} iš {totalSales} pardavimų su akcija ({promo.promoSharePercent}%)
        </span>
      </div>

      {/* ── Strategic Insights ── */}
      {promo.insights.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-6">
          {promo.insights.map((insight, i) => (
            <InsightCard key={i} insight={insight} />
          ))}
        </div>
      )}

      {/* ── Impact cards ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <ImpactCard
          label="Čekio pokytis"
          value={`${promo.upliftPercent >= 0 ? "+" : ""}${promo.upliftPercent}%`}
          valueColor={promo.upliftPercent >= 0 ? "text-green-600" : "text-red-600"}
          sub={`${fmtEur(promo.withPromoAvgCheck)} vs ${fmtEur(promo.withoutPromoAvgCheck)}`}
        />
        <ImpactCard
          label="Su akcija vid. prekių"
          value={String(promo.withPromoAvgItems)}
          sub={`Be akcijos: ${promo.withoutPromoAvgItems}`}
        />
        <ImpactCard
          label="Akcijų pajamos"
          value={fmtEur(promo.withPromoRevenue)}
          sub={`${promo.promoSharePercent}% visų pajamų`}
        />
        <ImpactCard
          label="Suteikta nuolaidų"
          value={fmtEur(promo.totalDiscountAmount)}
          valueColor="text-orange-600"
          sub={promo.byMethod.map((m) => `${m.method}: ${m.count}`).join(", ") || "—"}
        />
      </div>

      {/* ── Daily Trend Chart ── */}
      {promo.dailyTrend.length > 1 && (
        <DailyTrendChart trend={promo.dailyTrend} />
      )}

      {/* ── Buyer Behavior Comparison ── */}
      <div className="bg-white rounded-lg border border-gray-200 p-5 mb-6">
        <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-3">
          Pirkėjų elgsena: su akcija vs be akcijos
        </h3>
        <div className="grid grid-cols-2 gap-4">
          <ComparisonPanel
            title="Su akcija"
            color="purple"
            count={promo.withPromoCount}
            revenue={promo.withPromoRevenue}
            avgCheck={promo.withPromoAvgCheck}
            avgItems={promo.withPromoAvgItems}
            isHighlighted
          />
          <ComparisonPanel
            title="Be akcijos"
            color="gray"
            count={promo.withoutPromoCount}
            revenue={promo.withoutPromoRevenue}
            avgCheck={promo.withoutPromoAvgCheck}
            avgItems={promo.withoutPromoAvgItems}
          />
        </div>
      </div>

      {/* ── Sortable Promo Performance Table ── */}
      <div className="bg-white rounded-lg border border-gray-200 p-5 mb-6">
        <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
          Akcijų efektyvumas
        </h3>
        <p className="text-[10px] text-gray-400 mb-3">
          Spauskite stulpelio antraštę rūšiavimui. Spauskite eilutę detalėms.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-gray-200 text-left">
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
                <th className="pb-2 text-gray-400 font-semibold text-right cursor-pointer hover:text-gray-600" onClick={() => toggleSort("avgItems")}>
                  Vid. prekių{sortIcon("avgItems")}
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
                const roiColor =
                  p.revenuePerDiscountEuro >= 10 ? "text-green-600"
                    : p.revenuePerDiscountEuro >= 5 ? "text-yellow-600"
                      : p.revenuePerDiscountEuro > 0 ? "text-orange-600" : "text-gray-400";
                const isExpanded = expandedPromo === p.promoId;
                const revenueShare = totalRevenue > 0 ? ((p.totalRevenue / totalRevenue) * 100).toFixed(1) : "0";
                return (
                  <tr key={p.promoId} className="border-b border-gray-50">
                    <td colSpan={8} className="p-0">
                      <div
                        className={`flex items-center gap-0 px-0 py-2 cursor-pointer transition-colors ${
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
                          <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${
                            p.applyOn === "BASKET" ? "bg-blue-50 text-blue-600"
                              : p.applyOn === "TOTAL" ? "bg-purple-50 text-purple-600"
                                : p.applyOn === "ITEM" ? "bg-green-50 text-green-600"
                                  : "bg-gray-50 text-gray-500"
                          }`}>
                            {p.applyOn}
                          </span>
                        </div>
                        <div className="w-[50px] text-right font-semibold text-gray-700 flex-shrink-0">{p.txnCount}</div>
                        <div className="w-[70px] text-right font-semibold text-gray-700 flex-shrink-0">{fmtEur(p.totalRevenue)}</div>
                        <div className="w-[65px] text-right text-gray-600 flex-shrink-0">{fmtEur(p.avgCheck)}</div>
                        <div className="w-[55px] text-right text-gray-600 flex-shrink-0">{p.avgItems}</div>
                        <div className="w-[65px] text-right text-orange-600 flex-shrink-0">{fmtEur(p.totalDiscount)}</div>
                        <div className={`w-[50px] text-right font-bold flex-shrink-0 ${roiColor}`}>
                          {p.revenuePerDiscountEuro > 0 ? `${p.revenuePerDiscountEuro}x` : "—"}
                        </div>
                      </div>

                      {/* Expanded detail panel */}
                      {isExpanded && (
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
                          {/* Mini revenue bar */}
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

      {/* ── Apply-on type breakdown ── */}
      {promo.byApplyOn.length > 1 && (
        <div className="bg-white rounded-lg border border-gray-200 p-5 mb-6">
          <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-3">
            Nuolaidų tipai
          </h3>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {promo.byApplyOn.map((ao) => (
              <div key={ao.type} className="rounded-lg bg-gray-50 border border-gray-100 px-3 py-2">
                <div className="text-[10px] text-gray-400 uppercase font-medium">{ao.type}</div>
                <div className="text-lg font-bold text-gray-800">{ao.count}</div>
                <div className="text-[10px] text-gray-400">Nuolaida: {fmtEur(ao.discountAmount)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────

function InsightCard({ insight }: { insight: PromoInsight }) {
  const styles = {
    success: { bg: "bg-green-50", border: "border-green-200", icon: "✓", iconColor: "text-green-600", titleColor: "text-green-800" },
    warning: { bg: "bg-amber-50", border: "border-amber-200", icon: "⚠", iconColor: "text-amber-600", titleColor: "text-amber-800" },
    opportunity: { bg: "bg-blue-50", border: "border-blue-200", icon: "→", iconColor: "text-blue-600", titleColor: "text-blue-800" },
    info: { bg: "bg-gray-50", border: "border-gray-200", icon: "i", iconColor: "text-gray-500", titleColor: "text-gray-700" },
  };
  const s = styles[insight.type];
  return (
    <div className={`${s.bg} ${s.border} border rounded-lg px-4 py-3`}>
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

function ImpactCard({ label, value, sub, valueColor }: {
  label: string; value: string; sub: string; valueColor?: string;
}) {
  return (
    <div className="bg-white rounded-lg border border-purple-200 px-4 py-3">
      <p className="text-[10px] text-purple-400 uppercase tracking-wide mb-0.5">{label}</p>
      <p className={`text-xl font-bold ${valueColor || "text-gray-900"}`}>{value}</p>
      <p className="text-[10px] text-gray-400 mt-0.5">{sub}</p>
    </div>
  );
}

function ComparisonPanel({ title, color, count, revenue, avgCheck, avgItems, isHighlighted }: {
  title: string; color: "purple" | "gray"; count: number; revenue: number; avgCheck: number; avgItems: number; isHighlighted?: boolean;
}) {
  const bg = color === "purple" ? "bg-purple-50 border-purple-100" : "bg-gray-50 border-gray-100";
  const label = color === "purple" ? "text-purple-500" : "text-gray-400";
  return (
    <div className={`rounded-lg border p-4 ${bg}`}>
      <div className={`text-[10px] font-semibold uppercase mb-2 ${label}`}>{title}</div>
      <div className="space-y-2">
        <Row label="Pardavimai" value={String(count)} bold />
        <Row label="Pajamos" value={fmtEur(revenue)} bold />
        <Row label="Vid. čekis" value={fmtEur(avgCheck)} bold highlight={isHighlighted} />
        <Row label="Vid. prekių" value={String(avgItems)} bold />
      </div>
    </div>
  );
}

function Row({ label, value, bold, highlight }: { label: string; value: string; bold?: boolean; highlight?: boolean }) {
  return (
    <div className="flex justify-between text-[11px]">
      <span className="text-gray-500">{label}</span>
      <span className={`${bold ? "font-bold" : ""} ${highlight ? "text-green-600" : "text-gray-800"}`}>{value}</span>
    </div>
  );
}

function DailyTrendChart({ trend }: { trend: DailyPromoTrend[] }) {
  const maxPromoPercent = Math.max(...trend.map((d) => d.promoPercent), 1);
  const maxRevenue = Math.max(...trend.map((d) => d.totalRevenue), 1);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5 mb-6">
      <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
        Akcijų tendencija pagal dieną
      </h3>
      <p className="text-[10px] text-gray-400 mb-3">
        Violetinė — akcijų pardavimų dalis (%), žalia — bendra dienos apyvarta
      </p>
      <div className="flex items-end gap-[2px] h-[100px]">
        {trend.map((d) => {
          const promoPct = (d.promoPercent / maxPromoPercent) * 100;
          const revPct = (d.totalRevenue / maxRevenue) * 100;
          return (
            <div
              key={d.date}
              className="flex-1 flex flex-col items-center justify-end h-full relative group"
            >
              {/* Tooltip */}
              <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-[9px] px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-10">
                <div className="font-semibold">{d.date.slice(5)}</div>
                <div>Pardav.: {d.totalSales} (akcijų: {d.promoSales})</div>
                <div>Akcijų %: {d.promoPercent}%</div>
                <div>Pajamos: {fmtEur(d.totalRevenue)}</div>
                <div>Vid. nuolaida: {fmtEur(d.avgDiscount)}</div>
              </div>
              {/* Revenue bar (green, background) */}
              <div
                className="w-full rounded-t-[2px] bg-emerald-100 absolute bottom-0"
                style={{ height: `${Math.max(revPct, 2)}%` }}
              />
              {/* Promo share bar (purple, foreground) */}
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
      {/* Legend */}
      <div className="flex items-center gap-4 mt-2 text-[9px] text-gray-400">
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded bg-purple-400" /> Akcijų dalis %
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded bg-emerald-100" /> Dienos apyvarta
        </span>
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────

function fmtEur(cents: number): string {
  return `${(cents / 100).toFixed(2)}€`;
}
