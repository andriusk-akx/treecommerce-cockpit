// Diagnose: how far back do trend.get and history.get actually return data?
// User reports: dashboard "shows nothing older than 14 days for any host".
// We need to know whether trend retention is short (server-side cap) or
// whether the per-item history.get limit=25000 is silently truncating the
// older days.
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

// Pick a known production host group with active monitoring: Rimi.
const items = await zbx("item.get", {
  output: ["itemid", "hostid", "key_"],
  groupids: ["198"],
  search: { key_: "system.cpu.util[,,avg1]" },
});
console.log(`Found ${items.length} system.cpu.util[,,avg1] items in Rimi group.`);
if (items.length === 0) process.exit(0);

// Take a small sample so the per-item history call returns fast.
const sample = items.slice(0, 5);
const sampleIds = sample.map((i) => i.itemid);

console.log("\n────── 1. trend.get over the last 60 days ──────");
const t0 = Date.now();
const trends = await zbx("trend.get", {
  output: ["itemid", "clock", "value_max"],
  itemids: sampleIds,
  time_from: String(Math.floor(Date.now() / 1000) - 60 * 86400),
  limit: 100000,
});
console.log(`  trend.get returned ${trends.length} records in ${Date.now() - t0}ms`);
const trendDates = new Set(trends.map((t) => localDate(parseInt(t.clock))));
const sortedTrendDates = [...trendDates].sort();
console.log(`  Date span: ${sortedTrendDates[0]} → ${sortedTrendDates.at(-1)} (${trendDates.size} days)`);

console.log("\n────── 2. history.get per item, last 60 days, limit=25000 DESC ──────");
for (const it of sample) {
  const t1 = Date.now();
  const rows = await zbx("history.get", {
    output: ["clock"],
    itemids: [it.itemid],
    history: 0,
    time_from: String(Math.floor(Date.now() / 1000) - 60 * 86400),
    sortfield: "clock",
    sortorder: "DESC",
    limit: 25000,
  });
  const dates = new Set(rows.map((r) => localDate(parseInt(r.clock))));
  const sorted = [...dates].sort();
  console.log(`  item ${it.itemid}: ${rows.length} records, ${dates.size} days, span ${sorted[0] ?? "—"} → ${sorted.at(-1) ?? "—"} (${Date.now() - t1}ms)`);
}

console.log("\n────── 3. history.get per item, last 60 days, NO limit ASC ──────");
// What does Zabbix's actual history retention give us if we don't truncate?
const it0 = sample[0];
const t2 = Date.now();
const allRows = await zbx("history.get", {
  output: ["clock"],
  itemids: [it0.itemid],
  history: 0,
  time_from: String(Math.floor(Date.now() / 1000) - 60 * 86400),
  sortfield: "clock",
  sortorder: "ASC",
});
const allDates = new Set(allRows.map((r) => localDate(parseInt(r.clock))));
const allSorted = [...allDates].sort();
console.log(`  item ${it0.itemid}: ${allRows.length} records, ${allDates.size} days, span ${allSorted[0] ?? "—"} → ${allSorted.at(-1) ?? "—"} (${Date.now() - t2}ms)`);
