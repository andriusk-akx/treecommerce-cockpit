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

const items = await zbx("item.get", {
  output: ["itemid", "hostid"],
  groupids: ["198"],
  search: { key_: "system.cpu.util[,,avg1]" },
});
console.log(`Items: ${items.length}`);

// Try trends.get for all items in one big batch
const t0 = Date.now();
const timeFrom = Math.floor(Date.now() / 1000) - 14 * 86400;
const trends = await zbx("trend.get", {
  output: ["itemid", "clock", "value_min", "value_avg", "value_max", "num"],
  itemids: items.map(i => i.itemid),
  time_from: String(timeFrom),
  limit: 50000,
});
console.log(`trend.get: ${trends.length} hourly records in ${Date.now() - t0}ms`);

if (trends.length === 0) {
  console.log("EMPTY — trends.get not enabled or no aggregates yet, falling back needed");
} else {
  // Group by item & local date
  const itemHostMap = new Map(items.map(i => [i.itemid, i.hostid]));
  const perItemDays = new Map();
  for (const t of trends) {
    const d = new Date(parseInt(t.clock) * 1000).toLocaleDateString("en-CA", { timeZone: "Europe/Vilnius" });
    const k = t.itemid;
    if (!perItemDays.has(k)) perItemDays.set(k, new Map());
    const m = perItemDays.get(k);
    if (!m.has(d)) m.set(d, { max: 0, n: 0 });
    const e = m.get(d);
    e.max = Math.max(e.max, parseFloat(t.value_max));
    e.n++;
  }

  const allDates = new Set();
  for (const m of perItemDays.values()) for (const d of m.keys()) allDates.add(d);
  const sortedDates = [...allDates].sort();
  console.log(`\nDate range: ${sortedDates[0]} → ${sortedDates[sortedDates.length-1]}, ${sortedDates.length} days`);
  console.log(`Items with at least one trend record: ${perItemDays.size} / ${items.length}`);

  // Specifically Pavilnionys SCO2
  const pavHosts = await zbx("host.get", { output: ["hostid", "name"], search: { name: "Pavilnionys" } });
  const pavSco2 = pavHosts.find(h => /SCO2\b/.test(h.name));
  if (pavSco2) {
    const pavItem = items.find(i => i.hostid === pavSco2.hostid);
    if (pavItem && perItemDays.has(pavItem.itemid)) {
      console.log(`\nPavilnionys SCO2 trends per day:`);
      const m = perItemDays.get(pavItem.itemid);
      for (const [d, e] of [...m.entries()].sort()) {
        console.log(`  ${d}: max=${e.max.toFixed(1)}% (${e.n} hourly records)`);
      }
    }
  }
}
