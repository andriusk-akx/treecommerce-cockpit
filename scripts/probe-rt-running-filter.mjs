// Diagnose: why does RtOverview "Retellect running" filter show only 2 hosts?
// Walks through every dimension of the filter chain on real Rimi prod data
// and shows where each host falls out.
//
// Filter chain (per RtOverview.tsx line 316):
//   rtActive = rtFresh && rtCpuTotal > RETELLECT_CPU_THRESHOLD (1.0)
//
// Where:
//   rtFresh       = freshest python.cpu sample updated within last 300s
//   rtCpuTotal    = sum of all python.cpu values on the host (Math.max(0, value))
//
// We also compare with the big-tile "retellectLiveHostIds" rule (totalCpu > 0).

import * as fs from "node:fs";

const env = fs.readFileSync(".env.local", "utf8");
const TOKEN = env.match(/^ZABBIX_TOKEN=["']?([^"'\n]+)/m)[1];
const URL_ZBX = "https://monitoring.strongpoint.com/api_jsonrpc.php";

async function zbx(method, params = {}) {
  const res = await fetch(URL_ZBX, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: Math.random() }),
  });
  const data = await res.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.result;
}

const FRESH_SEC = 300;
const RETELLECT_CPU_THRESHOLD = 1.0;
const NOW = Math.floor(Date.now() / 1000);

console.log("=== Step 1: All LT_T*_SCOW_* hosts (Rimi fleet) ===");
const allHosts = await zbx("host.get", {
  output: ["hostid", "host", "name", "status"],
});
const rimiHosts = allHosts.filter((h) => /^LT_T\d+_SCOW_\d+/.test(h.host));
const enabled = rimiHosts.filter((h) => h.status === "0");
const disabled = rimiHosts.filter((h) => h.status === "1");
console.log(`  Found ${rimiHosts.length} Rimi hosts (${enabled.length} enabled, ${disabled.length} disabled)`);

console.log("\n=== Step 2: python.cpu items + perf_counter[\\Process(python*)\\] for each enabled host ===");
const hostIds = enabled.map((h) => h.hostid);
// Pull both *.cpu and perf_counter forms — same ones the dashboard uses.
// Per RtOverview, only `procCpu` items with category=retellect feed the filter,
// and those come from `getProcessCpuItems` which is a hybrid of perf_counter +
// .cpu fallback. We mirror it here without filter: status=0, no state filter
// — to get a full view including ZBX_NOTSUPPORTED items.
// Dashboard uses `filter: { status: 0, state: 0 }` — UNSUPPORTED items dropped.
// We pull WITHOUT that filter so we can also count what the dashboard misses.
const items = await zbx("item.get", {
  output: ["itemid", "hostid", "key_", "lastvalue", "lastclock", "state", "error"],
  hostids: hostIds,
  filter: { status: 0 },
});

console.log(`  Total items returned (no state filter): ${items.length}`);
const dashboardItems = items.filter((i) => i.state === "0");
console.log(`  Items dashboard would see (state=0):    ${dashboardItems.length}`);
const dashboardRtItems = dashboardItems.filter((i) => isDashboardRetellectKey(i.key_));
console.log(`  …of which dashboard 'retellect' items:  ${dashboardRtItems.length}`);
const allRtItems = items.filter((i) => isAnyRetellectKey(i.key_));
console.log(`  All retellect items (incl perf_counter, incl state=1): ${allRtItems.length}`);

// Match retellect-relevant keys.
// IMPORTANT: getProcessCpuItems() (the actual dashboard data path) excludes
// perf_counter items entirely — see client.ts line 505. So the dashboard
// only sees `python*.cpu` keys. We mirror that here to reproduce its view.
function isDashboardRetellectKey(key) {
  return /^python\d*\.cpu$/.test(key);
}
function isAnyRetellectKey(key) {
  if (/^python\d*\.cpu$/.test(key)) return true;
  if (/^perf_counter\["?\\Process\(python(#\d+)?\)\\% Processor Time/.test(key)) return true;
  return false;
}
const isRetellectKey = isDashboardRetellectKey;

// Per-host aggregates — restrict to dashboard items (state=0, no perf_counter)
// to reproduce the dashboard's view exactly.
items.forEach((i) => { i._dashboardSees = i.state === "0" && isDashboardRetellectKey(i.key_); });
const byHost = new Map(); // hostId → {hasItem, items[], rtCpuTotal, rtFreshestMs, rtUnsupportedItemCount}
for (const h of enabled) {
  byHost.set(h.hostid, {
    host: h,
    hasItem: false,
    items: [],
    rtCpuTotal: 0,
    rtFreshestMs: 0,
    rtUnsupportedItemCount: 0,
  });
}
for (const item of items) {
  const entry = byHost.get(item.hostid);
  if (!entry) continue;
  // Match dashboard exactly: state=0 only, .cpu only (no perf_counter)
  if (!item._dashboardSees) {
    if (item.state === "1" && isAnyRetellectKey(item.key_)) entry.rtUnsupportedItemCount += 1;
    continue;
  }
  entry.hasItem = true;
  entry.items.push(item);
  const lastMs = item.lastclock !== "0" ? parseInt(item.lastclock) * 1000 : 0;
  if (lastMs > 0) {
    const cpu = parseFloat(item.lastvalue) || 0;
    entry.rtCpuTotal += Math.max(0, cpu);
    if (lastMs > entry.rtFreshestMs) entry.rtFreshestMs = lastMs;
  }
}

console.log(`  ${items.filter((i) => isRetellectKey(i.key_)).length} retellect-pattern items across ${[...byHost.values()].filter((e) => e.hasItem).length} hosts`);

console.log("\n=== Step 3: Funnel — where hosts drop out of 'rtActive' ===");
const counts = {
  total: enabled.length,
  hasItem: 0,
  anyClockNonZero: 0,
  freshestUnderThreshold: 0,
  cpuGtZero: 0,
  cpuGtOne: 0,
  fresh_AND_cpuGtZero: 0, // matches big-tile "retellectLiveHostIds"
  fresh_AND_cpuGtOne: 0, // matches filter "rtActive"
};
const rows = [];
for (const e of byHost.values()) {
  const ageSec = e.rtFreshestMs > 0 ? (NOW - e.rtFreshestMs / 1000) : null;
  const fresh = ageSec !== null && ageSec < FRESH_SEC;
  if (e.hasItem) counts.hasItem += 1;
  if (e.rtFreshestMs > 0) counts.anyClockNonZero += 1;
  if (fresh) counts.freshestUnderThreshold += 1;
  if (e.rtCpuTotal > 0) counts.cpuGtZero += 1;
  if (e.rtCpuTotal > RETELLECT_CPU_THRESHOLD) counts.cpuGtOne += 1;
  if (fresh && e.rtCpuTotal > 0) counts.fresh_AND_cpuGtZero += 1;
  if (fresh && e.rtCpuTotal > RETELLECT_CPU_THRESHOLD) counts.fresh_AND_cpuGtOne += 1;
  rows.push({
    host: e.host.host,
    name: e.host.name,
    hasItem: e.hasItem,
    items: e.items.length,
    unsupported: e.rtUnsupportedItemCount,
    rtCpuTotal: e.rtCpuTotal,
    rtAgeSec: ageSec,
    fresh,
    rtActiveTile: fresh && e.rtCpuTotal > 0,         // big-tile rule
    rtActiveFilter: fresh && e.rtCpuTotal > 1.0,     // filter rule
  });
}

console.log(`  Total enabled hosts:                     ${counts.total}`);
console.log(`  Have python.cpu/perf_counter items:      ${counts.hasItem}`);
console.log(`  Any item with lastclock != 0:            ${counts.anyClockNonZero}`);
console.log(`  Freshest sample < ${FRESH_SEC}s old:             ${counts.freshestUnderThreshold}`);
console.log(`  rtCpuTotal > 0 (any positive python):    ${counts.cpuGtZero}`);
console.log(`  rtCpuTotal > 1.0 (filter threshold):     ${counts.cpuGtOne}`);
console.log(`  fresh AND rtCpuTotal > 0  (TILE rule):   ${counts.fresh_AND_cpuGtZero}`);
console.log(`  fresh AND rtCpuTotal > 1.0 (FILTER rule):${counts.fresh_AND_cpuGtOne}  ← only this many show up`);

console.log("\n=== Step 4: 'Marginal' hosts — fresh + python > 0 but ≤ 1.0 (filter rejects, tile counts) ===");
const marginal = rows
  .filter((r) => r.fresh && r.rtCpuTotal > 0 && r.rtCpuTotal <= 1.0)
  .sort((a, b) => b.rtCpuTotal - a.rtCpuTotal);
console.log(`  ${marginal.length} hosts in this band:`);
marginal.forEach((r) => {
  console.log(`    ${r.host.padEnd(22)}  ${r.name.padEnd(40)}  cpu=${r.rtCpuTotal.toFixed(3).padStart(7)}%  age=${Math.round(r.rtAgeSec)}s  items=${r.items} unsup=${r.unsupported}`);
});

console.log("\n=== Step 5: Stale hosts — have python items, have CPU > 0, but freshest > 5min ===");
const stale = rows
  .filter((r) => !r.fresh && r.rtCpuTotal > 0)
  .sort((a, b) => (a.rtAgeSec ?? 0) - (b.rtAgeSec ?? 0));
console.log(`  ${stale.length} hosts in this band:`);
stale.slice(0, 20).forEach((r) => {
  const ageMin = Math.round((r.rtAgeSec ?? 0) / 60);
  console.log(`    ${r.host.padEnd(22)}  cpu=${r.rtCpuTotal.toFixed(2).padStart(6)}%  age=${ageMin}m  unsup=${r.unsupported}/${r.items}`);
});
if (stale.length > 20) console.log(`    … ${stale.length - 20} more`);

console.log("\n=== Step 6: Hosts that PASS the filter (the 2-ish that show up) ===");
const passing = rows.filter((r) => r.rtActiveFilter).sort((a, b) => b.rtCpuTotal - a.rtCpuTotal);
console.log(`  ${passing.length} hosts:`);
passing.forEach((r) => {
  console.log(`    ${r.host.padEnd(22)}  ${r.name.padEnd(40)}  cpu=${r.rtCpuTotal.toFixed(2)}%  age=${Math.round(r.rtAgeSec)}s`);
});

console.log("\n=== Step 7: Hosts with NO python items at all (template not deployed) ===");
const noItems = rows.filter((r) => !r.hasItem);
console.log(`  ${noItems.length} hosts. First 10:`);
noItems.slice(0, 10).forEach((r) => console.log(`    ${r.host.padEnd(22)}  ${r.name}`));
