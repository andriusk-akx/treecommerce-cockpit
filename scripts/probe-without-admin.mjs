// Test what we can discover/extract from Zabbix without admin involvement.
// Checking: token permissions, available items beyond *.cpu, system.run support.
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
  return data;
}

const hosts = await zbx("host.get", { output: ["hostid", "name"], search: { name: "Pavilnionys" } });
const host = hosts.result.find(h => /SCO2\b/.test(h.name));
console.log("Host:", host.name, host.hostid);

// 1) FULL item list — find everything not just *.cpu
console.log("\n=== 1) ALL items on this host (categorised) ===");
const items = await zbx("item.get", {
  output: ["itemid", "key_", "name", "delay", "type", "value_type", "lastvalue", "status"],
  hostids: [host.hostid],
});
const all = items.result;
const byPrefix = new Map();
for (const it of all) {
  const prefix = it.key_.split(/[.[]/)[0];
  byPrefix.set(prefix, (byPrefix.get(prefix) ?? []).concat(it));
}
for (const [prefix, list] of [...byPrefix.entries()].sort()) {
  console.log(`  ${prefix.padEnd(20)} ${list.length} items`);
}

// 2) Look for proc.* / process discovery
console.log("\n=== 2) proc.* items ===");
const procItems = all.filter(it => /^proc\b/.test(it.key_) || /^perf_counter/.test(it.key_));
for (const it of procItems.slice(0, 30)) {
  console.log(`  ${it.key_.slice(0, 70).padEnd(72)} type=${it.type} status=${it.status}`);
}
if (procItems.length > 30) console.log(`  ... +${procItems.length - 30} more`);

// 3) Try item.create — write permission?
console.log("\n=== 3) Can we create items? ===");
const testCreate = await zbx("item.create", {
  hostid: host.hostid,
  key_: "agent.ping",  // safe key, just testing permission
  type: 0, value_type: 3, name: "TEST permission probe", delay: "1m",
});
if (testCreate.error) {
  console.log(`  WRITE DENIED: ${testCreate.error.message} — ${testCreate.error.data}`);
} else {
  console.log(`  WRITE ALLOWED: created itemid=${testCreate.result.itemids[0]}`);
  // Clean up
  await zbx("item.delete", testCreate.result.itemids);
  console.log(`  (cleaned up)`);
}

// 4) Check user permissions
console.log("\n=== 4) Token permissions ===");
const me = await zbx("user.get", { output: ["userid", "username", "roleid"], selectRole: ["name", "type"] });
if (me.result?.length) {
  for (const u of me.result) {
    console.log(`  user=${u.username} role=${u.role?.name} type=${u.role?.type}`);
  }
}

// 5) Check if system.run is anywhere on this host (probably not, but worth checking)
console.log("\n=== 5) system.run / vfs.* / agent.* items ===");
const sysRun = all.filter(it => /^system\.run|^vfs\.|^agent\./.test(it.key_));
for (const it of sysRun.slice(0, 20)) {
  console.log(`  ${it.key_.slice(0, 60).padEnd(62)} last=${(it.lastvalue || "—").slice(0, 30)}`);
}

// 6) Direct probe — can we query agent on demand?
//    "Get value from agent" via Zabbix proxy is task.create with type 6, but
//    that's restricted to admin too. Try task.create.
console.log("\n=== 6) On-demand agent value (task.create) ===");
const taskTest = await zbx("task.create", {
  type: 6,
  request: { itemid: all[0].itemid },
});
if (taskTest.error) {
  console.log(`  TASK DENIED: ${taskTest.error.message} — ${taskTest.error.data}`);
} else {
  console.log(`  TASK CREATED: ${JSON.stringify(taskTest.result).slice(0, 200)}`);
}
