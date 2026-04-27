// Replicate the FIXED API math (per-category sample count) on Pavilnionys SCO2
// at 18:23 to verify monitored sum now matches host CPU.
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

const hosts = await zbx("host.get", { output: ["hostid", "name"], search: { name: "Pavilnionys" } });
const host = hosts.find(h => /SCO2\b/.test(h.name));
const allItems = await zbx("item.get", {
  output: ["itemid", "key_"], hostids: [host.hostid], filter: { status: 0, state: 0 },
});
const procs = allItems.filter(it => it.key_.endsWith(".cpu") && !it.key_.startsWith("perf_counter") && !it.key_.startsWith("system.cpu"));
const sysItem = allItems.find(it => it.key_ === "system.cpu.util[,,avg1]");

const categoryById = new Map();
for (const it of procs) {
  const base = it.key_.replace(/\.cpu$/, "").toLowerCase();
  if (/^python\d*$/.test(base)) categoryById.set(it.itemid, "retellect");
  else if (base === "spss" || base === "sp.sss" || base === "sp") categoryById.set(it.itemid, "scoApp");
  else if (base === "sql" || base === "sqlservr") categoryById.set(it.itemid, "db");
  else if (base === "vm" || base === "vmware-vmx") categoryById.set(it.itemid, "system");
}

// Probe a representative day: 2026-04-25, 1-min granularity
const dt = new Date("2026-04-25T00:00:00");
const timeFrom = Math.floor(dt.getTime() / 1000);
const timeTill = timeFrom + 86400 - 1;
const granularityMin = 1;

const buckets = new Map();
const itemIds = Array.from(categoryById.keys());
for (let i = 0; i < itemIds.length; i += 20) {
  const batch = itemIds.slice(i, i + 20);
  const records = await zbx("history.get", {
    output: ["itemid", "clock", "value"], itemids: batch, history: 0,
    time_from: String(timeFrom), time_till: String(timeTill),
    sortfield: "clock", sortorder: "ASC", limit: 50000,
  });
  for (const r of records) {
    const cat = categoryById.get(r.itemid);
    if (!cat) continue;
    const d = new Date(parseInt(r.clock) * 1000);
    const slotKey = `2026-04-25T${String(d.getHours()).padStart(2, "0")}:${String(Math.floor(d.getMinutes() / granularityMin) * granularityMin).padStart(2, "0")}`;
    let b = buckets.get(slotKey);
    if (!b) { b = { retellect: 0, scoApp: 0, db: 0, system: 0, countR: 0, countS: 0, countD: 0, countSys: 0, sysCpuValues: [] }; buckets.set(slotKey, b); }
    b[cat] += parseFloat(r.value) || 0;
    if (cat === "retellect") b.countR++;
    else if (cat === "scoApp") b.countS++;
    else if (cat === "db") b.countD++;
    else if (cat === "system") b.countSys++;
  }
}

// system.cpu.util
const sysRecs = await zbx("history.get", {
  output: ["clock", "value"], itemids: [sysItem.itemid], history: 0,
  time_from: String(timeFrom), time_till: String(timeTill),
  sortfield: "clock", sortorder: "ASC", limit: 50000,
});
for (const r of sysRecs) {
  const d = new Date(parseInt(r.clock) * 1000);
  const slotKey = `2026-04-25T${String(d.getHours()).padStart(2, "0")}:${String(Math.floor(d.getMinutes() / granularityMin) * granularityMin).padStart(2, "0")}`;
  let b = buckets.get(slotKey);
  if (!b) { b = { retellect: 0, scoApp: 0, db: 0, system: 0, countR: 0, countS: 0, countD: 0, countSys: 0, sysCpuValues: [] }; buckets.set(slotKey, b); }
  b.sysCpuValues.push(parseFloat(r.value) || 0);
}

console.log(`Pavilnionys SCO2 — 04-25 around 18:23 (FIXED math, per-category divisor):\n`);
console.log("SLOT       Retellect    SCO     DB    System  | Sum  | Host max  | Other");
for (const slotKey of [...buckets.keys()].filter(k => k.includes("T18:2")).sort()) {
  const b = buckets.get(slotKey);
  const r = b.countR > 0 ? b.retellect / b.countR : 0;
  const sa = b.countS > 0 ? b.scoApp / b.countS : 0;
  const dbv = b.countD > 0 ? b.db / b.countD : 0;
  const sys = b.countSys > 0 ? b.system / b.countSys : 0;
  const sum = r + sa + dbv + sys;
  const sysMax = b.sysCpuValues.length ? Math.max(...b.sysCpuValues) : 0;
  const other = Math.max(0, sysMax - sum);
  const slotShort = slotKey.split("T")[1];
  console.log(`${slotShort}    ${r.toFixed(2).padStart(5)}%   ${sa.toFixed(2).padStart(5)}%   ${dbv.toFixed(2).padStart(5)}%   ${sys.toFixed(2).padStart(5)}%   | ${sum.toFixed(1).padStart(5)}% | ${sysMax.toFixed(1).padStart(6)}%   | ${other.toFixed(1).padStart(5)}%`);
}
