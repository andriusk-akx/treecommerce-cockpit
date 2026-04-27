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
  averageSlot,
  normaliseValue,
  summariseDay,
} from "./math";

export const dynamic = "force-dynamic";

interface HourlyBucket {
  retellect: number;
  scoApp: number;
  db: number;
  system: number;
  // Per-category sample counts. Categories are averaged independently because
  // items inside a slot can fire at slightly different timestamps (e.g. spss
  // at 18:23:09, sql at 18:23:10) — using a shared "unique timestamps" divisor
  // would deflate every category by the number of fellow categories present,
  // so a single 25% spss reading shows up as ~6%.
  countR: number;
  countS: number;
  countD: number;
  countSys: number;
  // system.cpu.util[,,avg1] samples in this slot — kept separate so we can
  // surface the "true" overall CPU as a reference line in the UI alongside
  // the per-process breakdown (which only counts monitored processes).
  sysCpuValues: number[];
}

export async function GET(req: NextRequest) {
  const hostId = req.nextUrl.searchParams.get("hostId");
  const days = parseInt(req.nextUrl.searchParams.get("days") || "1", 10);
  const granularityMin = Math.max(1, Math.min(60, parseInt(req.nextUrl.searchParams.get("granularity") || "60", 10)));
  if (!hostId) return NextResponse.json({ error: "hostId required" }, { status: 400 });

  const client = getZabbixClient();
  // Per-host process CPU items + system.cpu.util[,,avg1] (overall host CPU)
  // + system.cpu.num (cores). Cached per-host for 60s — item lists for a host
  // change only when SP redeploys the template, far less often than the user
  // clicks drill-down on different days.
  const allItems = (await cached(
    `zabbix:procHistItems:${hostId}`,
    () => client.request("item.get", {
      output: ["itemid", "key_", "lastvalue"],
      hostids: [hostId],
      filter: { status: 0, state: 0 },
    }) as Promise<Array<{ itemid: string; key_: string; lastvalue: string }>>,
    60_000,
  )) as Array<{ itemid: string; key_: string; lastvalue: string }>;

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
  const numCpuItem = allItems.find((it) => it.key_ === "system.cpu.num");
  // Cores known? Default to 1 so we never divide by zero. Modern SCO hosts
  // are 4-core; older ones may be 2.
  const cores = Math.max(1, parseInt(numCpuItem?.lastvalue || "1") || 1);

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
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    // Parse as LOCAL midnight (server runs in Europe/Vilnius). The user's
    // calendar day is local-time based, so 00:00 on date = UTC offset behind.
    const d = new Date(dateStr + "T00:00:00");
    timeFrom = Math.floor(d.getTime() / 1000);
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

  const batchResults = await Promise.all(batchPromises.map((p) => p.catch((e) => {
    console.warn("[rt-process-history] batch failed:", e);
    return [] as Array<{ itemid: string; clock: string; value: string }>;
  })));
  for (const records of batchResults) {
    {
      for (const r of records) {
        const cat = categoryById.get(r.itemid);
        if (!cat) continue;
        const dt = new Date(parseInt(r.clock) * 1000);
        const yyyy = dt.getFullYear();
        const mm = String(dt.getMonth() + 1).padStart(2, "0");
        const dd = String(dt.getDate()).padStart(2, "0");
        const hh = String(dt.getHours()).padStart(2, "0");
        // Bucket by granularityMin within the hour: e.g. 5-min → 0/5/10/.../55
        const minBucket = Math.floor(dt.getMinutes() / granularityMin) * granularityMin;
        const mmm = String(minBucket).padStart(2, "0");
        const slotKey = `${yyyy}-${mm}-${dd}T${hh}:${mmm}`;
        let b = buckets.get(slotKey);
        if (!b) {
          b = { retellect: 0, scoApp: 0, db: 0, system: 0, countR: 0, countS: 0, countD: 0, countSys: 0, sysCpuValues: [] };
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
        const dt = new Date(tsSec * 1000);
        const yyyy = dt.getFullYear();
        const mm = String(dt.getMonth() + 1).padStart(2, "0");
        const dd = String(dt.getDate()).padStart(2, "0");
        const hh = String(dt.getHours()).padStart(2, "0");
        const minBucket = Math.floor(dt.getMinutes() / granularityMin) * granularityMin;
        const mmm = String(minBucket).padStart(2, "0");
        const slotKey = `${yyyy}-${mm}-${dd}T${hh}:${mmm}`;
        let b = buckets.get(slotKey);
        if (!b) {
          b = { retellect: 0, scoApp: 0, db: 0, system: 0, countR: 0, countS: 0, countD: 0, countSys: 0, sysCpuValues: [] };
          buckets.set(slotKey, b);
        }
        b.sysCpuValues.push(value);
      }
    } catch (e) {
      console.warn("[rt-process-history] system.cpu.util fetch failed:", e);
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
  const slots: Array<{ slot: number; hourKey: string; hour: number; minute: number; label: string; retellect: number; scoApp: number; db: number; system: number; free: number; sysCpuAvg: number | null; sysCpuMax: number | null }> = [];
  let baseDay: string;
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    baseDay = dateStr;
  } else {
    const dt = new Date(timeFrom * 1000);
    baseDay = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  }
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
    const avg = b
      ? averageSlot({
          retellect: b.retellect,
          scoApp: b.scoApp,
          db: b.db,
          system: b.system,
          countR: b.countR,
          countS: b.countS,
          countD: b.countD,
          countSys: b.countSys,
        })
      : { retellect: 0, scoApp: 0, db: 0, system: 0, free: 100 };
    const { retellect: r, scoApp: sa, db: dbv, system: sys } = avg;
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
      free: Math.max(0, 100 - r - sa - dbv - sys),
      sysCpuAvg,
      sysCpuMax,
    });
  }
  return NextResponse.json({ slots, hasSysCpu: !!sysCpuItem, daySummary });
}
