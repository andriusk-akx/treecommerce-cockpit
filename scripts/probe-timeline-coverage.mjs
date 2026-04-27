// Replicate the page-level getCpuHistoryDaily fetch and check whether limit=50000
// truncates recent days for some hosts.
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

// Get system.cpu.util items for a representative subset of hosts
const items = await zbx("item.get", {
  output: ["itemid", "hostid", "key_", "delay"],
  groupids: ["198"],
  search: { key_: "system.cpu.util[,,avg1]" },
});
console.log(`Total system.cpu.util[,,avg1] items: ${items.length}`);
const delays = new Map();
for (const it of items) delays.set(it.delay, (delays.get(it.delay) ?? 0) + 1);
console.log("Item delays:", [...delays.entries()].map(([d, c]) => `${d}=${c}`).join(", "));

const itemIds = items.slice(0, 20).map(it => it.itemid);
const itemHostMap = new Map(items.slice(0, 20).map(it => [it.itemid, it.hostid]));
console.log(`\nProbing batch of ${itemIds.length} items with limit=50000 (current code)`);
const timeFrom = Math.floor(Date.now() / 1000) - 14 * 86400;
const records = await zbx("history.get", {
  output: ["itemid", "clock", "value"],
  itemids: itemIds, history: 0, time_from: String(timeFrom),
  sortfield: "clock", sortorder: "ASC", limit: 50000,
});
console.log(`Records returned: ${records.length} (expected ~20 × 14d × 1440min = 403200 if 1-min sampling)`);

// Group records per item per day
const perItemDays = new Map();
for (const r of records) {
  const date = new Date(parseInt(r.clock) * 1000).toLocaleDateString("en-CA", { timeZone: "Europe/Vilnius" });
  const key = r.itemid;
  if (!perItemDays.has(key)) perItemDays.set(key, new Map());
  const m = perItemDays.get(key);
  m.set(date, (m.get(date) ?? 0) + 1);
}

const allDates = new Set();
for (const m of perItemDays.values()) for (const d of m.keys()) allDates.add(d);
const sortedDates = [...allDates].sort();
console.log(`\nDate range covered: ${sortedDates[0]} → ${sortedDates[sortedDates.length - 1]}`);
console.log(`Days: ${sortedDates.length}`);

console.log("\nSamples per item per day:");
console.log("ITEM        ", sortedDates.map(d => d.slice(5)).join("  "));
for (const [iid, m] of [...perItemDays.entries()].slice(0, 8)) {
  const hostId = itemHostMap.get(iid);
  const row = sortedDates.map(d => String(m.get(d) ?? 0).padStart(5)).join("  ");
  console.log(`item ${iid} (h${hostId}):  ${row}`);
}

// Test newer hosts specifically — the user complained about Pavilnionys
console.log("\n=== Pavilnionys SCO2 specifically ===");
const pav = items.find(it => false); // we don't have host names yet, query
const pavHosts = await zbx("host.get", { output: ["hostid", "name"], search: { name: "Pavilnionys" } });
const pavSco2 = pavHosts.find(h => /SCO2\b/.test(h.name));
if (pavSco2) {
  console.log(`Host: ${pavSco2.name} (${pavSco2.hostid})`);
  const pavItem = items.find(it => it.hostid === pavSco2.hostid);
  if (pavItem) {
    console.log(`Item: ${pavItem.itemid} delay=${pavItem.delay}`);
    // Fetch directly with bigger limit
    const pavRecs = await zbx("history.get", {
      output: ["clock"], itemids: [pavItem.itemid], history: 0,
      time_from: String(timeFrom),
      sortfield: "clock", sortorder: "ASC", limit: 100000,
    });
    console.log(`Direct fetch (limit=100000): ${pavRecs.length} samples`);
    const dayCounts = new Map();
    for (const r of pavRecs) {
      const d = new Date(parseInt(r.clock) * 1000).toLocaleDateString("en-CA", { timeZone: "Europe/Vilnius" });
      dayCounts.set(d, (dayCounts.get(d) ?? 0) + 1);
    }
    for (const [d, n] of [...dayCounts.entries()].sort()) console.log(`   ${d}: ${n} samples`);
  }
}
