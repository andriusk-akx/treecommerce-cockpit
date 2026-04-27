// Replicate the new API behavior — including system.cpu.util reference fetch.
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
const granularityMin = parseInt(process.argv[4] || "60", 10);

const hosts = await zbx("host.get", { output: ["hostid", "name"], search: { name: want } });
const exact = process.argv[5];
const host = exact ? hosts.find(h => h.hostid === exact) : (hosts.find(h => new RegExp(`\\b${want}\\b`).test(h.name)) || hosts[0]);
console.log("Host:", host.name);

const allItems = await zbx("item.get", {
  output: ["itemid", "key_"],
  hostids: [host.hostid],
  filter: { status: 0, state: 0 },
});
const procs = allItems.filter(it => it.key_.endsWith(".cpu") && !it.key_.startsWith("perf_counter") && !it.key_.startsWith("system.cpu"));
const sysItem = allItems.find(it => it.key_ === "system.cpu.util[,,avg1]" || it.key_ === "system.cpu.util");

const categoryById = new Map();
for (const it of procs) {
  const base = it.key_.replace(/\.cpu$/, "").toLowerCase();
  if (/^python\d*$/.test(base)) categoryById.set(it.itemid, "retellect");
  else if (base === "spss" || base === "sp.sss" || base === "sp") categoryById.set(it.itemid, "scoApp");
  else if (base === "sql" || base === "sqlservr") categoryById.set(it.itemid, "db");
  else if (base === "vm" || base === "vmware-vmx") categoryById.set(it.itemid, "system");
}
const itemIds = Array.from(categoryById.keys());

const dt = new Date(`${isoDate}T00:00:00`);
const timeFrom = Math.floor(dt.getTime() / 1000);
const timeTill = timeFrom + 86400 - 1;
const slotsPerDay = Math.floor(1440 / granularityMin);

const buckets = new Map();
function getBucket(slotKey) {
  let b = buckets.get(slotKey);
  if (!b) { b = { retellect: 0, scoApp: 0, db: 0, system: 0, timestamps: new Set(), sysCpuValues: [] }; buckets.set(slotKey, b); }
  return b;
}

for (let i = 0; i < itemIds.length; i += 20) {
  const records = await zbx("history.get", {
    output: ["itemid", "clock", "value"], itemids: itemIds.slice(i, i + 20),
    history: 0, time_from: String(timeFrom), time_till: String(timeTill),
    sortfield: "clock", sortorder: "ASC", limit: 50000,
  });
  for (const r of records) {
    const cat = categoryById.get(r.itemid); if (!cat) continue;
    const tsSec = parseInt(r.clock); const d = new Date(tsSec * 1000);
    const slotKey = `${isoDate}T${String(d.getHours()).padStart(2, "0")}:${String(Math.floor(d.getMinutes() / granularityMin) * granularityMin).padStart(2, "0")}`;
    const b = getBucket(slotKey);
    b[cat] += parseFloat(r.value) || 0;
    b.timestamps.add(tsSec);
  }
}

if (sysItem) {
  const sysRecords = await zbx("history.get", {
    output: ["clock", "value"], itemids: [sysItem.itemid],
    history: 0, time_from: String(timeFrom), time_till: String(timeTill),
    sortfield: "clock", sortorder: "ASC", limit: 50000,
  });
  for (const r of sysRecords) {
    const d = new Date(parseInt(r.clock) * 1000);
    const slotKey = `${isoDate}T${String(d.getHours()).padStart(2, "0")}:${String(Math.floor(d.getMinutes() / granularityMin) * granularityMin).padStart(2, "0")}`;
    const b = getBucket(slotKey);
    b.sysCpuValues.push(parseFloat(r.value) || 0);
  }
}

console.log(`\n=== ${host.name} on ${isoDate} (${granularityMin}min slots) ===`);
console.log("HOUR  Retellect    SCO    DB    System    SUM    sysCPU avg/max");
let peakHour = -1, peakSum = -1;
for (let i = 0; i < slotsPerDay; i++) {
  const totalMin = i * granularityMin;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const slotKey = `${isoDate}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  const b = buckets.get(slotKey);
  const samples = b ? Math.max(1, b.timestamps.size) : 1;
  const r = b ? b.retellect / samples : 0;
  const sa = b ? b.scoApp / samples : 0;
  const dbv = b ? b.db / samples : 0;
  const sys = b ? b.system / samples : 0;
  const sum = r + sa + dbv + sys;
  if (sum > peakSum) { peakSum = sum; peakHour = h; }
  const sysVals = b?.sysCpuValues ?? [];
  const sysAvg = sysVals.length ? sysVals.reduce((a, b) => a + b, 0) / sysVals.length : null;
  const sysMax = sysVals.length ? Math.max(...sysVals) : null;
  console.log(`  ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}  ${r.toFixed(1).padStart(5)}%  ${sa.toFixed(1).padStart(5)}%  ${dbv.toFixed(1).padStart(5)}%  ${sys.toFixed(1).padStart(5)}%   ${sum.toFixed(1).padStart(5)}%   ${sysAvg !== null ? sysAvg.toFixed(1) + "/" + sysMax.toFixed(1) + "%" : "—"}`);
}
console.log(`\nProcess peak hour: ${peakHour}:00 at ${peakSum.toFixed(1)}%`);
