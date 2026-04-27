#!/usr/bin/env node
/**
 * Integration verification: spin up the Next.js dev server, hit the
 * /api/rt/process-history endpoint for a known busy host/day, and compare
 * its slot data to a parallel hand-computed reference.
 *
 * Tests that the END-TO-END API (route + math + Zabbix) gives the same
 * numbers as the math.ts unit tests would predict.
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

const URL = process.env.ZABBIX_URL;
const TOKEN = process.env.ZABBIX_TOKEN;
const APP_BASE = process.env.APP_BASE || "http://localhost:3000";

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

// Pick the same host as verify-calc-realhost.mjs.
const hosts = await call("host.get", {
  output: ["hostid", "name"],
  groupids: ["198"],
  search: { name: "Pavilnionys" },
});
const target = hosts.find(h => /SCO2/i.test(h.name));
if (!target) { console.error("No Pavilnionys SCO2"); process.exit(1); }
const hostId = target.hostid;

const dayDate = new Date(Date.now() - 24 * 3600 * 1000);
const yyyy = dayDate.getFullYear();
const mm = String(dayDate.getMonth() + 1).padStart(2, "0");
const dd = String(dayDate.getDate()).padStart(2, "0");
const dateStr = `${yyyy}-${mm}-${dd}`;
console.log(`Verifying ${target.name} on ${dateStr}\n`);

// Hit the API endpoint.
const apiUrl = `${APP_BASE}/api/rt/process-history?hostId=${hostId}&date=${dateStr}&granularity=60`;
console.log("API GET:", apiUrl);
const t0 = Date.now();
const res = await fetch(apiUrl);
const elapsed = Date.now() - t0;
console.log(`Response: ${res.status} in ${elapsed}ms`);
const body = await res.json();
if (!res.ok) { console.error("API error:", body); process.exit(1); }
console.log(`Slots: ${body.slots.length}, hasSysCpu: ${body.hasSysCpu}`);
if (body.daySummary) {
  console.log(`daySummary: max=${body.daySummary.maxValue}@${body.daySummary.maxLabel}, avg=${body.daySummary.avgValue}, samples=${body.daySummary.samples}`);
  console.log(`  minutesAbove:`, body.daySummary.minutesAbove);
}

// ── Build reference (mirrors what the route does, end to end) ──
const allItems = await call("item.get", {
  output: ["itemid", "key_", "lastvalue"],
  hostids: [hostId],
  filter: { status: 0, state: 0 },
});
const numCpuItem = allItems.find(it => it.key_ === "system.cpu.num");
const cores = Math.max(1, parseInt(numCpuItem?.lastvalue || "1") || 1);
const { categoryById, needsCoresDivision } = m.chooseTelemetrySources(
  allItems.map(it => ({ itemid: it.itemid, key_: it.key_ }))
);
const itemIds = Array.from(categoryById.keys());
const dt = new Date(dateStr + "T00:00:00");
const tFrom = Math.floor(dt.getTime() / 1000);
const tTill = tFrom + 86400 - 1;
console.log(`\nFetching ${itemIds.length} item histories for reference...`);
let allRecords = [];
for (let i = 0; i < itemIds.length; i += 20) {
  const batch = itemIds.slice(i, i + 20);
  const res = await call("history.get", {
    output: ["itemid", "clock", "value"], itemids: batch, history: 0,
    time_from: String(tFrom), time_till: String(tTill),
    sortfield: "clock", sortorder: "ASC", limit: 50000,
  });
  allRecords = allRecords.concat(res);
}

// Aggregate into per-hour buckets identically to the route.
const buckets = new Map();
for (const r of allRecords) {
  const cat = categoryById.get(r.itemid);
  if (!cat) continue;
  const dt = new Date(parseInt(r.clock) * 1000);
  const slotKey = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}T${String(dt.getHours()).padStart(2, "0")}:00`;
  let b = buckets.get(slotKey);
  if (!b) {
    b = { retellect: 0, scoApp: 0, db: 0, system: 0, countR: 0, countS: 0, countD: 0, countSys: 0 };
    buckets.set(slotKey, b);
  }
  const raw = parseFloat(r.value) || 0;
  const v = m.normaliseValue(raw, needsCoresDivision.has(r.itemid), cores);
  b[cat] += v;
  if (cat === "retellect") b.countR++;
  else if (cat === "scoApp") b.countS++;
  else if (cat === "db") b.countD++;
  else if (cat === "system") b.countSys++;
}

// Compare every slot returned by the API to our reference.
const apiByKey = new Map(body.slots.map(s => [s.hourKey, s]));
let mismatches = 0, matches = 0;
let busiestSlot = null;
for (const [slotKey, b] of buckets) {
  const ref = m.averageSlot(b);
  const got = apiByKey.get(slotKey);
  if (!got) { console.log("  ✗ Slot missing from API:", slotKey); mismatches++; continue; }
  const within = (a, x, tol = 0.1) => Math.abs(a - x) <= tol;
  const ok = within(ref.retellect, got.retellect) &&
             within(ref.scoApp,   got.scoApp) &&
             within(ref.db,       got.db) &&
             within(ref.system,   got.system);
  if (ok) matches++;
  else {
    mismatches++;
    console.log(`  ✗ ${slotKey}: ref ${JSON.stringify(ref)} vs got ${JSON.stringify({retellect:got.retellect,scoApp:got.scoApp,db:got.db,system:got.system,free:got.free})}`);
  }
  const totalRef = ref.retellect + ref.scoApp + ref.db + ref.system;
  if (!busiestSlot || totalRef > (busiestSlot.tracked || 0)) {
    busiestSlot = { slotKey, ref, got, tracked: totalRef };
  }
}

console.log(`\nVerification: ${matches}/${matches + mismatches} slots agree (tolerance ±0.1%)`);
if (busiestSlot) {
  console.log(`\nBusiest slot ${busiestSlot.slotKey}:`);
  console.log(`  ref: ${JSON.stringify(busiestSlot.ref)}`);
  console.log(`  got: retellect=${busiestSlot.got.retellect}, scoApp=${busiestSlot.got.scoApp}, db=${busiestSlot.got.db}, system=${busiestSlot.got.system}, free=${busiestSlot.got.free}, sysCpuAvg=${busiestSlot.got.sysCpuAvg}`);
}
process.exit(mismatches > 0 ? 1 : 0);
