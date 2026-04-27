// At Pavilnionys SCO2 04-18 14:48, "Other" = 63.1% of CPU. Find every CPU
// item that had a non-zero value at that minute.
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
console.log("Host:", host.name);

const items = await zbx("item.get", {
  output: ["itemid", "key_", "name"],
  hostids: [host.hostid],
  filter: { status: 0, state: 0 },
});

// Window: 04-18 14:48 ±2min Vilnius
const t = Math.floor(new Date("2026-04-18T14:48:00").getTime() / 1000);

const cpuItems = items.filter(it => /cpu/i.test(it.key_) || /process/i.test(it.key_));
console.log(`\nProbing ${cpuItems.length} CPU/process items at 14:48 (±2min):\n`);

const results = [];
for (const it of cpuItems) {
  for (const valueType of [0, 3]) {
    const recs = await zbx("history.get", {
      output: ["clock", "value"], itemids: [it.itemid], history: valueType,
      time_from: String(t - 120), time_till: String(t + 120),
      sortfield: "clock", sortorder: "ASC", limit: 10,
    });
    if (recs.length) {
      const closest = recs.reduce((m, r) => Math.abs(parseInt(r.clock) - t) < Math.abs(parseInt(m.clock) - t) ? r : m);
      const v = parseFloat(closest.value);
      results.push({ key: it.key_, value: v, name: it.name });
      break;
    }
  }
}

// Sort by value desc, show what's actually consuming CPU
results.sort((a, b) => b.value - a.value);
console.log("KEY".padEnd(48) + "  VALUE       NAME");
console.log("─".repeat(110));
for (const r of results) {
  console.log(r.key.slice(0, 46).padEnd(48) + "  " + r.value.toFixed(2).padStart(8) + "%  " + (r.name || "").slice(0, 50));
}

// Sum the per-process *.cpu items (monitored categories) vs system.cpu.util
const procSum = results
  .filter(r => r.key.endsWith(".cpu") && !r.key.startsWith("perf_counter") && !r.key.startsWith("system.cpu"))
  .reduce((s, r) => s + r.value, 0);
const sysCpu = results.find(r => r.key === "system.cpu.util[,,avg1]")?.value ?? 0;
console.log();
console.log(`Sum of all *.cpu items: ${procSum.toFixed(2)}%`);
console.log(`system.cpu.util[,,avg1]: ${sysCpu.toFixed(2)}%`);
console.log(`Gap (Other): ${(sysCpu - procSum).toFixed(2)}%`);
