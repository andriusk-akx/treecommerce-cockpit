import { config as loadEnv } from "dotenv";
loadEnv({ path: "/Users/andrius/Projects/treecommerce-cockpit/app/.env.local" });
const URL = process.env.ZABBIX_URL, TOKEN = process.env.ZABBIX_TOKEN;
let id = 0, total = 0;
async function call(method, params) {
  id++; total++;
  const t0 = Date.now();
  const r = await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
    signal: AbortSignal.timeout(60_000),
  });
  const d = await r.json();
  const dt = Date.now() - t0;
  if (d.error) throw new Error(method + ": " + d.error.message);
  return { result: d.result, dt };
}
// Time the slowest individual call to see if Zabbix is being slow.
console.log("Individual Zabbix calls:");
const t = Date.now();
const hosts = await call("host.get", { output: ["hostid","host","name","status","maintenance_status"], selectInterfaces: ["ip","type","available"], selectGroups: ["groupid","name"] });
console.log(`  host.get: ${hosts.dt}ms (${hosts.result.length} hosts)`);
const hostIds = hosts.result.map(h => h.hostid);

const cpuParams = { output: ["itemid","hostid","name","key_","lastvalue","units","lastclock","value_type"], hostids: hostIds, filter: { status: 0, state: 0 }, sortfield: "name" };
const cpu = await call("item.get", { ...cpuParams, search: { key_: "system.cpu" } });
console.log(`  item.get(system.cpu): ${cpu.dt}ms (${cpu.result.length})`);
const mem = await call("item.get", { ...cpuParams, search: { key_: "vm.memory" } });
console.log(`  item.get(vm.memory): ${mem.dt}ms (${mem.result.length})`);
const disk = await call("item.get", { ...cpuParams, search: { key_: "vfs.fs" } });
console.log(`  item.get(vfs.fs): ${disk.dt}ms (${disk.result.length})`);
const net = await call("item.get", { ...cpuParams, search: { key_: "net.if" } });
console.log(`  item.get(net.if): ${net.dt}ms (${net.result.length})`);
const proc = await call("item.get", { ...cpuParams, search: { key_: "proc" } });
console.log(`  item.get(proc): ${proc.dt}ms (${proc.result.length})`);
const procCpu = await call("item.get", { ...cpuParams, search: { key_: ".cpu" } });
console.log(`  item.get(.cpu): ${procCpu.dt}ms (${procCpu.result.length})`);

console.log(`\nTotal wall: ${Date.now() - t}ms (${total} requests)`);
