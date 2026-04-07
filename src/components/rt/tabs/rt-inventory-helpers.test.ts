import { describe, it, expect } from "vitest";
import {
  determineRtStatus,
  buildProcByHost,
  isPresetPeriod,
  resolvePeriodDays,
  snapToValidGranularity,
} from "./rt-inventory-helpers";

// ─── determineRtStatus ──────────────────────────────────────────────

describe("determineRtStatus", () => {
  it("returns 'running' when proc item exists with count > 0", () => {
    const result = determineRtStatus({
      retellectEnabled: true,
      zabbixHostExists: true,
      procMatch: { count: 3 },
    });
    expect(result.status).toBe("running");
    expect(result.processCount).toBe(3);
  });

  it("returns 'stopped' when proc item exists with count = 0", () => {
    const result = determineRtStatus({
      retellectEnabled: true,
      zabbixHostExists: true,
      procMatch: { count: 0 },
    });
    expect(result.status).toBe("stopped");
    expect(result.processCount).toBe(0);
  });

  it("proc item takes priority over DB flag (stopped even if enabled)", () => {
    const result = determineRtStatus({
      retellectEnabled: true,
      zabbixHostExists: true,
      procMatch: { count: 0 },
    });
    expect(result.status).toBe("stopped");
  });

  it("proc item takes priority even if retellectEnabled=false", () => {
    const result = determineRtStatus({
      retellectEnabled: false,
      zabbixHostExists: true,
      procMatch: { count: 2 },
    });
    expect(result.status).toBe("running");
    expect(result.processCount).toBe(2);
  });

  it("returns 'running' when enabled + Zabbix host exists (no proc item)", () => {
    const result = determineRtStatus({
      retellectEnabled: true,
      zabbixHostExists: true,
      procMatch: null,
    });
    expect(result.status).toBe("running");
    expect(result.processCount).toBe(0);
  });

  it("returns 'unknown' when enabled but no Zabbix host", () => {
    const result = determineRtStatus({
      retellectEnabled: true,
      zabbixHostExists: false,
      procMatch: null,
    });
    expect(result.status).toBe("unknown");
  });

  it("returns 'not-installed' when not enabled + no proc item", () => {
    const result = determineRtStatus({
      retellectEnabled: false,
      zabbixHostExists: true,
      procMatch: null,
    });
    expect(result.status).toBe("not-installed");
  });

  it("returns 'not-installed' when nothing (no enabled, no Zabbix, no proc)", () => {
    const result = determineRtStatus({
      retellectEnabled: false,
      zabbixHostExists: false,
      procMatch: null,
    });
    expect(result.status).toBe("not-installed");
  });
});

// ─── buildProcByHost ────────────────────────────────────────────────

describe("buildProcByHost", () => {
  it("returns empty map for empty input", () => {
    const result = buildProcByHost([]);
    expect(result.size).toBe(0);
  });

  it("ignores non-retellect items", () => {
    const result = buildProcByHost([
      { hostId: "h1", key: "proc.num", name: "Number of processes", value: 220 },
      { hostId: "h1", key: "proc.num[,,run]", name: "Number of running processes", value: 3 },
      { hostId: "h1", key: "kernel.maxproc", name: "Maximum number of processes", value: 4194304 },
    ]);
    expect(result.size).toBe(0);
  });

  it("matches items with 'retellect' in key", () => {
    const result = buildProcByHost([
      { hostId: "h1", key: "proc.num[retellect]", name: "Retellect processes", value: 2 },
    ]);
    expect(result.size).toBe(1);
    expect(result.get("h1")).toEqual({ count: 2, key: "proc.num[retellect]" });
  });

  it("matches items with 'retellect' in name (case insensitive)", () => {
    const result = buildProcByHost([
      { hostId: "h1", key: "proc.num[,user]", name: "Retellect Agent CPU", value: 1 },
    ]);
    expect(result.size).toBe(1);
    expect(result.get("h1")?.count).toBe(1);
  });

  it("matches 'rt_agent' in key", () => {
    const result = buildProcByHost([
      { hostId: "h1", key: "proc.num[rt_agent]", name: "RT agent", value: 5 },
    ]);
    expect(result.size).toBe(1);
    expect(result.get("h1")?.count).toBe(5);
  });

  it("matches 'rtagent' in key", () => {
    const result = buildProcByHost([
      { hostId: "h1", key: "proc.cpu.util[rtagent]", name: "Process CPU", value: 3 },
    ]);
    expect(result.size).toBe(1);
  });

  it("keeps highest value when multiple retellect items per host", () => {
    const result = buildProcByHost([
      { hostId: "h1", key: "proc.num[retellect]", name: "Count", value: 2 },
      { hostId: "h1", key: "proc.cpu.util[retellect]", name: "CPU", value: 15 },
    ]);
    expect(result.size).toBe(1);
    expect(result.get("h1")?.count).toBe(15);
  });

  it("handles multiple hosts independently", () => {
    const result = buildProcByHost([
      { hostId: "h1", key: "proc.num[retellect]", name: "Count", value: 2 },
      { hostId: "h2", key: "proc.num[retellect]", name: "Count", value: 0 },
      { hostId: "h3", key: "proc.num", name: "Total procs", value: 300 },
    ]);
    expect(result.size).toBe(2);
    expect(result.get("h1")?.count).toBe(2);
    expect(result.get("h2")?.count).toBe(0);
    expect(result.has("h3")).toBe(false);
  });
});

// ─── isPresetPeriod ─────────────────────────────────────────────────

describe("isPresetPeriod", () => {
  it("returns true for all preset IDs", () => {
    expect(isPresetPeriod("1h")).toBe(true);
    expect(isPresetPeriod("1d")).toBe(true);
    expect(isPresetPeriod("7d")).toBe(true);
    expect(isPresetPeriod("14d")).toBe(true);
    expect(isPresetPeriod("30d")).toBe(true);
    expect(isPresetPeriod("90d")).toBe(true);
  });

  it("returns false for custom period strings", () => {
    expect(isPresetPeriod("45")).toBe(false);
    expect(isPresetPeriod("100")).toBe(false);
    expect(isPresetPeriod("3d")).toBe(false);
    expect(isPresetPeriod("")).toBe(false);
  });
});

// ─── resolvePeriodDays ──────────────────────────────────────────────

describe("resolvePeriodDays", () => {
  it("returns correct days for preset periods", () => {
    expect(resolvePeriodDays("1h")).toBe(0);
    expect(resolvePeriodDays("1d")).toBe(1);
    expect(resolvePeriodDays("7d")).toBe(7);
    expect(resolvePeriodDays("14d")).toBe(14);
    expect(resolvePeriodDays("30d")).toBe(30);
    expect(resolvePeriodDays("90d")).toBe(90);
  });

  it("parses custom period as number of days", () => {
    expect(resolvePeriodDays("45")).toBe(45);
    expect(resolvePeriodDays("100")).toBe(100);
    expect(resolvePeriodDays("365")).toBe(365);
    expect(resolvePeriodDays("1")).toBe(1);
  });

  it("returns default 14 for invalid input", () => {
    expect(resolvePeriodDays("")).toBe(14);
    expect(resolvePeriodDays("abc")).toBe(14);
    expect(resolvePeriodDays("0")).toBe(14);
    expect(resolvePeriodDays("-5")).toBe(14);
  });
});

// ─── snapToValidGranularity ─────────────────────────────────────────

describe("snapToValidGranularity", () => {
  it("returns exact value when it's a valid 1440 divisor", () => {
    expect(snapToValidGranularity(1)).toBe(1);
    expect(snapToValidGranularity(5)).toBe(5);
    expect(snapToValidGranularity(10)).toBe(10);
    expect(snapToValidGranularity(15)).toBe(15);
    expect(snapToValidGranularity(30)).toBe(30);
    expect(snapToValidGranularity(60)).toBe(60);
    expect(snapToValidGranularity(120)).toBe(120);
  });

  it("snaps to nearest valid divisor for non-divisors", () => {
    // 9 → 8 or 10, both valid; result must divide 1440
    expect(1440 % snapToValidGranularity(9)).toBe(0);
    expect(snapToValidGranularity(9)).toBeLessThanOrEqual(10);
    expect(snapToValidGranularity(9)).toBeGreaterThanOrEqual(8);
    // 14 → 12 or 15
    expect(1440 % snapToValidGranularity(14)).toBe(0);
    // 25 → 24
    expect(snapToValidGranularity(25)).toBe(24);
    // 50 → 48
    expect(snapToValidGranularity(50)).toBe(48);
    // 55 → 48 or 60
    expect(1440 % snapToValidGranularity(55)).toBe(0);
  });

  it("clamps to 1-120 range", () => {
    expect(snapToValidGranularity(0)).toBe(1);
    expect(snapToValidGranularity(-5)).toBe(1);
    expect(snapToValidGranularity(200)).toBe(120);
    expect(snapToValidGranularity(999)).toBe(120);
  });

  it("all results evenly divide 1440", () => {
    for (let m = 1; m <= 120; m++) {
      const snapped = snapToValidGranularity(m);
      expect(1440 % snapped).toBe(0);
    }
  });
});
