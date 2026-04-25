import { describe, it, expect } from "vitest";
import {
  formatRetellectCpu,
  cpuRiskColor,
  aggregateRetellectCpu,
  summarizeHardwareClasses,
} from "./rt-overview-helpers";

describe("formatRetellectCpu", () => {
  it("returns '0%' for exactly zero", () => {
    expect(formatRetellectCpu(0)).toBe("0%");
  });
  it("returns '0%' for negative or NaN", () => {
    expect(formatRetellectCpu(-1)).toBe("0%");
  });
  it("rounds tiny positive values up to 0.1%", () => {
    expect(formatRetellectCpu(0.026)).toBe("0.1%");
    expect(formatRetellectCpu(0.04)).toBe("0.1%");
  });
  it("rounds 0.05% to 0.1% (Math.max floor)", () => {
    expect(formatRetellectCpu(0.05)).toBe("0.1%");
  });
  it("renders normal positive values with 1 decimal", () => {
    expect(formatRetellectCpu(0.6)).toBe("0.6%");
    expect(formatRetellectCpu(7.04)).toBe("7.0%");
    expect(formatRetellectCpu(15.99)).toBe("16.0%");
  });
});

describe("cpuRiskColor", () => {
  it("returns red above 70", () => {
    expect(cpuRiskColor(70.1)).toBe("red");
    expect(cpuRiskColor(99)).toBe("red");
  });
  it("returns amber above 40", () => {
    expect(cpuRiskColor(40.1)).toBe("amber");
    expect(cpuRiskColor(70)).toBe("amber");
  });
  it("returns emerald for positive values up to 40", () => {
    expect(cpuRiskColor(0.1)).toBe("emerald");
    expect(cpuRiskColor(40)).toBe("emerald");
  });
  it("returns gray for 0 or negative", () => {
    expect(cpuRiskColor(0)).toBe("gray");
    expect(cpuRiskColor(-1)).toBe("gray");
  });
});

describe("aggregateRetellectCpu", () => {
  it("sums all retellect-category items per host", () => {
    const result = aggregateRetellectCpu([
      { hostId: "1", category: "retellect", cpuValue: 0.5, lastClock: "2026-04-25T10:00:00Z" },
      { hostId: "1", category: "retellect", cpuValue: 1.5, lastClock: "2026-04-25T10:00:00Z" },
      { hostId: "1", category: "retellect", cpuValue: 0.2, lastClock: "2026-04-25T10:00:00Z" },
      { hostId: "2", category: "retellect", cpuValue: 4.0, lastClock: "2026-04-25T10:00:00Z" },
    ]);
    expect(result.get("1")).toBe(2.2);
    expect(result.get("2")).toBe(4.0);
  });

  it("ignores non-retellect categories", () => {
    const result = aggregateRetellectCpu([
      { hostId: "1", category: "sco", cpuValue: 100, lastClock: "2026-04-25T10:00:00Z" },
      { hostId: "1", category: "retellect", cpuValue: 1.0, lastClock: "2026-04-25T10:00:00Z" },
    ]);
    expect(result.get("1")).toBe(1.0);
  });

  it("excludes items with null or zero lastClock", () => {
    const result = aggregateRetellectCpu([
      { hostId: "1", category: "retellect", cpuValue: 5.0, lastClock: null },
      { hostId: "2", category: "retellect", cpuValue: 3.0, lastClock: "2026-04-25T10:00:00Z" },
    ]);
    expect(result.get("1")).toBeUndefined();
    expect(result.get("2")).toBe(3.0);
  });

  it("clamps negative values to 0", () => {
    const result = aggregateRetellectCpu([
      { hostId: "1", category: "retellect", cpuValue: -5, lastClock: "2026-04-25T10:00:00Z" },
      { hostId: "1", category: "retellect", cpuValue: 1, lastClock: "2026-04-25T10:00:00Z" },
    ]);
    expect(result.get("1")).toBe(1);
  });

  it("returns empty map for empty input", () => {
    expect(aggregateRetellectCpu([]).size).toBe(0);
  });
});

describe("summarizeHardwareClasses", () => {
  it("computes avg + peak + sample count per group", () => {
    const groups = new Map([
      ["WN Beetle M3", { hosts: 4, cpuValues: [10, 20, 30, 40] }],
      ["WN Beetle M2", { hosts: 2, cpuValues: [50, 60] }],
    ]);
    const result = summarizeHardwareClasses(groups);
    const m3 = result.find((r) => r.name === "WN Beetle M3")!;
    const m2 = result.find((r) => r.name === "WN Beetle M2")!;
    expect(m3.avgCpu).toBe(25);
    expect(m3.peakCpu).toBe(40);
    expect(m3.sampleCount).toBe(4);
    expect(m2.avgCpu).toBe(55);
    expect(m2.peakCpu).toBe(60);
    expect(m2.sampleCount).toBe(2);
  });

  it("rounds avg and peak to 1 decimal", () => {
    const groups = new Map([
      ["test", { hosts: 3, cpuValues: [10.123, 20.456, 30.789] }],
    ]);
    const [row] = summarizeHardwareClasses(groups);
    expect(row.avgCpu).toBe(20.5);
    expect(row.peakCpu).toBe(30.8);
  });

  it("classifies risk by avg CPU", () => {
    const groups = new Map([
      ["critical-class", { hosts: 1, cpuValues: [80] }],
      ["warn-class", { hosts: 1, cpuValues: [50] }],
      ["ok-class", { hosts: 1, cpuValues: [20] }],
      ["empty-class", { hosts: 5, cpuValues: [] }],
    ]);
    const result = summarizeHardwareClasses(groups);
    expect(result.find((r) => r.name === "critical-class")!.risk).toBe("critical");
    expect(result.find((r) => r.name === "warn-class")!.risk).toBe("warn");
    expect(result.find((r) => r.name === "ok-class")!.risk).toBe("ok");
    expect(result.find((r) => r.name === "empty-class")!.risk).toBe("unknown");
  });

  it("sorts by avg CPU desc; empty groups last", () => {
    const groups = new Map([
      ["low", { hosts: 1, cpuValues: [10] }],
      ["high", { hosts: 1, cpuValues: [80] }],
      ["medium", { hosts: 1, cpuValues: [40] }],
      ["empty", { hosts: 5, cpuValues: [] }],
    ]);
    const result = summarizeHardwareClasses(groups);
    expect(result.map((r) => r.name)).toEqual(["high", "medium", "low", "empty"]);
  });

  it("handles single-element groups", () => {
    const groups = new Map([
      ["solo", { hosts: 1, cpuValues: [42.5] }],
    ]);
    const [row] = summarizeHardwareClasses(groups);
    expect(row.avgCpu).toBe(42.5);
    expect(row.peakCpu).toBe(42.5);
    expect(row.sampleCount).toBe(1);
  });

  it("returns empty array for empty input", () => {
    expect(summarizeHardwareClasses(new Map())).toEqual([]);
  });
});
