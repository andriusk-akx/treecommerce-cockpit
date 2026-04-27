// Find which SCO2 host has actual 100% peak on 04-18.
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

const hosts = await zbx("host.get", { output: ["hostid", "name"], search: { name: "SCO2" } });
const sco2Hosts = hosts.filter(h => /\bSCO2\b/.test(h.name));
console.log("SCO2 hosts:", sco2Hosts.length);

const dt = new Date("2026-04-18T00:00:00Z");
const fromUtc = Math.floor(dt.getTime() / 1000) - 12 * 3600;
const tillUtc = fromUtc + 86400 + 24 * 3600;

console.log("\nProbing each SCO2 host for 04-18 system.cpu.util max:");
for (const h of sco2Hosts) {
  const items = await zbx("item.get", {
    output: ["itemid", "key_"],
    hostids: [h.hostid],
    filter: { key_: ["system.cpu.util[,,avg1]", "system.cpu.util"] },
  });
  if (!items.length) {
    console.log(`  ${h.name.padEnd(45)} NO system.cpu.util item`);
    continue;
  }
  const recs = await zbx("history.get", {
    output: ["clock", "value"],
    itemids: [items[0].itemid],
    history: 0, time_from: String(fromUtc), time_till: String(tillUtc),
    sortfield: "clock", sortorder: "ASC", limit: 5000,
  });
  if (!recs.length) { console.log(`  ${h.name.padEnd(45)} no history`); continue; }
  const max = Math.max(...recs.map(r => parseFloat(r.value)));
  const peakRec = recs.reduce((m, r) => parseFloat(r.value) > parseFloat(m.value) ? r : m);
  const peakLocal = new Date(parseInt(peakRec.clock) * 1000).toLocaleString("lt-LT", { timeZone: "Europe/Vilnius" });
  console.log(`  ${h.name.padEnd(45)} max=${max.toFixed(1)}%  peak@${peakLocal}  (n=${recs.length})`);
}
