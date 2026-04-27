// Benchmark: RT page Zabbix data fetch path
const URL = process.env.ZABBIX_URL || "https://monitoring.strongpoint.com/api_jsonrpc.php";
const TOKEN = process.env.ZABBIX_TOKEN;
if (!TOKEN) { console.error("Set ZABBIX_TOKEN"); process.exit(1); }

let reqId = 0;
let reqCount = 0;
let methodCount = new Map();
async function call(method, params = {}) {
  reqId++; reqCount++;
  methodCount.set(method, (methodCount.get(method) || 0) + 1);
  const res = await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: reqId }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json();
  if (data.error) throw new Error(method + ": " + data.error.message);
  return data.result;
}

async function getHosts() {
  return call("host.get", {
    output: ["hostid", "host", "name", "status", "maintenance_status"],
    selectInterfaces: ["ip", "type", "available"],
    selectGroups: ["groupid", "name"],
  });
}
async function getResourceMetrics() {
  const hosts = await getHosts();
  const hostIds = hosts.map(h => h.hostid);
  if (hostIds.length === 0) return { hosts: [], items: [] };
  const itemParams = {
    output: ["itemid", "hostid", "name", "key_", "lastvalue", "units", "lastclock", "value_type"],
    hostids: hostIds,
    filter: { status: 0, state: 0 },
    sortfield: "name",
  };
  const [cpu, mem, disk, net] = await Promise.all([
    call("item.get", { ...itemParams, search: { key_: "system.cpu" } }),
    call("item.get", { ...itemParams, search: { key_: "vm.memory" } }),
    call("item.get", { ...itemParams, search: { key_: "vfs.fs" } }),
    call("item.get", { ...itemParams, search: { key_: "net.if" } }),
  ]);
  return { hosts, items: [...cpu, ...mem, ...disk, ...net] };
}
async function getItems(hostIds, search) {
  return call("item.get", {
    output: ["itemid", "hostid", "name", "key_", "lastvalue", "units", "lastclock", "value_type", "state", "status"],
    hostids: hostIds,
    ...(search ? { search: { key_: search } } : {}),
    filter: { status: 0, state: 0 },
    sortfield: "name",
  });
}
async function getProcessCpuItems(hostIds) {
  if (hostIds.length === 0) return [];
  return call("item.get", {
    output: ["itemid", "hostid", "name", "key_", "lastvalue", "units", "lastclock", "value_type"],
    hostids: hostIds,
    search: { key_: ".cpu" },
    filter: { status: 0, state: 0 },
    sortfield: "key_",
  });
}
async function getCpuHistory(itemIds) {
  if (itemIds.length === 0) return [];
  const timeFrom = Math.floor(Date.now() / 1000) - 14 * 24 * 3600;
  return call("history.get", {
    output: ["itemid", "clock", "value"],
    itemids: itemIds, history: 0,
    time_from: String(timeFrom), sortfield: "clock", sortorder: "ASC", limit: 500000,
  });
}

async function benchCurrent() {
  reqCount = 0; methodCount = new Map();
  const t0 = Date.now();
  const t1 = Date.now();
  const [res1, hosts1] = await Promise.all([getResourceMetrics(), getHosts()]);
  const d1 = Date.now() - t1;
  const t2 = Date.now();
  const h2 = await getHosts();
  const cpuDetail = await getItems(h2.map(h => h.hostid), "system.cpu");
  const d2 = Date.now() - t2;
  const t3 = Date.now();
  const h3 = await getHosts();
  const proc = await getItems(h3.map(h => h.hostid), "proc");
  const d3 = Date.now() - t3;
  const t4 = Date.now();
  const h4 = await getHosts();
  const procCpu = await getProcessCpuItems(h4.map(h => h.hostid));
  const d4 = Date.now() - t4;
  const t5 = Date.now();
  const ids = cpuDetail.filter(i => i.key_ === "system.cpu.util[,,avg1]" || i.key_ === "system.cpu.util").map(i => i.itemid);
  const hist = await getCpuHistory(ids);
  const d5 = Date.now() - t5;
  return { total: Date.now() - t0, d1, d2, d3, d4, d5, reqCount, methodCount: new Map(methodCount), histRows: hist.length };
}

console.log("\n=== BASELINE (sequential, dup getHosts) ===");
for (let i = 0; i < 2; i++) {
  const r = await benchCurrent();
  console.log(`Run ${i+1}: total ${r.total}ms | res+hosts ${r.d1}ms | cpuDetail ${r.d2}ms | proc ${r.d3}ms | procCpu ${r.d4}ms | history ${r.d5}ms | histRows ${r.histRows}`);
  console.log(`  HTTP requests: ${r.reqCount}`);
  for (const [m, c] of r.methodCount) console.log(`    ${m}: ${c}`);
}
