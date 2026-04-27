// Two new items found in the Rimi sweep:
//   proc_info[python]            — process metadata for python (count? state?)
//   system.cpu.util[,system]     — kernel-mode CPU split (we asked SP admin for this!)
// Find which hosts have them and what they return.
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

console.log("=== proc_info[python] coverage across Rimi ===");
const procInfoItems = await zbx("item.get", {
  output: ["itemid", "hostid", "key_", "name", "lastvalue", "lastclock", "units"],
  groupids: ["198"],
  filter: { key_: "proc_info[python]" },
});
console.log("Hosts with this item:", procInfoItems.length);
const hostIds = [...new Set(procInfoItems.map(i => i.hostid))];
const hosts = await zbx("host.get", { output: ["hostid", "name"], hostids: hostIds });
const hostNameByid = new Map(hosts.map(h => [h.hostid, h.name]));
for (const it of procInfoItems.slice(0, 10)) {
  const ageMin = it.lastclock === "0" ? -1 : Math.round((Date.now() / 1000 - parseInt(it.lastclock)) / 60);
  console.log("  " + (hostNameByid.get(it.hostid) || it.hostid).padEnd(40) + " value=" + it.lastvalue + " (units=" + (it.units || "") + ", age=" + (ageMin < 0 ? "never" : ageMin + "min") + ")");
}
if (procInfoItems.length > 10) console.log("  ... +" + (procInfoItems.length - 10) + " more");

console.log("\n=== system.cpu.util[,system] coverage (KERNEL CPU split!) ===");
const sysSplitItems = await zbx("item.get", {
  output: ["itemid", "hostid", "key_", "name", "lastvalue", "lastclock"],
  groupids: ["198"],
  filter: { key_: "system.cpu.util[,system]" },
});
console.log("Hosts with this item:", sysSplitItems.length);
for (const it of sysSplitItems.slice(0, 20)) {
  const ageMin = it.lastclock === "0" ? -1 : Math.round((Date.now() / 1000 - parseInt(it.lastclock)) / 60);
  console.log("  " + (hostNameByid.get(it.hostid) || it.hostid).padEnd(40) + " value=" + it.lastvalue + " age=" + (ageMin < 0 ? "never" : ageMin + "min"));
}

console.log("\n=== Other system.cpu.util[,...] variants ===");
// Search more broadly
const sysItems = await zbx("item.get", {
  output: ["itemid", "hostid", "key_", "name", "lastvalue", "lastclock"],
  groupids: ["198"],
  search: { key_: "system.cpu.util" },
});
const variants = new Set();
for (const it of sysItems) variants.add(it.key_);
for (const v of [...variants].sort()) {
  const count = sysItems.filter(i => i.key_ === v).length;
  console.log("  " + v.padEnd(40) + " — " + count + " hosts");
}
