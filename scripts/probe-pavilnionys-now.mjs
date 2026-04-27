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
  output: ["itemid", "key_", "lastvalue", "lastclock", "delay"],
  hostids: [host.hostid],
  search: { key_: "system.cpu.util" },
});
for (const it of items) {
  const ageMin = Math.floor((Date.now() / 1000 - parseInt(it.lastclock)) / 60);
  console.log(`  ${it.key_.padEnd(28)}  last=${parseFloat(it.lastvalue).toFixed(1)}%  age=${ageMin}min  delay=${it.delay}`);
}

// Get last 2h of system.cpu.util[,,avg1]
const item = items.find(i => i.key_ === "system.cpu.util[,,avg1]");
if (item) {
  const now = Math.floor(Date.now() / 1000);
  const recs = await zbx("history.get", {
    output: ["clock", "value"], itemids: [item.itemid], history: 0,
    time_from: String(now - 2 * 3600), sortfield: "clock", sortorder: "ASC", limit: 200,
  });
  console.log(`\nLast 2 hours (${recs.length} samples):`);
  if (recs.length) {
    const max2h = Math.max(...recs.map(r => parseFloat(r.value)));
    const avg2h = recs.reduce((a, r) => a + parseFloat(r.value), 0) / recs.length;
    console.log(`  Last 2h: max=${max2h.toFixed(1)}%  avg=${avg2h.toFixed(1)}%  newest=${parseFloat(recs[recs.length-1].value).toFixed(1)}%`);

    const max1h = Math.max(...recs.filter(r => parseInt(r.clock) >= now - 3600).map(r => parseFloat(r.value)));
    const last1h = recs.filter(r => parseInt(r.clock) >= now - 3600);
    if (last1h.length) {
      const avg1h = last1h.reduce((a, r) => a + parseFloat(r.value), 0) / last1h.length;
      console.log(`  Last 1h: max=${max1h.toFixed(1)}%  avg=${avg1h.toFixed(1)}%  (${last1h.length} samples)`);
    }

    console.log("\nLast 10 samples (newest first):");
    for (const r of recs.slice(-10).reverse()) {
      const ts = new Date(parseInt(r.clock) * 1000).toLocaleTimeString("lt-LT", { timeZone: "Europe/Vilnius", hour12: false });
      console.log(`  ${ts}  ${parseFloat(r.value).toFixed(1)}%`);
    }
  }

  // Today's max so far (Vilnius)
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayRecs = await zbx("history.get", {
    output: ["clock", "value"], itemids: [item.itemid], history: 0,
    time_from: String(Math.floor(todayStart.getTime() / 1000)),
    sortfield: "clock", sortorder: "ASC", limit: 5000,
  });
  console.log(`\nToday so far (${todayRecs.length} samples):`);
  if (todayRecs.length) {
    const peak = todayRecs.reduce((m, r) => parseFloat(r.value) > parseFloat(m.value) ? r : m);
    const peakTs = new Date(parseInt(peak.clock) * 1000).toLocaleTimeString("lt-LT", { timeZone: "Europe/Vilnius", hour12: false });
    console.log(`  Day max so far: ${parseFloat(peak.value).toFixed(1)}% at ${peakTs}`);
    const above70 = todayRecs.filter(r => parseFloat(r.value) >= 70).length;
    const above90 = todayRecs.filter(r => parseFloat(r.value) >= 90).length;
    console.log(`  Min ≥ 70%: ${above70}  ≥ 90%: ${above90}`);
  }
}
