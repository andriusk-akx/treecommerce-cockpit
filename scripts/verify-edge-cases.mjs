#!/usr/bin/env node
/**
 * Edge case simulation for the math.ts helpers and getCpuHistoryDaily
 * aggregation. The "drunk warehouse manager" test list — every weird thing
 * that production data has thrown at us, plus a few hypotheticals.
 *
 * Run on real Zabbix where useful (host with experimental items, etc.),
 * else with synthetic data fed through the helpers.
 */
import assert from "node:assert/strict";
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

const URL = process.env.ZABBIX_URL;
const TOKEN = process.env.ZABBIX_TOKEN;

const m = await import("../src/app/api/rt/process-history/math.ts");

let id = 0;
async function call(method, params) {
  id++;
  const r = await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
    signal: AbortSignal.timeout(60_000),
  });
  const d = await r.json();
  if (d.error) throw new Error(method + ": " + d.error.message);
  return d.result;
}

let passed = 0, failed = 0;
const t = (name, fn) => {
  try {
    const r = fn();
    if (r instanceof Promise) return r.then(() => { passed++; console.log("  ✓", name); }, e => { failed++; console.log("  ✗", name, "—", e.message); });
    passed++; console.log("  ✓", name);
  } catch (e) { failed++; console.log("  ✗", name, "—", e.message); }
};

// ─── A. Synthetic edge cases through helpers ──

console.log("A. Synthetic edge cases through helpers");

t("empty item list → empty result", () => {
  const r = m.chooseTelemetrySources([]);
  assert.equal(r.categoryById.size, 0);
});

t("only system.cpu items (no process metrics) → empty result", () => {
  const r = m.chooseTelemetrySources([
    { itemid: "1", key_: "system.cpu.util[,,avg1]" },
    { itemid: "2", key_: "system.cpu.util[,system]" },
    { itemid: "3", key_: "system.cpu.num" },
    { itemid: "4", key_: "system.cpu.load" },
  ]);
  assert.equal(r.categoryById.size, 0);
});

t("only unknown processes → empty result (no crash)", () => {
  const r = m.chooseTelemetrySources([
    { itemid: "1", key_: "lsass.cpu" },
    { itemid: "2", key_: "svchost.cpu" },
    { itemid: "3", key_: "MsMpEng.cpu" },
  ]);
  assert.equal(r.categoryById.size, 0);
});

t("perf_counter without process group → no crash", () => {
  const r = m.chooseTelemetrySources([
    { itemid: "1", key_: 'perf_counter["weird.key.with.dots"]' },
    { itemid: "2", key_: 'perf_counter[\\Memory\\Available MBytes]' },
  ]);
  assert.equal(r.categoryById.size, 0);
});

t("normaliseValue handles negative (corrupted) value", () => {
  // Zabbix history.get can occasionally emit negative values when the agent
  // restarts and emits "value before agent up". The math doesn't crash;
  // downstream the chart clips to 0 via Math.max(0, …).
  assert.equal(m.normaliseValue(-5, true, 4), -5/4);
});

t("normaliseValue with cores=NaN falls back to 1", () => {
  assert.equal(m.normaliseValue(40, true, NaN), 40);
});

t("averageSlot with all-zero counts → all-zero result, free=100", () => {
  const r = m.averageSlot({
    retellect: 0, scoApp: 0, db: 0, system: 0,
    countR: 0, countS: 0, countD: 0, countSys: 0,
  });
  assert.equal(r.retellect, 0);
  assert.equal(r.scoApp, 0);
  assert.equal(r.db, 0);
  assert.equal(r.system, 0);
  assert.equal(r.free, 100);
});

t("averageSlot with extreme values (1000% — sensor spike)", () => {
  // perf_counter occasionally emits values >100% during context switches.
  // The math doesn't clamp; the UI shows the raw spike for transparency.
  const r = m.averageSlot({
    retellect: 1000, scoApp: 0, db: 0, system: 0,
    countR: 1, countS: 0, countD: 0, countSys: 0,
  });
  assert.equal(r.retellect, 1000);
  assert.equal(r.free, 0); // clamped at 0
});

t("summariseDay with all-100% day", () => {
  const samples = Array.from({ length: 1440 }, (_, i) => ({ clock: i * 60, value: 100 }));
  const s = m.summariseDay(samples);
  assert.equal(s.maxValue, 100);
  assert.equal(s.avgValue, 100);
  assert.equal(s.minutesAbove.t50, 1440);
  assert.equal(s.minutesAbove.t95, 1440);
});

t("summariseDay with all-0% day", () => {
  const samples = Array.from({ length: 1440 }, (_, i) => ({ clock: i * 60, value: 0 }));
  const s = m.summariseDay(samples);
  assert.equal(s.maxValue, 0);
  assert.equal(s.minutesAbove.t50, 0);
});

t("summariseDay with NaN value (corrupted) does NOT crash", () => {
  const samples = [
    { clock: 1, value: 50 },
    { clock: 2, value: NaN },
    { clock: 3, value: 70 },
  ];
  // NaN comparisons are false, so the peak stays at 70 (or 50 if NaN slipped
  // in first). We accept either, as long as we don't throw.
  const s = m.summariseDay(samples);
  assert.ok(s !== null);
  assert.equal(s.samples, 3);
});

t("summariseDay with single-element sparse history", () => {
  const s = m.summariseDay([{ clock: 1700000000, value: 42.5 }]);
  assert.equal(s.maxValue, 42.5);
  assert.equal(s.avgValue, 42.5);
  assert.equal(s.minutesAbove.t50, 0);
  assert.equal(s.minutesAbove.t70, 0);
});

t("normalizeProcName with multi-# (perf_counter weirdness)", () => {
  // Hypothetical: perf_counter format may have multiple # if process has
  // an instance number with a literal #. Strip them all.
  assert.equal(m.normalizeProcName("python#1#2"), "python12");
});

// ─── B. Real-fleet edge cases ──

console.log("\nB. Real-fleet edge cases");

await t("CHM Outlet SCO1 — only host with experimental items", async () => {
  const hosts = await call("host.get", {
    output: ["hostid", "name"],
    groupids: ["198"],
    search: { name: "CHM Outlet" },
  });
  if (!hosts.length) { console.log("    (no Outlet host found, skipping)"); return; }
  const target = hosts.find(h => /SCO1/i.test(h.name)) || hosts[0];
  const items = await call("item.get", {
    output: ["itemid", "key_"],
    hostids: [target.hostid],
    filter: { status: 0, state: 0 },
  });
  // Outlet has system.cpu.util[,system] and proc_info[python] which no other
  // host has. Our math.ts ignores both (correctly):
  //   system.cpu.util[,system] is filtered by isCpuKey
  //   proc_info[*] doesn't end with .cpu
  const r = m.chooseTelemetrySources(items.map(it => ({ itemid: it.itemid, key_: it.key_ })));
  // Should still pick the regular *.cpu items.
  assert.ok(r.categoryById.size > 0, "expected some CPU items chosen on Outlet");
  const cats = new Set();
  for (const [, c] of r.categoryById) cats.add(c);
  console.log("    Outlet categories:", Array.from(cats).join(", "));
});

await t("Host with NO process items returns empty slots", async () => {
  // Find a host with very few items (likely network/peripheral host).
  const allHosts = await call("host.get", { output: ["hostid", "name"], groupids: ["198"] });
  for (const h of allHosts.slice(0, 10)) {
    const items = await call("item.get", {
      output: ["itemid", "key_"],
      hostids: [h.hostid],
      filter: { status: 0, state: 0 },
      countOutput: false,
    });
    const r = m.chooseTelemetrySources(items.map(it => ({ itemid: it.itemid, key_: it.key_ })));
    if (r.categoryById.size === 0) {
      console.log(`    Host ${h.name} has no process items → empty result (correct)`);
      return;
    }
  }
  console.log("    All probed hosts have process items (no empty case found)");
});

await t("Stale samples (lastclock far in past) flow through math unchanged", async () => {
  // The math does not care about freshness; that's UI's concern. So a stale
  // sample with old clock is still aggregated normally.
  const samples = [
    { clock: 1700000000, value: 50 }, // 2023-11
    { clock: 1700000060, value: 70 },
  ];
  const s = m.summariseDay(samples);
  assert.equal(s.samples, 2);
  assert.equal(s.maxValue, 70);
});

await t("Multi-core normalization: 8-core host (if any) doesn't double-count", async () => {
  // Test the math: cores=8 means perf_counter values get / 8.
  assert.equal(m.normaliseValue(800, true, 8), 100); // hypothetical "all 8 cores 100%"
  assert.equal(m.normaliseValue(400, true, 8), 50);
});

await t("Single-core host (cores=1) — perf_counter divides by 1 (no scaling)", () => {
  assert.equal(m.normaliseValue(85, true, 1), 85);
});

await t("Non-integer cores (impossible but safe)", () => {
  // If somehow cores is fractional, max(1, cores) keeps things sane.
  assert.equal(m.normaliseValue(40, true, 0.5), 40);
});

// ─── C. Future-proofing: invalid inputs ──

console.log("\nC. Invalid inputs (defensive)");

t("date string with missing pieces — UI passes blanks", () => {
  // Not in math.ts but worth exercising the categorise on weird strings.
  assert.equal(m.categorise(""), null);
  assert.equal(m.categorise(" "), null);
  assert.equal(m.categorise("python "), null); // trailing space → no match
});

t("category names are exact (case-sensitive on python prefix)", () => {
  assert.equal(m.categorise("Python"), null); // categorise() expects already-normalized lowercase
  assert.equal(m.categorise("PYTHON"), null);
});

t("really large slot bucket (1000-sample minute) doesn't overflow", () => {
  const r = m.averageSlot({
    retellect: 50000, scoApp: 0, db: 0, system: 0,
    countR: 1000, countS: 0, countD: 0, countSys: 0,
  });
  assert.equal(r.retellect, 50);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
