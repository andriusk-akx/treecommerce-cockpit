// Quick probe: what inventory / hardware items are available on Rimi SCO WIN hosts?
const URL = "https://monitoring.strongpoint.com/api_jsonrpc.php";
const TOKEN = process.env.ZABBIX_TOKEN;
if (!TOKEN) { console.error("Set ZABBIX_TOKEN env var"); process.exit(1); }

async function call(method, params = {}, skipAuth = false) {
  const headers = { "Content-Type": "application/json" };
  if (!skipAuth) headers["Authorization"] = `Bearer ${TOKEN}`;
  const res = await fetch(URL, { method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: Math.random() }) });
  const data = await res.json();
  if (data.error) throw new Error(`${method}: ${data.error.message} — ${data.error.data}`);
  return data.result;
}

const hosts = await call("host.get", {
  output: ["hostid", "host", "name"],
  selectInventory: ["type", "hardware", "os", "software", "hw_arch"],
  limit: 3,
  search: { host: "Rimi" }, searchWildcardsEnabled: true,
});
console.log("Sample hosts w/ inventory:");
for (const h of hosts) {
  console.log(`  ${h.host} (${h.hostid})`);
  console.log(`    inventory:`, h.inventory);
}

if (hosts.length > 0) {
  const hostId = hosts[0].hostid;
  for (const [label, key] of [["CPU", "cpu"], ["Memory", "memory"], ["system.hw", "system.hw"]]) {
    const items = await call("item.get", {
      output: ["itemid", "key_", "name", "lastvalue"],
      hostids: [hostId],
      search: { key_: key }, searchWildcardsEnabled: true,
    });
    console.log(`\n${label} items (${items.length}):`);
    for (const it of items.slice(0, 15)) {
      console.log(`  ${it.key_} = ${it.lastvalue} [${it.name}]`);
    }
  }
}
