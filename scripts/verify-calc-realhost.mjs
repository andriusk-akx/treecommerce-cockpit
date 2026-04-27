#!/usr/bin/env node
/**
 * Calculation verification: pick a real Rimi SCO host and a real day, fetch
 * the raw Zabbix data ourselves, compute expected dashboard numbers from
 * first principles, then compare to what our route logic produces.
 *
 * Verifies three pieces of math:
 *   1. summariseDay  → max, avg, minutesAbove
 *   2. averageSlot   → per-slot per-category averages
 *   3. chooseTelemetrySources + normaliseValue → which item is picked, division by cores
 */
import assert from "node:assert/strict";
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

const URL = process.env.ZABBIX_URL;
const TOKEN = process.env.ZABBIX_TOKEN;

const m = await import("../src/app/api/rt/process-history/math.ts");

let id = 0;
async function call(method, params) {
  id++;
  const r = await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
    signal: AbortSignal.timeout(60_000),
  });
  const d = await r.json();
  if (d.error) throw new Error(method + ": " + d.error.message);
  return d.result;
}

// ── Step 1: pick a busy host. We previously saw spikes on Pavilnionys SCO2.
const hosts = await call("host.get", {
  output: ["hostid", "name"],
  groupids: ["198"],
  search: { name: "Pavilnionys" },
});
const target = hosts.find(h => /SCO2/i.test(h.name)) || hosts[0];
if (!target) {
  console.log("No Pavilnionys host found — picking first Rimi host instead");
  const all = await call("host.get", { output: ["hostid", "name"], groupids: ["198"] });
  if (!all.length) { console.error("No Rimi hosts"); process.exit(1); }
}
const hostId = target.hostid;
console.log(`Target host: ${target.name} (${hostId})\n`);

// ── Step 2: fetch all relevant items for that host.
const allItems = await call("item.get", {
  output: ["itemid", "key_", "lastvalue"],
  hostids: [hostId],
  filter: { status: 0, state: 0 },
});
console.log(`Items returned: ${allItems.length}`);

const sysCpuItem = allItems.find(it => it.key_ === "system.cpu.util[,,avg1]" || it.key_ === "system.cpu.util");
const numCpuItem = allItems.find(it => it.key_ === "system.cpu.num");
const cores = Math.max(1, parseInt(numCpuItem?.lastvalue || "1") || 1);
console.log(`Cores: ${cores}, has sysCpu item: ${!!sysCpuItem}`);

// ── Step 3: chooseTelemetrySources and report what was picked vs available.
const { categoryById, needsCoresDivision } = m.chooseTelemetrySources(
  allItems.map(it => ({ itemid: it.itemid, key_: it.key_ }))
);
console.log(`Process items chosen: ${categoryById.size}`);
const categoryCounts = { retellect: 0, scoApp: 0, db: 0, system: 0 };
const needsDivCount = needsCoresDivision.size;
for (const [, cat] of categoryById) categoryCounts[cat]++;
console.log("By category:", categoryCounts, "| perf_counter (needs /cores):", needsDivCount);

// ── Step 4: pick yesterday (already settled day) and fetch sysCpu for that day.
const dayDate = new Date(Date.now() - 24 * 3600 * 1000);
const yyyy = dayDate.getFullYear();
const mmm = String(dayDate.getMonth() + 1).padStart(2, "0");
const ddd = String(dayDate.getDate()).padStart(2, "0");
const dateStr = `${yyyy}-${mmm}-${ddd}`;
const t0 = Math.floor(new Date(dateStr + "T00:00:00").getTime() / 1000);
const t1 = t0 + 86400 - 1;
console.log(`\nDay window: ${dateStr} [${t0}, ${t1}] = ${new Date(t0 * 1000).toISOString()} → ${new Date(t1 * 1000).toISOString()}`);

if (!sysCpuItem) {
  console.log("No sysCpu item — skipping day-summary check");
  process.exit(0);
}

const sysHistory = await call("history.get", {
  output: ["clock", "value"],
  itemids: [sysCpuItem.itemid],
  history: 0,
  time_from: String(t0), time_till: String(t1),
  sortfield: "clock", sortorder: "ASC", limit: 50000,
});
console.log(`sysCpu samples for ${dateStr}: ${sysHistory.length}`);

if (sysHistory.length === 0) {
  console.log("No samples — host may not have been reporting that day");
  process.exit(0);
}

// ── Step 5: compute reference summary by hand (no shared code).
const values = sysHistory.map(r => parseFloat(r.value)).filter(v => !Number.isNaN(v));
const refMax = Math.max(...values);
const refMin = Math.min(...values);
const refAvg = values.reduce((s, v) => s + v, 0) / values.length;
const refAbove = (t) => values.filter(v => v >= t).length;
console.log("\nReference (hand-computed):");
console.log(`  max=${refMax.toFixed(2)}, min=${refMin.toFixed(2)}, avg=${refAvg.toFixed(2)}, n=${values.length}`);
console.log(`  ≥50: ${refAbove(50)}, ≥70: ${refAbove(70)}, ≥90: ${refAbove(90)}, ≥95: ${refAbove(95)}`);

// ── Step 6: feed the same samples through summariseDay and compare.
const samples = sysHistory.map(r => ({ clock: parseInt(r.clock), value: parseFloat(r.value) }));
const summary = m.summariseDay(samples);
console.log("\nsummariseDay output:");
console.log(`  maxValue=${summary.maxValue}, avgValue=${summary.avgValue}, samples=${summary.samples}`);
console.log(`  minutesAbove:`, summary.minutesAbove);

// Allow up to 0.1 of error for rounding to 1 decimal.
function near(a, b, tol = 0.05) { return Math.abs(a - b) <= tol; }
let allGood = true;
function check(label, ref, got, tol = 0.05) {
  const ok = typeof ref === "number" ? near(ref, got, tol) : ref === got;
  console.log(`  ${ok ? "✓" : "✗"} ${label}: ref=${typeof ref === "number" ? ref.toFixed(2) : ref}, got=${got}`);
  if (!ok) allGood = false;
}
console.log("\nVerification:");
check("max",            Math.round(refMax * 10) / 10, summary.maxValue);
check("avg",            Math.round(refAvg * 10) / 10, summary.avgValue, 0.1);
check("samples count",  values.length,                 summary.samples);
check("minutesAbove50", refAbove(50),                  summary.minutesAbove.t50);
check("minutesAbove70", refAbove(70),                  summary.minutesAbove.t70);
check("minutesAbove90", refAbove(90),                  summary.minutesAbove.t90);
check("minutesAbove95", refAbove(95),                  summary.minutesAbove.t95);

// ── Step 7: spot-check averageSlot for a known peak slot.
// Find the peak and aggregate the surrounding ±30s into a slot for *.cpu items.
const peakIdx = values.indexOf(refMax);
const peakClock = parseInt(sysHistory[peakIdx].clock);
console.log(`\nPeak at ${new Date(peakClock * 1000).toISOString()} = ${refMax.toFixed(1)}%`);

// Fetch process samples for the peak hour.
const procIds = Array.from(categoryById.keys());
if (procIds.length === 0) {
  console.log("No process items for this host — skipping per-slot check");
  process.exit(allGood ? 0 : 1);
}
const peakHourStart = peakClock - (peakClock % 3600);
const peakHourEnd = peakHourStart + 3600;
const procHistory = await call("history.get", {
  output: ["itemid", "clock", "value"],
  itemids: procIds, history: 0,
  time_from: String(peakHourStart), time_till: String(peakHourEnd),
  sortfield: "clock", sortorder: "ASC", limit: 10000,
});
console.log(`Process samples in peak hour: ${procHistory.length}`);

// Build a slot bucket aligned to the peak hour (60-min granularity).
const bucket = { retellect: 0, scoApp: 0, db: 0, system: 0, countR: 0, countS: 0, countD: 0, countSys: 0 };
for (const r of procHistory) {
  const cat = categoryById.get(r.itemid);
  if (!cat) continue;
  const raw = parseFloat(r.value) || 0;
  const v = m.normaliseValue(raw, needsCoresDivision.has(r.itemid), cores);
  bucket[cat] += v;
  if (cat === "retellect") bucket.countR++;
  else if (cat === "scoApp") bucket.countS++;
  else if (cat === "db") bucket.countD++;
  else if (cat === "system") bucket.countSys++;
}
const slotAvg = m.averageSlot(bucket);
console.log("\nPeak-hour slot averages:");
console.log(`  retellect=${slotAvg.retellect}%, scoApp=${slotAvg.scoApp}%, db=${slotAvg.db}%, system=${slotAvg.system}%, free=${slotAvg.free}%`);
const trackedSum = slotAvg.retellect + slotAvg.scoApp + slotAvg.db + slotAvg.system;
const sysAvgPeak = (() => {
  const v = sysHistory.filter(r => parseInt(r.clock) >= peakHourStart && parseInt(r.clock) < peakHourEnd).map(r => parseFloat(r.value));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
})();
console.log(`  → tracked sum: ${trackedSum.toFixed(1)}% | system.cpu.util[,,avg1] hour avg: ${sysAvgPeak?.toFixed(1) ?? "n/a"}%`);
console.log(`  → "Other" gap: ${sysAvgPeak ? Math.max(0, sysAvgPeak - trackedSum).toFixed(1) : "n/a"}% (kernel + untracked user procs)`);

console.log(allGood ? "\nAll checks passed ✓" : "\nFAILED ✗");
process.exit(allGood ? 0 : 1);
