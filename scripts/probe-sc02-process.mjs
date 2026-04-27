// Probe SC02 hour 18 process CPU values to understand normalization.
// Plain mjs — no tsx required (Linux sandbox compat).
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
  if (data.error) throw new Error(`${method}: ${data.error.message} — ${data.error.data}`);
  return data.result;
}

const namePattern = process.argv[2] || "SC02";
const isoDate = process.argv[3] || "2026-04-18";

const hosts = await zbx("host.get", {
  output: ["hostid", "host", "name"],
  search: { name: namePattern },
  sortfield: "name",
});
if (!hosts.length) { console.log("No host found for", namePattern); process.exit(0); }

// Pick one matching SC02, prefer name like "* SC02"
const want = process.argv[4] || "";
const host = (want && hosts.find(h => h.name.includes(want)))
  || hosts.find(h => /\bSCO2\b/.test(h.name))
  || hosts[0];
console.log("Selected host:", host.name, "(hostid=" + host.hostid + ")");
console.log();

const items = await zbx("item.get", {
  output: ["itemid", "key_", "name", "lastvalue", "lastclock", "status", "units"],
  hostids: [host.hostid],
});
const cpuItems = items.filter(it => it.key_.startsWith("system.cpu") || it.key_.endsWith(".cpu"));
console.log("=== CPU items ===");
for (const it of cpuItems) {
  const age = it.lastclock === "0" ? "never" : `${Math.round((Date.now() / 1000 - Number(it.lastclock)) / 60)}min`;
  console.log("  " + it.key_.padEnd(36) + " last=" + (it.lastvalue || "").padEnd(10) + " age=" + age + " units=" + (it.units || "%"));
}
console.log();

// Hour 18 of date (Vilnius local)
const dt = new Date(`${isoDate}T18:00:00`);
const offset = -dt.getTimezoneOffset() * 60; // local→UTC offset in seconds
const timeFrom = Math.floor(dt.getTime() / 1000);
const timeTill = timeFrom + 3600;
console.log(`=== Hour 18:00–19:00 on ${isoDate} (Vilnius) ===`);
console.log(`  epoch ${timeFrom}–${timeTill}, host TZ offset ${offset}s`);
console.log();

const procItems = cpuItems.filter(
  it => it.key_.endsWith(".cpu") && !it.key_.startsWith("perf_counter") && !it.key_.startsWith("system.cpu")
);
console.log(`Per-process items (${procItems.length}):`);

let sumAvg = 0, sumMax = 0;
for (const item of procItems) {
  const records = await zbx("history.get", {
    output: ["itemid", "clock", "value"],
    itemids: [item.itemid],
    history: 0,
    time_from: String(timeFrom),
    time_till: String(timeTill),
    sortfield: "clock",
    sortorder: "ASC",
    limit: 200,
  });
  if (!records.length) {
    console.log(`  ${item.key_.padEnd(20)} → 0 samples`);
    continue;
  }
  const values = records.map(r => parseFloat(r.value));
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const max = Math.max(...values);
  sumAvg += avg;
  sumMax += max;
  console.log(`  ${item.key_.padEnd(20)} → ${String(records.length).padStart(3)}smp avg=${avg.toFixed(1).padStart(6)}% max=${max.toFixed(1).padStart(6)}%`);
}
console.log(`  ${"SUM".padEnd(20)} → avg=${sumAvg.toFixed(1)}%  max=${sumMax.toFixed(1)}%  (raw, not divided by cores)`);

const sysItem = cpuItems.find(it => it.key_ === "system.cpu.util[,,avg1]" || it.key_ === "system.cpu.util");
const numItem = cpuItems.find(it => it.key_ === "system.cpu.num");
console.log();
console.log("=== Reference (overall + cores) ===");
if (numItem) {
  console.log(`  system.cpu.num = ${numItem.lastvalue}`);
}
if (sysItem) {
  const records = await zbx("history.get", {
    output: ["itemid", "clock", "value"],
    itemids: [sysItem.itemid],
    history: 0,
    time_from: String(timeFrom),
    time_till: String(timeTill),
    sortfield: "clock",
    sortorder: "ASC",
    limit: 200,
  });
  if (records.length) {
    const values = records.map(r => parseFloat(r.value));
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const max = Math.max(...values);
    console.log(`  ${sysItem.key_.padEnd(20)} → ${records.length}smp avg=${avg.toFixed(1)}% max=${max.toFixed(1)}% [overall host CPU]`);
  }
}
