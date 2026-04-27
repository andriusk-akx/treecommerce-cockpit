// Replicate the new getCpuHistoryDaily implementation locally and verify
// Pavilnionys SCO2 now has data for every recent day.
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
  output: ["itemid", "hostid"], groupids: ["198"],
  search: { key_: "system.cpu.util[,,avg1]" },
});
console.log(`Items: ${items.length}`);

const hostIds = await zbx("host.get", { output: ["hostid", "name"], hostids: items.map(i => i.hostid) });
const hostNameMap = new Map(hostIds.map(h => [h.hostid, h.name]));

const itemIds = items.map(i => i.itemid);
const itemHostMap = new Map(items.map(i => [i.itemid, i.hostid]));
const timeFrom = Math.floor(Date.now() / 1000) - 14 * 86400;

const dailyMap = new Map();
const localDate = (clockSec) => new Date(clockSec * 1000).toLocaleDateString("en-CA", { timeZone: "Europe/Vilnius" });
const merge = (hostId, date, value) => {
  const key = `${hostId}|${date}`;
  const b = dailyMap.get(key);
  if (b) { b.max = Math.max(b.max, value); b.min = Math.min(b.min, value); b.sum += value; b.count++; }
  else { dailyMap.set(key, { max: value, sum: value, min: value, count: 1 }); }
};

// 1) trend.get
const t0 = Date.now();
try {
  const trends = await zbx("trend.get", {
    output: ["itemid", "clock", "value_min", "value_avg", "value_max"],
    itemids: itemIds, time_from: String(timeFrom), limit: 100000,
  });
  console.log(`trend.get: ${trends.length} records in ${Date.now() - t0}ms`);
  for (const t of trends) {
    const hostId = itemHostMap.get(t.itemid);
    if (!hostId) continue;
    const date = localDate(parseInt(t.clock));
    const vmax = parseFloat(t.value_max) || 0;
    const vavg = parseFloat(t.value_avg) || 0;
    const vmin = parseFloat(t.value_min) || 0;
    const key = `${hostId}|${date}`;
    const b = dailyMap.get(key);
    if (b) { b.max = Math.max(b.max, vmax); b.min = Math.min(b.min, vmin); b.sum += vavg; b.count++; }
    else { dailyMap.set(key, { max: vmax, sum: vavg, min: vmin, count: 1 }); }
  }
} catch (e) { console.warn("trend.get failed:", e.message); }

// 2) per-item history.get with concurrency 8
const t1 = Date.now();
const fetchOne = async (itemId) => {
  try {
    const records = await zbx("history.get", {
      output: ["itemid", "clock", "value"],
      itemids: [itemId], history: 0, time_from: String(timeFrom),
      sortfield: "clock", sortorder: "DESC", limit: 25000,
    });
    const hostId = itemHostMap.get(itemId);
    if (!hostId) return;
    for (const r of records) {
      const date = localDate(parseInt(r.clock));
      merge(hostId, date, parseFloat(r.value) || 0);
    }
  } catch (e) { console.warn(`item ${itemId}:`, e.message); }
};
for (let i = 0; i < itemIds.length; i += 8) {
  const slice = itemIds.slice(i, i + 8);
  await Promise.all(slice.map(fetchOne));
}
console.log(`history.get per-item (concurrency 8): ${Date.now() - t1}ms`);
console.log(`Total dailyMap entries: ${dailyMap.size}`);

// Pavilnionys SCO2
const pavHosts = await zbx("host.get", { output: ["hostid", "name"], search: { name: "Pavilnionys" } });
const pavSco2 = pavHosts.find(h => /SCO2\b/.test(h.name));
if (pavSco2) {
  console.log(`\n=== ${pavSco2.name} timeline ===`);
  for (const [k, v] of [...dailyMap.entries()].filter(([k]) => k.startsWith(pavSco2.hostid + "|")).sort()) {
    const date = k.split("|")[1];
    console.log(`  ${date}: max=${v.max.toFixed(1)}%  avg=${(v.sum/v.count).toFixed(1)}%  (${v.count} records)`);
  }
}
