// Inventory of CPU-related Zabbix items on Pavilnionys SCO2 + their reading
// at 18:23. Goal: identify what we should add to the dashboard to shrink the
// "Other" gap (host CPU vs sum of currently monitored 4 categories).
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
console.log("Host:", host.name, "(" + host.hostid + ")");

const items = await zbx("item.get", {
  output: ["itemid", "key_", "name", "lastvalue", "lastclock", "delay", "status", "units"],
  hostids: [host.hostid],
  filter: { status: 0 },
});
console.log(`\nTotal active items: ${items.length}`);

// Group by CPU-relevance
const cpuRelated = items.filter(it =>
  /cpu|process|proc\b/i.test(it.key_) || /cpu|process/i.test(it.name)
);
console.log(`CPU-related items: ${cpuRelated.length}\n`);

console.log("KEY".padEnd(40) + "  LAST".padStart(10) + "  AGE".padStart(8) + "  NAME");
console.log("─".repeat(120));
for (const it of cpuRelated.sort((a, b) => a.key_.localeCompare(b.key_))) {
  const ageMin = it.lastclock === "0" ? -1 : Math.round((Date.now() / 1000 - parseInt(it.lastclock)) / 60);
  const ageStr = ageMin < 0 ? "never" : ageMin < 60 ? `${ageMin}m` : `${Math.round(ageMin / 60)}h`;
  const last = it.lastvalue === "" ? "—" : parseFloat(it.lastvalue || "0").toFixed(2);
  console.log(it.key_.slice(0, 38).padEnd(40) + "  " + (last + (it.units || "%")).padStart(10) + "  " + ageStr.padStart(8) + "  " + (it.name || "").slice(0, 60));
}

// Now reading at 18:23 specifically — for every CPU item that has 1-min sampling.
console.log("\n=== CPU items reading at 2026-04-25 18:23 (Vilnius) ===");
const dt18 = new Date("2026-04-25T18:23:00");
const t = Math.floor(dt18.getTime() / 1000);
const window = 120; // ±2min
const candidates = cpuRelated.filter(it => it.lastclock !== "0" && parseFloat(it.lastvalue || "0") !== 0);
console.log(`Candidates with non-zero last value: ${candidates.length}`);

for (const it of candidates) {
  try {
    const recs = await zbx("history.get", {
      output: ["clock", "value"], itemids: [it.itemid], history: 0,
      time_from: String(t - window), time_till: String(t + window),
      sortfield: "clock", sortorder: "ASC", limit: 10,
    });
    if (!recs.length) {
      // Try float type 0, then int 3, double 0 — already 0; skip.
      continue;
    }
    // Find sample closest to 18:23
    const closest = recs.reduce((m, r) => Math.abs(parseInt(r.clock) - t) < Math.abs(parseInt(m.clock) - t) ? r : m);
    const localTs = new Date(parseInt(closest.clock) * 1000).toLocaleTimeString("lt-LT", { timeZone: "Europe/Vilnius", hour12: false });
    console.log(`  ${it.key_.slice(0, 36).padEnd(38)}  ${parseFloat(closest.value).toFixed(2).padStart(8)}%  @${localTs}`);
  } catch {
    // skip
  }
}
