#!/usr/bin/env node
/**
 * Sandbox-side verification: vitest can't run on linux/arm64 due to a rolldown
 * binding mismatch, so we re-run the math.ts tests as plain Node assertions
 * to make sure the logic is correct before the user runs vitest on Mac.
 */
import assert from "node:assert/strict";

const m = await import("../src/app/api/rt/process-history/math.ts");
const {
  normalizeProcName,
  categorise,
  chooseTelemetrySources,
  averageSlot,
  normaliseValue,
  summariseDay,
} = m;

let passed = 0, failed = 0;
const t = (name, fn) => {
  try { fn(); passed++; console.log("  ✓", name); }
  catch (e) { failed++; console.log("  ✗", name, "—", e.message); }
};

console.log("normalizeProcName");
t("lowercases", () => assert.equal(normalizeProcName("Python"), "python"));
t("strips '#' so python#1 → python1", () => assert.equal(normalizeProcName("python#1"), "python1"));
t("preserves dotted sp.sss", () => assert.equal(normalizeProcName("sp.sss"), "sp.sss"));
t("empty string safe", () => assert.equal(normalizeProcName(""), ""));

console.log("\ncategorise");
t("python → retellect", () => assert.equal(categorise("python"), "retellect"));
t("python1 → retellect", () => assert.equal(categorise("python1"), "retellect"));
t("python42 → retellect", () => assert.equal(categorise("python42"), "retellect"));
t("pythonw → null (out of scope)", () => assert.equal(categorise("pythonw"), null));
t("python-server → null", () => assert.equal(categorise("python-server"), null));
t("spss → scoApp", () => assert.equal(categorise("spss"), "scoApp"));
t("sp.sss → scoApp", () => assert.equal(categorise("sp.sss"), "scoApp"));
t("sql → db", () => assert.equal(categorise("sql"), "db"));
t("sqlservr → db", () => assert.equal(categorise("sqlservr"), "db"));
t("vm → system", () => assert.equal(categorise("vm"), "system"));
t("vmware-vmx → system", () => assert.equal(categorise("vmware-vmx"), "system"));
t("explorer → null", () => assert.equal(categorise("explorer"), null));
t("cs300sd → null", () => assert.equal(categorise("cs300sd"), null));

console.log("\nchooseTelemetrySources");
t("perf_counter wins over .cpu fallback", () => {
  const r = chooseTelemetrySources([
    { itemid: "100", key_: "python1.cpu" },
    { itemid: "200", key_: 'perf_counter["\\Process(python#1)\\% Processor Time"]' },
  ]);
  assert.equal(r.categoryById.get("100"), undefined);
  assert.equal(r.categoryById.get("200"), "retellect");
  assert.equal(r.needsCoresDivision.has("200"), true);
});
t("falls back to .cpu when no perf_counter", () => {
  const r = chooseTelemetrySources([{ itemid: "100", key_: "spss.cpu" }]);
  assert.equal(r.categoryById.get("100"), "scoApp");
  assert.equal(r.needsCoresDivision.has("100"), false);
});
t("system.cpu items dropped", () => {
  const r = chooseTelemetrySources([
    { itemid: "1", key_: "system.cpu.util[,,avg1]" },
    { itemid: "2", key_: "system.cpu.util[,system]" },
    { itemid: "3", key_: "python.cpu" },
  ]);
  assert.equal(r.categoryById.size, 1);
  assert.equal(r.categoryById.get("3"), "retellect");
});
t("perf_counter for unknown proc dropped", () => {
  const r = chooseTelemetrySources([
    { itemid: "1", key_: 'perf_counter["\\Process(explorer)\\% Processor Time"]' },
  ]);
  assert.equal(r.categoryById.size, 0);
});
t("realistic Rimi mix: 6 perf_counter chosen, 0 .cpu", () => {
  const r = chooseTelemetrySources([
    { itemid: "1", key_: "python.cpu" }, { itemid: "2", key_: "python1.cpu" },
    { itemid: "3", key_: "python2.cpu" }, { itemid: "4", key_: "python3.cpu" },
    { itemid: "5", key_: "spss.cpu" }, { itemid: "6", key_: "sqlservr.cpu" },
    { itemid: "7", key_: 'perf_counter["\\Process(python)\\% Processor Time"]' },
    { itemid: "8", key_: 'perf_counter["\\Process(python#1)\\% Processor Time"]' },
    { itemid: "9", key_: 'perf_counter["\\Process(python#2)\\% Processor Time"]' },
    { itemid: "10", key_: 'perf_counter["\\Process(python#3)\\% Processor Time"]' },
    { itemid: "11", key_: 'perf_counter["\\Process(spss)\\% Processor Time"]' },
    { itemid: "12", key_: 'perf_counter["\\Process(sqlservr)\\% Processor Time"]' },
  ]);
  assert.equal(r.categoryById.size, 6);
  assert.equal(r.needsCoresDivision.size, 6);
  for (const id of ["1", "2", "3", "4", "5", "6"]) {
    assert.equal(r.categoryById.has(id), false);
  }
});
t("Outlet (no perf_counter) all .cpu chosen, 0 cores division", () => {
  const r = chooseTelemetrySources([
    { itemid: "1", key_: "python.cpu" }, { itemid: "2", key_: "spss.cpu" },
    { itemid: "3", key_: "sqlservr.cpu" }, { itemid: "4", key_: "vm.cpu" },
  ]);
  assert.equal(r.categoryById.size, 4);
  assert.equal(r.needsCoresDivision.size, 0);
});

console.log("\naverageSlot");
t("each category divides by its OWN count (regression check)", () => {
  const r = averageSlot({
    retellect: 80, scoApp: 24, db: 99, system: 4,
    countR: 4, countS: 1, countD: 4, countSys: 1,
  });
  assert.equal(r.retellect, 20.0);
  assert.equal(r.scoApp, 24.0);
  assert.equal(r.db, 24.8);
  assert.equal(r.system, 4.0);
});
t("zero count → 0 (not NaN)", () => {
  const r = averageSlot({ retellect: 0, scoApp: 0, db: 50, system: 0, countR: 0, countS: 0, countD: 1, countSys: 0 });
  assert.equal(r.retellect, 0);
  assert.equal(r.db, 50);
  assert.equal(r.free, 50);
});
t("free clamped at 0", () => {
  const r = averageSlot({ retellect: 60, scoApp: 30, db: 30, system: 0, countR: 1, countS: 1, countD: 1, countSys: 0 });
  assert.equal(r.free, 0);
});
t("rounds to 1 decimal", () => {
  const r = averageSlot({ retellect: 1, scoApp: 0, db: 0, system: 0, countR: 3, countS: 0, countD: 0, countSys: 0 });
  assert.equal(r.retellect, 0.3);
});

console.log("\nnormaliseValue");
t("perf_counter divides by cores", () => assert.equal(normaliseValue(99, true, 4), 99/4));
t("*.cpu pass-through", () => assert.equal(normaliseValue(8.24, false, 4), 8.24));
t("cores=0 fallback to 1", () => assert.equal(normaliseValue(40, true, 0), 40));

console.log("\nsummariseDay");
t("empty → null", () => assert.equal(summariseDay([]), null));
t("computes max, avg, thresholds", () => {
  const r = summariseDay([
    { clock: 1000, value: 10 }, { clock: 2000, value: 50 },
    { clock: 3000, value: 95 }, { clock: 4000, value: 70 }, { clock: 5000, value: 60 },
  ]);
  assert.equal(r.maxValue, 95);
  assert.equal(r.maxAtClock, 3000);
  assert.equal(r.avgValue, 57);
  assert.equal(r.minutesAbove.t50, 4);
  assert.equal(r.minutesAbove.t70, 2);
  assert.equal(r.minutesAbove.t90, 1);
  assert.equal(r.minutesAbove.t95, 1);
});
t("threshold inclusive (>= t)", () => {
  const r = summariseDay([
    { clock: 1, value: 70 }, { clock: 2, value: 70 }, { clock: 3, value: 50 },
  ]);
  assert.equal(r.minutesAbove.t70, 2);
  assert.equal(r.minutesAbove.t50, 3);
});
t("rounds maxValue + avgValue", () => {
  const r = summariseDay([
    { clock: 1, value: 99.444 }, { clock: 2, value: 33.333 },
  ]);
  assert.equal(r.maxValue, 99.4);
  assert.equal(r.avgValue, 66.4);
});
t("single-sample day", () => {
  const r = summariseDay([{ clock: 555, value: 80 }]);
  assert.equal(r.samples, 1);
  assert.equal(r.maxValue, 80);
  assert.equal(r.avgValue, 80);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
