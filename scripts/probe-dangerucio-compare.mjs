// Compare Dangeručio SCO2 (silent) with SCO1 (same store) and a known-working host
// to localise the issue: store-level, host-level, or process-name mismatch.
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
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.result;
}

const TARGETS = [
  { id: "25249", label: "SCO1 same store (T822)" },
  { id: "25250", label: "SCO2 SUSPECT (T822)" },
];

// Find a host that is currently reporting python data, for sanity check.
console.log("=== Step A: Find one host that IS reporting python data right now ===");
const allPython = await zbx("item.get", {
  output: ["itemid", "hostid", "key_", "lastclock", "lastvalue"],
  filter: { key_: ["python.cpu", "python1.cpu", "python2.cpu", "python3.cpu"] },
  search: { key_: "python" },
});

const reporting = allPython.filter(i => i.lastclock !== "0" && parseFloat(i.lastvalue) > 0);
console.log(`  Items reporting python.cpu > 0: ${reporting.length}`);
if (reporting.length > 0) {
  // Group by host
  const byHost = new Map();
  for (const it of reporting) {
    const cur = byHost.get(it.hostid) || 0;
    byHost.set(it.hostid, cur + 1);
  }
  const [topHostId] = [...byHost.entries()].sort((a, b) => b[1] - a[1])[0];
  const hostInfo = await zbx("host.get", { output: ["host", "name"], hostids: [topHostId] });
  console.log(`  Best reference host: ${hostInfo[0].host} (${hostInfo[0].name})`);
  TARGETS.push({ id: topHostId, label: `KNOWN-WORKING (${hostInfo[0].host})` });
}

console.log("\n=== Step B: Side-by-side python perf_counter status per host ===");
console.log(`  ${"HOST".padEnd(40)} ${"KEY".padEnd(45)} ${"LAST".padEnd(12)} ${"VAL"}`);
for (const t of TARGETS) {
  const items = await zbx("item.get", {
    output: ["itemid", "key_", "lastclock", "lastvalue"],
    hostids: [t.id],
    search: { key_: "python" },
  });
  for (const it of items) {
    const lastAge = it.lastclock === "0" ? "NEVER" : `${Math.round((Date.now()/1000 - parseInt(it.lastclock))/60)}m`;
    console.log(`  ${t.label.padEnd(40)} ${it.key_.slice(0, 45).padEnd(45)} ${lastAge.padEnd(12)} ${it.lastvalue || "-"}`);
  }
  console.log("");
}

console.log("=== Step C: Agent connectivity — when did each host last report ANYTHING? ===");
for (const t of TARGETS) {
  const items = await zbx("item.get", {
    output: ["itemid", "key_", "lastclock"],
    hostids: [t.id],
    sortfield: "lastclock",
    sortorder: "DESC",
    limit: 1,
  });
  // Sort by lastclock descending manually since "0" = never
  const reporting = items.filter(i => i.lastclock !== "0");
  if (reporting.length === 0) {
    console.log(`  ${t.label.padEnd(40)} NO ITEMS EVER REPORTED — agent never reachable`);
  } else {
    const newest = reporting[0];
    const lastAge = Math.round((Date.now()/1000 - parseInt(newest.lastclock))/60);
    console.log(`  ${t.label.padEnd(40)} freshest item: ${newest.key_} — ${lastAge}m ago`);
  }
}

console.log("\n=== Step D: Total reporting vs configured items per host ===");
for (const t of TARGETS) {
  const items = await zbx("item.get", {
    output: ["itemid", "lastclock", "status"],
    hostids: [t.id],
  });
  const enabled = items.filter(i => i.status === "0");
  const reporting = enabled.filter(i => i.lastclock !== "0");
  console.log(`  ${t.label.padEnd(40)} enabled=${enabled.length}  reporting=${reporting.length}  (${Math.round(reporting.length/enabled.length*100)}%)`);
}
