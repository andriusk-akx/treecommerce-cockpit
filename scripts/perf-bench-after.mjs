// Benchmark: simulate OPTIMIZED RT page (parallel + in-flight dedup host.get)
const URL = process.env.ZABBIX_URL || "https://monitoring.strongpoint.com/api_jsonrpc.php";
const TOKEN = process.env.ZABBIX_TOKEN;
if (!TOKEN) { console.error("Set ZABBIX_TOKEN"); process.exit(1); }

let reqId = 0, reqCount = 0;
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

// ── In-flight dedup cache helper (mirrors our cache.ts) ──
const cache = new Map(), pending = new Map();
async function cached(key, fn, ttl = 30_000) {
  const now = Date.now();
  const existing = cache.get(key);
  if (existing && existing.expiresAt > now) return existing.data;
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const p = (async () => {
    try {
      const data = await fn();
      cache.set(key, { data, expiresAt: Date.now() + ttl });
      return data;
    } finally { pending.delete(key); }
  })();
  pending.set(key, p);
  return p;
}

async function getHosts() {
  return cached("host.get", () => call("host.get", {
    output: ["hostid", "host", "name", "status", "maintenance_status"],
    selectInterfaces: ["ip", "type", "available"],
    selectGroups: ["groupid", "name"],
  }));
}
async function getResourceMetrics() {
  return cached("resourceMetrics", async () => {
    const hosts = await getHosts();
    const hostIds = hosts.map(h => h.hostid);
    if (hostIds.length === 0) return { hosts, items: [] };
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
  });
}
async function getItems(hostIds, search) {
  const key = `item.get:${search || "*"}:${hostIds.slice().sort().join(",")}`;
  return cached(key, () => call("item.get", {
    output: ["itemid", "hostid", "name", "key_", "lastvalue", "units", "lastclock", "value_type", "state", "status"],
    hostids: hostIds,
    ...(search ? { search: { key_: search } } : {}),
    filter: { status: 0, state: 0 }, sortfield: "name",
  }));
}
async function getProcessCpuItems(hostIds) {
  const key = `procCpu:${hostIds.slice().sort().join(",")}`;
  return cached(key, () => call("item.get", {
    output: ["itemid", "hostid", "name", "key_", "lastvalue", "units", "lastclock", "value_type"],
    hostids: hostIds, search: { key_: ".cpu" },
    filter: { status: 0, state: 0 }, sortfield: "key_",
  }));
}
async function getCpuHistory(itemIds) {
  if (itemIds.length === 0) return [];
  const timeFrom = Math.floor(Date.now() / 1000) - 14 * 24 * 3600;
  return call("history.get", {
    output: ["itemid", "clock", "value"], itemids: itemIds, history: 0,
    time_from: String(timeFrom), sortfield: "clock", sortorder: "ASC", limit: 500000,
  });
}

async function benchOptimized() {
  // clear caches between runs
  cache.clear(); pending.clear();
  reqCount = 0; methodCount = new Map();
  const t0 = Date.now();
  // ── 4 fetchers run in parallel ──
  const [res1, cpuDetail, proc, procCpu] = await Promise.all([
    (async () => {
      const [r, h] = await Promise.all([getResourceMetrics(), getHosts()]);
      return { r, h };
    })(),
    (async () => {
      const h = await getHosts();
      return getItems(h.map(x => x.hostid), "system.cpu");
    })(),
    (async () => {
      const h = await getHosts();
      return getItems(h.map(x => x.hostid), "proc");
    })(),
    (async () => {
      const h = await getHosts();
      return getProcessCpuItems(h.map(x => x.hostid));
    })(),
  ]);
  const dParallel = Date.now() - t0;
  // ── history (sequential after) ──
  const t5 = Date.now();
  const ids = cpuDetail.filter(i => i.key_ === "system.cpu.util[,,avg1]" || i.key_ === "system.cpu.util").map(i => i.itemid);
  const hist = await getCpuHistory(ids);
  const d5 = Date.now() - t5;
  return { total: Date.now() - t0, dParallel, d5, reqCount, methodCount: new Map(methodCount), histRows: hist.length };
}

console.log("\n=== OPTIMIZED (parallel + in-flight dedup host.get) ===");
for (let i = 0; i < 2; i++) {
  const r = await benchOptimized();
  console.log(`Run ${i+1}: total ${r.total}ms | 4 parallel fetchers ${r.dParallel}ms | history ${r.d5}ms | histRows ${r.histRows}`);
  console.log(`  HTTP requests: ${r.reqCount}`);
  for (const [m, c] of r.methodCount) console.log(`    ${m}: ${c}`);
}
