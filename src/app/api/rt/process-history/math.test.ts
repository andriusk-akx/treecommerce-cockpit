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
  it("classifies vm / vmware-vmx as system (VM host)", () => {
    expect(categorise("vm")).toBe("system");
    expect(categorise("vmware-vmx")).toBe("system");
  });
  it("classifies besclient (BigFix endpoint mgmt) as its OWN besclient bucket", () => {
    // 2026-04-28 it first landed in "system" after a SP testlab snapshot.
    // 2026-05-12 the SP admin detailed the "Other" bucket on testlab into
    // BESClient / Elastic / Windows OS core — besclient now has its own
    // top-level row so the BigFix cost is read directly, not buried in System.
    expect(categorise("besclient")).toBe("besclient");
  });
  it("classifies elastic-agent / elasticsearch variants as elastic", () => {
    // Added 2026-05-12 after SP admin enabled Elastic agent monitoring on
    // testlab_SPUB-P-SCO150. Accept the agent and the search server name
    // variants the StrongPoint deploy might use.
    expect(categorise("elastic")).toBe("elastic");
    expect(categorise("elastic-agent")).toBe("elastic");
    expect(categorise("elasticagent")).toBe("elastic");
    expect(categorise("elasticsearch")).toBe("elastic");
  });
  it("does NOT route a 'system' process name to osCore — kernel CPU is a host-scope item", () => {
    // osCore is fed exclusively from `system.cpu.util[,system]` by the route.
    // If categorise() also returned "osCore" for a hypothetical
    // perf_counter[\Process(System)], a host publishing BOTH would double-
    // count its kernel cycles. The cleaner contract: categorise = process
    // bucket; kernel item = osCore bucket; the two channels never overlap.
    expect(categorise("system")).toBeNull();
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
  // Helper: build a SlotBucket with sensible zero defaults so each test
  // only has to specify the fields it actually cares about. Keeps the
  // 7-category shape from spreading boilerplate across every assertion.
  const slot = (over: Partial<Parameters<typeof averageSlot>[0]> = {}): Parameters<typeof averageSlot>[0] => ({
    retellect: 0, scoApp: 0, db: 0, system: 0, besclient: 0, elastic: 0, osCore: 0,
    countR: 0, countS: 0, countD: 0, countSys: 0, countBes: 0, countEla: 0, countOs: 0,
    ...over,
  });

  it("each category averaged independently by its own count", () => {
    // Real-world bug we already fixed once: dividing all categories by the
    // SHARED count of timestamps in a slot scaled every category down ~4×.
    // averageSlot must use per-category counts.
    const r = averageSlot(slot({
      retellect: 80, scoApp: 24, db: 99, system: 4,
      countR: 4, countS: 1, countD: 4, countSys: 1, // ← all distinct counts
    }));
    expect(r.retellect).toBe(20);    // 80/4
    expect(r.scoApp).toBe(24);       // 24/1
    expect(r.db).toBe(24.75);        // 99/4 — preserved at 2-decimal precision
    expect(r.system).toBe(4);        // 4/1
  });

  it("zero count → zero (not NaN, not 1)", () => {
    const r = averageSlot(slot({
      db: 50,
      countD: 1,
    }));
    expect(r.retellect).toBe(0);
    expect(r.scoApp).toBe(0);
    expect(r.db).toBe(50);
    expect(r.system).toBe(0);
    expect(r.free).toBe(50); // 100 - 50
  });

  it("free is clamped at zero (no negative free)", () => {
    const r = averageSlot(slot({
      retellect: 60, scoApp: 30, db: 30,
      countR: 1, countS: 1, countD: 1,
    }));
    // r=60, sa=30, db=30 → sum=120 → free=max(0, 100-120)=0
    expect(r.free).toBe(0);
  });

  it("rounds to two decimal places to preserve sub-1% precision for the UI formatter", () => {
    // Pre-2026-05-13 the contract was 1 decimal (0.3). Elastic-agent's
    // typical 0.04% on a 4-core host would have rounded to 0.0 and the
    // UI bar showed "0%" even though monitoring was working. 2 decimals
    // is the minimum that keeps small but non-zero values legible while
    // RtTimeline's formatPct decides per-value precision for display.
    const r = averageSlot(slot({
      retellect: 1,
      countR: 3,
    }));
    expect(r.retellect).toBe(0.33); // 1/3 = 0.3333… → 0.33
  });

  it("besclient / elastic / osCore are averaged independently and subtract from free", () => {
    // The 2026-05-12 SP-admin breakdown of the testlab host produces three
    // new buckets. They must each average by their own count and shrink the
    // residual free bar correctly.
    const r = averageSlot(slot({
      retellect: 20, besclient: 30, elastic: 18, osCore: 24,
      countR: 2,    countBes: 3,    countEla: 2,  countOs: 4,
    }));
    expect(r.retellect).toBe(10);  // 20/2
    expect(r.besclient).toBe(10);  // 30/3
    expect(r.elastic).toBe(9);     // 18/2
    expect(r.osCore).toBe(6);      // 24/4
    expect(r.free).toBe(65);       // 100 - (10+10+9+6) = 65
  });

  // ─── Invariants ──────────────────────────────────────────────────
  // Properties that must hold across ANY input. These guard against future
  // refactors silently breaking the contract the UI relies on.

  it("INVARIANT: free is always in [0, 100] and matches max(0, 100 − sum of 7 categories)", () => {
    // Sample a deliberately adversarial spread: each category has different
    // sums and counts, plus a zero-everything bucket, plus an over-100% case.
    // The contract is NOT "named + free ≤ 100" (named can legitimately
    // exceed 100 when host CPU is over-attributed by perf_counter rounding);
    // the contract is that `free` itself stays bounded and is the clamped
    // residual of the named breakdown. The drill-down panel separately
    // recomputes Other against host CPU, not against this `free`.
    const cases = [
      slot({ retellect: 30, scoApp: 20, db: 10, system: 5, besclient: 8, elastic: 4, osCore: 6,
             countR: 1, countS: 1, countD: 1, countSys: 1, countBes: 1, countEla: 1, countOs: 1 }),
      slot({ retellect: 99, scoApp: 99, db: 99, system: 99, besclient: 99, elastic: 99, osCore: 99,
             countR: 1, countS: 1, countD: 1, countSys: 1, countBes: 1, countEla: 1, countOs: 1 }),
      slot({ retellect: 5, countR: 100 }), // tiny avg, zero everywhere else
      slot({}),                              // wholly empty bucket
    ];
    for (const c of cases) {
      const r = averageSlot(c);
      const sumNamed = r.retellect + r.scoApp + r.db + r.system + r.besclient + r.elastic + r.osCore;
      // free is bounded.
      expect(r.free).toBeGreaterThanOrEqual(0);
      expect(r.free).toBeLessThanOrEqual(100);
      // free is the clamped residual, with one-decimal rounding slack so
      // post-round sums can drift up to 0.7 below/above the unrounded value
      // (seven values × 0.1 max rounding each).
      const expected = Math.max(0, 100 - sumNamed);
      expect(Math.abs(r.free - expected)).toBeLessThanOrEqual(0.7 + 1e-9);
    }
  });

  it("INVARIANT: when monitored categories overshoot 100, free is exactly 0 (never negative)", () => {
    const r = averageSlot(slot({
      retellect: 40, scoApp: 30, db: 30, system: 20, besclient: 15, elastic: 10, osCore: 10,
      countR: 1, countS: 1, countD: 1, countSys: 1, countBes: 1, countEla: 1, countOs: 1,
    }));
    // 40+30+30+20+15+10+10 = 155 → free should be 0, not -55
    expect(r.free).toBe(0);
    expect(Number.isFinite(r.free)).toBe(true);
  });

  it("INVARIANT: each category is independent — adding samples to one never moves another", () => {
    const base = averageSlot(slot({
      retellect: 20, scoApp: 30,
      countR: 2,    countS: 3,
    }));
    // Bumping ONLY besclient should leave retellect / scoApp / db / system / etc. untouched.
    const bumped = averageSlot(slot({
      retellect: 20, scoApp: 30, besclient: 12,
      countR: 2,    countS: 3,    countBes: 4,
    }));
    expect(bumped.retellect).toBe(base.retellect);
    expect(bumped.scoApp).toBe(base.scoApp);
    expect(bumped.db).toBe(base.db);
    expect(bumped.system).toBe(base.system);
    expect(bumped.elastic).toBe(base.elastic);
    expect(bumped.osCore).toBe(base.osCore);
    // Only besclient + free should change.
    expect(bumped.besclient).toBe(3);              // 12/4
    expect(bumped.free).toBe(base.free - 3);       // exactly that much carved out of free
  });

  it("INVARIANT: every numeric output is finite (no NaN, no -Infinity) for any input combo", () => {
    // Degenerate inputs that have historically produced NaN:
    //   - sum > 0 but count === 0 (division-by-zero path)
    //   - all-zero bucket
    //   - very small sums with very large counts (precision loss)
    const adversarial = [
      slot({ retellect: 0,  countR: 0 }),
      slot({ retellect: 100, countR: 0 }),
      slot({ retellect: 1e-9, countR: 1e9 }),
      slot({ retellect: 1, scoApp: 1, db: 1, system: 1, besclient: 1, elastic: 1, osCore: 1,
             countR: 0, countS: 0, countD: 0, countSys: 0, countBes: 0, countEla: 0, countOs: 0 }),
    ];
    for (const c of adversarial) {
      const r = averageSlot(c);
      for (const v of [r.retellect, r.scoApp, r.db, r.system, r.besclient, r.elastic, r.osCore, r.free]) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it("REALISTIC: Pavilnionys SCO2 hour-18 reproduces hand-computed averages", () => {
    // 2026-05-08 CPU analysis snapshot: 4-core host, RT-ON spike showed
    //   sp.sss ~34% avg, sql ~25% avg, retellect ~2%, vm ~1%, besclient ~3%, elastic ~1%, kernel ~5%
    // Build the bucket as if 60 1-min samples landed in the slot with one
    // sample per category per minute (real Zabbix cadence for *.cpu items).
    const r = averageSlot(slot({
      retellect: 2 * 60,  scoApp: 34 * 60, db: 25 * 60, system: 1 * 60,
      besclient: 3 * 60, elastic: 1 * 60,  osCore: 5 * 60,
      countR: 60, countS: 60, countD: 60, countSys: 60,
      countBes: 60, countEla: 60, countOs: 60,
    }));
    expect(r.retellect).toBe(2);
    expect(r.scoApp).toBe(34);
    expect(r.db).toBe(25);
    expect(r.system).toBe(1);
    expect(r.besclient).toBe(3);
    expect(r.elastic).toBe(1);
    expect(r.osCore).toBe(5);
    expect(r.free).toBe(29);  // 100 - 71 = 29 → still some unattributed CPU
    // Cross-check the "monitored sum" the UI uses for the Other bar.
    const monitored = r.retellect + r.scoApp + r.db + r.system + r.besclient + r.elastic + r.osCore;
    expect(monitored).toBe(71);
  });
});

// ─── End-to-end: categorise() ↔ averageSlot() fidelity ─────────────
//
// The dashboard pipeline is: Zabbix item key → categorise() → bucket
// accumulator → averageSlot(). If categorise() routes a process to the
// wrong bucket, the slot bars will be wrong even though averageSlot()
// itself works correctly. This test simulates the full pipeline on a
// realistic mix of items to guard the seam.

describe("end-to-end pipeline (categorise → averageSlot)", () => {
  it("routes a realistic 7-category fleet of items into the right buckets and produces sane averages", () => {
    // One sample per process, all 50% on a single-core host so the math is
    // trivial to verify by inspection: each category sees 50%, sum = 350%,
    // free clamps to 0.
    //
    // osCore is fed separately because it's not a process-routed bucket —
    // the live route reads `system.cpu.util[,system]` (kernel CPU at host
    // scope) and accumulates straight into `osCore` / `countOs`. We do the
    // same here so the test mirrors the production data flow.
    type Sample = { proc: string; value: number };
    const procSamples: Sample[] = [
      { proc: "python",        value: 50 },
      { proc: "sp.sss",        value: 50 },
      { proc: "sqlservr",      value: 50 },
      { proc: "vmware-vmx",    value: 50 },
      { proc: "besclient",     value: 50 },
      { proc: "elastic-agent", value: 50 },
      // Anything categorise() doesn't know must NOT contaminate any bucket.
      { proc: "explorer",      value: 99 },
      { proc: "cs300sd",       value: 99 },
      { proc: "system",        value: 99 }, // not routed — kernel item handles it
    ];
    const kernelSamples = [50]; // system.cpu.util[,system] reads → osCore

    const acc = {
      retellect: 0, scoApp: 0, db: 0, system: 0, besclient: 0, elastic: 0, osCore: 0,
      countR: 0, countS: 0, countD: 0, countSys: 0, countBes: 0, countEla: 0, countOs: 0,
    };
    for (const s of procSamples) {
      const cat = categorise(s.proc);
      if (!cat) continue;
      acc[cat] += s.value;
      if (cat === "retellect") acc.countR++;
      else if (cat === "scoApp") acc.countS++;
      else if (cat === "db") acc.countD++;
      else if (cat === "system") acc.countSys++;
      else if (cat === "besclient") acc.countBes++;
      else if (cat === "elastic") acc.countEla++;
    }
    for (const v of kernelSamples) {
      acc.osCore += v;
      acc.countOs++;
    }
    const r = averageSlot(acc);
    // Each known category should land at exactly its single sample (50%).
    expect(r.retellect).toBe(50);
    expect(r.scoApp).toBe(50);
    expect(r.db).toBe(50);
    expect(r.system).toBe(50);
    expect(r.besclient).toBe(50);
    expect(r.elastic).toBe(50);
    expect(r.osCore).toBe(50);
    // Unknown procs (explorer, cs300sd, "system" process) must not have
    // leaked into any bucket — confirmed by the monitored sum landing at
    // exactly 350 (7 × 50), not 350+99 or 350+198 or 350+99 again.
    const monitoredSum = r.retellect + r.scoApp + r.db + r.system + r.besclient + r.elastic + r.osCore;
    expect(monitoredSum).toBe(350);
    expect(r.free).toBe(0);
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
