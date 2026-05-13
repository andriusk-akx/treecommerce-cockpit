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

export type Category =
  | "retellect"
  | "scoApp"
  | "db"
  | "system"
  | "besclient"
  | "elastic"
  | "osCore";

/** Categories that come from named processes (chooseTelemetrySources). `osCore`
 *  is NOT in this set because Windows OS kernel work doesn't have a single
 *  process name — it's sourced from `system.cpu.util[,system]` (kernel CPU)
 *  by the route, not from `categorise()`.
 *
 *  Named `HistoryProcessCategory` (not `ProcessCategory`) to avoid colliding
 *  with `ProcessCategory` from `@/lib/zabbix/types`, which uses a different
 *  taxonomy ("sco" / "hw" / "sys") for the procCpu Zabbix items. The two
 *  category systems describe different data and must stay separate. */
export type HistoryProcessCategory = Exclude<Category, "osCore">;

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
 * 2026-04-28 — `besclient` (IBM BigFix) was first lumped into "system" after
 * a SP testlab snapshot showed it consistently consuming CPU on SCO hosts.
 *
 * 2026-05-12 — SP admin deployed finer monitoring on testlab host
 * (testlab_SPUB-P-SCO150) that detailed the previously-anonymous "Other"
 * bucket into three named sub-categories: BESClient, Elastic agent, and
 * Windows OS kernel work. `besclient` is now its OWN category (moved out of
 * "system" so users can read the BigFix cost directly), and `elastic-agent`
 * / `elasticsearch` / similar names map to "elastic". The Windows kernel
 * ("System" process, PID 4) maps to "osCore" but is normally sourced from
 * the kernel-CPU item `system.cpu.util[,system]` rather than a process key
 * — the categorise() route is kept here so a host that DOES publish a
 * perf_counter for the "System" process still lands in the right bucket.
 *
 * "system" category is preserved for the VM host process (vmware-vmx) and
 * any other VM-runtime supervisor — labelled "System (VM host)" in the UI
 * to disambiguate from the new osCore bucket.
 *
 * osCore is intentionally NOT reachable from this function: Windows kernel
 * CPU comes from the host-scope item `system.cpu.util[,system]`, not from
 * a process name, and the route fetches it via a dedicated path. Routing
 * a hypothetical `perf_counter[\Process(System)]` here would double-count
 * against the kernel item on hosts that publish both.
 */
export function categorise(procName: string): HistoryProcessCategory | null {
  if (/^python\d*$/.test(procName)) return "retellect";
  if (procName === "spss" || procName === "sp.sss" || procName === "sp") return "scoApp";
  if (procName === "sql" || procName === "sqlservr") return "db";
  if (procName === "vm" || procName === "vmware-vmx") return "system";
  if (procName === "besclient") return "besclient";
  if (
    procName === "elastic" ||
    procName === "elastic-agent" ||
    procName === "elasticagent" ||
    procName === "elasticsearch" ||
    procName === "elasticagentexe"
  ) {
    return "elastic";
  }
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
  categoryById: Map<string, HistoryProcessCategory>;
  needsCoresDivision: Set<string>;
} {
  const isCpuKey = (k: string) =>
    k.endsWith(".cpu") && !k.startsWith("perf_counter") && !k.startsWith("system.cpu");
  const isPerfProcKey = (k: string) =>
    /^perf_counter\["?\\Process\(/.test(k) && /\\% Processor Time/.test(k);

  const cpuItems = allItems.filter((it) => isCpuKey(it.key_));
  const perfItems = allItems.filter((it) => isPerfProcKey(it.key_));

  const categoryById = new Map<string, HistoryProcessCategory>();
  const needsCoresDivision = new Set<string>();
  const perfByProc = new Map<string, { itemid: string; cat: HistoryProcessCategory }>();

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
  besclient: number;
  elastic: number;
  osCore: number;
  countR: number;
  countS: number;
  countD: number;
  countSys: number;
  countBes: number;
  countEla: number;
  countOs: number;
}

export interface SlotAverages {
  retellect: number;
  scoApp: number;
  db: number;
  system: number;
  besclient: number;
  elastic: number;
  osCore: number;
  /** Remainder after every named category is subtracted from 100. Clamped ≥0
   *  so a slot where monitored sums overshoot host CPU (rare, perf_counter
   *  rounding) never renders a negative bar. */
  free: number;
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
export function averageSlot(b: SlotBucket): SlotAverages {
  // 2-decimal precision so the UI can render sub-1% values honestly.
  // Pre-2026-05-13 this was 1 decimal, which collapsed values < 0.05%
  // (like Elastic agent's typical 0.04% per host) to "0%" — the user
  // saw blank bars and assumed monitoring was broken when in fact the
  // process simply uses negligible CPU. With 2 decimals the formatter
  // in RtTimeline can show "0.04%" for tiny values and "11%" / "0.5%"
  // for larger ones via conditional precision.
  const round = (v: number) => Math.round(v * 100) / 100;
  const r = b.countR > 0 ? round(b.retellect / b.countR) : 0;
  const sa = b.countS > 0 ? round(b.scoApp / b.countS) : 0;
  const dbv = b.countD > 0 ? round(b.db / b.countD) : 0;
  const sys = b.countSys > 0 ? round(b.system / b.countSys) : 0;
  const bes = b.countBes > 0 ? round(b.besclient / b.countBes) : 0;
  const ela = b.countEla > 0 ? round(b.elastic / b.countEla) : 0;
  const os = b.countOs > 0 ? round(b.osCore / b.countOs) : 0;
  return {
    retellect: r,
    scoApp: sa,
    db: dbv,
    system: sys,
    besclient: bes,
    elastic: ela,
    osCore: os,
    free: Math.max(0, 100 - r - sa - dbv - sys - bes - ela - os),
  };
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
