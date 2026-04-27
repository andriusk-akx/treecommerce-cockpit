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

// Find the Rimi group
const groups = await call("hostgroup.get", { output: ["groupid", "name"] });
const rimi = groups.filter(g => /rimi/i.test(g.name));
console.log("Rimi groups:", rimi);

// Get 3 hosts from the first Rimi group
if (rimi.length > 0) {
  const groupId = rimi[0].groupid;
  const hosts = await call("host.get", {
    output: ["hostid", "host", "name"],
    selectInventory: ["type", "hardware", "os", "software", "hw_arch", "type_full"],
    groupids: [groupId],
    limit: 2,
  });
  console.log(`\nFirst 2 hosts in "${rimi[0].name}":`);
  for (const h of hosts) {
    console.log(`  ${h.host}`);
    console.log(`    inventory:`, JSON.stringify(h.inventory, null, 2).slice(0, 500));
  }

  if (hosts.length > 0) {
    const hostId = hosts[0].hostid;
    for (const [label, keys] of [
      ["CPU items", ["system.cpu"]],
      ["Memory items", ["vm.memory"]],
      ["system.hw items", ["system.hw"]],
      ["system.sw items", ["system.sw"]],
    ]) {
      const items = await call("item.get", {
        output: ["itemid", "key_", "name", "lastvalue"],
        hostids: [hostId],
        search: { key_: keys[0] }, searchWildcardsEnabled: true,
      });
      console.log(`\n${label} (${items.length}):`);
      for (const it of items.slice(0, 12)) {
        const val = String(it.lastvalue ?? "").slice(0, 60);
        console.log(`  ${it.key_} = ${val}`);
      }
    }
  }
}
