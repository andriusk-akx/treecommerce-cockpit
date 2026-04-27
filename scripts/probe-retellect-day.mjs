// CHM Outlet SCO3 has retellectEnabled but Retellect % suspiciously low.
// Get the FULL day of python perf_counters to see if it's consistently low,
// or whether the screenshot just hit a quiet minute. Also probe other CHM
// Outlet hosts to compare.
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

const hosts = await zbx("host.get", { output: ["hostid", "name"], search: { name: "CHM Outlet" } });

// For each CHM Outlet host: get python perf_counter sum over 04-26 (day so far)
const dt = new Date("2026-04-26T00:00:00");
const tFrom = Math.floor(dt.getTime() / 1000);
const tTill = tFrom + 86400 - 1;

console.log("CHM Outlet hosts — per-day Retellect (python sum) statistics:");
console.log("HOST".padEnd(36) + "  CORES   N(samples)  AVG    MAX    DAY MAX SCO   DAY MAX HOST");
console.log("-".repeat(110));

for (const h of hosts) {
  const items = await zbx("item.get", {
    output: ["itemid", "key_", "lastvalue"],
    hostids: [h.hostid],
    filter: { status: 0 },
  });
  const numCpu = items.find(i => i.key_ === "system.cpu.num");
  const cores = Math.max(1, parseInt(numCpu?.lastvalue || "1") || 1);
  const pythonItems = items.filter(i => /^perf_counter\[.*Process\(python(#\d+)?\).*Processor Time/.test(i.key_));
  const spssItem = items.find(i => /^perf_counter\[.*Process\(sp\.sss\).*Processor Time/.test(i.key_));
  const sysCpu = items.find(i => i.key_ === "system.cpu.util[,,avg1]");

  if (pythonItems.length === 0) {
    console.log(h.name.slice(0, 34).padEnd(36) + "  no python perf_counter items");
    continue;
  }

  // Aggregate python sum per minute slot
  const slotSum = new Map(); // slotKey -> sum of all python values at that slot
  for (const it of pythonItems) {
    const recs = await zbx("history.get", {
      output: ["clock", "value"], itemids: [it.itemid], history: 0,
      time_from: String(tFrom), time_till: String(tTill),
      sortfield: "clock", sortorder: "ASC", limit: 5000,
    });
    for (const r of recs) {
      const min = Math.floor(parseInt(r.clock) / 60);
      slotSum.set(min, (slotSum.get(min) ?? 0) + (parseFloat(r.value) || 0));
    }
  }

  if (slotSum.size === 0) { console.log(h.name.slice(0, 34).padEnd(36) + "  no samples"); continue; }
  const values = [...slotSum.values()].map(v => v / cores); // normalize to % of host
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const max = Math.max(...values);

  // SCO app peak (sp.sss) for comparison
  let scoPeak = 0;
  if (spssItem) {
    const recs = await zbx("history.get", {
      output: ["value"], itemids: [spssItem.itemid], history: 0,
      time_from: String(tFrom), time_till: String(tTill), sortfield: "clock", sortorder: "ASC", limit: 5000,
    });
    if (recs.length) scoPeak = Math.max(...recs.map(r => parseFloat(r.value))) / cores;
  }
  let hostPeak = 0;
  if (sysCpu) {
    const recs = await zbx("history.get", {
      output: ["value"], itemids: [sysCpu.itemid], history: 0,
      time_from: String(tFrom), time_till: String(tTill), sortfield: "clock", sortorder: "ASC", limit: 5000,
    });
    if (recs.length) hostPeak = Math.max(...recs.map(r => parseFloat(r.value)));
  }

  console.log(
    h.name.slice(0, 34).padEnd(36) +
    "  " + String(cores).padStart(2) +
    "      " + String(values.length).padStart(5) +
    "       " + avg.toFixed(2).padStart(5) + "% " +
    " " + max.toFixed(2).padStart(5) + "%  " +
    " " + scoPeak.toFixed(1).padStart(5) + "%       " +
    " " + hostPeak.toFixed(1).padStart(5) + "%"
  );
}
