#!/usr/bin/env node
/**
 * Benchmark the pilot detail page's Zabbix data path end-to-end.
 *
 * Mirrors src/app/retellect/[pilotId]/page.tsx:
 *   1. 4 parallel fetchers (Resources, CPU detail, Proc items, ProcCpu)
 *   2. Sequential CPU history (depends on cpuDetailItems → matchedHostIds)
 *
 * Goal: identify the dominant cost so we know what to optimize.
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

const URL = process.env.ZABBIX_URL;
const TOKEN = process.env.ZABBIX_TOKEN;
if (!URL || !TOKEN) { console.error("Set ZABBIX_URL and ZABBIX_TOKEN"); process.exit(1); }

let reqId = 0, reqCount = 0, methodCount = new Map();
async function call(method, params = {}) {
  reqId++; reqCount++;
  methodCount.set(method, (methodCount.get(method) || 0) + 1);
  const t0 = Date.now();
  const res = await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: reqId }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json();
  const dt = Date.now() - t0;
  if (data.error) throw new Error(method + ": " + data.error.message);
  return { result: data.result, dt };
}

const cache = new Map(), pending = new Map();
async function cached(key, fn, ttl = 30_000) {
  const now = Date.now();
  const e = cache.get(key);
  if (e && e.expiresAt > now) return e.data;
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const p = (async () => {
    try { const data = await fn(); cache.set(key, { data, expiresAt: Date.now() + ttl }); return data; }
    finally { pending.delete(key); }
  })();
  pending.set(key, p);
  return p;
}

async function getHosts() {
  return cached("host.get", async () => (await call("host.get", {
    output: ["hostid", "host", "name", "status", "maintenance_status"],
    selectInterfaces: ["ip", "type", "available"],
    selectGroups: ["groupid", "name"],
  })).result);
}
async function getResourceMetrics() {
  return cached("resourceMetrics", async () => {
    const hosts = await getHosts();
    const hostIds = hosts.map(h => h.hostid);
    const itemParams = {
      output: ["itemid", "hostid", "name", "key_", "lastvalue", "units", "lastclock", "value_type"],
      hostids: hostIds, filter: { status: 0, state: 0 }, sortfield: "name",
    };
    const [cpu, mem, disk, net] = await Promise.all([
      call("item.get", { ...itemParams, search: { key_: "system.cpu" } }),
      call("item.get", { ...itemParams, search: { key_: "vm.memory" } }),
      call("item.get", { ...itemParams, search: { key_: "vfs.fs" } }),
      call("item.get", { ...itemParams, search: { key_: "net.if" } }),
    ]);
    return { hosts, items: [...cpu.result, ...mem.result, ...disk.result, ...net.result] };
  });
}
async function getItems(hostIds, search) {
  const key = `item.get:${search || "*"}:${hostIds.slice().sort().join(",")}`;
  return cached(key, async () => (await call("item.get", {
    output: ["itemid", "hostid", "name", "key_", "lastvalue", "units", "lastclock", "value_type", "state", "status"],
    hostids: hostIds, ...(search ? { search: { key_: search } } : {}),
    filter: { status: 0, state: 0 }, sortfield: "name",
  })).result);
}
async function getProcessCpuItems(hostIds) {
  const key = `procCpu:${hostIds.slice().sort().join(",")}`;
  return cached(key, async () => (await call("item.get", {
    output: ["itemid", "hostid", "name", "key_", "lastvalue", "units", "lastclock", "value_type"],
    hostids: hostIds, search: { key_: ".cpu" },
    filter: { status: 0, state: 0 }, sortfield: "key_",
  })).result);
}

// Mirror src/lib/zabbix/client.ts getCpuHistoryDaily
async function getCpuHistoryDaily(itemIds, concurrency = 8) {
  if (itemIds.length === 0) return { trend: { dt: 0, rows: 0 }, hist: { dt: 0, rows: 0, batches: 0 } };
  const timeFrom = Math.floor(Date.now() / 1000) - 14 * 24 * 3600;
  // 1) trend.get — single call
  const tt = Date.now();
  let trendRows = 0;
  try {
    const tres = await call("trend.get", {
      output: ["itemid", "clock", "value_min", "value_avg", "value_max"],
      itemids: itemIds, time_from: String(timeFrom), limit: 100000,
    });
    trendRows = tres.result.length;
  } catch (e) { console.warn("trend.get failed:", e.message); }
  const trendDt = Date.now() - tt;
  // 2) history.get per item with bounded concurrency
  const ht = Date.now();
  let histRows = 0, batches = 0;
  for (let i = 0; i < itemIds.length; i += concurrency) {
    const slice = itemIds.slice(i, i + concurrency);
    batches++;
    const res = await Promise.all(slice.map(id =>
      call("history.get", {
        output: ["itemid", "clock", "value"],
        itemids: [id], history: 0,
        time_from: String(timeFrom),
        sortfield: "clock", sortorder: "DESC", limit: 25000,
      }).catch(() => ({ result: [], dt: 0 }))
    ));
    histRows += res.reduce((s, r) => s + r.result.length, 0);
  }
  const histDt = Date.now() - ht;
  return { trend: { dt: trendDt, rows: trendRows }, hist: { dt: histDt, rows: histRows, batches } };
}

async function bench(label, concurrency) {
  cache.clear(); pending.clear();
  reqCount = 0; methodCount = new Map();
  const t0 = Date.now();

  // Phase 1: 4 parallel fetchers (mirror page.tsx)
  const t1 = Date.now();
  const [res, hosts, cpuDetail, proc, procCpu] = await Promise.all([
    getResourceMetrics(),
    getHosts(),
    (async () => { const h = await getHosts(); return getItems(h.map(x => x.hostid), "system.cpu"); })(),
    (async () => { const h = await getHosts(); return getItems(h.map(x => x.hostid), "proc"); })(),
    (async () => { const h = await getHosts(); return getProcessCpuItems(h.map(x => x.hostid)); })(),
  ]);
  const d1 = Date.now() - t1;

  // Phase 2: history fetch (gated)
  const cpuUtilItems = cpuDetail.filter(i => i.key_ === "system.cpu.util[,,avg1]" || i.key_ === "system.cpu.util");
  const itemIds = cpuUtilItems.map(i => i.itemid);
  const histStats = await getCpuHistoryDaily(itemIds, concurrency);

  const total = Date.now() - t0;
  console.log(`\n[${label}] concurrency=${concurrency}`);
  console.log(`  Phase 1 (4 parallel fetchers): ${d1}ms, hosts=${hosts.length}, cpuDetail=${cpuDetail.length}, proc=${proc.length}, procCpu=${procCpu.length}, util items=${itemIds.length}`);
  console.log(`  Phase 2 (history): trend ${histStats.trend.dt}ms (${histStats.trend.rows} rows), per-item ${histStats.hist.dt}ms (${histStats.hist.rows} rows, ${histStats.hist.batches} batches)`);
  console.log(`  TOTAL: ${total}ms | requests: ${reqCount}`);
  for (const [m, c] of methodCount) console.log(`    ${m}: ${c}`);
  return total;
}

console.log("=== Pilot page Zabbix data fetch benchmark ===");
await bench("baseline-conc8", 8);
await bench("conc16", 16);
await bench("conc24", 24);
await bench("conc32", 32);
