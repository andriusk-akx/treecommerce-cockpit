// CHM Outlet SC03 has retellectEnabled = true but dashboard shows Retellect ~0.2%.
// Inventory every CPU-related item on this host + recent values to find out
// whether Retellect is actually running, and if so under which item key.
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
console.log("Found CHM Outlet hosts:");
for (const h of hosts) console.log("  " + h.name + " (id=" + h.hostid + ")");
const host = hosts.find(h => /SCO?03\b|SCO3\b/.test(h.name)) || hosts[0];
console.log("\nUsing:", host.name);

// All items
const items = await zbx("item.get", {
  output: ["itemid", "key_", "name", "lastvalue", "lastclock", "delay"],
  hostids: [host.hostid],
  filter: { status: 0, state: 0 },
});
console.log("\n=== ALL active items (" + items.length + ") ===");

// CPU/process related
const cpu = items.filter(it => /cpu|process|proc\b|python|sql|spss|sp\.|vm|udm|nhst|cs300|retellect/i.test(it.key_));
console.log("\n=== CPU / process / Retellect items (" + cpu.length + ") ===");
console.log("KEY".padEnd(60) + "  LAST".padStart(10) + "  AGE".padStart(8));
console.log("-".repeat(90));
for (const it of cpu.sort((a, b) => a.key_.localeCompare(b.key_))) {
  const ageMin = it.lastclock === "0" ? -1 : Math.round((Date.now() / 1000 - parseInt(it.lastclock)) / 60);
  const ageStr = ageMin < 0 ? "never" : ageMin < 60 ? `${ageMin}m` : `${Math.round(ageMin / 60)}h`;
  const last = it.lastvalue === "" ? "—" : (parseFloat(it.lastvalue) || 0).toFixed(2);
  console.log(it.key_.slice(0, 58).padEnd(60) + "  " + last.padStart(10) + "  " + ageStr.padStart(8));
}

// Probe at the moment shown in screenshot: 04-26 06:53 Vilnius
const t = Math.floor(new Date("2026-04-26T06:53:00").getTime() / 1000);
console.log("\n=== Values at 2026-04-26 06:53 Vilnius (window ±2min) ===");
console.log("KEY".padEnd(60) + "  VALUE");
console.log("-".repeat(80));
for (const it of cpu) {
  for (const vt of [0, 3]) {
    const recs = await zbx("history.get", {
      output: ["clock", "value"], itemids: [it.itemid], history: vt,
      time_from: String(t - 120), time_till: String(t + 120),
      sortfield: "clock", sortorder: "ASC", limit: 10,
    });
    if (recs.length) {
      const closest = recs.reduce((m, r) => Math.abs(parseInt(r.clock) - t) < Math.abs(parseInt(m.clock) - t) ? r : m);
      const v = parseFloat(closest.value);
      if (v > 0.001) console.log(it.key_.slice(0, 58).padEnd(60) + "  " + v.toFixed(2) + "%");
      break;
    }
  }
}
