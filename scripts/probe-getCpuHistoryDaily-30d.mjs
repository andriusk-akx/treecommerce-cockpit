// Replicates ZabbixClient._getCpuHistoryDailyUncached with daysBack=30 to
// see whether the merged dailyMap actually contains older days.
import * as fs from "node:fs";

const env = fs.readFileSync(".env.local", "utf8");
const TOKEN = env.match(/^ZABBIX_TOKEN=["']?([^"'\n]+)/m)[1];
const URL = "https://monitoring.strongpoint.com/api_jsonrpc.php";

async function zbx(method, params = {}) {
  const res = await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: Math.random() }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

const localDate = (sec) =>
  new Date(sec * 1000).toLocaleDateString("en-CA", { timeZone: "Europe/Vilnius" });

// Same item discovery as the page (system.cpu.util[,,avg1]) for Rimi group.
const items = await zbx("item.get", {
  output: ["itemid", "hostid", "key_"],
  groupids: ["198"],
  search: { key_: "system.cpu.util" },
});
const filtered = items.filter((i) => i.key_ === "system.cpu.util[,,avg1]" || i.key_ === "system.cpu.util");
console.log(`Items after filter: ${filtered.length}`);

// Take FIRST 10 items to keep the probe quick.
const sample = filtered.slice(0, 10);
const itemIds = sample.map((i) => i.itemid);
const itemHostMap = new Map(sample.map((i) => [i.itemid, i.hostid]));

const daysBack = 30;
const timeFrom = Math.floor(Date.now() / 1000) - daysBack * 86400;

// 1) trend.get
const trends = await zbx("trend.get", {
  output: ["itemid", "clock", "value_min", "value_avg", "value_max"],
  itemids: itemIds,
  time_from: String(timeFrom),
  limit: 100000,
});
console.log(`trend.get: ${trends.length} records`);

// 2) history.get per item, limit 25000 DESC
const allHistory = [];
for (const id of itemIds) {
  const rows = await zbx("history.get", {
    output: ["itemid", "clock", "value"],
    itemids: [id],
    history: 0,
    time_from: String(timeFrom),
    sortfield: "clock",
    sortorder: "DESC",
    limit: 25000,
  });
  allHistory.push(...rows);
}
console.log(`history.get total: ${allHistory.length} records`);

// 3) Merge
const dailyMap = new Map();
const merge = (hostId, date, v) => {
  const k = `${hostId}|${date}`;
  if (!dailyMap.has(k)) dailyMap.set(k, { max: v, n: 1 });
  else {
    const b = dailyMap.get(k);
    b.max = Math.max(b.max, v);
    b.n++;
  }
};
for (const t of trends) {
  const h = itemHostMap.get(t.itemid);
  if (!h) continue;
  merge(h, localDate(parseInt(t.clock)), parseFloat(t.value_max) || 0);
}
for (const r of allHistory) {
  const h = itemHostMap.get(r.itemid);
  if (!h) continue;
  merge(h, localDate(parseInt(r.clock)), parseFloat(r.value) || 0);
}

// 4) Aggregate by date globally — how many hosts have data on each day?
const dateHostCount = new Map();
for (const k of dailyMap.keys()) {
  const date = k.split("|")[1];
  dateHostCount.set(date, (dateHostCount.get(date) || 0) + 1);
}
const sorted = [...dateHostCount.entries()].sort();
console.log(`\nPer-day host coverage (out of ${sample.length} sampled items):`);
for (const [d, n] of sorted) {
  const bar = "█".repeat(n);
  console.log(`  ${d}: ${String(n).padStart(2)} ${bar}`);
}
console.log(`\nTotal distinct days: ${sorted.length}`);
console.log(`Span: ${sorted[0]?.[0]} → ${sorted.at(-1)?.[0]}`);
