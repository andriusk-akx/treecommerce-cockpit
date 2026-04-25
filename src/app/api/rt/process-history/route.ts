/**
 * GET /api/rt/process-history?hostId=...&days=1
 *
 * Returns per-hour CPU breakdown for one host across the requested window.
 * Categorizes Zabbix python*.cpu / spss.cpu / sql.cpu / vm.cpu items into
 * retellect / scoApp / db / system buckets and aggregates by hour.
 */
import { NextRequest, NextResponse } from "next/server";
import { getZabbixClient } from "@/lib/zabbix/client";

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
  const allItems = (await client.request("item.get", {
    output: ["itemid", "key_"],
    hostids: [hostId],
    filter: { status: 0, state: 0 },
  })) as Array<{ itemid: string; key_: string }>;

  const isProcessKey = (k: string) =>
    k.endsWith(".cpu") &&
    !k.startsWith("perf_counter") &&
    !k.startsWith("system.cpu");
  const procs = allItems.filter((it) => isProcessKey(it.key_));
  const sysCpuItem = allItems.find(
    (it) => it.key_ === "system.cpu.util[,,avg1]" || it.key_ === "system.cpu.util"
  );
  if (procs.length === 0) return NextResponse.json({ slots: [], hasSysCpu: !!sysCpuItem });

  // Categorize each itemid
  const categoryById = new Map<string, "retellect" | "scoApp" | "db" | "system">();
  for (const it of procs) {
    const base = it.key_.replace(/\.cpu$/, "").toLowerCase();
    if (/^python\d*$/.test(base)) categoryById.set(it.itemid, "retellect");
    else if (base === "spss" || base === "sp.sss" || base === "sp") categoryById.set(it.itemid, "scoApp");
    else if (base === "sql" || base === "sqlservr") categoryById.set(it.itemid, "db");
    else if (base === "vm" || base === "vmware-vmx") categoryById.set(it.itemid, "system");
    // others (cs300sd, NHSTW32, udm) ignored — too niche
  }

  // Date range: if `date` (YYYY-MM-DD) is given, fetch 00:00 → 23:59:59 of that
  // calendar day; otherwise fall back to last `days` days (default 1 day).
  const itemIds = Array.from(categoryById.keys());
  if (itemIds.length === 0) return NextResponse.json({ slots: [] });
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
  // Batch in 20s to avoid Zabbix HTTP 500
  for (let i = 0; i < itemIds.length; i += 20) {
    const batch = itemIds.slice(i, i + 20);
    try {
      const records = (await client.request("history.get", {
        output: ["itemid", "clock", "value"],
        itemids: batch,
        history: 0,
        time_from: String(timeFrom),
        time_till: String(timeTill),
        sortfield: "clock",
        sortorder: "ASC",
        limit: 50000,
      })) as Array<{ itemid: string; clock: string; value: string }>;

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
        const v = parseFloat(r.value) || 0;
        b[cat] += v;
        if (cat === "retellect") b.countR++;
        else if (cat === "scoApp") b.countS++;
        else if (cat === "db") b.countD++;
        else if (cat === "system") b.countSys++;
      }
    } catch (e) {
      console.warn("[rt-process-history] batch failed:", e);
    }
  }

  // Fetch overall system.cpu.util history for the same window — used as
  // a reference line in the chart (per-process sum ignores untracked
  // processes and is hourly-averaged, while system.cpu.util captures
  // every CPU consumer including kernel work).
  // Also: keep the raw 1-min sample list so we can answer the user's
  // direct question "where exactly did the 100% spike happen?".
  type SysSample = { clock: number; value: number };
  const sysAllSamples: SysSample[] = [];
  if (sysCpuItem) {
    try {
      const sysRecords = (await client.request("history.get", {
        output: ["itemid", "clock", "value"],
        itemids: [sysCpuItem.itemid],
        history: 0,
        time_from: String(timeFrom),
        time_till: String(timeTill),
        sortfield: "clock",
        sortorder: "ASC",
        limit: 50000,
      })) as Array<{ clock: string; value: string }>;
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
  let daySummary: {
    samples: number;
    maxValue: number;
    maxAtClock: number; // unix seconds
    maxLabel: string;   // local HH:MM:SS
    avgValue: number;
    minutesAbove: { t50: number; t70: number; t90: number; t95: number };
    raw: Array<{ clock: number; value: number }>; // for line chart at 1-min granularity
  } | null = null;
  if (sysAllSamples.length > 0) {
    const peak = sysAllSamples.reduce((m, s) => (s.value > m.value ? s : m), sysAllSamples[0]);
    const peakLocal = new Date(peak.clock * 1000).toLocaleTimeString("lt-LT", {
      timeZone: "Europe/Vilnius", hour12: false,
    });
    const sum = sysAllSamples.reduce((acc, s) => acc + s.value, 0);
    const above = (t: number) => sysAllSamples.filter((s) => s.value >= t).length;
    daySummary = {
      samples: sysAllSamples.length,
      maxValue: Math.round(peak.value * 10) / 10,
      maxAtClock: peak.clock,
      maxLabel: peakLocal,
      avgValue: Math.round((sum / sysAllSamples.length) * 10) / 10,
      minutesAbove: { t50: above(50), t70: above(70), t90: above(90), t95: above(95) },
      raw: sysAllSamples.map((s) => ({ clock: s.clock, value: Math.round(s.value * 10) / 10 })),
    };
  }

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
    const r = b && b.countR > 0 ? Math.round((b.retellect / b.countR) * 10) / 10 : 0;
    const sa = b && b.countS > 0 ? Math.round((b.scoApp / b.countS) * 10) / 10 : 0;
    const dbv = b && b.countD > 0 ? Math.round((b.db / b.countD) * 10) / 10 : 0;
    const sys = b && b.countSys > 0 ? Math.round((b.system / b.countSys) * 10) / 10 : 0;
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
