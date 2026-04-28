// Investigate why Retellect data is missing for Dangeručio SCO2 (T822, hostid 25250)
// — Rimi admin claims Retellect IS deployed there.
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

const HOSTID = "25250"; // LT_T822_SCOW_32 = Dangeručio SCO2
const REF_HOSTID = "25249"; // LT_T822_SCOW_31 = Dangeručio SCO1 (sibling for comparison)

console.log("=== Step 1: Verify host exists and is enabled ===");
const hostInfo = await zbx("host.get", {
  output: ["hostid", "host", "name", "status"],
  hostids: [HOSTID, REF_HOSTID],
});
hostInfo.forEach(h => {
  console.log(`  ${h.host} (${h.name}) — status=${h.status === "0" ? "ENABLED" : "DISABLED"}`);
});

console.log("\n=== Step 2: Item count + by-key-pattern breakdown for SCO2 ===");
const items = await zbx("item.get", {
  output: ["itemid", "key_", "name", "lastclock", "lastvalue", "status"],
  hostids: [HOSTID],
  sortfield: "key_",
});
console.log(`  Total items on Dangeručio SCO2: ${items.length}`);

// Categorize
const cats = {
  pythonPerf: items.filter(i => /perf_counter.*Process\(python.*Processor Time/i.test(i.key_)),
  pythonCpu: items.filter(i => /^python\d*\.cpu/.test(i.key_)),
  spssPerf: items.filter(i => /perf_counter.*Process\(sp\.sss.*Processor Time/i.test(i.key_)),
  systemCpu: items.filter(i => /^system\.cpu/.test(i.key_)),
  procNum: items.filter(i => /^proc\.num/.test(i.key_)),
};
for (const [k, list] of Object.entries(cats)) {
  console.log(`  [${k}]: ${list.length} items`);
  list.slice(0, 5).forEach(i => {
    const lastAge = i.lastclock === "0" ? "NEVER" : `${Math.round((Date.now()/1000 - parseInt(i.lastclock))/60)}m ago`;
    const stat = i.status === "0" ? "ENA" : "DIS";
    console.log(`    ${stat}  ${i.key_.padEnd(70)}  last=${lastAge}  val=${i.lastvalue || "-"}`);
  });
}

console.log("\n=== Step 3: Compare with sibling SCO1 (same store, expected similar template) ===");
const itemsRef = await zbx("item.get", {
  output: ["itemid", "key_"],
  hostids: [REF_HOSTID],
});
console.log(`  Total items on Dangeručio SCO1: ${itemsRef.length}`);

const sco2Keys = new Set(items.map(i => i.key_));
const sco1Keys = new Set(itemsRef.map(i => i.key_));

const missingOnSCO2 = [...sco1Keys].filter(k => !sco2Keys.has(k));
const extraOnSCO2 = [...sco2Keys].filter(k => !sco1Keys.has(k));
console.log(`  Keys in SCO1 but NOT in SCO2: ${missingOnSCO2.length}`);
missingOnSCO2.filter(k => /python|spss|perf_counter|proc\./.test(k)).slice(0, 20).forEach(k => console.log(`    MISSING: ${k}`));
console.log(`  Keys in SCO2 but NOT in SCO1: ${extraOnSCO2.length}`);
extraOnSCO2.filter(k => /python|spss|perf_counter|proc\./.test(k)).slice(0, 20).forEach(k => console.log(`    EXTRA:   ${k}`));

console.log("\n=== Step 4: What does our dashboard see (filterable items) ===");
// Mirror the same regex chooseTelemetrySources uses
const dashItems = items.filter(i =>
  /^perf_counter\["?\\Process\(/.test(i.key_) && /\\% Processor Time/.test(i.key_)
  || /\.cpu$/.test(i.key_) && !i.key_.startsWith("system.cpu")
);
console.log(`  Items dashboard would pick up: ${dashItems.length}`);
dashItems.forEach(i => {
  const lastAge = i.lastclock === "0" ? "NEVER" : `${Math.round((Date.now()/1000 - parseInt(i.lastclock))/60)}m ago`;
  console.log(`    ${i.key_.padEnd(70)}  last=${lastAge}  val=${i.lastvalue || "-"}`);
});
