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

/** Categories that were rolled out late (SP admin enabled corresponding Zabbix
 *  items first on testlab `SPUB-P-SCO150` ~2026-05-12, then on Rimi prod hosts
 *  from ~2026-05-09 onward — and the rollout date varies per host). Drill-downs
 *  into earlier days legitimately have ZERO samples for these items: the items
 *  simply did not exist yet on that host. The cockpit must NOT render those as
 *  "0%" bars because doing so falsely implies the categories were measured and
 *  found to consume nothing. Instead, the route reports them in a per-day
 *  `unmonitored: string[]` field and the UI folds their would-be residual into
 *  "Other" with an explanatory sub-label. */
export type SparseCategory = "besclient" | "elastic" | "osCore";
export const SPARSE_CATEGORIES: readonly SparseCategory[] = ["besclient", "elastic", "osCore"];

/**
 * Identify which of the recently-deployed sparse categories had ZERO Zabbix
 * samples across the entire day. Caller passes a per-day count per sparse
 * category; categories whose count is exactly 0 are returned in stable order.
 *
 * Used by the route to set `unmonitored` on the drill-down response so the UI
 * can hide misleading "0%" bars and explain the absence on the Other row.
 *
 * Note: this is intentionally day-level, not slot-level. Forward-fill in the
 * route already handles intra-day gaps from 5-min poll cadence — those slots
 * still belong to a "monitored" day. A category is unmonitored only when not
 * a single sample arrived during the requested window.
 */
export function findUnmonitoredCategories(
  dailyCounts: Record<SparseCategory, number>,
): SparseCategory[] {
  return SPARSE_CATEGORIES.filter((k) => (dailyCounts[k] ?? 0) === 0);
}

export interface RawItem {
  itemid: string;
  key_: string;
}

/**
 * Normalise process names so *.cpu and perf_counter keys cross-reference.
 *
 * Strips an optional "#" followed by trailing digits at the END of the name
 * — covering BOTH:
 *
 *   1. Windows perfcounter instance suffix:  "sp.sss#1" -> "sp.sss"
 *   2. Zabbix UserParameter index suffix:     "python1" -> "python"
 *
 * The two flavours represent the same underlying process (Windows numbers
 * concurrent instances of one .exe as #0/#1/...; some StrongPoint agent
 * templates expose the same data as `python1.cpu`/`python2.cpu` items).
 * Normalising both to the same key lets chooseTelemetrySources dedupe
 * them — perfcounter wins, *.cpu fills the gap.
 *
 * The regex anchors to the END (#?\d+$), so:
 *
 *   "sp.sss#0"  -> "sp.sss"        (categorise -> scoApp)
 *   "sp.sss"    -> "sp.sss"        (categorise -> scoApp)
 *   "python1"   -> "python"        (categorise -> retellect via /^python\d*$/)
 *   "python#3"  -> "python"        (categorise -> retellect)
 *   "weird#name" -> "weird#name"   (mid-name '#' survives — only trailing digits strip)
 *   "ipv6"      -> "ipv"           (defensive: a process literally named "ipv6" would lose the 6,
 *                                   but no categorise() entry depends on a trailing digit so this
 *                                   is moot in practice)
 *
 * After normalisation, multiple instance-numbered items for the same
 * process share a single normalised name. chooseTelemetrySources keeps
 * all of them (per-group, root-vs-instance dedupe applies) and the route
 * sums their per-minute values, so three sp.sss#0..#2 workers at 25%
 * each correctly become a 75% slot value.
 *
 * Older code did `replace(/#/g, "")` which (a) mangled "sp.sss#1" into
 * "sp.sss1" — a name categorise() did not match — silently dropping
 * multi-instance SCO processes from the breakdown, and (b) did NOT strip
 * the bare-digit suffix on `python1`, so cpu items and perf items used
 * different keys whenever both flavours existed for the same process.
 */
export function normalizeProcName(name: string): string {
  return name.toLowerCase().replace(/#?\d+$/, "");
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
 *
 * Multi-instance handling (memory: project_sco_process_architecture
 * documents that sp.sss runs as 3 instances on each SCO):
 *
 *   1. perf_counter items are grouped by normalised process name. ALL
 *      entries in a group contribute to the same category. The route
 *      later SUMS their per-minute values, so multiple workers correctly
 *      add up to the total category load.
 *
 *   2. There is intentionally NO root-vs-instance dedupe. Windows perfcounter
 *      numbers concurrent instances as `name`, `name#1`, `name#2`, ... —
 *      the bare-name counter is the FIRST instance, not an aggregate.
 *      Three sp.sss processes show up as `sp.sss` + `sp.sss#1` + `sp.sss#2`,
 *      and all three values must be summed to get total SCO App load.
 *      Dropping the bare-name entry would under-count by one instance.
 *
 *   3. *.cpu fallback: agent-emitted "spss.cpu" etc. are "% of host"
 *      and don't need /cores. Used only when the host doesn't publish
 *      any perf_counter for that normalised name.
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

  // Group perf items by normalised process name and category. All entries
  // per group are kept — multi-instance Windows processes naturally show up
  // as `name`, `name#1`, `name#2`, ... and summing them is correct.
  const perfGroups = new Map<string, HistoryProcessCategory>();

  for (const it of perfItems) {
    const m = it.key_.match(/\\Process\(([^)]+)\)/);
    if (!m) continue;
    const procName = normalizeProcName(m[1]);
    const cat = categorise(procName);
    if (!cat) continue;
    perfGroups.set(procName, cat);
    categoryById.set(it.itemid, cat);
    needsCoresDivision.add(it.itemid);
  }

  // *.cpu fallback: include only when the normalised name has NO perf_counter
  // group at all. perf is more accurate (instantaneous, captures spikes) so
  // we prefer it whenever available.
  for (const it of cpuItems) {
    const procName = normalizeProcName(it.key_.replace(/\.cpu$/, ""));
    if (perfGroups.has(procName)) continue;
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
  /** Remainder after every named category is subtracted from 100. Clamped >=0
   *  so a slot where monitored sums overshoot host CPU (rare, perf_counter
   *  rounding) never renders a negative bar.
   *
   *  Kept for back-compat. The new averageSlotV2 returns a richer object
   *  (with host CPU + Other + dataQuality), but the existing route plumbing
   *  still reads `free` from this path until it's fully migrated. */
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

/** Slot data quality classification.
 *
 *   "ok"   — categories add up plausibly given host CPU (within tolerance)
 *   "warn" — modest overshoot or no host CPU reading available
 *   "fail" — categories sum exceeds host CPU by more than HARD_TOLERANCE_PP.
 *            Almost always indicates a cpu_num normalisation problem.
 *
 *  See spec §4.4 (AKpilot-CPU-Normalization-Spec.md). */
export type SlotDataQuality = "ok" | "warn" | "fail";

/** Per-category point-percent tolerance bands for the sanity check.
 *
 *  These are deliberately generous: per-counter rounding + multi-source
 *  category sums can drift a few percentage points off host CPU even on
 *  a perfectly-normalised host. We only flag when the gap is large
 *  enough to be visible to the operator as "this can't be right".
 *
 *  Tolerance is symmetric around 0 — Σnamed lower than host CPU (a
 *  large "Other" share) is fine; Σnamed higher than host CPU by more
 *  than the tolerance is the failure mode. */
export const SLOT_TOLERANCE_PP = {
  ok: 5,
  warn: 15,
} as const;

export interface SlotAveragesV2 {
  /** Per-category averages, same numbers as averageSlot returned. */
  categories: {
    retellect: number;
    scoApp: number;
    db: number;
    system: number;
    besclient: number;
    elastic: number;
    osCore: number;
  };
  /** Average of the slot's system.cpu.util samples — the "actual" host
   *  CPU utilisation. Null when no sysCpu samples landed in this slot
   *  (older Zabbix templates without `system.cpu.util`, or a slot the
   *  poll cadence skipped). When null we cannot derive Other/free and
   *  the data quality drops to "warn" at best. */
  hostCpu: number | null;
  /** max(0, hostCpu - sum(categories)) — the share of host CPU we couldn't
   *  attribute to any monitored category. Renders as the "Other" bar in
   *  the stacked breakdown. Zero when hostCpu is null. */
  other: number;
  /** max(0, 100 - hostCpu) — host idle. Zero when hostCpu is null.
   *  Replaces the legacy `free = 100 - sum(categories)` definition,
   *  which over-attributed CPU to "free" whenever cores normalisation
   *  was wrong. */
  free: number;
  /** Σ(categories) - hostCpu. Positive = monitored sums overshoot host
   *  CPU (the cpu_num bug). Negative = there's headroom for "Other".
   *  Null when hostCpu is null. */
  overshootPp: number | null;
  /** Quality classification — see SlotDataQuality. */
  dataQuality: SlotDataQuality;
}

/**
 * V2 of averageSlot: same category math, plus host CPU integration and a
 * data-quality classification. Routes use this for slots after 2026-05-20;
 * the legacy averageSlot is kept callable for any code still on the v1 path.
 *
 * `hostCpuValues` is the array of system.cpu.util samples that landed in
 * this slot. The route already collects them as `bucket.sysCpuValues` so
 * no new fetches are required — only a parameter change at the call site.
 *
 * `coresKnown=false` (cpu_num could not be resolved for this host) forces
 * dataQuality to at most "warn" even when the sums happen to look right —
 * the route is intentionally pessimistic when normalisation could not be
 * applied.
 */
export function averageSlotV2(
  b: SlotBucket,
  hostCpuValues: number[],
  coresKnown: boolean,
): SlotAveragesV2 {
  const avg = averageSlot(b);
  const hostCpu = hostCpuValues.length
    ? Math.round((hostCpuValues.reduce((acc, v) => acc + v, 0) / hostCpuValues.length) * 10) / 10
    : null;
  const sumNamed =
    avg.retellect + avg.scoApp + avg.db + avg.system +
    avg.besclient + avg.elastic + avg.osCore;

  let other = 0;
  let free = 0;
  let overshootPp: number | null = null;
  let dataQuality: SlotDataQuality = "warn";

  if (hostCpu === null) {
    // Without host CPU we can't tell whether sums make sense. Treat as warn.
    dataQuality = "warn";
  } else {
    other = Math.max(0, Math.round((hostCpu - sumNamed) * 100) / 100);
    // `free` is derived from what remains AFTER named + other so the stack
    // always sums to ~100 even when categories overshoot host CPU (the
    // cpu_num bug shape). In the happy path (sumNamed <= hostCpu), `other`
    // absorbs the gap and `free` collapses to 100 - hostCpu = idle. In the
    // overshoot path, `other` is clamped to 0 and `free` shrinks so the
    // visual stack stays within 100% — the warning banner above tells the
    // operator the values were not properly normalised.
    free = Math.max(0, Math.round((100 - sumNamed - other) * 100) / 100);
    overshootPp = Math.round((sumNamed - hostCpu) * 100) / 100;
    if (!coresKnown) {
      // We didn't normalise per_counter values — assume the worst.
      dataQuality = "warn";
    } else if (Math.abs(overshootPp) <= SLOT_TOLERANCE_PP.ok) {
      dataQuality = "ok";
    } else if (overshootPp <= SLOT_TOLERANCE_PP.warn) {
      // Negative overshoot or modest positive — still survivable.
      dataQuality = "warn";
    } else {
      dataQuality = "fail";
    }
  }

  return {
    categories: {
      retellect: avg.retellect,
      scoApp: avg.scoApp,
      db: avg.db,
      system: avg.system,
      besclient: avg.besclient,
      elastic: avg.elastic,
      osCore: avg.osCore,
    },
    hostCpu,
    other,
    free,
    overshootPp,
    dataQuality,
  };
}

/**
 * Convert a Zabbix raw value to "% of host" given the item's source kind.
 *
 * Defensive on `cores`: if it's NaN, <=0, or otherwise garbage we default to 1
 * so the value passes through unchanged rather than producing NaN. The route
 * already guards with `parseInt(... || "1") || 1` upstream, but the helper
 * shouldn't trust its caller.
 */
export function normaliseValue(raw: number, isPerfCounter: boolean, cores: number): number {
  if (!isPerfCounter) return raw;
  // Cores must be >=1 to make sense. Anything below (NaN, 0, negative,
  // fractional) is treated as 1 -> value passes through unchanged.
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
