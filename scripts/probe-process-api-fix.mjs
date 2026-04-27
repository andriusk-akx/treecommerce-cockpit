// Verify the new process-history API math by replicating it locally.
// Probes SCO2 hour 18 (2026-04-18) and computes per-slot averages using
// the unique-timestamps approach (matches the fixed API).
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

const hosts = await zbx("host.get", {
  output: ["hostid", "name"],
  search: { name: "SCO2" },
  sortfield: "name",
});
const host = hosts.find(h => /\bSCO2\b/.test(h.name)) || hosts[0];
console.log("Host:", host.name, "(id=" + host.hostid + ")");

const items = await zbx("item.get", {
  output: ["itemid", "key_"],
  hostids: [host.hostid],
  filter: { status: 0, state: 0 },
});
const procs = items.filter(it => it.key_.endsWith(".cpu") && !it.key_.startsWith("perf_counter") && !it.key_.startsWith("system.cpu"));

const categoryById = new Map();
for (const it of procs) {
  const base = it.key_.replace(/\.cpu$/, "").toLowerCase();
  if (/^python\d*$/.test(base)) categoryById.set(it.itemid, "retellect");
  else if (base === "spss" || base === "sp.sss" || base === "sp") categoryById.set(it.itemid, "scoApp");
  else if (base === "sql" || base === "sqlservr") categoryById.set(it.itemid, "db");
  else if (base === "vm" || base === "vmware-vmx") categoryById.set(it.itemid, "system");
}
const itemIds = Array.from(categoryById.keys());
console.log(`Categorized ${itemIds.length} items: ${[...new Set(categoryById.values())].join(", ")}`);

// Fetch full day 04-18
const dt = new Date("2026-04-18T00:00:00");
const timeFrom = Math.floor(dt.getTime() / 1000);
const timeTill = timeFrom + 86400 - 1;
const granularityMin = 60;
const slotsPerDay = Math.floor(1440 / granularityMin);

const buckets = new Map();
for (let i = 0; i < itemIds.length; i += 20) {
  const batch = itemIds.slice(i, i + 20);
  const records = await zbx("history.get", {
    output: ["itemid", "clock", "value"],
    itemids: batch,
    history: 0,
    time_from: String(timeFrom),
    time_till: String(timeTill),
    sortfield: "clock",
    sortorder: "ASC",
    limit: 50000,
  });
  for (const r of records) {
    const cat = categoryById.get(r.itemid);
    if (!cat) continue;
    const tsSec = parseInt(r.clock);
    const tsMs = tsSec * 1000;
    const d = new Date(tsMs);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const minBucket = Math.floor(d.getMinutes() / granularityMin) * granularityMin;
    const mmm = String(minBucket).padStart(2, "0");
    const slotKey = `${yyyy}-${mm}-${dd}T${hh}:${mmm}`;
    let b = buckets.get(slotKey);
    if (!b) {
      b = { retellect: 0, scoApp: 0, db: 0, system: 0, timestamps: new Set() };
      buckets.set(slotKey, b);
    }
    b[cat] += parseFloat(r.value) || 0;
    b.timestamps.add(tsSec);
  }
}

console.log("\n=== Per-hour breakdown (NEW math: sum / unique_timestamps) ===");
console.log("HOUR  Retellect    SCO   DB    System    SUM    samples");
let peakHour = -1, peakSum = -1;
for (let i = 0; i < slotsPerDay; i++) {
  const totalMin = i * granularityMin;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const slotKey = `2026-04-18T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  const b = buckets.get(slotKey);
  const samples = b ? Math.max(1, b.timestamps.size) : 1;
  const r = b ? Math.round((b.retellect / samples) * 10) / 10 : 0;
  const sa = b ? Math.round((b.scoApp / samples) * 10) / 10 : 0;
  const dbv = b ? Math.round((b.db / samples) * 10) / 10 : 0;
  const sys = b ? Math.round((b.system / samples) * 10) / 10 : 0;
  const sum = r + sa + dbv + sys;
  if (sum > peakSum) { peakSum = sum; peakHour = h; }
  console.log(`  ${String(h).padStart(2, "0")}    ${String(r).padStart(5)}%   ${String(sa).padStart(4)}%  ${String(dbv).padStart(4)}%  ${String(sys).padStart(4)}%   ${sum.toFixed(1).padStart(5)}%   ${samples}smp`);
}
console.log(`\nPeak hour: ${peakHour}:00 at ${peakSum.toFixed(1)}%`);

// Compare with old broken math: count = retellect-only, no timestamp dedup
console.log("\n=== Old (buggy) math comparison: count=retellect-only ===");
const oldBuckets = new Map();
for (let i = 0; i < itemIds.length; i += 20) {
  const batch = itemIds.slice(i, i + 20);
  const records = await zbx("history.get", {
    output: ["itemid", "clock", "value"],
    itemids: batch, history: 0,
    time_from: String(timeFrom), time_till: String(timeTill),
    sortfield: "clock", sortorder: "ASC", limit: 50000,
  });
  for (const r of records) {
    const cat = categoryById.get(r.itemid);
    if (!cat) continue;
    const d = new Date(parseInt(r.clock) * 1000);
    const slotKey = `2026-04-18T${String(d.getHours()).padStart(2, "0")}:00`;
    let b = oldBuckets.get(slotKey);
    if (!b) { b = { retellect: 0, scoApp: 0, db: 0, system: 0, count: 0 }; oldBuckets.set(slotKey, b); }
    b[cat] += parseFloat(r.value) || 0;
    if (cat === "retellect") b.count++;
  }
}
let oldPeakHour = -1, oldPeakSum = -1;
for (let h = 0; h < 24; h++) {
  const slotKey = `2026-04-18T${String(h).padStart(2, "0")}:00`;
  const b = oldBuckets.get(slotKey);
  if (!b) continue;
  const samples = Math.max(1, b.count);
  const sum = (b.retellect + b.scoApp + b.db + b.system) / samples;
  if (sum > oldPeakSum) { oldPeakSum = sum; oldPeakHour = h; }
}
console.log(`Old peak: ${oldPeakHour}:00 at ${oldPeakSum.toFixed(1)}%  (after /4 cores: ${(oldPeakSum / 4).toFixed(1)}%)`);
