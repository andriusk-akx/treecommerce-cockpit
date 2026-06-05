/**
 * GET /api/rt/process-history?hostId=...&days=1
 *
 * Returns per-hour CPU breakdown for one host across the requested window.
 * Categorizes Zabbix python*.cpu / spss.cpu / sql.cpu / vm.cpu items into
 * retellect / scoApp / db / system buckets and aggregates by hour.
 */
import { NextRequest, NextResponse } from "next/server";
import { getZabbixClient } from "@/lib/zabbix/client";
import { cached } from "@/lib/zabbix/cache";
import {
  chooseTelemetrySources,
  averageSlotV2,
  normaliseValue,
  summariseDay,
  findUnmonitoredCategories,
  type SparseCategory,
  type SlotDataQuality,
} from "./math";
import { resolveCoresForHost } from "@/lib/zabbix/cores";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * All slot keying + day-window math must run in Vilnius local time, NOT
 * the server's TZ (Railway containers default to UTC). Without this:
 *   - A sample at 14:30 Vilnius local lands in slot "11:30" UTC → the
 *     chart label "14:30" displays 17:30 EEST data, and infrequent
 *     items (BESClient samples every 5 min) show 0% in the slot the
 *     user expects them in.
 *   - `?date=2026-05-13` is interpreted as UTC midnight → fetches data
 *     for 03:00 EEST through 02:59 EEST next day, skipping the
 *     early-morning portion the user thinks is "their day".
 *
 * `instrumentation.ts` already pins process.env.TZ at boot, but V8
 * caches TZ on first Date call. This formatter is independent of
 * process state — it always speaks Europe/Vilnius regardless of what
 * the server thinks "local" is. Defense in depth.
 */
const VILNIUS_TZ = "Europe/Vilnius";
const vilniusParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: VILNIUS_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Format a Unix-ms instant as Vilnius {year, month, day, hour, minute}. */
function vilniusFields(ms: number): { yyyy: string; mm: string; dd: string; hh: string; mi: string } {
  const parts = vilniusParts.formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  // Intl returns hour "24" at midnight on some engines — normalise.
  const hh = get("hour") === "24" ? "00" : get("hour");
  return { yyyy: get("year"), mm: get("month"), dd: get("day"), hh, mi: get("minute") };
}

/**
 * Strict YYYY-MM-DD validator. The route used to gate the `date` param with
 * `/^\d{4}-\d{2}-\d{2}$/`, which accepted obviously broken inputs like
 * `9999-99-99` or `2026-13-32`. Those slipped through to `new Date(...)`,
 * which silently returned `Invalid Date`, propagated NaN through the
 * timeFrom / timeTill calculation, and ended up sending `time_from: "NaN"`
 * to Zabbix — the user just saw an empty drill-down with no hint that
 * their input was junk. This validator does a full month/day/leap-year
 * check via the round-trip identity `Date.toISOString().startsWith(input)`.
 */
function isValidYyyyMmDd(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

/** Vilnius local midnight on `yyyy-mm-dd` as a Unix-seconds instant. Honest
 *  about DST: uses Intl to discover the UTC offset Vilnius has at the
 *  beginning of that calendar day, then subtracts to get the true UTC
 *  instant for 00:00 local. */
function vilniusMidnightUnix(dateStr: string): number {
  // UTC midnight as a starting probe — Vilnius is +2 or +3 of UTC, so this
  // lands in the "previous evening" Vilnius-side. We read the offset back
  // off Intl rather than hard-coding DST rules.
  const probe = new Date(`${dateStr}T12:00:00Z`); // noon UTC, safely inside the right day
  // Format probe in Vilnius and parse offset from the result.
  const offsetFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: VILNIUS_TZ,
    timeZoneName: "shortOffset",
    hour: "2-digit",
    hour12: false,
  });
  const tzName = offsetFmt.formatToParts(probe).find((p) => p.type === "timeZoneName")?.value ?? "GMT+02";
  // tzName is e.g. "GMT+03" (summer) or "GMT+02" (winter). Parse the digits.
  const m = tzName.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  const sign = m && m[1] === "-" ? -1 : 1;
  const hours = m ? parseInt(m[2], 10) : 2;
  const mins = m && m[3] ? parseInt(m[3], 10) : 0;
  const offsetSec = sign * (hours * 3600 + mins * 60);
  // Vilnius midnight in UTC = `dateStr` 00:00 UTC minus the Vilnius offset.
  const utcMidnightSec = Math.floor(new Date(`${dateStr}T00:00:00Z`).getTime() / 1000);
  return utcMidnightSec - offsetSec;
}

interface HourlyBucket {
  retellect: number;
  scoApp: number;
  db: number;
  system: number;
  besclient: number;
  elastic: number;
  /** osCore is normally fed from `system.cpu.util[,system]` (kernel-mode CPU
   *  at host scope) rather than from a named process. The route accumulates
   *  it into the same bucket so all 7 categories average through a single
   *  `averageSlot()` call. */
  osCore: number;
  // Per-category sample counts. Categories are averaged independently because
  // items inside a slot can fire at slightly different timestamps (e.g. spss
  // at 18:23:09, sql at 18:23:10) — using a shared "unique timestamps" divisor
  // would deflate every category by the number of fellow categories present,
  // so a single 25% spss reading shows up as ~6%.
  countR: number;
  countS: number;
  countD: number;
  countSys: number;
  countBes: number;
  countEla: number;
  countOs: number;
  // system.cpu.util[,,avg1] samples in this slot — kept separate so we can
  // surface the "true" overall CPU as a reference line in the UI alongside
  // the per-process breakdown (which only counts monitored processes).
  sysCpuValues: number[];
}

function emptyBucket(): HourlyBucket {
  return {
    retellect: 0, scoApp: 0, db: 0, system: 0,
    besclient: 0, elastic: 0, osCore: 0,
    countR: 0, countS: 0, countD: 0, countSys: 0,
    countBes: 0, countEla: 0, countOs: 0,
    sysCpuValues: [],
  };
}

export async function GET(req: NextRequest) {
  const hostId = req.nextUrl.searchParams.get("hostId");
  // Zabbix display name passed alongside hostId so `resolveCoresForHost`
  // can find the Device row (sourceHostKey stores the display name, not
  // the numeric id). Optional for backward compat — older clients that
  // forgot to pass it just get the coresKnown=false fallback.
  const hostName = req.nextUrl.searchParams.get("hostName") ?? undefined;
  // Robust numeric query-param parsing — `parseInt("abc") === NaN` and the
  // older `Math.max(1, Math.min(60, NaN))` propagated NaN straight through to
  // `time_from`/granularity bucket keys, so any garbage `?days=foo` /
  // `?granularity=foo` produced an opaque Zabbix RPC error or empty drill-
  // down without telling the caller the input was the problem. We now coerce
  // explicitly and 400 on out-of-range so the failure is loud and local.
  const parseBoundedInt = (raw: string | null, fallback: number, min: number, max: number): number => {
    if (raw === null) return fallback;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return fallback;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  };
  const days = parseBoundedInt(req.nextUrl.searchParams.get("days"), 1, 1, 365);
  const granularityMin = parseBoundedInt(req.nextUrl.searchParams.get("granularity"), 60, 1, 60);
  if (!hostId) return NextResponse.json({ error: "hostId required" }, { status: 400 });

  const client = getZabbixClient();
  // Per-host process CPU items + system.cpu.util[,,avg1] (overall host CPU)
  // + system.cpu.num (cores). Cached per-host for 60s — item lists for a host
  // change only when SP redeploys the template, far less often than the user
  // clicks drill-down on different days.
  // `value_type` + `name` added 2026-06-05 for transaction-overlay detection:
  // value_type picks the correct history.get store (0=float, 3=unsigned) for
  // the txn counter, and name widens pattern matching beyond the raw key_.
  // Cache key bumped to v2 so a stale v1 entry (missing the new fields) can't
  // suppress detection for up to the TTL window right after deploy.
  type ZItem = { itemid: string; key_: string; lastvalue: string; value_type?: string; name?: string };
  const allItems = (await cached(
    `zabbix:procHistItems2:${hostId}`,
    () => client.request("item.get", {
      output: ["itemid", "key_", "lastvalue", "value_type", "name"],
      hostids: [hostId],
      // Filter ONLY by status (item not administratively disabled).
      // Do NOT filter by state — `state: 0` would exclude items that are
      // currently ZBX_NOTSUPPORTED but still hold valid history from when
      // they were healthy. Drill-down is a HISTORICAL query: e.g. SC02
      // Pavilnionys' perf_counter[\Process(python#1)] is state=1 today,
      // yet the API has 850 samples >1% on Apr 26 — filtering by current
      // state hides those samples and makes the day-drill render 0%
      // Retellect even though Retellect was running heavily that day.
      filter: { status: 0 },
    }) as Promise<ZItem[]>,
    60_000,
  )) as ZItem[];

  // ── Transaction-start overlay detection (2026-06-05) ───────────────────
  // SP admin began publishing a per-SCO transaction-start counter on every
  // monitored kasa (90-day retention). Its exact key is not yet uniform
  // across the fleet, so we AUTO-DETECT it: match transaction-ish tokens in
  // key_ or name and hard-exclude CPU / resource items so an unrelated
  // counter can never be mistaken for transactions. Only numeric items
  // (float / unsigned) are eligible because we bucket the values. The chosen
  // item's key + detected semantics are echoed back in the response so the
  // operator can confirm the match in the UI.
  const TXN_INCLUDE = /tranzak|transact|\btxn\b|\btrans\b|receipt|checkout|\bsale[s]?\b|\bbasket\b/i;
  const TXN_EXCLUDE = /cpu|processor|perf_counter|memory|\bmem\b|disk|net\.|swap|uptime|version|config|agent|ping|temp|fan|power|voltage|boot|proc\.num/i;
  const txnItem =
    allItems
      .filter((it) => {
        const hay = `${it.key_} ${it.name ?? ""}`;
        if (TXN_EXCLUDE.test(hay)) return false;
        if (!TXN_INCLUDE.test(hay)) return false;
        const vt = Number(it.value_type);
        // 0=float, 3=unsigned int (numeric counters), 2=log. SP's fleet
        // publishes transaction starts as a Zabbix LOG item that captures one
        // `StartTransaction` line per customer transaction
        // (`log[E:\logs\spsss\pos.log,StartTransaction,,,all]`), so each log
        // record == one transaction and we count records rather than read a
        // numeric value.
        return vt === 0 || vt === 2 || vt === 3;
      })
      .sort((a, b) => {
        const score = (it: ZItem) => {
          const hay = `${it.key_} ${it.name ?? ""}`.toLowerCase();
          let s = 0;
          if (/tranzak|transact|\btxn\b/.test(hay)) s += 3;
          if (/start/.test(hay)) s += 2;
          if (/count|cnt|total|\bnum\b/.test(hay)) s += 1;
          return s;
        };
        return score(b) - score(a); // highest score first
      })[0] ?? null;

  // Two parallel telemetry sources for per-process CPU on the same host:
  //   *.cpu items  → 1-min sliding average, "% of host" (already normalised)
  //   perf_counter[\Process(<name>)\% Processor Time]
  //                → instantaneous, "% of one core" (needs / cores)
  // The perf_counter family captures spikes the *.cpu averages smooth out,
  // so we treat it as primary and use *.cpu only as a fallback when the
  // host doesn't publish a perf_counter for that process.
  const sysCpuItem = allItems.find(
    (it) => it.key_ === "system.cpu.util[,,avg1]" || it.key_ === "system.cpu.util"
  );
  // Windows kernel-mode CPU (host scope). 2026-05-12: SP admin deployed
  // this item on testlab_SPUB-P-SCO150 so the previously-anonymous "Other"
  // bucket can be split into BESClient / Elastic / Windows OS core. Hosts
  // without this item simply have osCore = 0 and the residual stays in
  // "free" / Other as before.
  // Two acceptable kernel-CPU sources on this fleet:
  //   1. system.cpu.util[,system,*]  — host-scope kernel %, already normalised.
  //      The "clean" item SP admin added on testlab 2026-05-15 with the key
  //      `system.cpu.util[,system,avg1]`. The avg-window parameter varies
  //      (avg1 / avg5 / avg15) so we match the family rather than a single
  //      exact string — pre-2026-05-15 a strict `system.cpu.util[,system]`
  //      check silently fell back to (2) even when the host-scope item was
  //      live.
  //   2. perf_counter[\Process(System)\...]  — Windows PID 4 "System" process,
  //      which IS the kernel work surfaced as a process counter. Returns
  //      "% of one core", so needs /cores division on the route side. SP
  //      admin's earlier May-8 deploy used this form; we keep it as the
  //      fallback so hosts that don't yet have the host-scope item still
  //      get an OS Core breakdown.
  //
  // Prefer (1) when both exist — cleaner semantics, no cores math.
  const sysKernelHostItem = allItems.find((it) => /^system\.cpu\.util\[,system(,|\])/.test(it.key_));
  const sysKernelProcItem = !sysKernelHostItem
    ? allItems.find((it) => /^perf_counter\["?\\Process\(System\)\\% Processor Time/.test(it.key_))
    : null;
  const sysKernelItem = sysKernelHostItem ?? sysKernelProcItem;
  // Both kernel-time sources turn out to need /cores division on this
  // fleet:
  //   • `perf_counter[\Process(System)\…]` is documented "% of one core"
  //     and always needed /cores — that branch was already correct.
  //   • `system.cpu.util[,system,avg1]` was originally assumed to be
  //     host-scope ("already normalised") based on Zabbix's Linux
  //     behaviour. Empirically on Windows SP-managed agents (verified on
  //     StrongPoint Testlab SCO0150 2026-05-26 — Andrius), this item
  //     returns per-core values that scale 0..(100·cores). Drill-down
  //     stacks showed OS Core ≈ 37–48 % when host CPU was 33–35 % on a
  //     4-core box — divide-by-cores brings OS Core to ~9–12 % which
  //     fits inside host CPU and matches the User+Kernel ≤ host invariant.
  //
  // Keeping the two-source branching (host-scope item preferred) because
  // the perf_counter form is the older fallback and we still want to
  // pick the "clean" item when both exist — the cores division just
  // applies unconditionally now.
  const sysKernelNeedsCoresDiv = !!sysKernelItem;
  const numCpuItem = allItems.find((it) => it.key_ === "system.cpu.num");
  // Resolve cpu_num via the layered helper (live Zabbix -> cached Device.cpuCores
  // -> inferred from CPU model -> coresKnown=false). The old code silently
  // defaulted to cores=1 here, which left perf_counter values un-normalised on
  // hosts whose Zabbix agent doesn't publish system.cpu.num. The result was
  // stacked bars summing past 100% on the drill-down (e.g. SCO App 87% + DB 36%
  // on a host with peak CPU 85%). See AKpilot-CPU-Normalization-Spec.md.
  const coresResolved = await resolveCoresForHost({
    hostId,
    hostName,
    zabbixItem: numCpuItem,
    prisma,
  });
  const cores = coresResolved.value;
  const coresKnown = coresResolved.coresKnown;

  // Pure helper computes the chosen item set: perf_counter wins per process,
  // *.cpu fills the gap for processes without a perf_counter equivalent.
  const { categoryById, needsCoresDivision } = chooseTelemetrySources(
    allItems.map((it) => ({ itemid: it.itemid, key_: it.key_ })),
  );

  if (categoryById.size === 0) {
    return NextResponse.json({ slots: [], hasSysCpu: !!sysCpuItem });
  }

  // Date range: if `date` (YYYY-MM-DD) is given, fetch 00:00 → 23:59:59 of that
  // calendar day; otherwise fall back to last `days` days (default 1 day).
  const itemIds = Array.from(categoryById.keys());
  if (itemIds.length === 0) return NextResponse.json({ slots: [], hasSysCpu: !!sysCpuItem });
  const dateStr = req.nextUrl.searchParams.get("date"); // YYYY-MM-DD
  let timeFrom: number;
  let timeTill: number;
  if (dateStr && isValidYyyyMmDd(dateStr)) {
    // Parse as Vilnius-local midnight, independent of server timezone.
    // Railway containers run in UTC; using `new Date(...T00:00:00)` would
    // capture UTC midnight there and skip the user's actual early morning.
    timeFrom = vilniusMidnightUnix(dateStr);
    timeTill = timeFrom + 86400 - 1;
  } else {
    const now = Math.floor(Date.now() / 1000);
    timeFrom = now - days * 86400;
    timeTill = now;
  }

  const buckets = new Map<string, HourlyBucket>();
  // Fetch process batches AND the sysCpu reference series in parallel.
  // Previously each batch waited for the previous one to resolve, plus
  // sysCpu was a separate sequential call after the loop — so a host with
  // 20 items + sysCpu took 3 round-trips serially (~600 ms). Batching them
  // via Promise.all reduces this to a single round-trip wall time.
  const batchPromises: Promise<Array<{ itemid: string; clock: string; value: string }>>[] = [];
  for (let i = 0; i < itemIds.length; i += 20) {
    const batch = itemIds.slice(i, i + 20);
    batchPromises.push(
      client.request("history.get", {
        output: ["itemid", "clock", "value"],
        itemids: batch,
        history: 0,
        time_from: String(timeFrom),
        time_till: String(timeTill),
        sortfield: "clock",
        sortorder: "ASC",
        limit: 50000,
      }) as Promise<Array<{ itemid: string; clock: string; value: string }>>
    );
  }
  // System CPU reference fetched in parallel with process fetches.
  const sysCpuPromise: Promise<Array<{ clock: string; value: string }>> | null = sysCpuItem
    ? (client.request("history.get", {
        output: ["itemid", "clock", "value"],
        itemids: [sysCpuItem.itemid],
        history: 0,
        time_from: String(timeFrom),
        time_till: String(timeTill),
        sortfield: "clock",
        sortorder: "ASC",
        limit: 50000,
      }) as Promise<Array<{ clock: string; value: string }>>)
    : null;
  // Kernel-mode CPU fetched in parallel — fills the osCore bucket. Hosts
  // that don't publish this item simply skip the merge step and osCore stays 0.
  const sysKernelPromise: Promise<Array<{ clock: string; value: string }>> | null = sysKernelItem
    ? (client.request("history.get", {
        output: ["itemid", "clock", "value"],
        itemids: [sysKernelItem.itemid],
        history: 0,
        time_from: String(timeFrom),
        time_till: String(timeTill),
        sortfield: "clock",
        sortorder: "ASC",
        limit: 50000,
      }) as Promise<Array<{ clock: string; value: string }>>)
    : null;
  // Transaction-start counter fetched in parallel. Uses the item's own
  // value_type for the history store (counters are usually unsigned = 3,
  // not float = 0), otherwise history.get returns an empty set.
  const txnIsLog = txnItem ? Number(txnItem.value_type) === 2 : false;
  const txnHistoryType = txnItem ? (Number(txnItem.value_type) === 3 ? 3 : Number(txnItem.value_type) === 2 ? 2 : 0) : 0;
  const txnPromise: Promise<Array<{ clock: string; value: string }>> | null = txnItem
    ? (client.request("history.get", {
        // Log items: we only need the timestamp (one record = one transaction);
        // numeric items: we need the value to delta/sum.
        output: txnIsLog ? ["clock"] : ["clock", "value"],
        itemids: [txnItem.itemid],
        history: txnHistoryType,
        time_from: String(timeFrom),
        time_till: String(timeTill),
        sortfield: "clock",
        sortorder: "ASC",
        limit: 50000,
      }) as Promise<Array<{ clock: string; value: string }>>)
    : null;

  const batchResults = await Promise.all(batchPromises.map((p) => p.catch((e) => {
    console.warn("[rt-process-history] batch failed:", e);
    return [] as Array<{ itemid: string; clock: string; value: string }>;
  })));
  for (const records of batchResults) {
    {
      for (const r of records) {
        const cat = categoryById.get(r.itemid);
        if (!cat) continue;
        // Slot key in Vilnius local time — guarantees the heatmap label
        // "14:30" carries the Vilnius 14:30 sample regardless of server TZ.
        const { yyyy, mm, dd, hh, mi } = vilniusFields(parseInt(r.clock) * 1000);
        const minBucket = Math.floor(parseInt(mi, 10) / granularityMin) * granularityMin;
        const mmm = String(minBucket).padStart(2, "0");
        const slotKey = `${yyyy}-${mm}-${dd}T${hh}:${mmm}`;
        let b = buckets.get(slotKey);
        if (!b) {
          b = emptyBucket();
          buckets.set(slotKey, b);
        }
        // perf_counter values are "% of one core" — convert to "% of host".
        // *.cpu values are already in host units; pass through.
        const raw = parseFloat(r.value) || 0;
        const v = normaliseValue(raw, needsCoresDivision.has(r.itemid), cores);
        b[cat] += v;
        if (cat === "retellect") b.countR++;
        else if (cat === "scoApp") b.countS++;
        else if (cat === "db") b.countD++;
        else if (cat === "system") b.countSys++;
        else if (cat === "besclient") b.countBes++;
        else if (cat === "elastic") b.countEla++;
        else if (cat === "osCore") b.countOs++;
      }
    }
  }

  // Process the sysCpu series fetched in parallel above (no extra round trip).
  type SysSample = { clock: number; value: number };
  const sysAllSamples: SysSample[] = [];
  if (sysCpuPromise) {
    try {
      const sysRecords = await sysCpuPromise;
      for (const r of sysRecords) {
        const tsSec = parseInt(r.clock);
        const value = parseFloat(r.value) || 0;
        sysAllSamples.push({ clock: tsSec, value });
        const { yyyy, mm, dd, hh, mi } = vilniusFields(tsSec * 1000);
        const minBucket = Math.floor(parseInt(mi, 10) / granularityMin) * granularityMin;
        const mmm = String(minBucket).padStart(2, "0");
        const slotKey = `${yyyy}-${mm}-${dd}T${hh}:${mmm}`;
        let b = buckets.get(slotKey);
        if (!b) {
          b = emptyBucket();
          buckets.set(slotKey, b);
        }
        b.sysCpuValues.push(value);
      }
    } catch (e) {
      console.warn("[rt-process-history] system.cpu.util fetch failed:", e);
    }
  }

  // Kernel-mode CPU → osCore bucket. Same slot-key calc as above; we
  // intentionally don't sample-count this against perf_counter items
  // (countOs) using the per-item path because the kernel series is host-
  // scoped and has its own cadence.
  if (sysKernelPromise) {
    try {
      const kernelRecords = await sysKernelPromise;
      for (const r of kernelRecords) {
        const tsSec = parseInt(r.clock);
        const raw = parseFloat(r.value) || 0;
        const { yyyy, mm, dd, hh, mi } = vilniusFields(tsSec * 1000);
        const minBucket = Math.floor(parseInt(mi, 10) / granularityMin) * granularityMin;
        const mmm = String(minBucket).padStart(2, "0");
        const slotKey = `${yyyy}-${mm}-${dd}T${hh}:${mmm}`;
        let b = buckets.get(slotKey);
        if (!b) {
          b = emptyBucket();
          buckets.set(slotKey, b);
        }
        // system.cpu.util[,system] is already "% of host" (no cores division).
        // perf_counter[\Process(System)\…] is "% of one core" → /cores.
        // sysKernelNeedsCoresDiv was set above when we chose the source item.
        const v = sysKernelNeedsCoresDiv ? raw / Math.max(1, cores) : raw;
        b.osCore += v;
        b.countOs++;
      }
    } catch (e) {
      console.warn("[rt-process-history] system.cpu.util[,system] fetch failed:", e);
    }
  }

  // ── Transaction overlay: bucket samples into per-slot counts. ──────────
  // Semantics are auto-detected from the data shape (SP admin's fleet keys
  // aren't uniform yet): a cumulative counter is (almost) monotonically
  // non-decreasing across the day → use consecutive deltas; anything else is
  // treated as a per-poll count → sum the samples. Both paths attribute the
  // resulting count to the Vilnius-local slot of the sample, matching the CPU
  // slot keys exactly so the overlay aligns minute-for-minute with the line.
  const txnSlotCounts = new Map<string, number>();
  let txnSemantics: "event" | "counter" | "count" | "none" = "none";
  let txnTotal = 0;
  if (txnPromise) {
    try {
      const txnRecords = await txnPromise;
      const addToSlot = (clockSec: number, n: number) => {
        if (!(n > 0)) return;
        const { yyyy, mm, dd, hh, mi } = vilniusFields(clockSec * 1000);
        const minBucket = Math.floor(parseInt(mi, 10) / granularityMin) * granularityMin;
        const slotKey = `${yyyy}-${mm}-${dd}T${hh}:${String(minBucket).padStart(2, "0")}`;
        txnSlotCounts.set(slotKey, (txnSlotCounts.get(slotKey) ?? 0) + n);
        txnTotal += n;
      };
      if (txnIsLog) {
        // Log item: each record is one `StartTransaction` line = one
        // transaction. Count records per slot — no value parsing.
        txnSemantics = "event";
        for (const r of txnRecords) {
          const clock = parseInt(r.clock, 10);
          if (Number.isFinite(clock)) addToSlot(clock, 1);
        }
      } else {
        // Numeric item: auto-detect counter (deltas) vs per-poll count (sum).
        const samples = txnRecords
          .map((r) => ({ clock: parseInt(r.clock, 10), value: parseFloat(r.value) }))
          .filter((s) => Number.isFinite(s.clock) && Number.isFinite(s.value))
          .sort((a, b) => a.clock - b.clock);
        if (samples.length >= 2) {
          let nonDec = 0;
          for (let i = 1; i < samples.length; i++) {
            if (samples[i].value >= samples[i - 1].value) nonDec++;
          }
          txnSemantics = nonDec / (samples.length - 1) >= 0.85 ? "counter" : "count";
        } else if (samples.length === 1) {
          txnSemantics = "count";
        }
        if (txnSemantics === "counter") {
          for (let i = 1; i < samples.length; i++) {
            let delta = samples[i].value - samples[i - 1].value;
            // Counter reset (service restart / rollover): the post-reset sample
            // is the count since reset — clamp negative deltas to 0 so a restart
            // never paints a fake spike or a negative band.
            if (delta < 0) delta = 0;
            addToSlot(samples[i].clock, delta);
          }
        } else if (txnSemantics === "count") {
          for (const s of samples) addToSlot(s.clock, s.value);
        }
      }
    } catch (e) {
      console.warn("[rt-process-history] transaction item fetch failed:", e);
      txnSemantics = "none";
    }
  }

  // Build a top-level day summary directly from the raw 1-min samples — gives
  // the user an exact answer to "when did the 100% spike happen, how long did
  // it last, how many minutes were above each threshold". This is independent
  // of the slot/granularity choice for the chart.
  const daySummaryBase = summariseDay(sysAllSamples);
  const daySummary: (typeof daySummaryBase & {
    maxLabel: string;
    raw: Array<{ clock: number; value: number }>;
  }) | null = daySummaryBase
    ? {
        ...daySummaryBase,
        maxLabel: new Date(daySummaryBase.maxAtClock * 1000).toLocaleTimeString("lt-LT", {
          timeZone: "Europe/Vilnius",
          hour12: false,
        }),
        raw: sysAllSamples.map((s) => ({ clock: s.clock, value: Math.round(s.value * 10) / 10 })),
      }
    : null;

  // Emit slots for the entire calendar day at the requested granularity.
  // 60min → 24 slots, 15min → 96 slots, 5min → 288 slots, etc.
  const slotsPerDay = Math.floor(1440 / granularityMin);
  const slots: Array<{
    slot: number;
    hourKey: string;
    hour: number;
    minute: number;
    label: string;
    retellect: number;
    scoApp: number;
    db: number;
    system: number;
    besclient: number;
    elastic: number;
    osCore: number;
    free: number;
    /** Unattributed host CPU share = max(0, hostCpu - Sum(named)). Rendered
     *  as a distinct "Other" stack segment so the chart visually adds up
     *  to host CPU even when monitored categories don't cover every
     *  process. Zero when hostCpu is null. */
    other: number;
    /** Average system.cpu.util for this slot's time window, or null when no
     *  samples landed in the slot. Replaces the legacy `free = 100 - Sum`
     *  approach with a true host-CPU-vs-attributed comparison. */
    hostCpu: number | null;
    /** Sum(named) - hostCpu in percentage points. Positive = monitored sums
     *  overshoot host CPU (typically a cpu_num normalisation problem).
     *  Null when hostCpu is null. */
    overshootPp: number | null;
    /** Slot sanity classification. "ok" within tolerance, "warn" mild or
     *  cores unknown, "fail" large overshoot (almost always a cpu_num
     *  problem). Drives the per-slot badge on the drill-down. */
    dataQuality: SlotDataQuality;
    sysCpuAvg: number | null;
    sysCpuMax: number | null;
    /** Transaction count attributed to this 1-min slot, or null when the host
     *  publishes no transaction item. Client buckets these into 15-min for the
     *  load overlay; the raw per-slot value drives the tooltip. */
    txn: number | null;
  }> = [];
  let baseDay: string;
  if (dateStr && isValidYyyyMmDd(dateStr)) {
    baseDay = dateStr;
  } else {
    // Anchor baseDay to the Vilnius calendar day, not server-local, so the
    // slot keys built below match the keys we wrote into `buckets` above.
    const { yyyy, mm, dd } = vilniusFields(timeFrom * 1000);
    baseDay = `${yyyy}-${mm}-${dd}`;
  }
  /**
   * Forward-fill window for sparse-cadence categories.
   *
   * SP admin's BESClient / Elastic / Process(System) items poll every ~5 min
   * (verified via Zabbix sample timestamps 2026-05-13). Most 1-min slots
   * therefore have NO sample for those items and the per-slot bar collapses
   * to 0% — making the user believe "monitoring is broken" when in reality
   * the previous and following minutes both carry valid readings.
   *
   * Fix: while emitting the per-slot output, remember the last non-zero
   * value seen for each sparse category and re-use it for up to
   * FILL_WINDOW_MIN minutes after the sample. SCO App / DB / System / etc.
   * are sampled every minute, so they're never carried — only the three
   * newly-deployed perf_counter items get filled.
   *
   * 6 min covers the typical 5-min poll cadence with one-minute slack for
   * agent drift. Longer gaps (item misconfigured / agent dropped) still
   * render as a real 0% so genuine outages are visible.
   *
   * Forward-fill is intentionally not applied to `free` directly — we
   * recompute it from the filled-in named buckets below so the residual
   * stays consistent with what the user sees in the bars.
   */
  const FILL_WINDOW_MIN = 6;
  const FILL_MAX_SLOTS = Math.max(1, Math.ceil(FILL_WINDOW_MIN / granularityMin));
  const SPARSE_KEYS = ["besclient", "elastic", "osCore"] as const;
  type SparseKey = (typeof SPARSE_KEYS)[number];
  const lastSeen: Record<SparseKey, { value: number; atSlot: number } | null> = {
    besclient: null,
    elastic: null,
    osCore: null,
  };

  for (let i = 0; i < slotsPerDay; i++) {
    const totalMin = i * granularityMin;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    const slotKey = `${baseDay}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    const b = buckets.get(slotKey);
    // Average each category sum by the number of unique timestamps observed in
    // the slot. Each timestamp contributes one "category total" (sum of all
    // items in that category at that instant); averaging across timestamps
    // gives the slot's mean category usage.
    //
    // Note: per-process Zabbix values (python.cpu, spss.cpu, sql.cpu, vm.cpu)
    // are emitted by the StrongPoint agent in **% of total host CPU**, not
    // "% of one core". Verified via probe: SCO2 hour 18 sum = 23% raw vs
    // system.cpu.util = 27%. So we do NOT divide by core count.
    // Each category averages over its own sample count. If a category has no
    // samples in the slot we treat it as 0 (rather than dividing by 1, which
    // would inflate transient spikes). Items inside a category that fire at
    // separate timestamps inside one slot still average correctly because
    // their per-item contributions all land in the same accumulator.
    // averageSlotV2 produces both the per-category numbers (same math as the
    // legacy averageSlot) AND the host-CPU-aware fields: `hostCpu`, `other`,
    // `free`, `overshootPp`, `dataQuality`. The route surfaces all of these
    // so the UI can show a warning whenever monitored sums exceed host CPU
    // by more than the spec's tolerance (5pp "ok", 15pp "warn", above that
    // "fail"). Without averageSlotV2 we'd reproduce the legacy bug where
    // `free = 100 - Σnamed` masked cpu_num normalisation problems by
    // visually filling the rest with idle.
    const slotV2 = b
      ? averageSlotV2(
          {
            retellect: b.retellect,
            scoApp: b.scoApp,
            db: b.db,
            system: b.system,
            besclient: b.besclient,
            elastic: b.elastic,
            osCore: b.osCore,
            countR: b.countR,
            countS: b.countS,
            countD: b.countD,
            countSys: b.countSys,
            countBes: b.countBes,
            countEla: b.countEla,
            countOs: b.countOs,
          },
          b.sysCpuValues,
          coresKnown,
        )
      : {
          categories: {
            retellect: 0, scoApp: 0, db: 0, system: 0,
            besclient: 0, elastic: 0, osCore: 0,
          },
          hostCpu: null,
          other: 0,
          free: 100,
          overshootPp: null,
          dataQuality: "warn" as SlotDataQuality,
        };
    const avg = {
      ...slotV2.categories,
      free: slotV2.free,
    };
    const { retellect: r, scoApp: sa, db: dbv, system: sys } = avg;
    // Sparse-cadence forward-fill: for besclient / elastic / osCore, if this
    // slot has no real reading (0 from averageSlot) but a recent slot had one
    // within FILL_MAX_SLOTS, carry the value forward. Otherwise keep 0.
    const filled: Record<SparseKey, number> = { besclient: 0, elastic: 0, osCore: 0 };
    for (const k of SPARSE_KEYS) {
      const v = avg[k];
      if (v > 0) {
        filled[k] = v;
        lastSeen[k] = { value: v, atSlot: i };
      } else {
        const seen = lastSeen[k];
        filled[k] = seen && i - seen.atSlot <= FILL_MAX_SLOTS ? seen.value : 0;
      }
    }
    // `os` is reassigned below by the post-fill re-clamp; `bes` and `ela`
    // are read-only after destructure — split so ESLint's prefer-const
    // (destructuring: "any") doesn't fail CI.
    const { besclient: bes, elastic: ela } = filled;
    let { osCore: os } = filled;
    // ── Post-fill OS Core re-clamp.
    //
    // averageSlotV2 clamps OS Core per slot so Σnamed ≤ hostCpu. But the
    // forward-fill above can pump OS Core back UP using a value carried
    // over from a recent slot where hostCpu was higher (e.g. previous
    // minute hostCpu=60 → osCore clamped to 25; this minute hostCpu=37 →
    // no osCore sample → fill imports 25 from prior). When that happens
    // the slot's final Σnamed once again overshoots hostCpu by exactly
    // the carry-over.
    //
    // Re-clamp os against THIS slot's recomputedHostCpu and the freshly
    // forward-filled non-osCore sum. The other sparse keys (besclient,
    // elastic) are kept as-is — they're small relative to hostCpu and
    // are first-class attributions like the dense process counters.
    const recomputedHostCpu = slotV2.hostCpu;
    if (recomputedHostCpu !== null && coresKnown) {
      const sumOtherThanOsCore = r + sa + dbv + sys + bes + ela;
      const allowedOs = Math.max(0, Math.round((recomputedHostCpu - sumOtherThanOsCore) * 100) / 100);
      if (os > allowedOs) os = allowedOs;
    }
    // Recompute Other / Free / dataQuality using the post-fill, post-clamp
    // category values. Forward-fill can lift besclient/elastic/osCore from
    // 0 to a recently-seen value; without re-running the math, slotV2.other
    // and slotV2.free still reflect the pre-fill snapshot, breaking the
    // Σ+Other+Free=100 invariant by exactly the fill delta. We keep the
    // dataQuality classification from slotV2 if it was already worse
    // ("warn"/"fail"); the fill itself can't push a slot from ok to fail.
    const filledSum = r + sa + dbv + sys + bes + ela + os;
    let recomputedOther = slotV2.other;
    let recomputedFree = slotV2.free;
    let recomputedOvershoot = slotV2.overshootPp;
    if (recomputedHostCpu !== null) {
      recomputedOther = Math.max(0, Math.round((recomputedHostCpu - filledSum) * 100) / 100);
      recomputedFree = Math.max(0, Math.round((100 - filledSum - recomputedOther) * 100) / 100);
      recomputedOvershoot = Math.round((filledSum - recomputedHostCpu) * 100) / 100;
    }
    const sysCpuVals = b?.sysCpuValues ?? [];
    const sysCpuAvg = sysCpuVals.length
      ? Math.round((sysCpuVals.reduce((acc, v) => acc + v, 0) / sysCpuVals.length) * 10) / 10
      : null;
    const sysCpuMax = sysCpuVals.length
      ? Math.round(Math.max(...sysCpuVals) * 10) / 10
      : null;
    slots.push({
      slot: i,
      hourKey: slotKey,
      hour: h,
      minute: m,
      label: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
      retellect: r,
      scoApp: sa,
      db: dbv,
      system: sys,
      besclient: bes,
      elastic: ela,
      osCore: os,
      // `free` stays as the host-CPU-derived idle from V2 (or 100 when no
      // hostCpu data exists). `other` is the unattributed slice of host CPU
      // = max(0, hostCpu - Σnamed) and goes into a new "Other" stack segment
      // in the drill-down. dataQuality drives the slot's sanity badge.
      free: recomputedFree,
      other: recomputedOther,
      hostCpu: recomputedHostCpu,
      overshootPp: recomputedOvershoot,
      dataQuality: slotV2.dataQuality,
      sysCpuAvg,
      sysCpuMax,
      txn: txnItem ? Math.round(txnSlotCounts.get(slotKey) ?? 0) : null,
    });
  }
  // Day-level unmonitored categories: items that were never published on this
  // host across the requested window. Computed AFTER all batch + kernel fetches
  // and BEFORE any forward-fill — forward-fill only affects display per slot
  // when the cadence is sparse, but a truly absent item has zero samples all
  // day. The UI uses this to hide deceptive "0%" rows in the drill-down and
  // fold the would-be residual into Other with an explanatory sub-label.
  // See `feedback` notes (2026-05-19) and project_rt_category_split memory.
  let totalBes = 0;
  let totalEla = 0;
  let totalOs = 0;
  for (const [, b] of buckets) {
    totalBes += b.countBes;
    totalEla += b.countEla;
    totalOs += b.countOs;
  }
  const unmonitored: SparseCategory[] = findUnmonitoredCategories({
    besclient: totalBes,
    elastic: totalEla,
    osCore: totalOs,
  });

  // Day-level sanity rollup: counts of slots in each dataQuality bucket so the
  // UI can render a single dot per day in the heatmap header without iterating
  // the slot array on every render. `coresKnown` propagates so the timeline
  // row's cpu_num badge can show "?c" with a tooltip when normalisation could
  // not be applied for this host.
  let okCount = 0;
  let warnCount = 0;
  let failCount = 0;
  for (const s of slots) {
    const dq = (s as { dataQuality?: SlotDataQuality }).dataQuality;
    if (dq === "ok") okCount += 1;
    else if (dq === "warn") warnCount += 1;
    else if (dq === "fail") failCount += 1;
  }
  // Day-level "fail" must reflect a sustained inconsistency, not a single
  // noisy slot. Per-minute slots routinely show transient Σnamed > host CPU
  // overshoots because `system.cpu.util` and the per-process counters land
  // at slightly different timestamps within the same minute — that's
  // sampling alignment noise, not a normalisation bug. Threshold for
  // promoting to "fail": at least 5 failed slots AND > 1% of the day's
  // slots (≈ 14 of 1440 at 1-min granularity). Below that, the day is
  // demoted to "warn" so the operator still gets a soft signal in the
  // drill-down banner without the red alarm + "fix this now" tone of the
  // "fail" banner.
  const totalSlots = okCount + warnCount + failCount;
  const failIsSustained =
    failCount >= 5 && failCount / Math.max(1, totalSlots) > 0.01;
  const dayDataQuality: SlotDataQuality =
    failIsSustained
      ? "fail"
      : failCount > 0 || warnCount > okCount
        ? "warn"
        : "ok";

  return NextResponse.json({
    slots,
    hasSysCpu: !!sysCpuItem,
    hasOsCore: !!sysKernelItem,
    unmonitored,
    daySummary,
    cores,
    coresKnown,
    coresSource: coresResolved.source,
    dataQuality: {
      day: dayDataQuality,
      ok: okCount,
      warn: warnCount,
      fail: failCount,
    },
    // Transaction overlay provenance — lets the UI show which Zabbix item was
    // auto-matched and how its values were interpreted, so the operator can
    // confirm (or flag) the detection. Null when the host has no txn item.
    txnMeta: txnItem
      ? { key: txnItem.key_, name: txnItem.name ?? null, semantics: txnSemantics, total: Math.round(txnTotal) }
      : null,
  });
}
