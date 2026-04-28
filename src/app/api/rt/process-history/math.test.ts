import { describe, it, expect } from "vitest";
import {
  normalizeProcName,
  categorise,
  chooseTelemetrySources,
  averageSlot,
  normaliseValue,
  summariseDay,
} from "./math";

// ─── normalizeProcName ──────────────────────────────────────────────

describe("normalizeProcName", () => {
  it("lowercases", () => {
    expect(normalizeProcName("Python")).toBe("python");
    expect(normalizeProcName("SPSS")).toBe("spss");
  });
  it("strips '#' so perf_counter `python#1` aligns with `python1.cpu`", () => {
    expect(normalizeProcName("python#1")).toBe("python1");
    expect(normalizeProcName("python#42")).toBe("python42");
  });
  it("preserves dotted names like sp.sss", () => {
    expect(normalizeProcName("sp.sss")).toBe("sp.sss");
  });
  it("handles empty string without throwing", () => {
    expect(normalizeProcName("")).toBe("");
  });
});

// ─── categorise ─────────────────────────────────────────────────────

describe("categorise", () => {
  it("classifies python (any digit suffix) as retellect", () => {
    expect(categorise("python")).toBe("retellect");
    expect(categorise("python1")).toBe("retellect");
    expect(categorise("python42")).toBe("retellect");
  });
  it("does NOT classify pythonw / python-server as retellect", () => {
    // The cockpit deliberately tracks only the StrongPoint-deployed worker
    // pattern. `pythonw` (windowless) and other variants are out of scope.
    expect(categorise("pythonw")).toBeNull();
    expect(categorise("python-server")).toBeNull();
  });
  it("classifies spss / sp.sss / sp as scoApp", () => {
    expect(categorise("spss")).toBe("scoApp");
    expect(categorise("sp.sss")).toBe("scoApp");
    expect(categorise("sp")).toBe("scoApp");
  });
  it("classifies sql / sqlservr as db", () => {
    expect(categorise("sql")).toBe("db");
    expect(categorise("sqlservr")).toBe("db");
  });
  it("classifies vm / vmware-vmx as system", () => {
    expect(categorise("vm")).toBe("system");
    expect(categorise("vmware-vmx")).toBe("system");
  });
  it("classifies besclient (BigFix endpoint mgmt) as system", () => {
    // Added 2026-04-28 after SP testlab snapshot showed besclient running
    // with multiple instances at ~3% per core on SCO hosts.
    expect(categorise("besclient")).toBe("system");
  });
  it("returns null for unknown procs (cs300sd, NHSTW32, udm)", () => {
    expect(categorise("cs300sd")).toBeNull();
    expect(categorise("nhstw32")).toBeNull();
    expect(categorise("udm")).toBeNull();
    expect(categorise("explorer")).toBeNull();
  });
});

// ─── chooseTelemetrySources ─────────────────────────────────────────

describe("chooseTelemetrySources", () => {
  it("returns empty maps when host has no relevant items", () => {
    const r = chooseTelemetrySources([
      { itemid: "1", key_: "agent.version" },
      { itemid: "2", key_: "system.uptime" },
    ]);
    expect(r.categoryById.size).toBe(0);
    expect(r.needsCoresDivision.size).toBe(0);
  });

  it("picks perf_counter[ \\Process(python#1) ] over python1.cpu when both exist", () => {
    const r = chooseTelemetrySources([
      { itemid: "100", key_: "python1.cpu" },
      { itemid: "200", key_: 'perf_counter["\\Process(python#1)\\% Processor Time"]' },
    ]);
    expect(r.categoryById.get("100")).toBeUndefined();
    expect(r.categoryById.get("200")).toBe("retellect");
    expect(r.needsCoresDivision.has("200")).toBe(true);
    expect(r.needsCoresDivision.has("100")).toBe(false);
  });

  it("falls back to *.cpu when perf_counter is missing for that process", () => {
    const r = chooseTelemetrySources([
      { itemid: "100", key_: "spss.cpu" },
      { itemid: "200", key_: 'perf_counter["\\Process(python#1)\\% Processor Time"]' },
    ]);
    expect(r.categoryById.get("100")).toBe("scoApp");
    expect(r.categoryById.get("200")).toBe("retellect");
    expect(r.needsCoresDivision.has("100")).toBe(false);
    expect(r.needsCoresDivision.has("200")).toBe(true);
  });

  it("ignores system.cpu and other system metrics", () => {
    const r = chooseTelemetrySources([
      { itemid: "1", key_: "system.cpu.util[,,avg1]" },
      { itemid: "2", key_: "system.cpu.util[,system]" },
      { itemid: "3", key_: "system.cpu.num" },
      { itemid: "4", key_: "python.cpu" },
    ]);
    expect(r.categoryById.size).toBe(1);
    expect(r.categoryById.get("4")).toBe("retellect");
  });

  it("perf_counter without a recognised process is dropped", () => {
    const r = chooseTelemetrySources([
      { itemid: "1", key_: 'perf_counter["\\Process(explorer)\\% Processor Time"]' },
      { itemid: "2", key_: 'perf_counter["\\Process(svchost)\\% Processor Time"]' },
    ]);
    expect(r.categoryById.size).toBe(0);
  });

  it("realistic mix from a Rimi SCO host (4 python workers + spss + sql)", () => {
    const r = chooseTelemetrySources([
      { itemid: "1", key_: "python.cpu" },
      { itemid: "2", key_: "python1.cpu" },
      { itemid: "3", key_: "python2.cpu" },
      { itemid: "4", key_: "python3.cpu" },
      { itemid: "5", key_: "spss.cpu" },
      { itemid: "6", key_: "sqlservr.cpu" },
      { itemid: "7", key_: 'perf_counter["\\Process(python)\\% Processor Time"]' },
      { itemid: "8", key_: 'perf_counter["\\Process(python#1)\\% Processor Time"]' },
      { itemid: "9", key_: 'perf_counter["\\Process(python#2)\\% Processor Time"]' },
      { itemid: "10", key_: 'perf_counter["\\Process(python#3)\\% Processor Time"]' },
      { itemid: "11", key_: 'perf_counter["\\Process(spss)\\% Processor Time"]' },
      { itemid: "12", key_: 'perf_counter["\\Process(sqlservr)\\% Processor Time"]' },
    ]);
    // 6 distinct processes → 6 chosen item ids, all perf_counter.
    expect(r.categoryById.size).toBe(6);
    expect(r.categoryById.get("7")).toBe("retellect");
    expect(r.categoryById.get("8")).toBe("retellect");
    expect(r.categoryById.get("9")).toBe("retellect");
    expect(r.categoryById.get("10")).toBe("retellect");
    expect(r.categoryById.get("11")).toBe("scoApp");
    expect(r.categoryById.get("12")).toBe("db");
    // None of the *.cpu fallbacks should be selected.
    for (const id of ["1", "2", "3", "4", "5", "6"]) {
      expect(r.categoryById.has(id)).toBe(false);
    }
    // Every chosen item needs cores division.
    expect(r.needsCoresDivision.size).toBe(6);
  });

  it("Outlet-style host: no perf_counter, only *.cpu — all fallbacks chosen, NO cores division", () => {
    const r = chooseTelemetrySources([
      { itemid: "1", key_: "python.cpu" },
      { itemid: "2", key_: "spss.cpu" },
      { itemid: "3", key_: "sqlservr.cpu" },
      { itemid: "4", key_: "vm.cpu" },
    ]);
    expect(r.categoryById.get("1")).toBe("retellect");
    expect(r.categoryById.get("2")).toBe("scoApp");
    expect(r.categoryById.get("3")).toBe("db");
    expect(r.categoryById.get("4")).toBe("system");
    expect(r.needsCoresDivision.size).toBe(0);
  });
});

// ─── averageSlot ────────────────────────────────────────────────────

describe("averageSlot", () => {
  it("each category averaged independently by its own count", () => {
    // Real-world bug we already fixed once: dividing all four categories
    // by the SHARED count of timestamps in a slot scaled every category
    // down ~4×. averageSlot must use per-category counts.
    const r = averageSlot({
      retellect: 80, scoApp: 24, db: 99, system: 4,
      countR: 4, countS: 1, countD: 4, countSys: 1, // ← all distinct counts
    });
    expect(r.retellect).toBe(20.0); // 80/4
    expect(r.scoApp).toBe(24.0);    // 24/1
    expect(r.db).toBe(24.8);        // 99/4 = 24.75 → rounded to 24.8
    expect(r.system).toBe(4.0);     // 4/1
  });

  it("zero count → zero (not NaN, not 1)", () => {
    const r = averageSlot({
      retellect: 0, scoApp: 0, db: 50, system: 0,
      countR: 0, countS: 0, countD: 1, countSys: 0,
    });
    expect(r.retellect).toBe(0);
    expect(r.scoApp).toBe(0);
    expect(r.db).toBe(50);
    expect(r.system).toBe(0);
    expect(r.free).toBe(50); // 100 - 50
  });

  it("free is clamped at zero (no negative free)", () => {
    const r = averageSlot({
      retellect: 60, scoApp: 30, db: 30, system: 0,
      countR: 1, countS: 1, countD: 1, countSys: 0,
    });
    // r=60, sa=30, db=30, sys=0 → sum=120 → free=max(0, 100-120)=0
    expect(r.free).toBe(0);
  });

  it("rounds to one decimal place to match the API contract", () => {
    const r = averageSlot({
      retellect: 1, scoApp: 0, db: 0, system: 0,
      countR: 3, countS: 0, countD: 0, countSys: 0,
    });
    expect(r.retellect).toBe(0.3); // 1/3 = 0.333… → 0.3
  });
});

// ─── normaliseValue ─────────────────────────────────────────────────

describe("normaliseValue", () => {
  it("perf_counter values are divided by core count", () => {
    expect(normaliseValue(99, true, 4)).toBe(99 / 4);
    expect(normaliseValue(50, true, 2)).toBe(25);
  });
  it("*.cpu values are passed through unchanged", () => {
    expect(normaliseValue(8.24, false, 4)).toBe(8.24);
  });
  it("never divides by zero (cores=0 → cores=1 fallback)", () => {
    expect(normaliseValue(40, true, 0)).toBe(40);
  });
  it("NaN cores → cores=1 fallback (defensive)", () => {
    expect(normaliseValue(40, true, NaN)).toBe(40);
  });
  it("fractional cores < 1 → cores=1 fallback", () => {
    expect(normaliseValue(40, true, 0.5)).toBe(40);
  });
  it("multi-core host (8 cores) divides correctly", () => {
    expect(normaliseValue(800, true, 8)).toBe(100);
  });
});

// ─── summariseDay ───────────────────────────────────────────────────

describe("summariseDay", () => {
  it("returns null for empty input", () => {
    expect(summariseDay([])).toBeNull();
  });

  it("computes max, max time, avg, and threshold counts", () => {
    const samples = [
      { clock: 1000, value: 10 },
      { clock: 2000, value: 50 },
      { clock: 3000, value: 95 },
      { clock: 4000, value: 70 },
      { clock: 5000, value: 60 },
    ];
    const r = summariseDay(samples)!;
    expect(r.samples).toBe(5);
    expect(r.maxValue).toBe(95);
    expect(r.maxAtClock).toBe(3000);
    expect(r.avgValue).toBe(57); // (10+50+95+70+60)/5 = 57.0
    expect(r.minutesAbove.t50).toBe(4); // 50, 95, 70, 60
    expect(r.minutesAbove.t70).toBe(2); // 95, 70
    expect(r.minutesAbove.t90).toBe(1); // 95
    expect(r.minutesAbove.t95).toBe(1); // 95
  });

  it("threshold is inclusive (>= t)", () => {
    const r = summariseDay([
      { clock: 1, value: 70 },
      { clock: 2, value: 70 },
      { clock: 3, value: 50 },
    ])!;
    expect(r.minutesAbove.t70).toBe(2); // both 70s count
    expect(r.minutesAbove.t50).toBe(3);
  });

  it("rounds maxValue and avgValue to 1 decimal", () => {
    const r = summariseDay([
      { clock: 1, value: 99.444 },
      { clock: 2, value: 33.333 },
    ])!;
    expect(r.maxValue).toBe(99.4);
    expect(r.avgValue).toBe(66.4); // (99.444+33.333)/2 = 66.388 → 66.4
  });

  it("handles single-sample day", () => {
    const r = summariseDay([{ clock: 555, value: 80 }])!;
    expect(r.samples).toBe(1);
    expect(r.maxValue).toBe(80);
    expect(r.avgValue).toBe(80);
    expect(r.maxAtClock).toBe(555);
  });
});
