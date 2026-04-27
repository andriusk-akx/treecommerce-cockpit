const URL = "https://monitoring.strongpoint.com/api_jsonrpc.php";
const TOKEN = process.env.ZABBIX_TOKEN;
async function call(method, params = {}, skipAuth = false) {
  const headers = { "Content-Type": "application/json" };
  if (!skipAuth) headers["Authorization"] = `Bearer ${TOKEN}`;
  const res = await fetch(URL, { method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: Math.random() }) });
  const data = await res.json();
  if (data.error) throw new Error(`${method}: ${data.error.message} — ${data.error.data}`);
  return data.result;
}

// Get all 109 Rimi hosts with both name and inventory
const hosts = await call("host.get", {
  output: ["hostid", "host", "name"],
  selectInventory: ["hardware"],
  groupids: ["198"],
});
console.log(`Total Rimi SCO WIN hosts: ${hosts.length}`);
console.log("\nSample of host vs name vs hardware:");
for (const h of hosts.slice(0, 10)) {
  const hw = h.inventory?.hardware || "(none)";
  console.log(`  host="${h.host}" | name="${h.name}" | hardware="${hw}"`);
}

// What distinct hardware values exist?
const hwCounts = {};
for (const h of hosts) {
  const hw = h.inventory?.hardware || "(none)";
  hwCounts[hw] = (hwCounts[hw] || 0) + 1;
}
console.log("\nDistinct CPU models:");
for (const [hw, c] of Object.entries(hwCounts).sort((a,b) => b[1]-a[1])) {
  console.log(`  ${c}x ${hw}`);
}

// Find a host with CPU items (sometimes only some hosts have monitoring)
let found = false;
for (const h of hosts.slice(0, 20)) {
  const items = await call("item.get", {
    output: ["key_", "lastvalue"],
    hostids: [h.hostid],
    search: { key_: "system.cpu" }, searchWildcardsEnabled: true,
    limit: 5,
  });
  if (items.length > 0) {
    console.log(`\nCPU items on ${h.host}:`);
    for (const it of items) console.log(`  ${it.key_} = ${it.lastvalue}`);
    found = true;
    break;
  }
}
if (!found) console.log("\nNo CPU items found in first 20 hosts.");
