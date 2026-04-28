import { describe, it, expect } from "vitest";
import {
  determineRtStatus,
  buildProcByHost,
  buildRetellectProcsByHost,
  RT_FRESHNESS_THRESHOLD_SEC,
  isPresetPeriod,
  resolvePeriodDays,
  snapToValidGranularity,
  compareHosts,
  RT_STATUS_SORT_ORDER,
  formatAgeShort,
  computeCpuTotal,
  bytesToGb,
  computeConnectionStats,
  resolveCpuModel,
  resolveOs,
  type HostSortable,
  type ConnectionStatsInput,
  type RtProcessStatus,
} from "./rt-inventory-helpers";

// ─── Sort / comparison helpers (HI-2) ──────────────────────────

function host(overrides: Partial<HostSortable> = {}): HostSortable {
  return {
    name: "host1",
    store: "StoreA",
    cpuModel: "Intel",
    memTotalGb: 4,
    rtProcessStatus: "running" as RtProcessStatus,
    cpuUser: 1,
    cpuSystem: 1,
    cpuTotal: 2,
    ...overrides,
  };
}

describe("RT_STATUS_SORT_ORDER", () => {
  it("ranks running before stopped before unknown before not-installed", () => {
    expect(RT_STATUS_SORT_ORDER.running).toBeLessThan(RT_STATUS_SORT_ORDER.stopped);
    expect(RT_STATUS_SORT_ORDER.stopped).toBeLessThan(RT_STATUS_SORT_ORDER.unknown);
    expect(RT_STATUS_SORT_ORDER.unknown).toBeLessThan(RT_STATUS_SORT_ORDER["not-installed"]);
  });
});

describe("compareHosts", () => {
  it("sorts by name ascending with natural numeric order", () => {
    const rows = [host({ name: "host10" }), host({ name: "host2" }), host({ name: "host1" })];
    rows.sort((a, b) => compareHosts(a, b, "name", "asc"));
    expect(rows.map((r) => r.name)).toEqual(["host1", "host2", "host10"]);
  });

  it("sorts by name descending", () => {
    const rows = [host({ name: "host1" }), host({ name: "host10" }), host({ name: "host2" })];
    rows.sort((a, b) => compareHosts(a, b, "name", "desc"));
    expect(rows.map((r) => r.name)).toEqual(["host10", "host2", "host1"]);
  });

  it("sorts by store ascending", () => {
    const rows = [host({ name: "a", store: "B" }), host({ name: "b", store: "A" })];
    rows.sort((a, b) => compareHosts(a, b, "store", "asc"));
    expect(rows.map((r) => r.store)).toEqual(["A", "B"]);
  });

  it("sorts by cpuModel ascending", () => {
    const rows = [host({ name: "a", cpuModel: "Intel Xeon" }), host({ name: "b", cpuModel: "Intel Celeron" })];
    rows.sort((a, b) => compareHosts(a, b, "cpuModel", "asc"));
    expect(rows.map((r) => r.cpuModel)).toEqual(["Intel Celeron", "Intel Xeon"]);
  });

  it("sorts by ramGb descending", () => {
    const rows = [host({ name: "a", memTotalGb: 4 }), host({ name: "b", memTotalGb: 16 }), host({ name: "c", memTotalGb: 8 })];
    rows.sort((a, b) => compareHosts(a, b, "ramGb", "desc"));
    expect(rows.map((r) => r.memTotalGb)).toEqual([16, 8, 4]);
  });

  it("sorts by rtStatus ascending: running → stopped → unknown → not-installed", () => {
    const rows = [
      host({ name: "a", rtProcessStatus: "not-installed" }),
      host({ name: "b", rtProcessStatus: "running" }),
      host({ name: "c", rtProcessStatus: "unknown" }),
      host({ name: "d", rtProcessStatus: "stopped" }),
    ];
    rows.sort((a, b) => compareHosts(a, b, "rtStatus", "asc"));
    expect(rows.map((r) => r.rtProcessStatus)).toEqual([
      "running",
      "stopped",
      "unknown",
      "not-installed",
    ]);
  });

  it("sorts by cpuTotal descending", () => {
    const rows = [host({ name: "a", cpuTotal: 5 }), host({ name: "b", cpuTotal: 80 }), host({ name: "c", cpuTotal: 40 })];
    rows.sort((a, b) => compareHosts(a, b, "cpuTotal", "desc"));
    expect(rows.map((r) => r.cpuTotal)).toEqual([80, 40, 5]);
  });

  it("uses name as stable tiebreaker when primary key is equal", () => {
    const rows = [
      host({ name: "charlie", cpuTotal: 10 }),
      host({ name: "alpha", cpuTotal: 10 }),
      host({ name: "bravo", cpuTotal: 10 }),
    ];
    rows.sort((a, b) => compareHosts(a, b, "cpuTotal", "asc"));
    expect(rows.map((r) => r.name)).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("treats NaN / Infinity numeric values as 0 and keeps sort stable", () => {
    const rows = [
      host({ name: "a", cpuTotal: Number.NaN }),
      host({ name: "b", cpuTotal: 5 }),
      host({ name: "c", cpuTotal: Infinity }),
    ];
    rows.sort((a, b) => compareHosts(a, b, "cpuTotal", "desc"));
    // `b` wins with 5; a and c both coerce to 0, tiebreak by name asc
    expect(rows.map((r) => r.name)).toEqual(["b", "a", "c"]);
  });

  it("handles a host whose user/system CPU were never reported (all zero)", () => {
    const rows = [
      host({ name: "a", cpuUser: 0, cpuSystem: 0 }),
      host({ name: "b", cpuUser: 2, cpuSystem: 1 }),
      host({ name: "c", cpuUser: 0, cpuSystem: 0 }),
    ];
    rows.sort((a, b) => compareHosts(a, b, "cpuUser", "desc"));
    expect(rows.map((r) => r.name)).toEqual(["b", "a", "c"]);
  });

  it("is stable on an empty array", () => {
    const rows: HostSortable[] = [];
    rows.sort((a, b) => compareHosts(a, b, "name", "asc"));
    expect(rows).toEqual([]);
  });

  it("ascending and descending produce opposite orderings", () => {
    const base = [host({ name: "a", cpuTotal: 1 }), host({ name: "b", cpuTotal: 3 }), host({ name: "c", cpuTotal: 2 })];
    const asc = [...base].sort((a, b) => compareHosts(a, b, "cpuTotal", "asc")).map((r) => r.name);
    const desc = [...base].sort((a, b) => compareHosts(a, b, "cpuTotal", "desc")).map((r) => r.name);
    expect(asc).toEqual([...desc].reverse());
  });
});

// ─── formatAgeShort ───────────────────────────────────────

describe("formatAgeShort", () => {
  it("formats seconds below 60 as 'Ns'", () => {
    expect(formatAgeShort(0)).toBe("0s");
    expect(formatAgeShort(1)).toBe("1s");
    expect(formatAgeShort(42)).toBe("42s");
    expect(formatAgeShort(59)).toBe("59s");
  });

  it("crosses into minutes at exactly 60 seconds", () => {
    expect(formatAgeShort(60)).toBe("1m");
    expect(formatAgeShort(90)).toBe("2m"); // Math.round(1.5) = 2
    expect(formatAgeShort(3599)).toBe("60m");
  });

  it("crosses into hours at exactly 3600 seconds", () => {
    expect(formatAgeShort(3600)).toBe("1h");
    expect(formatAgeShort(7199)).toBe("2h");
    expect(formatAgeShort(86399)).toBe("24h");
  });

  it("crosses into days at exactly 86400 seconds", () => {
    expect(formatAgeShort(86400)).toBe("1d");
    expect(formatAgeShort(172800)).toBe("2d");
    expect(formatAgeShort(86400 * 7)).toBe("7d");
  });

  it("rounds to nearest unit", () => {
    // 61s → Math.round(61/60) = 1m
    expect(formatAgeShort(61)).toBe("1m");
    // 89s → Math.round(89/60) = 1m (since 1.483... rounds to 1)
    expect(formatAgeShort(89)).toBe("1m");
  });

  it("clamps negative seconds to 0 in the seconds bucket", () => {
    // Negative ageSec (clock skew) → still a seconds-bucket value, clamped
    expect(formatAgeShort(-5)).toBe("0s");
  });

  it("returns em-dash for null / NaN / Infinity", () => {
    expect(formatAgeShort(null)).toBe("—");
    expect(formatAgeShort(Number.NaN)).toBe("—");
    expect(formatAgeShort(Infinity)).toBe("—");
    expect(formatAgeShort(-Infinity)).toBe("—");
  });
});

// ─── computeCpuTotal ─────────────────────────────────────

describe("computeCpuTotal", () => {
  it("sums user + system when both positive", () => {
    expect(computeCpuTotal(2, 3, 0)).toBe(5);
    expect(computeCpuTotal(4.3, 1.2, 0)).toBeCloseTo(5.5, 5);
  });

  it("prefers user+system over a standalone fallback total", () => {
    // DB/Zabbix may double-count if we used both — verify we ignore fallback when user+system > 0
    expect(computeCpuTotal(2, 3, 99)).toBe(5);
  });

  it("falls back to aggregated total when user and system are zero", () => {
    expect(computeCpuTotal(0, 0, 12.3)).toBe(12.3);
  });

  it("returns 0 when everything is zero", () => {
    expect(computeCpuTotal(0, 0, 0)).toBe(0);
  });

  it("treats negative components as 0 and falls through to fallback", () => {
    expect(computeCpuTotal(-1, -1, 8)).toBe(8);
  });

  it("treats NaN components as 0", () => {
    expect(computeCpuTotal(Number.NaN, 5, 0)).toBe(5);
    expect(computeCpuTotal(Number.NaN, Number.NaN, 3.14)).toBeCloseTo(3.1, 2);
  });

  it("rounds to 1 decimal place", () => {
    // 1.23 + 2.34 = 3.57 → 3.6
    expect(computeCpuTotal(1.23, 2.34, 0)).toBe(3.6);
    // 1.21 + 2.34 = 3.55 → 3.6 (round-half-up in Math.round with multiplier)
    expect(computeCpuTotal(1.21, 2.34, 0)).toBe(3.6);
    // 1.21 + 2.31 = 3.52 → 3.5
    expect(computeCpuTotal(1.21, 2.31, 0)).toBe(3.5);
  });

  it("ignores NaN fallback when user+system also zero", () => {
    expect(computeCpuTotal(0, 0, Number.NaN)).toBe(0);
    expect(computeCpuTotal(0, 0, Infinity)).toBe(0);
  });
});

// ─── bytesToGb ─────────────────────────────────────────

describe("bytesToGb", () => {
  it("converts bytes to GB correctly", () => {
    expect(bytesToGb(1024 * 1024 * 1024)).toBe(1);
    expect(bytesToGb(4 * 1024 ** 3)).toBe(4);
    expect(bytesToGb(8 * 1024 ** 3)).toBe(8);
  });

  it("handles null / undefined / zero / negative values", () => {
    expect(bytesToGb(null)).toBe(0);
    expect(bytesToGb(undefined)).toBe(0);
    expect(bytesToGb(0)).toBe(0);
    expect(bytesToGb(-1024)).toBe(0);
  });

  it("handles NaN and Infinity as 0", () => {
    expect(bytesToGb(Number.NaN)).toBe(0);
    expect(bytesToGb(Infinity)).toBe(0);
  });

  it("returns fractional GB for sub-gigabyte totals", () => {
    expect(bytesToGb(512 * 1024 * 1024)).toBeCloseTo(0.5, 5);
  });
});

// ─── computeConnectionStats ────────────────────────────────

function isoMinusSec(nowUnix: number, ageSec: number): string {
  return new Date((nowUnix - ageSec) * 1000).toISOString();
}

function row(overrides: Partial<ConnectionStatsInput> = {}): ConnectionStatsInput {
  return {
    zabbixMatched: true,
    lastClock: null,
    retellectEnabled: false,
    rtProcessStatus: "not-installed" as RtProcessStatus,
    ...overrides,
  };
}

describe("computeConnectionStats", () => {
  const NOW = 1_700_000_000; // 2023-11-14 22:13:20 UTC

  it("returns all-zero counters for an empty list", () => {
    expect(computeConnectionStats([], NOW)).toEqual({
      total: 0,
      matched: 0,
      reportingCpu: 0,
      retellectExpected: 0,
      retellectRunning: 0,
    });
  });

  it("counts matched only for hosts with zabbixMatched=true", () => {
    const hosts = [
      row({ zabbixMatched: true }),
      row({ zabbixMatched: false }),
      row({ zabbixMatched: true }),
    ];
    const stats = computeConnectionStats(hosts, NOW);
    expect(stats.total).toBe(3);
    expect(stats.matched).toBe(2);
  });

  it("counts reportingCpu only for matched hosts with fresh lastClock (<5min)", () => {
    const hosts = [
      row({ zabbixMatched: true, lastClock: isoMinusSec(NOW, 30) }), // 30s → fresh
      row({ zabbixMatched: true, lastClock: isoMinusSec(NOW, 299) }), // 299s → fresh
      row({ zabbixMatched: true, lastClock: isoMinusSec(NOW, 300) }), // exactly 5 min → STALE (< not ≤)
      row({ zabbixMatched: true, lastClock: isoMinusSec(NOW, 3600) }), // 1h → stale
      row({ zabbixMatched: false, lastClock: isoMinusSec(NOW, 10) }), // unmatched → ignored
      row({ zabbixMatched: true, lastClock: null }), // matched but no data yet
    ];
    const stats = computeConnectionStats(hosts, NOW);
    expect(stats.matched).toBe(5);
    expect(stats.reportingCpu).toBe(2);
  });

  it("uses the freshness threshold constant (300s)", () => {
    // Sanity: the reportingCpu branch must match RT_FRESHNESS_THRESHOLD_SEC
    expect(RT_FRESHNESS_THRESHOLD_SEC).toBe(300);
    const hosts = [
      row({ zabbixMatched: true, lastClock: isoMinusSec(NOW, RT_FRESHNESS_THRESHOLD_SEC - 1) }),
      row({ zabbixMatched: true, lastClock: isoMinusSec(NOW, RT_FRESHNESS_THRESHOLD_SEC) }),
    ];
    const stats = computeConnectionStats(hosts, NOW);
    expect(stats.reportingCpu).toBe(1);
  });

  it("counts retellectExpected from DB flag regardless of Zabbix match", () => {
    const hosts = [
      row({ retellectEnabled: true }),
      row({ retellectEnabled: true, zabbixMatched: false }),
      row({ retellectEnabled: false }),
    ];
    const stats = computeConnectionStats(hosts, NOW);
    expect(stats.retellectExpected).toBe(2);
  });

  it("counts retellectRunning only for rtProcessStatus='running'", () => {
    const hosts = [
      row({ rtProcessStatus: "running" }),
      row({ rtProcessStatus: "running" }),
      row({ rtProcessStatus: "stopped" }),
      row({ rtProcessStatus: "unknown" }),
      row({ rtProcessStatus: "not-installed" }),
    ];
    const stats = computeConnectionStats(hosts, NOW);
    expect(stats.retellectRunning).toBe(2);
  });

  it("handles malformed ISO lastClock gracefully (treated as not fresh)", () => {
    const hosts = [
      row({ zabbixMatched: true, lastClock: "not-a-date" }),
      row({ zabbixMatched: true, lastClock: isoMinusSec(NOW, 10) }),
    ];
    const stats = computeConnectionStats(hosts, NOW);
    expect(stats.matched).toBe(2);
    // malformed clock does NOT count toward reportingCpu
    expect(stats.reportingCpu).toBe(1);
  });

  it("treats future lastClock as fresh (age clamped to 0)", () => {
    // Clock skew: Zabbix reports a sample 30s in the future → still fresh
    const hosts = [row({ zabbixMatched: true, lastClock: isoMinusSec(NOW, -30) })];
    const stats = computeConnectionStats(hosts, NOW);
    expect(stats.reportingCpu).toBe(1);
  });

  it("integrates all counters for a realistic pilot snapshot", () => {
    // 4 DB devices: 3 matched, 2 reporting, 3 expected-to-run-RT, 1 actually running
    const hosts = [
      row({ zabbixMatched: true, lastClock: isoMinusSec(NOW, 10), retellectEnabled: true, rtProcessStatus: "running" }),
      row({ zabbixMatched: true, lastClock: isoMinusSec(NOW, 200), retellectEnabled: true, rtProcessStatus: "stopped" }),
      row({ zabbixMatched: true, lastClock: isoMinusSec(NOW, 900), retellectEnabled: true, rtProcessStatus: "unknown" }),
      row({ zabbixMatched: false, lastClock: null, retellectEnabled: false, rtProcessStatus: "not-installed" }),
    ];
    const stats = computeConnectionStats(hosts, NOW);
    expect(stats).toEqual({
      total: 4,
      matched: 3,
      reportingCpu: 2,
      retellectExpected: 3,
      retellectRunning: 1,
    });
  });
});

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

  it("returns 'unknown' when enabled + Zabbix host exists but no proc evidence", () => {
    // Regression: previously returned 'running' optimistically, which misled the UI.
    // Without proc.num we cannot prove the process is running, so the honest answer is 'unknown'.
    const result = determineRtStatus({
      retellectEnabled: true,
      zabbixHostExists: true,
      procMatch: null,
    });
    expect(result.status).toBe("unknown");
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

// ─── determineRtStatus — Python telemetry path (HI-6) ────────────────

describe("determineRtStatus (retellectProcs)", () => {
  const NOW = 1_800_000_000; // deterministic reference timestamp

  it("returns 'running' when any python sample is fresh (<5 min old)", () => {
    const result = determineRtStatus({
      retellectEnabled: true,
      zabbixHostExists: true,
      procMatch: null,
      retellectProcs: [
        { procName: "python", cpuValue: 2.1, lastClockUnix: NOW - 30 },
        { procName: "python1", cpuValue: 1.4, lastClockUnix: NOW - 60 },
        { procName: "python2", cpuValue: 0.8, lastClockUnix: NOW - 120 },
      ],
      nowUnix: NOW,
    });
    expect(result.status).toBe("running");
    expect(result.processCount).toBe(3);
    expect(result.freshestAgeSec).toBe(30);
    expect(result.retellectCpuTotal).toBe(4.3);
  });

  it("returns 'stopped' when python items exist but every sample is stale (>=5 min)", () => {
    const result = determineRtStatus({
      retellectEnabled: true,
      zabbixHostExists: true,
      procMatch: null,
      retellectProcs: [
        { procName: "python", cpuValue: 0, lastClockUnix: NOW - RT_FRESHNESS_THRESHOLD_SEC - 30 },
      ],
      nowUnix: NOW,
    });
    expect(result.status).toBe("stopped");
    expect(result.processCount).toBe(1);
    expect(result.freshestAgeSec).toBe(RT_FRESHNESS_THRESHOLD_SEC + 30);
  });

  it("returns 'not-installed' when retellectProcs is empty and DB flag is false", () => {
    const result = determineRtStatus({
      retellectEnabled: false,
      zabbixHostExists: true,
      procMatch: null,
      retellectProcs: [],
      nowUnix: NOW,
    });
    expect(result.status).toBe("not-installed");
    expect(result.retellectCpuTotal).toBe(0);
    expect(result.freshestAgeSec).toBeNull();
  });

  it("returns 'unknown' when DB says enabled but no python items found", () => {
    // Flags a mismatch: provisioning expects Retellect but Zabbix has no python.cpu items.
    // User should see this as a misconfiguration signal.
    const result = determineRtStatus({
      retellectEnabled: true,
      zabbixHostExists: true,
      procMatch: null,
      retellectProcs: [],
      nowUnix: NOW,
    });
    expect(result.status).toBe("unknown");
  });

  it("uses the youngest sample — 1 fresh among several stale is still running", () => {
    const result = determineRtStatus({
      retellectEnabled: true,
      zabbixHostExists: true,
      procMatch: null,
      retellectProcs: [
        { procName: "python", cpuValue: 0, lastClockUnix: NOW - 3600 },
        { procName: "python1", cpuValue: 0, lastClockUnix: NOW - 3600 },
        { procName: "python2", cpuValue: 4.5, lastClockUnix: NOW - 45 },
      ],
      nowUnix: NOW,
    });
    expect(result.status).toBe("running");
    expect(result.freshestAgeSec).toBe(45);
  });

  it("boundary: exactly at threshold is 'stopped' (strict <5 min for running)", () => {
    const result = determineRtStatus({
      retellectEnabled: true,
      zabbixHostExists: true,
      procMatch: null,
      retellectProcs: [
        { procName: "python", cpuValue: 0, lastClockUnix: NOW - RT_FRESHNESS_THRESHOLD_SEC },
      ],
      nowUnix: NOW,
    });
    expect(result.status).toBe("stopped");
  });

  it("retellectProcs takes priority over legacy procMatch", () => {
    // If both signals are provided, the python telemetry wins — it's the authoritative source.
    const result = determineRtStatus({
      retellectEnabled: true,
      zabbixHostExists: true,
      procMatch: { count: 99 }, // stale proc.num claim
      retellectProcs: [
        { procName: "python", cpuValue: 0, lastClockUnix: NOW - 60 },
      ],
      nowUnix: NOW,
    });
    expect(result.status).toBe("running");
    expect(result.processCount).toBe(1); // counted from retellectProcs, not procMatch
  });

  it("sums CPU % across all python workers", () => {
    const result = determineRtStatus({
      retellectEnabled: true,
      zabbixHostExists: true,
      procMatch: null,
      retellectProcs: [
        { procName: "python", cpuValue: 1.0, lastClockUnix: NOW - 30 },
        { procName: "python1", cpuValue: 2.5, lastClockUnix: NOW - 30 },
        { procName: "python2", cpuValue: 3.2, lastClockUnix: NOW - 30 },
      ],
      nowUnix: NOW,
    });
    expect(result.retellectCpuTotal).toBe(6.7);
  });
});

// ─── buildRetellectProcsByHost ─────────────────────────────

describe("buildRetellectProcsByHost", () => {
  it("returns an empty map for no input", () => {
    const result = buildRetellectProcsByHost([]);
    expect(result.size).toBe(0);
  });

  it("groups python entries by host and discards non-retellect categories", () => {
    const result = buildRetellectProcsByHost([
      { hostId: "h1", key: "python.cpu", name: "Python", procName: "python", category: "retellect", cpuValue: 1.5, lastClockUnix: 100 },
      { hostId: "h1", key: "python1.cpu", name: "Python1", procName: "python1", category: "retellect", cpuValue: 2.0, lastClockUnix: 110 },
      { hostId: "h1", key: "spss.cpu", name: "SPSS", procName: "spss", category: "sco", cpuValue: 5.0, lastClockUnix: 120 },
      { hostId: "h2", key: "python.cpu", name: "Python", procName: "python", category: "retellect", cpuValue: 3.0, lastClockUnix: 130 },
      { hostId: "h2", key: "sqlservr.cpu", name: "SQL", procName: "sqlservr", category: "db", cpuValue: 0.2, lastClockUnix: 140 },
    ]);
    expect(result.size).toBe(2);
    expect(result.get("h1")?.length).toBe(2);
    expect(result.get("h2")?.length).toBe(1);
    expect(result.get("h1")?.every((s) => s.procName.startsWith("python"))).toBe(true);
  });

  it("sorts python workers naturally (python, python1, python2, python10)", () => {
    const result = buildRetellectProcsByHost([
      { hostId: "h1", key: "python10.cpu", name: "", procName: "python10", category: "retellect", cpuValue: 0, lastClockUnix: 0 },
      { hostId: "h1", key: "python.cpu",   name: "", procName: "python",   category: "retellect", cpuValue: 0, lastClockUnix: 0 },
      { hostId: "h1", key: "python2.cpu",  name: "", procName: "python2",  category: "retellect", cpuValue: 0, lastClockUnix: 0 },
      { hostId: "h1", key: "python1.cpu",  name: "", procName: "python1",  category: "retellect", cpuValue: 0, lastClockUnix: 0 },
    ]);
    const names = result.get("h1")?.map((s) => s.procName) ?? [];
    expect(names).toEqual(["python", "python1", "python2", "python10"]);
  });

  it("preserves cpuValue and lastClockUnix on each sample", () => {
    const result = buildRetellectProcsByHost([
      { hostId: "h1", key: "python.cpu", name: "", procName: "python", category: "retellect", cpuValue: 2.7, lastClockUnix: 1700000000 },
    ]);
    const s = result.get("h1")?.[0];
    expect(s?.cpuValue).toBe(2.7);
    expect(s?.lastClockUnix).toBe(1700000000);
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

// ─── resolveCpuModel / resolveOs (RT-CPUMODEL phase 1) ───────────────

describe("resolveCpuModel", () => {
  it("prefers DB value when both are present", () => {
    expect(resolveCpuModel("Intel Xeon E3-1220", "Intel(R) generic")).toBe("Intel Xeon E3-1220");
  });

  it("falls back to inventory value when DB is null", () => {
    expect(resolveCpuModel(null, "Intel(R) Pentium(R) G4400")).toBe("Intel(R) Pentium(R) G4400");
  });

  it("falls back to inventory value when DB is undefined", () => {
    expect(resolveCpuModel(undefined, "Intel Atom")).toBe("Intel Atom");
  });

  it("falls back to inventory value when DB is empty string", () => {
    expect(resolveCpuModel("", "AMD Ryzen 5")).toBe("AMD Ryzen 5");
  });

  it("falls back to inventory value when DB is em-dash placeholder", () => {
    expect(resolveCpuModel("—", "Intel Core i5")).toBe("Intel Core i5");
  });

  it("falls back to inventory value when DB is hyphen placeholder", () => {
    expect(resolveCpuModel("-", "Intel Core i7")).toBe("Intel Core i7");
  });

  it("falls back to inventory value when DB is the literal string 'null'", () => {
    expect(resolveCpuModel("null", "Intel Core i9")).toBe("Intel Core i9");
    expect(resolveCpuModel("NULL", "Intel Core i9")).toBe("Intel Core i9");
  });

  it("returns placeholder when both DB and inventory are null/empty", () => {
    expect(resolveCpuModel(null, null)).toBe("—");
    expect(resolveCpuModel(undefined, undefined)).toBe("—");
    expect(resolveCpuModel("", "")).toBe("—");
    expect(resolveCpuModel("—", null)).toBe("—");
  });

  it("respects a custom placeholder", () => {
    expect(resolveCpuModel(null, null, "Unknown")).toBe("Unknown");
    expect(resolveCpuModel("", "", "n/a")).toBe("n/a");
  });

  it("trims whitespace before deciding presence", () => {
    expect(resolveCpuModel("   ", "Intel Atom")).toBe("Intel Atom");
    expect(resolveCpuModel("  Intel Xeon  ", null)).toBe("Intel Xeon");
  });

  it("never returns a falsy string — always either a real value or the placeholder", () => {
    const inputs: Array<[string | null | undefined, string | null | undefined]> = [
      [null, null], ["", ""], [undefined, undefined], ["—", "—"], ["-", "-"],
    ];
    for (const [a, b] of inputs) {
      expect(resolveCpuModel(a, b)).toBeTruthy();
    }
  });
});

describe("resolveOs", () => {
  it("uses the same fallback contract as resolveCpuModel", () => {
    // Sanity: resolveOs is a thin wrapper today but exists separately so callers
    // signal intent (and so we can diverge later without breaking callers).
    expect(resolveOs("Windows 10 Pro", "Microsoft Windows 10")).toBe("Windows 10 Pro");
    expect(resolveOs(null, "Windows Server 2019")).toBe("Windows Server 2019");
    expect(resolveOs(null, null)).toBe("—");
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
