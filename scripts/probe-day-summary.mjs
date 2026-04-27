// Verify the new daySummary logic by running the same math against
// SHM Pavilnionys [T803] SCO2 — known to have 100% peak on 04-18.
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
const host = hosts.find(h => /SCO2/.test(h.name));
console.log("Host:", host.name, "id=" + host.hostid);

const items = await zbx("item.get", {
  output: ["itemid", "key_"], hostids: [host.hostid],
  filter: { key_: ["system.cpu.util[,,avg1]"] },
});
const item = items[0];

const dt = new Date("2026-04-18T00:00:00");
const timeFrom = Math.floor(dt.getTime() / 1000);
const timeTill = timeFrom + 86400 - 1;

const samples = await zbx("history.get", {
  output: ["clock", "value"], itemids: [item.itemid],
  history: 0, time_from: String(timeFrom), time_till: String(timeTill),
  sortfield: "clock", sortorder: "ASC", limit: 50000,
});

if (!samples.length) { console.log("no samples"); process.exit(0); }

const peak = samples.reduce((m, s) => parseFloat(s.value) > parseFloat(m.value) ? s : m);
const peakLocal = new Date(parseInt(peak.clock) * 1000).toLocaleTimeString("lt-LT", { timeZone: "Europe/Vilnius", hour12: false });
const sum = samples.reduce((acc, s) => acc + parseFloat(s.value), 0);
const above = (t) => samples.filter(s => parseFloat(s.value) >= t).length;

console.log(`\n=== Day summary for ${host.name} on 2026-04-18 ===`);
console.log(`samples       : ${samples.length}`);
console.log(`day max       : ${parseFloat(peak.value).toFixed(1)}% at ${peakLocal} Vilnius`);
console.log(`day avg       : ${(sum / samples.length).toFixed(1)}%`);
console.log(`min ≥ 95%     : ${above(95)}`);
console.log(`min ≥ 90%     : ${above(90)}`);
console.log(`min ≥ 70%     : ${above(70)}`);
console.log(`min ≥ 50%     : ${above(50)}`);
console.log();
console.log("Top 10 minutes:");
const top10 = [...samples].sort((a, b) => parseFloat(b.value) - parseFloat(a.value)).slice(0, 10);
for (const s of top10) {
  const local = new Date(parseInt(s.clock) * 1000).toLocaleTimeString("lt-LT", { timeZone: "Europe/Vilnius", hour12: false });
  console.log(`  ${local} → ${parseFloat(s.value).toFixed(1)}%`);
}
