// Compare timeline daily MAX vs drill-down per-minute samples for the same date.
// Hypothesis: timezone mismatch — timeline groups by UTC date, drill-down uses
// local Vilnius date, so the same calendar-day label points to different time
// windows.
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
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

const want = process.argv[2] || "SCO2";
const isoDate = process.argv[3] || "2026-04-18";

const hosts = await zbx("host.get", { output: ["hostid", "name"], search: { name: want } });
console.log("Found", hosts.length, "hosts matching", want);
for (const h of hosts.slice(0, 8)) console.log("  hostid=" + h.hostid + " name=" + h.name);

// Pick the host with highest CPU peak on isoDate
console.log();
console.log("=== Looking for host with 100% peak on " + isoDate + " ===");

let bestHost = null;
let bestMax = 0;
// Filter to a meaningful subset to keep the probe fast
const filtered = process.argv[4]
  ? hosts.filter(h => h.hostid === process.argv[4])
  : hosts.slice(0, 30);
for (const h of filtered) {
  const items = await zbx("item.get", {
    output: ["itemid", "key_"],
    hostids: [h.hostid],
    filter: { key_: ["system.cpu.util[,,avg1]", "system.cpu.util"] },
  });
  if (!items.length) continue;
  const item = items[0];
  // Wide window — 04-18 in any timezone
  const dt = new Date(`${isoDate}T00:00:00Z`);
  const fromUtc = Math.floor(dt.getTime() / 1000) - 6 * 3600;
  const tillUtc = fromUtc + 86400 + 12 * 3600;
  const recs = await zbx("history.get", {
    output: ["clock", "value"],
    itemids: [item.itemid],
    history: 0, time_from: String(fromUtc), time_till: String(tillUtc),
    sortfield: "clock", sortorder: "ASC", limit: 5000,
  });
  if (!recs.length) continue;
  const max = Math.max(...recs.map(r => parseFloat(r.value)));
  if (max > bestMax) { bestMax = max; bestHost = { ...h, item, recs }; }
  console.log(`  ${h.name.padEnd(40)} max=${max.toFixed(1)}% (${recs.length} smp around ${isoDate})`);
}

if (!bestHost) { console.log("No hosts with data"); process.exit(0); }
console.log();
console.log(`>>> Selected: ${bestHost.name} max=${bestMax.toFixed(1)}%`);
console.log();

// Now compute MAX bucketed by UTC date vs local Vilnius date
const utcDateMap = new Map();
const localDateMap = new Map();
for (const r of bestHost.recs) {
  const ts = parseInt(r.clock) * 1000;
  const v = parseFloat(r.value);
  const dt = new Date(ts);
  const utcDate = dt.toISOString().slice(0, 10);
  // Vilnius local date
  const localDate = dt.toLocaleDateString("en-CA", { timeZone: "Europe/Vilnius" });
  utcDateMap.set(utcDate, Math.max(utcDateMap.get(utcDate) ?? 0, v));
  localDateMap.set(localDate, Math.max(localDateMap.get(localDate) ?? 0, v));
}

console.log("=== Per UTC date max ===");
for (const [k, v] of [...utcDateMap.entries()].sort()) console.log(`  ${k}: ${v.toFixed(1)}%`);
console.log();
console.log("=== Per Vilnius local date max ===");
for (const [k, v] of [...localDateMap.entries()].sort()) console.log(`  ${k}: ${v.toFixed(1)}%`);
console.log();

// When did the actual peak happen?
const peakRec = bestHost.recs.reduce((m, r) => parseFloat(r.value) > parseFloat(m.value) ? r : m);
const peakDt = new Date(parseInt(peakRec.clock) * 1000);
const peakUtc = peakDt.toISOString();
const peakLocal = peakDt.toLocaleString("lt-LT", { timeZone: "Europe/Vilnius" });
console.log(`>>> Peak ${parseFloat(peakRec.value).toFixed(1)}% at:`);
console.log(`    UTC:     ${peakUtc}`);
console.log(`    Vilnius: ${peakLocal}`);
console.log();
console.log("How many minutes hit ≥ 95%?");
const high = bestHost.recs.filter(r => parseFloat(r.value) >= 95);
console.log(`    Count: ${high.length}, span ${high.length > 0 ? new Date(parseInt(high[0].clock) * 1000).toLocaleString("lt-LT", { timeZone: "Europe/Vilnius" }) + " → " + new Date(parseInt(high[high.length-1].clock) * 1000).toLocaleString("lt-LT", { timeZone: "Europe/Vilnius" }) : "—"}`);
