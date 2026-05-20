import { describe, it, expect } from "vitest";
import {
  normalizeProcName,
  categorise,
  chooseTelemetrySources,
  averageSlot,
  averageSlotV2,
  normaliseValue,
  summariseDay,
  findUnmonitoredCategories,
  SPARSE_CATEGORIES,
} from "./math";

// ─── normalizeProcName ──────────────────────────────────────────────

describe("normalizeProcName", () => {
  it("lowercases", () => {
    expect(normalizeProcName("Python")).toBe("python");
    expect(normalizeProcName("SPSS")).toBe("spss");
  });
  // 2026-05-20 spec: strip optional '#' followed by trailing digits at end
  // of name. Covers both Windows perfcounter `#N` suffix AND Zabbix
  // UserParameter `python1`/`python2` index style. Old code did
  // `replace(/#/g, "")` which mangled `sp.sss#1` -> `sp.sss1`, dropping
  // multi-instance SCO processes from the breakdown.
  it("strips perfcounter instance suffix '#N'", () => {
    expect(normalizeProcName("python#1")).toBe("python");
    expect(normalizeProcName("python#42")).toBe("python");
    expect(normalizeProcName("sp.sss#0")).toBe("sp.sss");
    expect(normalizeProcName("sp.sss#2")).toBe("sp.sss");
  });
  it("strips Zabbix UserParameter index suffix (bare trailing digits)", () => {
    expect(normalizeProcName("python1")).toBe("python");
    expect(normalizeProcName("python42")).toBe("python");
  });
  it("preserves mid-name '#' (regex anchors to END only)", () => {
    expect(normalizeProcName("weird#name")).toBe("weird#name");
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
    // Both items normalise to "python" now (perfcounter strips '#1',
    // *.cpu strips '.cpu' then the bare digit '1'). chooseTelemetrySources
    // groups them and the perfcounter wins; python1.cpu is dropped.
    const r = chooseTelemetrySources([
      { itemid: "100", key_: "python1.cpu" },
      { itemid: "200", key_: 'perf_counter["\\Process(python#1)\\% Processor Time"]' },
    ]);
    expect(r.categoryById.get("100")).toBeUndefined();
    expect(r.categoryById.get("200")).toBe("retellect");
    expect(r.needsCoresDivision.has("200")).toBe(true);
    expect(r.needsCoresDivision.has("100")).toBe(false);
  });

  it("keeps ALL perf_counter instances of a multi-instance process (sp.sss#0/#1/#2)", () => {
    // Memory: project_sco_process_architecture documents sp.sss runs as 3
    // instances. The old normalizeProcName mangled each to sp.sss0/1/2 and
    // dropped them (categorise() did not match). Now all three are kept,
    // grouped under "sp.sss", and the route sums their values.
    const r = chooseTelemetrySources([
      { itemid: "10", key_: 'perf_counter["\\Process(sp.sss#0)\\% Processor Time"]' },
      { itemid: "11", key_: 'perf_counter["\\Process(sp.sss#1)\\% Processor Time"]' },
      { itemid: "12", key_: 'perf_counter["\\Process(sp.sss#2)\\% Processor Time"]' },
    ]);
    expect(r.categoryById.get("10")).toBe("scoApp");
    expect(r.categoryById.get("11")).toBe("scoApp");
    expect(r.categoryById.get("12")).toBe("scoApp");
    expect(r.needsCoresDivision.has("10")).toBe(true);
    expect(r.needsCoresDivision.has("11")).toBe(true);
    expect(r.needsCoresDivision.has("12")).toBe(true);
  });

  it("keeps BOTH bare \\Process(sp.sss) and \\Process(sp.sss#N) variants", () => {
    // Windows numbers concurrent instances of the same EXE as `name`,
    // `name#1`, `name#2`, ... The bare-name counter is the FIRST instance,
    // NOT an aggregate. Summing all of them gives the correct total CPU
    // across all running processes. Dropping the bare name would
    // under-count by exactly one instance.
    const r = chooseTelemetrySources([
      { itemid: "1", key_: 'perf_counter["\\Process(sp.sss)\\% Processor Time"]' },
      { itemid: "2", key_: 'perf_counter["\\Process(sp.sss#1)\\% Processor Time"]' },
      { itemid: "3", key_: 'perf_counter["\\Process(sp.sss#2)\\% Processor Time"]' },
    ]);
    expect(r.categoryById.get("1")).toBe("scoApp");
    expect(r.categoryById.get("2")).toBe("scoApp");
    expect(r.categoryById.get("3")).toBe("scoApp");
    expect(r.needsCoresDivision.has("1")).toBe(true);
    expect(r.needsCoresDivision.has("2")).toBe(true);
    expect(r.needsCoresDivision.has("3")).toBe(true);
  });

  it("keeps bare Process(sp.sss) when no #N instance exists for it", () => {
    const r = chooseTelemetrySources([
      { itemid: "1", key_: 'perf_counter["\\Process(sp.sss)\\% Processor Time"]' },
    ]);
    expect(r.categoryById.get("1")).toBe("scoApp");
    expect(r.needsCoresDivision.has("1")).toBe(true);
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

// ─── findUnmonitoredCategories ──────────────────────────────────────

describe("findUnmonitoredCategories", () => {
  // Day-level rollout flag: when a host had zero Zabbix samples for one of
  // the late-rollout categories (besclient / elastic / osCore) across the
  // entire drilled-into day, the UI must NOT render a flat 0% bar implying
  // the category was measured. The drill-down folds the would-be residual
  // into Other with an explanatory sub-label. This helper is the single
  // source of truth the route uses to populate `unmonitored` in the response.

  it("returns empty when every sparse category has at least one sample", () => {
    expect(findUnmonitoredCategories({ besclient: 1, elastic: 1, osCore: 1 })).toEqual([]);
    expect(findUnmonitoredCategories({ besclient: 1440, elastic: 287, osCore: 96 })).toEqual([]);
  });

  it("returns ALL three when nothing was sampled (typical Pavilnionys SCO02 drilling 2026-04-30, pre-rollout)", () => {
    // Real scenario that motivated the feature: SP admin enabled the three
    // new items on 2026-05-09. Drilling into 2026-04-30 has no samples at
    // all for any of them — Other should absorb the residual and the bar
    // chart should hide the three deceptive 0% rows.
    expect(findUnmonitoredCategories({ besclient: 0, elastic: 0, osCore: 0 })).toEqual([
      "besclient", "elastic", "osCore",
    ]);
  });

  it("returns only the missing categories when the host has partial coverage", () => {
    // E.g. a host where BESClient and Elastic are deployed but the kernel-CPU
    // item is not yet provisioned. Mixed prod hosts looked like this during
    // the 2026-05-09 → 2026-05-12 rollout window.
    expect(findUnmonitoredCategories({ besclient: 287, elastic: 287, osCore: 0 })).toEqual([
      "osCore",
    ]);
    expect(findUnmonitoredCategories({ besclient: 0, elastic: 12, osCore: 0 })).toEqual([
      "besclient", "osCore",
    ]);
  });

  it("preserves stable canonical order (besclient → elastic → osCore) regardless of input key order", () => {
    // UI sub-label concatenates the names; stable order keeps the message
    // identical run-to-run, which makes screenshots/snapshot diffs sane.
    const a = findUnmonitoredCategories({ osCore: 0, elastic: 0, besclient: 0 });
    const b = findUnmonitoredCategories({ besclient: 0, elastic: 0, osCore: 0 });
    expect(a).toEqual(b);
    expect(a).toEqual(["besclient", "elastic", "osCore"]);
  });

  it("SPARSE_CATEGORIES constant lists exactly the three rolled-out categories — guards against accidental expansion that would silently hide healthy buckets", () => {
    // If someone ever adds "retellect" or "scoApp" to SPARSE_CATEGORIES by
    // mistake, drilling into ANY day on ANY host with zero samples for those
    // (e.g. a host where Retellect was never deployed) would hide the bar
    // and confuse the user. This invariant lock keeps the set narrow.
    expect([...SPARSE_CATEGORIES].sort()).toEqual(["besclient", "elastic", "osCore"]);
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

// ─── averageSlotV2 (CPU normalisation spec 2026-05-20) ─────────────────
//
// V2 adds host-CPU integration and a sanity classification on top of the
// independent-per-category averages. The route uses these fields so the UI
// can show "Other" as the unattributed-but-real share of host CPU (instead
// of the legacy `free = 100 − Σ` which masked the >100% bug) and surface
// a warning whenever monitored sums overshoot host CPU.

describe("averageSlotV2", () => {
  const slot = (over: Partial<Parameters<typeof averageSlotV2>[0]> = {}): Parameters<typeof averageSlotV2>[0] => ({
    retellect: 0, scoApp: 0, db: 0, system: 0, besclient: 0, elastic: 0, osCore: 0,
    countR: 0, countS: 0, countD: 0, countSys: 0, countBes: 0, countEla: 0, countOs: 0,
    ...over,
  });

  it("data quality OK: categories sum close to host CPU (within 5pp tolerance)", () => {
    const r = averageSlotV2(
      slot({ scoApp: 22, countS: 1, db: 9, countD: 1, retellect: 1, countR: 1 }),
      [33],  // host CPU 33%, Σnamed = 32 → overshoot −1pp
      true,
    );
    expect(r.dataQuality).toBe("ok");
    expect(r.hostCpu).toBe(33);
    expect(r.other).toBe(1);     // 33 - 32 = 1 (max with 0)
    expect(r.free).toBe(67);     // 100 - 33 = 67
    expect(r.overshootPp).toBe(-1);
  });

  it("data quality FAIL: cpu_num normalisation missing → 135% on 85% host CPU (the original bug)", () => {
    // Reproduces the screenshot scenario: Σnamed = 87+36+7+4.7 = 134.7,
    // host CPU = 85. Old code rendered this as a stack >100%. averageSlotV2
    // surfaces dataQuality="fail" so the UI shows a warning instead.
    const r = averageSlotV2(
      slot({
        scoApp: 87, countS: 1,
        db: 36, countD: 1,
        system: 7.3, countSys: 1,
        retellect: 4.7, countR: 1,
      }),
      [85],
      true,
    );
    expect(r.dataQuality).toBe("fail");
    expect(r.hostCpu).toBe(85);
    expect(r.other).toBe(0);                 // clamped to 0 when sums overshoot
    expect(r.overshootPp).toBeGreaterThan(15);
  });

  it("data quality WARN: cores unknown forces warn even if numbers look ok", () => {
    // Same input as the "OK" case but coresKnown=false → the route did NOT
    // normalise perf_counter values, so we can't trust the sums.
    const r = averageSlotV2(
      slot({ scoApp: 22, countS: 1, db: 9, countD: 1 }),
      [33],
      false,  // coresKnown=false
    );
    expect(r.dataQuality).toBe("warn");
  });

  it("data quality WARN: no host CPU sample in slot", () => {
    const r = averageSlotV2(
      slot({ scoApp: 22, countS: 1 }),
      [],   // no sysCpu samples this slot
      true,
    );
    expect(r.dataQuality).toBe("warn");
    expect(r.hostCpu).toBeNull();
    expect(r.other).toBe(0);
    expect(r.free).toBe(0);
    expect(r.overshootPp).toBeNull();
  });

  it("Other is derived from host CPU, not from 100 - Σ (the legacy bug)", () => {
    // host=60, Σ=20 → Other should be 40 (host − Σ), NOT 80 (100 − Σ).
    // The legacy `free` formula attributed un-monitored CPU to "idle",
    // which masked normalisation errors and over-stated headroom.
    const r = averageSlotV2(
      slot({ scoApp: 20, countS: 1 }),
      [60],
      true,
    );
    expect(r.other).toBe(40);   // host CPU − Σ
    // free = max(0, 100 - Σnamed - other) = max(0, 100 - 20 - 40) = 40
    // Happens to equal 100 - hostCpu in the happy path; the next test
    // exercises the overshoot path where the two values diverge.
    expect(r.free).toBe(40);
  });

  it("INVARIANT: warn-level overshoot keeps stack within 100% (free shrinks, doesn't break)", () => {
    // Σ named = 95, host CPU = 85 (mild overshoot, ~10pp). Old free formula
    // gave 100-85=15 — stack of 95+0+15=110%. New formula gives
    // max(0, 100-95-0)=5 — stack of 95+0+5=100% with no negative bars.
    const r = averageSlotV2(
      slot({ scoApp: 95, countS: 1 }),
      [85],
      true,
    );
    expect(r.other).toBe(0);    // clamped: hostCpu - Σ = -10 -> 0
    expect(r.free).toBe(5);     // 100 - 95 - 0 = 5 (not 100 - hostCpu = 15)
    const total = r.categories.scoApp + r.other + r.free;
    expect(total).toBeCloseTo(100, 1);
    // overshoot 10pp falls in the warn band (>5pp <=15pp).
    expect(r.dataQuality).toBe("warn");
  });

  it("BREAKS invariant when sum exceeds 100 (fail-level overshoot — data is broken, math can't hide that)", () => {
    // Σ named = 110, host CPU = 80. Categories alone overshoot 100%. The
    // dataQuality classifier flags this as fail and the UI surfaces a red
    // banner; the math doesn't try to scale categories down because that
    // would distort the data the operator needs to see.
    const r = averageSlotV2(
      slot({ scoApp: 110, countS: 1 }),
      [80],
      true,
    );
    expect(r.other).toBe(0);
    expect(r.free).toBe(0);  // 100 - 110 - 0 clamped
    const total = r.categories.scoApp + r.other + r.free;
    expect(total).toBeGreaterThan(100);  // honest: data IS broken
    expect(r.dataQuality).toBe("fail"); // 30pp overshoot > 15pp threshold
  });

  it("free + other + Σ named = host CPU + free invariant always holds", () => {
    // Σ named + other = host CPU (clamped), free = 100 − host CPU
    // So Σ + other + free = max(Σ, host CPU) + (100 − host CPU)
    // which equals 100 when sums don't overshoot host CPU.
    const r = averageSlotV2(
      slot({ scoApp: 20, countS: 1, db: 10, countD: 1, system: 5, countSys: 1 }),
      [50],
      true,
    );
    const sumNamed = r.categories.scoApp + r.categories.db + r.categories.system;
    expect(sumNamed + r.other + r.free).toBeCloseTo(100, 1);
  });
});
