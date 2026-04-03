/**
 * 12eat TreeCommerce Export API Client
 *
 * Two environments:
 *   TEST: 10.36.161.75:9051 — test data (default, always accessible)
 *   PROD: 10.100.39.16:9051 — real client data (requires VPN/network)
 *
 * Cursor-based pagination: use /latest-cursor to get sync position,
 * then fetch transactions incrementally.
 */

// ─── Config ──────────────────────────────────────────────────────────

const ENDPOINTS = {
  test: "http://10.36.161.75:9051",
  prod: "http://10.100.39.16:9051",
} as const;

type Env = keyof typeof ENDPOINTS;

function getEnv(): Env {
  const env = process.env.TWELVEEAT_ENV;
  if (env === "prod") return "prod";
  return "test";
}

function getBaseUrl(): string {
  // Allow override via env for local dev / testing
  if (process.env.TWELVEEAT_BASE_URL) return process.env.TWELVEEAT_BASE_URL;
  return ENDPOINTS[getEnv()];
}

export function getApiInfo() {
  const env = getEnv();
  return { env, baseUrl: ENDPOINTS[env], isTest: env === "test" };
}

// ─── Types ───────────────────────────────────────────────────────────

export interface Transaction {
  timeStampSt: string;
  timeStampEnd: string;
  operatorNo: number;
  xactNo: number;
  uniqueStrNo: number;
  transType: number;      // 0=sale, 7=system, 8=return, 61=other
  amountPrice: number;    // cents
  totSoldItem: number;
  totNotCash: number;
  voided: boolean;
  masterSequence: number;
  items: TransactionItem[];
  tenders: Tender[];
  vats: VatEntry[];
  discounts: Discount[];
  device: Device;
}

export interface TransactionItem {
  timeStamp: string;
  terminalNo: number;
  sequenceNo: number;
  itemId: number;
  itemRefNo: string;
  description: string;
  amountPrice: number;   // cents
  quantity: number;
  extPrice: number;      // cents
  voided: boolean;
  taxCode: number;
  itemLabel: string;
  unit: string;
  priceNoVat: number;
  sumNoVat: number;
}

export interface Tender {
  terminalNo: number;
  tenderNo: number;
  amount: number;         // cents
  description: string;
  tenderType: string;     // CASH, CCARD, ROUNDING
  voided: boolean;
  creditCard: boolean;
}

export interface VatEntry {
  taxCode: number;
  soldAmount: number;
  vatAmount: number;
  vatPercentage: number;  // 2100 = 21%
}

export interface Discount {
  promId: number;
  hostPromoCode: string;
  description: string;
  percOff: number;
  percOffAmount: number;
  allowance: number;
  origAmt: number;
  applyOn: string;        // BASKET, TOTAL, ITEM, GROUP
  rewardType: string;
  initiativeId: number;
}

export interface Device {
  terminalId: number;
  companyId: number;
  chainId: number;
  storeId: number;
}

export interface Pagination {
  cursor: number;
  nextCursor: number;
  hasMore: boolean;
  count: number;
}

export interface TransactionResponse {
  data: Transaction[];
  pagination: Pagination;
}

// ─── API calls ───────────────────────────────────────────────────────

export async function getLatestCursor(): Promise<number> {
  const res = await fetch(`${getBaseUrl()}/api/v1/export/transactions/latest-cursor`, {
    signal: AbortSignal.timeout(5000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`12eat API: ${res.status}`);
  const data = await res.json();
  return data.nextCursor;
}

export async function getTransactions(
  cursor: number = 0,
  limit: number = 100
): Promise<TransactionResponse> {
  const res = await fetch(
    `${getBaseUrl()}/api/v1/export/transactions?cursor=${cursor}&limit=${limit}`,
    { signal: AbortSignal.timeout(5000), cache: "no-store" }
  );
  if (!res.ok) throw new Error(`12eat API: ${res.status}`);
  return res.json();
}

/**
 * Fetch the last N transactions by working backwards from latest cursor.
 * Returns sales only (transType 0, not voided).
 */
export async function getRecentSales(count: number = 500): Promise<Transaction[]> {
  const latest = await getLatestCursor();
  // Fetch more than needed since not all transactions are sales
  const fetchCount = Math.min(count * 3, 1000);
  const startCursor = Math.max(0, latest - fetchCount);

  const { data } = await getTransactions(startCursor, fetchCount);

  return data.filter(
    (t) => t.transType === 0 && !t.voided && t.items.length > 0
  );
}

// ─── Analytics helpers ───────────────────────────────────────────────

export interface SalesAnalytics {
  // Summary
  totalSales: number;          // count
  totalRevenue: number;        // cents
  totalItems: number;
  avgTransactionValue: number; // cents
  // Payment breakdown
  cashCount: number;
  cashAmount: number;
  cardCount: number;
  cardAmount: number;
  // Top products
  topProducts: { name: string; qty: number; revenue: number }[];
  // Per-hour distribution
  hourlyDistribution: { hour: number; count: number; revenue: number }[];
  // Per-terminal
  terminalStats: { terminalId: number; count: number; revenue: number }[];
  // Recent transactions (last 10)
  recentTransactions: {
    time: string;
    amount: number;
    items: number;
    paymentType: string;
    terminalId: number;
  }[];
  // ── Promo analytics ──
  promo: PromoAnalytics;
  // Meta
  timeRange: { from: string; to: string };
  latestCursor: number;
  apiEnv: string;
  isTestData: boolean;
}

export interface PromoAnalytics {
  // Overview: with promo vs without
  withPromoCount: number;
  withPromoRevenue: number;     // cents
  withPromoAvgCheck: number;    // cents
  withPromoAvgItems: number;
  withoutPromoCount: number;
  withoutPromoRevenue: number;
  withoutPromoAvgCheck: number;
  withoutPromoAvgItems: number;
  upliftPercent: number;        // avg check uplift %
  promoSharePercent: number;    // % of transactions with promo
  totalDiscountAmount: number;  // cents — total discount given
  // Per-promo breakdown
  promos: PromoDetail[];
  // Promo type breakdown (BASKET, TOTAL, ITEM, GROUP)
  byApplyOn: { type: string; count: number; discountAmount: number }[];
  // Discount method breakdown (percentage vs fixed)
  byMethod: { method: string; count: number; discountAmount: number }[];
  // Daily trend data for charts
  dailyTrend: DailyPromoTrend[];
  // Strategic insights
  insights: PromoInsight[];
}

export interface DailyPromoTrend {
  date: string;           // YYYY-MM-DD
  totalSales: number;
  promoSales: number;
  promoRevenue: number;   // cents
  totalRevenue: number;   // cents
  promoPercent: number;   // % of txns with promo
  avgDiscount: number;    // cents avg discount per promo txn
}

export interface PromoInsight {
  type: "success" | "warning" | "opportunity" | "info";
  title: string;
  description: string;
  metric?: string;
}

export interface PromoDetail {
  promoId: number;
  name: string;
  code: string;
  // How many transactions used it
  txnCount: number;
  // How many discount entries
  applicationCount: number;
  // Revenue of transactions that used this promo
  totalRevenue: number;         // cents
  avgCheck: number;             // cents
  // Total discount given
  totalDiscount: number;        // cents
  // What type (BASKET, TOTAL, ITEM, GROUP)
  applyOn: string;
  // ROI proxy: revenue per euro discounted
  revenuePerDiscountEuro: number;
  // Avg items per transaction using this promo
  avgItems: number;
}

export function analyzeSales(sales: Transaction[], latestCursor: number): SalesAnalytics {
  const apiInfo = getApiInfo();

  const emptyPromo: PromoAnalytics = {
    withPromoCount: 0, withPromoRevenue: 0, withPromoAvgCheck: 0, withPromoAvgItems: 0,
    withoutPromoCount: 0, withoutPromoRevenue: 0, withoutPromoAvgCheck: 0, withoutPromoAvgItems: 0,
    upliftPercent: 0, promoSharePercent: 0, totalDiscountAmount: 0,
    promos: [], byApplyOn: [], byMethod: [], dailyTrend: [], insights: [],
  };

  if (sales.length === 0) {
    return {
      totalSales: 0, totalRevenue: 0, totalItems: 0, avgTransactionValue: 0,
      cashCount: 0, cashAmount: 0, cardCount: 0, cardAmount: 0,
      topProducts: [], hourlyDistribution: [], terminalStats: [],
      recentTransactions: [], promo: emptyPromo,
      timeRange: { from: "-", to: "-" },
      latestCursor,
      apiEnv: apiInfo.env,
      isTestData: apiInfo.isTest,
    };
  }

  const totalRevenue = sales.reduce((s, t) => s + t.amountPrice, 0);
  const allItems = sales.flatMap((t) => t.items.filter((i) => !i.voided));
  const totalItems = allItems.reduce((s, i) => s + i.quantity, 0);

  // Payment types
  let cashCount = 0, cashAmount = 0, cardCount = 0, cardAmount = 0;
  for (const t of sales) {
    const tenders = t.tenders.filter((tn) => tn.amount > 0 && !tn.voided);
    const hasCash = tenders.some((tn) => tn.tenderType === "CASH");
    const hasCard = tenders.some((tn) => tn.tenderType === "CCARD");
    if (hasCash) { cashCount++; cashAmount += t.amountPrice; }
    if (hasCard) { cardCount++; cardAmount += t.amountPrice; }
  }

  // Top products
  const productMap = new Map<string, { qty: number; revenue: number }>();
  for (const item of allItems) {
    const key = item.description;
    const prev = productMap.get(key) || { qty: 0, revenue: 0 };
    prev.qty += item.quantity;
    prev.revenue += item.extPrice;
    productMap.set(key, prev);
  }
  const topProducts = Array.from(productMap.entries())
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  // Hourly distribution
  const hourMap = new Map<number, { count: number; revenue: number }>();
  for (const t of sales) {
    const h = new Date(t.timeStampSt).getHours();
    const prev = hourMap.get(h) || { count: 0, revenue: 0 };
    prev.count++;
    prev.revenue += t.amountPrice;
    hourMap.set(h, prev);
  }
  const hourlyDistribution = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    count: hourMap.get(h)?.count || 0,
    revenue: hourMap.get(h)?.revenue || 0,
  }));

  // Terminal stats
  const termMap = new Map<number, { count: number; revenue: number }>();
  for (const t of sales) {
    const tid = t.device.terminalId;
    const prev = termMap.get(tid) || { count: 0, revenue: 0 };
    prev.count++;
    prev.revenue += t.amountPrice;
    termMap.set(tid, prev);
  }
  const terminalStats = Array.from(termMap.entries())
    .map(([terminalId, v]) => ({ terminalId, ...v }))
    .sort((a, b) => b.revenue - a.revenue);

  // Recent transactions
  const sorted = [...sales].sort(
    (a, b) => new Date(b.timeStampSt).getTime() - new Date(a.timeStampSt).getTime()
  );
  const recentTransactions = sorted.slice(0, 10).map((t) => ({
    time: t.timeStampSt,
    amount: t.amountPrice,
    items: t.items.filter((i) => !i.voided).length,
    paymentType: t.tenders.find((tn) => tn.amount > 0 && tn.tenderType !== "ROUNDING")?.tenderType || "?",
    terminalId: t.device.terminalId,
  }));

  // ── Promo analytics ──
  const withPromo = sales.filter((t) => t.discounts.length > 0);
  const withoutPromo = sales.filter((t) => t.discounts.length === 0);

  const withPromoRevenue = withPromo.reduce((s, t) => s + t.amountPrice, 0);
  const withoutPromoRevenue = withoutPromo.reduce((s, t) => s + t.amountPrice, 0);
  const withPromoItems = withPromo.reduce((s, t) => s + t.items.filter((i) => !i.voided).length, 0);
  const withoutPromoItems = withoutPromo.reduce((s, t) => s + t.items.filter((i) => !i.voided).length, 0);
  const withPromoAvgCheck = withPromo.length > 0 ? Math.round(withPromoRevenue / withPromo.length) : 0;
  const withoutPromoAvgCheck = withoutPromo.length > 0 ? Math.round(withoutPromoRevenue / withoutPromo.length) : 0;
  const upliftPercent = withoutPromoAvgCheck > 0
    ? Math.round(((withPromoAvgCheck - withoutPromoAvgCheck) / withoutPromoAvgCheck) * 100)
    : 0;

  // Total discount amount: sum all allowance values + percOffAmount
  const allDiscounts = sales.flatMap((t) => t.discounts);
  const totalDiscountAmount = allDiscounts.reduce((s, d) => {
    return s + (d.allowance > 1 ? d.allowance : 0) + (d.percOffAmount || 0);
  }, 0);

  // Per-promo grouping by promId
  const promoMap = new Map<number, {
    name: string; code: string; applyOn: string;
    txnIds: Set<number>; appCount: number;
    totalDiscount: number;
  }>();
  for (const t of withPromo) {
    for (const d of t.discounts) {
      const pid = d.promId || 0;
      const prev = promoMap.get(pid) || {
        name: d.description || "?",
        code: d.hostPromoCode || "",
        applyOn: d.applyOn || "?",
        txnIds: new Set<number>(),
        appCount: 0,
        totalDiscount: 0,
      };
      prev.txnIds.add(t.masterSequence);
      prev.appCount++;
      prev.totalDiscount += (d.allowance > 1 ? d.allowance : 0) + (d.percOffAmount || 0);
      promoMap.set(pid, prev);
    }
  }

  // Build per-promo details
  const promos: PromoDetail[] = [];
  for (const [promoId, p] of promoMap) {
    const promoTxns = withPromo.filter((t) => p.txnIds.has(t.masterSequence));
    const promoRev = promoTxns.reduce((s, t) => s + t.amountPrice, 0);
    const promoItems = promoTxns.reduce((s, t) => s + t.items.filter((i) => !i.voided).length, 0);
    const avgCheck = promoTxns.length > 0 ? Math.round(promoRev / promoTxns.length) : 0;

    promos.push({
      promoId,
      name: p.name,
      code: p.code,
      txnCount: p.txnIds.size,
      applicationCount: p.appCount,
      totalRevenue: promoRev,
      avgCheck,
      totalDiscount: p.totalDiscount,
      applyOn: p.applyOn,
      revenuePerDiscountEuro: p.totalDiscount > 0 ? Math.round((promoRev / p.totalDiscount) * 100) / 100 : 0,
      avgItems: promoTxns.length > 0 ? Math.round((promoItems / promoTxns.length) * 10) / 10 : 0,
    });
  }
  promos.sort((a, b) => b.totalRevenue - a.totalRevenue);

  // By applyOn type
  const applyOnMap = new Map<string, { count: number; discountAmount: number }>();
  for (const d of allDiscounts) {
    const ao = d.applyOn || "?";
    const prev = applyOnMap.get(ao) || { count: 0, discountAmount: 0 };
    prev.count++;
    prev.discountAmount += (d.allowance > 1 ? d.allowance : 0) + (d.percOffAmount || 0);
    applyOnMap.set(ao, prev);
  }
  const byApplyOn = Array.from(applyOnMap.entries())
    .map(([type, v]) => ({ type, ...v }))
    .sort((a, b) => b.count - a.count);

  // By method (percentage vs fixed)
  let percCount = 0, percDisc = 0, fixedCount = 0, fixedDisc = 0;
  for (const d of allDiscounts) {
    if (d.percOff > 0) {
      percCount++;
      percDisc += d.percOffAmount || 0;
    } else if (d.allowance > 1) {
      fixedCount++;
      fixedDisc += d.allowance;
    }
  }
  const byMethod = [
    { method: "Procentinė nuolaida", count: percCount, discountAmount: percDisc },
    { method: "Fiksuota nuolaida", count: fixedCount, discountAmount: fixedDisc },
  ].filter((m) => m.count > 0);

  // ── Daily trend ──
  const dailyMap = new Map<string, { totalSales: number; promoSales: number; promoRevenue: number; totalRevenue: number; totalDiscount: number }>();
  for (const t of sales) {
    const day = t.timeStampSt.slice(0, 10);
    const prev = dailyMap.get(day) || { totalSales: 0, promoSales: 0, promoRevenue: 0, totalRevenue: 0, totalDiscount: 0 };
    prev.totalSales++;
    prev.totalRevenue += t.amountPrice;
    if (t.discounts.length > 0) {
      prev.promoSales++;
      prev.promoRevenue += t.amountPrice;
      for (const d of t.discounts) {
        prev.totalDiscount += (d.allowance > 1 ? d.allowance : 0) + (d.percOffAmount || 0);
      }
    }
    dailyMap.set(day, prev);
  }
  const dailyTrend: DailyPromoTrend[] = Array.from(dailyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({
      date,
      totalSales: d.totalSales,
      promoSales: d.promoSales,
      promoRevenue: d.promoRevenue,
      totalRevenue: d.totalRevenue,
      promoPercent: d.totalSales > 0 ? Math.round((d.promoSales / d.totalSales) * 100) : 0,
      avgDiscount: d.promoSales > 0 ? Math.round(d.totalDiscount / d.promoSales) : 0,
    }));

  // ── Strategic insights ──
  const insights: PromoInsight[] = [];

  // Best performing promo
  if (promos.length > 0) {
    const best = promos[0];
    if (best.revenuePerDiscountEuro >= 5) {
      insights.push({
        type: "success",
        title: `"${best.name}" — efektyviausia akcija`,
        description: `Generuoja ${formatCentsShort(best.totalRevenue)} pajamų su ${formatCentsShort(best.totalDiscount)} nuolaida. Kiekvienas nuolaidos euras grąžina ${best.revenuePerDiscountEuro}x pajamų.`,
        metric: `ROI ${best.revenuePerDiscountEuro}x`,
      });
    }
  }

  // Low ROI warning
  const lowRoi = promos.filter((p) => p.revenuePerDiscountEuro > 0 && p.revenuePerDiscountEuro < 3 && p.txnCount >= 3);
  if (lowRoi.length > 0) {
    insights.push({
      type: "warning",
      title: `${lowRoi.length} akcij${lowRoi.length === 1 ? "a" : "os"} su žemu ROI (<3x)`,
      description: `${lowRoi.map((p) => `"${p.name}" (${p.revenuePerDiscountEuro}x)`).join(", ")}. Svarstykite ar šios akcijos pakankmai skatina pardavimus palyginus su nuolaidos kaina.`,
    });
  }

  // Uplift insight
  if (upliftPercent > 0) {
    insights.push({
      type: "success",
      title: `Akcijos didina vid. čekį +${upliftPercent}%`,
      description: `Su akcija vid. čekis ${formatCentsShort(withPromoAvgCheck)}, be akcijos ${formatCentsShort(withoutPromoAvgCheck)}. Akcijos efektyviai skatina didesnį krepšelį.`,
      metric: `+${upliftPercent}%`,
    });
  } else if (upliftPercent < -10) {
    insights.push({
      type: "warning",
      title: `Akcijos mažina vid. čekį ${upliftPercent}%`,
      description: `Pirkėjai su akcija perka mažiau (${formatCentsShort(withPromoAvgCheck)}) nei be akcijos (${formatCentsShort(withoutPromoAvgCheck)}). Gali būti, kad nuolaidos pritraukia tik kainos-jautrius klientus.`,
      metric: `${upliftPercent}%`,
    });
  }

  // Items per basket insight
  const itemsDiff = (withPromo.length > 0 ? withPromoItems / withPromo.length : 0) - (withoutPromo.length > 0 ? withoutPromoItems / withoutPromo.length : 0);
  if (itemsDiff > 0.5) {
    insights.push({
      type: "opportunity",
      title: `Akcijos skatina daugiau prekių krepšelyje (+${itemsDiff.toFixed(1)})`,
      description: `Klientai su akcija perka vidutiniškai ${(withPromoItems / withPromo.length).toFixed(1)} prekes, be akcijos — ${(withoutPromoItems / withoutPromo.length).toFixed(1)}. Cross-sell galimybė.`,
    });
  }

  // Promo saturation
  const promoShare = sales.length > 0 ? (withPromo.length / sales.length) * 100 : 0;
  if (promoShare > 60) {
    insights.push({
      type: "warning",
      title: `Aukšta akcijų koncentracija: ${Math.round(promoShare)}% pardavimų su nuolaida`,
      description: `Daugiau nei pusė pardavimų vyksta su akcija. Tikrinkite ar klientai nepriprato prie nuolaidų ir ar jos negriauna maržos.`,
    });
  } else if (promoShare > 0 && promoShare < 15) {
    insights.push({
      type: "opportunity",
      title: `Maža akcijų aprėptis: tik ${Math.round(promoShare)}% pardavimų`,
      description: `Yra erdvės plėsti akcijų pasiekiamumą. Apsvarstykite aktyvesnę komunikaciją apie esamas akcijas.`,
    });
  }

  const promo: PromoAnalytics = {
    withPromoCount: withPromo.length,
    withPromoRevenue,
    withPromoAvgCheck,
    withPromoAvgItems: withPromo.length > 0 ? Math.round((withPromoItems / withPromo.length) * 10) / 10 : 0,
    withoutPromoCount: withoutPromo.length,
    withoutPromoRevenue,
    withoutPromoAvgCheck,
    withoutPromoAvgItems: withoutPromo.length > 0 ? Math.round((withoutPromoItems / withoutPromo.length) * 10) / 10 : 0,
    upliftPercent,
    promoSharePercent: sales.length > 0 ? Math.round((withPromo.length / sales.length) * 100) : 0,
    totalDiscountAmount,
    promos,
    byApplyOn,
    byMethod,
    dailyTrend,
    insights,
  };

  const times = sales.map((t) => t.timeStampSt).sort();

  return {
    totalSales: sales.length,
    totalRevenue,
    totalItems,
    avgTransactionValue: Math.round(totalRevenue / sales.length),
    cashCount, cashAmount,
    cardCount, cardAmount,
    topProducts,
    hourlyDistribution,
    terminalStats,
    recentTransactions,
    promo,
    timeRange: { from: times[0], to: times[times.length - 1] },
    latestCursor,
    apiEnv: apiInfo.env,
    isTestData: apiInfo.isTest,
  };
}

// ─── Cached data fetching (universal data-source) ───────────────────

import { fetchSource, type SourceResult } from "@/lib/data-source";

export interface SalesDataResult {
  analytics: SalesAnalytics | null;
  isLive: boolean;
  cachedAt: string | null;
  /** Full source result for the status bar — always available, even when data is not */
  sourceResult: SourceResult<{ sales: Transaction[]; cursor: number }>;
}

/**
 * Fetch recent sales with automatic cache fallback.
 * Uses the universal data-source system.
 *
 * Always returns a result (never null) so the status bar can show
 * source state even when data is unavailable.
 */
export async function getRecentSalesWithCache(count: number = 500): Promise<SalesDataResult> {
  const apiInfo = getApiInfo();
  const cacheKey = `12eat-sales-${apiInfo.env}-${count}`;

  const result = await fetchSource<{ sales: Transaction[]; cursor: number }>(
    cacheKey,
    {
      source: "12eat",
      label: "12eat Pardavimai",
      env: apiInfo.env,
      fetcher: async () => {
        const [sales, cursor] = await Promise.all([
          getRecentSales(count),
          getLatestCursor(),
        ]);
        return { sales, cursor };
      },
    },
  );

  if (result.status === "unavailable" || !result.data) {
    return {
      analytics: null,
      isLive: false,
      cachedAt: result.cachedAt,
      sourceResult: result,
    };
  }

  const analytics = analyzeSales(result.data.sales, result.data.cursor);
  return {
    analytics,
    isLive: result.status === "live",
    cachedAt: result.cachedAt,
    sourceResult: result,
  };
}

// ─── Internal helpers ───────────────────────────────────────────────

function formatCentsShort(cents: number): string {
  return `${(cents / 100).toFixed(2)}€`;
}
