/**
 * Pure helpers extracted from process-history/route.ts so they can be unit-
 * tested without spinning up a Next.js server or mocking Zabbix.
 *
 * These functions encode three subtle pieces of logic that have caused real
 * bugs in production data:
 *
 *   1. Choosing telemetry sources — when a host publishes BOTH
 *      `python1.cpu` (1-min average, % of host) and
 *      `perf_counter[\Process(python#1)\% Processor Time]` (instantaneous,
 *      % of one core), we must pick perf_counter (more accurate at peaks)
 *      and tag it for /cores normalisation. *.cpu is only a fallback when
 *      perf_counter is missing for that process.
 *
 *   2. Categorising process names into the four user-facing buckets:
 *      retellect / scoApp / db / system. Anything else returns null and
 *      gets filtered out (cs300sd / NHSTW32 / udm — niche peripheral
 *      drivers, irrelevant to the cockpit's "is Retellect impacting CPU"
 *      story).
 *
 *   3. Computing one slot's per-category averages with INDEPENDENT sample
 *      counts. A naive "divide by total timestamps in slot" formula scales
 *      every category down by ~4× (because timestamps are shared across
 *      categories). This is a known regression we already fixed once and
 *      it must NOT come back.
 */

export type Category = "retellect" | "scoApp" | "db" | "system";

export interface RawItem {
  itemid: string;
  key_: string;
}

/** Normalise process names so *.cpu and perf_counter keys cross-reference. */
export function normalizeProcName(name: string): string {
  return name.toLowerCase().replace(/#/g, "");
}

/**
 * Map a normalised process name to the user-facing category.
 * Returns null for processes the cockpit doesn't track (peripheral drivers).
 *
 * `besclient` (IBM BigFix endpoint management client) was added 2026-04-28
 * after a SP testlab snapshot revealed it consistently consuming CPU on
 * SCO hosts. BigFix is a SP-stack standard so it almost certainly runs on
 * the Rimi prod fleet too; categorising it here shrinks the "Other" bucket
 * by attributing the cycles to the System category. Awaiting prod snapshot
 * before deciding whether to also categorise teamviewer / vmware-vmx-related
 * processes / Defender (MsMpEng); those decisions live in CAT-2/CAT-3 if
 * needed.
 */
export function categorise(procName: string): Category | null {
  if (/^python\d*$/.test(procName)) return "retellect";
  if (procName === "spss" || procName === "sp.sss" || procName === "sp") return "scoApp";
  if (procName === "sql" || procName === "sqlservr") return "db";
  if (procName === "vm" || procName === "vmware-vmx" || procName === "besclient") return "system";
  return null;
}

/**
 * Given the full set of items reported by a host, return:
 *   - categoryById: the chosen item ids and their categories
 *   - needsCoresDivision: items whose values are "% of one core" (perf_counter)
 *
 * Logic:
 *   - perf_counter wins per-process (preferred for spike accuracy).
 *   - *.cpu items are only included for processes without perf_counter.
 *   - Items unrecognised by `categorise()` are silently dropped.
 */
export function chooseTelemetrySources(allItems: RawItem[]): {
  categoryById: Map<string, Category>;
  needsCoresDivision: Set<string>;
} {
  const isCpuKey = (k: string) =>
    k.endsWith(".cpu") && !k.startsWith("perf_counter") && !k.startsWith("system.cpu");
  const isPerfProcKey = (k: string) =>
    /^perf_counter\["?\\Process\(/.test(k) && /\\% Processor Time/.test(k);

  const cpuItems = allItems.filter((it) => isCpuKey(it.key_));
  const perfItems = allItems.filter((it) => isPerfProcKey(it.key_));

  const categoryById = new Map<string, Category>();
  const needsCoresDivision = new Set<string>();
  const perfByProc = new Map<string, { itemid: string; cat: Category }>();

  for (const it of perfItems) {
    const m = it.key_.match(/\\Process\(([^)]+)\)/);
    if (!m) continue;
    const procName = normalizeProcName(m[1]);
    const cat = categorise(procName);
    if (!cat) continue;
    perfByProc.set(procName, { itemid: it.itemid, cat });
  }
  for (const [, entry] of perfByProc) {
    categoryById.set(entry.itemid, entry.cat);
    needsCoresDivision.add(entry.itemid);
  }

  for (const it of cpuItems) {
    const procName = normalizeProcName(it.key_.replace(/\.cpu$/, ""));
    if (perfByProc.has(procName)) continue;
    const cat = categorise(procName);
    if (!cat) continue;
    categoryById.set(it.itemid, cat);
  }

  return { categoryById, needsCoresDivision };
}

export interface SlotBucket {
  retellect: number;
  scoApp: number;
  db: number;
  system: number;
  countR: number;
  countS: number;
  countD: number;
  countSys: number;
}

/**
 * Compute one slot's per-category averages from accumulated sums + counts.
 *
 * Each category is averaged INDEPENDENTLY by its own sample count. If a
 * category has zero samples we return 0 (rather than dividing by 1 or
 * inheriting another category's count, both of which would distort).
 *
 * Returns rounded values to match what the API serialises to the client.
 */
export function averageSlot(b: SlotBucket): {
  retellect: number;
  scoApp: number;
  db: number;
  system: number;
  free: number;
} {
  const r = b.countR > 0 ? Math.round((b.retellect / b.countR) * 10) / 10 : 0;
  const sa = b.countS > 0 ? Math.round((b.scoApp / b.countS) * 10) / 10 : 0;
  const dbv = b.countD > 0 ? Math.round((b.db / b.countD) * 10) / 10 : 0;
  const sys = b.countSys > 0 ? Math.round((b.system / b.countSys) * 10) / 10 : 0;
  return { retellect: r, scoApp: sa, db: dbv, system: sys, free: Math.max(0, 100 - r - sa - dbv - sys) };
}

/**
 * Convert a Zabbix raw value to "% of host" given the item's source kind.
 *
 * Defensive on `cores`: if it's NaN, ≤0, or otherwise garbage we default to 1
 * so the value passes through unchanged rather than producing NaN. The route
 * already guards with `parseInt(... || "1") || 1` upstream, but the helper
 * shouldn't trust its caller.
 */
export function normaliseValue(raw: number, isPerfCounter: boolean, cores: number): number {
  if (!isPerfCounter) return raw;
  // Cores must be ≥1 to make sense. Anything below (NaN, 0, negative,
  // fractional) is treated as 1 → value passes through unchanged.
  const safeCores = Number.isFinite(cores) && cores >= 1 ? cores : 1;
  return raw / safeCores;
}

/**
 * Compute daySummary — the top-level "what was peak / how long above
 * thresholds" stats from raw 1-min sysCpu samples.
 */
export function summariseDay(samples: Array<{ clock: number; value: number }>): {
  samples: number;
  maxValue: number;
  maxAtClock: number;
  avgValue: number;
  // Bucket keys mirror the threshold dropdown values exactly (50/60/70/80/90)
  // plus a 95 cap for very-hot days. Don't drop t50/t70/t90/t95 — older
  // callers (drill-down banner pre-2026-04-28) still consume them via the
  // RtTimeline DaySummary type.
  minutesAbove: { t50: number; t60: number; t70: number; t80: number; t90: number; t95: number };
} | null {
  if (samples.length === 0) return null;
  const peak = samples.reduce((m, s) => (s.value > m.value ? s : m), samples[0]);
  const sum = samples.reduce((acc, s) => acc + s.value, 0);
  const above = (t: number) => samples.filter((s) => s.value >= t).length;
  return {
    samples: samples.length,
    maxValue: Math.round(peak.value * 10) / 10,
    maxAtClock: peak.clock,
    avgValue: Math.round((sum / samples.length) * 10) / 10,
    minutesAbove: {
      t50: above(50), t60: above(60), t70: above(70),
      t80: above(80), t90: above(90), t95: above(95),
    },
  };
}
