#!/usr/bin/env node
/**
 * Test different strategies for the history.get phase.
 *
 * Strategies:
 *   A. Per-item, concurrency=8 (current)
 *   B. Per-item, concurrency=24 (sweet spot from previous bench)
 *   C. Batched (12 items per call), all batches in parallel
 *   D. Batched (24 items per call), all batches in parallel
 *   E. Single big call (all 108 items, limit=500k)
 *   F. trend.get only (no history.get) — does it cover 14 days?
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
const URL = process.env.ZABBIX_URL;
const TOKEN = process.env.ZABBIX_TOKEN;

let reqId = 0;
async function call(method, params = {}) {
  reqId++;
  const t0 = Date.now();
  const res = await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: reqId }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json();
  const dt = Date.now() - t0;
  if (data.error) throw new Error(method + ": " + data.error.message);
  return { result: data.result, dt };
}

async function getCpuUtilItemIds() {
  // Group id 198 = "Rimi SCO WIN"
  const hosts = await call("host.get", { output: ["hostid"], groupids: ["198"] });
  const hostIds = hosts.result.map(h => h.hostid);
  const items = await call("item.get", {
    output: ["itemid", "hostid", "key_"],
    hostids: hostIds, search: { key_: "system.cpu.util" },
    filter: { status: 0, state: 0 },
  });
  return items.result.filter(i => i.key_ === "system.cpu.util[,,avg1]" || i.key_ === "system.cpu.util").map(i => i.itemid);
}

const timeFrom = Math.floor(Date.now() / 1000) - 14 * 24 * 3600;

async function stratA(itemIds) { // per-item, conc 8
  const t0 = Date.now();
  let rows = 0, batches = 0;
  for (let i = 0; i < itemIds.length; i += 8) {
    const slice = itemIds.slice(i, i + 8);
    batches++;
    const res = await Promise.all(slice.map(id =>
      call("history.get", { output: ["itemid", "clock", "value"], itemids: [id], history: 0,
        time_from: String(timeFrom), sortfield: "clock", sortorder: "DESC", limit: 25000 })));
    rows += res.reduce((s, r) => s + r.result.length, 0);
  }
  return { dt: Date.now() - t0, rows, calls: itemIds.length };
}

async function stratB(itemIds) { // per-item, conc 24
  const t0 = Date.now();
  let rows = 0;
  for (let i = 0; i < itemIds.length; i += 24) {
    const slice = itemIds.slice(i, i + 24);
    const res = await Promise.all(slice.map(id =>
      call("history.get", { output: ["itemid", "clock", "value"], itemids: [id], history: 0,
        time_from: String(timeFrom), sortfield: "clock", sortorder: "DESC", limit: 25000 })));
    rows += res.reduce((s, r) => s + r.result.length, 0);
  }
  return { dt: Date.now() - t0, rows, calls: itemIds.length };
}

async function stratBatched(itemIds, batchSize) {
  const t0 = Date.now();
  const batches = [];
  for (let i = 0; i < itemIds.length; i += batchSize) batches.push(itemIds.slice(i, i + batchSize));
  // All batches in parallel
  const results = await Promise.all(batches.map(slice =>
    call("history.get", { output: ["itemid", "clock", "value"], itemids: slice, history: 0,
      time_from: String(timeFrom), sortfield: "clock", sortorder: "DESC",
      limit: batchSize * 25000 }) // give each batch enough headroom
  ));
  const rows = results.reduce((s, r) => s + r.result.length, 0);
  return { dt: Date.now() - t0, rows, calls: batches.length };
}

async function stratSingleBig(itemIds) {
  const t0 = Date.now();
  const res = await call("history.get", {
    output: ["itemid", "clock", "value"], itemids: itemIds, history: 0,
    time_from: String(timeFrom), sortfield: "clock", sortorder: "DESC",
    limit: 5_000_000,
  });
  return { dt: Date.now() - t0, rows: res.result.length, calls: 1 };
}

async function stratTrendOnly(itemIds) {
  const t0 = Date.now();
  const res = await call("trend.get", {
    output: ["itemid", "clock", "value_min", "value_avg", "value_max"],
    itemids: itemIds, time_from: String(timeFrom), limit: 1_000_000,
  });
  // Check distinct days returned
  const days = new Set();
  for (const r of res.result) {
    const dt = new Date(parseInt(r.clock) * 1000);
    days.add(dt.toISOString().slice(0, 10));
  }
  return { dt: Date.now() - t0, rows: res.result.length, calls: 1, days: days.size };
}

console.log("Fetching item IDs (Rimi only)...");
const itemIds = await getCpuUtilItemIds();
console.log(`Found ${itemIds.length} CPU util items in Rimi group\n`);

const strategies = [
  ["A) per-item conc=8 limit=25k (current)",  () => stratA(itemIds)],
  ["B) per-item conc=24 limit=25k",           () => stratB(itemIds)],
  ["C) batched=12 all-parallel",              () => stratBatched(itemIds, 12)],
  ["D) batched=24 all-parallel",              () => stratBatched(itemIds, 24)],
  ["E) single big call",                      () => stratSingleBig(itemIds)],
  ["F) trend.get only",                       () => stratTrendOnly(itemIds)],
];

for (const [label, fn] of strategies) {
  try {
    // 2 runs each, report best
    const r1 = await fn();
    const r2 = await fn();
    const best = r1.dt < r2.dt ? r1 : r2;
    console.log(`${label.padEnd(40)} ${String(best.dt).padStart(5)}ms | ${String(best.rows).padStart(7)} rows | ${best.calls} calls${best.days ? ` | ${best.days} days` : ""}`);
  } catch (e) {
    console.log(`${label.padEnd(40)} FAILED: ${e.message}`);
  }
}
