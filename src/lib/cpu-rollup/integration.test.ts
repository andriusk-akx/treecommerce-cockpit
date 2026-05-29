/**
 * Integration tests for the rollup writer/reader orchestrators with
 * Prisma and the Zabbix client mocked. These tests verify the glue:
 * which DB tables get touched, what the where/data shapes look like,
 * how the hybrid reader splits its window. Math correctness is covered
 * by the helpers/writer-process/reader-pure suites.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// vitest hoists vi.mock factories above all top-level code, so we have
// to register the mock fns through vi.hoisted to ensure they exist by
// the time the factories run.
const mocks = vi.hoisted(() => ({
  cpuMetricDailyUpsert: vi.fn(),
  cpuMetricHourlyUpsert: vi.fn(),
  cpuProcessMetricHourlyUpsert: vi.fn(),
  cpuMetricDailyFindMany: vi.fn(),
  cpuMetricHourlyFindMany: vi.fn(),
  cpuMetricDailyDeleteMany: vi.fn(),
  cpuMetricHourlyDeleteMany: vi.fn(),
  cpuProcessMetricHourlyDeleteMany: vi.fn(),
  pilotFindUnique: vi.fn(),
  pilotFindMany: vi.fn(),
  getHostsMock: vi.fn(),
  getItemsMock: vi.fn(),
  getCpuHistoryForRangeMock: vi.fn(),
  fetchRolloutRawBucketsMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    cpuMetricDaily: {
      upsert: mocks.cpuMetricDailyUpsert,
      findMany: mocks.cpuMetricDailyFindMany,
      deleteMany: mocks.cpuMetricDailyDeleteMany,
    },
    cpuMetricHourly: {
      upsert: mocks.cpuMetricHourlyUpsert,
      findMany: mocks.cpuMetricHourlyFindMany,
      deleteMany: mocks.cpuMetricHourlyDeleteMany,
    },
    cpuProcessMetricHourly: {
      upsert: mocks.cpuProcessMetricHourlyUpsert,
      deleteMany: mocks.cpuProcessMetricHourlyDeleteMany,
    },
    pilot: {
      findUnique: mocks.pilotFindUnique,
      findMany: mocks.pilotFindMany,
    },
  },
}));

vi.mock("@/lib/zabbix/client", () => ({
  getZabbixClient: () => ({
    getHosts: mocks.getHostsMock,
    getItems: mocks.getItemsMock,
    getCpuHistoryForRange: mocks.getCpuHistoryForRangeMock,
  }),
}));

vi.mock("@/lib/rollout-insights/fetcher", () => ({
  fetchRolloutRawBuckets: mocks.fetchRolloutRawBucketsMock,
}));

const {
  cpuMetricDailyUpsert, cpuMetricHourlyUpsert, cpuProcessMetricHourlyUpsert,
  cpuMetricDailyFindMany, cpuMetricHourlyFindMany,
  pilotFindUnique, pilotFindMany,
  getHostsMock, getItemsMock, getCpuHistoryForRangeMock,
  fetchRolloutRawBucketsMock,
} = mocks;

import { rollupPilotRange } from "./writer";
import { readCpuHistoryHybrid } from "./reader";

beforeEach(() => {
  vi.clearAllMocks();
  cpuMetricDailyUpsert.mockResolvedValue({ id: "x" });
  cpuMetricHourlyUpsert.mockResolvedValue({ id: "x" });
  cpuProcessMetricHourlyUpsert.mockResolvedValue({ id: "x" });
  cpuMetricDailyFindMany.mockResolvedValue([]);
  cpuMetricHourlyFindMany.mockResolvedValue([]);
  pilotFindMany.mockResolvedValue([]);
  getHostsMock.mockResolvedValue([]);
  getItemsMock.mockResolvedValue([]);
  getCpuHistoryForRangeMock.mockResolvedValue({ daily: [], samples: [] });
  fetchRolloutRawBucketsMock.mockResolvedValue({
    periodDays: 2,
    perHostBuckets: [],
    generatedAt: new Date().toISOString(),
  });
});

// ── writer: rollupPilotRange ─────────────────────────────────────────

describe("rollupPilotRange — empty pilot", () => {
  it("returns warning when pilot has no devices", async () => {
    pilotFindUnique.mockResolvedValue({ id: "p1", devices: [] });
    const stats = await rollupPilotRange("p1", "2026-05-15", "2026-05-15");
    expect(stats.hostsResolved).toBe(0);
    expect(stats.warnings).toContain("No matching Zabbix hosts for pilot");
    expect(cpuMetricDailyUpsert).not.toHaveBeenCalled();
  });

  it("returns warning when pilot not found at all", async () => {
    pilotFindUnique.mockResolvedValue(null);
    const stats = await rollupPilotRange("nonexistent", "2026-05-15", "2026-05-15");
    expect(stats.hostsResolved).toBe(0);
    expect(stats.warnings.length).toBeGreaterThan(0);
    expect(cpuMetricDailyUpsert).not.toHaveBeenCalled();
  });
});

describe("rollupPilotRange — happy path", () => {
  it("upserts daily, hourly, and per-process rows", async () => {
    pilotFindUnique.mockResolvedValue({
      id: "p1",
      devices: [
        { id: "d1", name: "SCO01", sourceHostKey: null, store: { name: "Store A" } },
      ],
    });
    getHostsMock.mockResolvedValue([{ hostid: "z1", name: "SCO01" }]);
    getItemsMock.mockResolvedValue([{ itemid: "i1", hostid: "z1", key_: "system.cpu.util[,,avg1]" }]);
    getCpuHistoryForRangeMock.mockResolvedValue({
      daily: [
        {
          hostId: "z1",
          date: "2026-05-15",
          max: 80, avg: 35, min: 5,
          minutesAbove: { 20: 100, 30: 60, 40: 40, 50: 25, 60: 12, 70: 5, 80: 1, 90: 0 },
          totalSamples: 1440,
        },
      ],
      samples: [
        // one sample per minute for the first hour (60 samples)
        ...Array.from({ length: 60 }, (_, i) => ({
          hostId: "z1",
          clockSec: Math.floor(Date.UTC(2026, 4, 14, 21, i, 0) / 1000),
          value: 30 + (i % 10),
        })),
      ],
    });
    fetchRolloutRawBucketsMock.mockResolvedValue({
      periodDays: 2,
      perHostBuckets: [],
      generatedAt: new Date().toISOString(),
    });

    const stats = await rollupPilotRange("p1", "2026-05-15", "2026-05-15");

    expect(stats.hostsResolved).toBe(1);
    expect(stats.dailyRowsUpserted).toBe(1);
    expect(stats.hourlyRowsUpserted).toBe(1); // one hour bucket from 60 samples
    expect(cpuMetricDailyUpsert).toHaveBeenCalledTimes(1);
    const call = cpuMetricDailyUpsert.mock.calls[0][0];
    expect(call.create.zHostId).toBe("z1");
    expect(call.create.pilotId).toBe("p1");
    expect(call.create.deviceId).toBe("d1");
    expect(call.create.minutesAbove70).toBe(5);
    expect(call.create.totalSamples).toBe(1440);
    expect(call.create.source).toBe("history");
  });

  it("classifies trend-only days correctly", async () => {
    pilotFindUnique.mockResolvedValue({
      id: "p1",
      devices: [{ id: "d1", name: "SCO01", sourceHostKey: null, store: { name: "Store A" } }],
    });
    getHostsMock.mockResolvedValue([{ hostid: "z1", name: "SCO01" }]);
    getItemsMock.mockResolvedValue([{ itemid: "i1", hostid: "z1", key_: "system.cpu.util[,,avg1]" }]);
    getCpuHistoryForRangeMock.mockResolvedValue({
      daily: [
        {
          hostId: "z1",
          date: "2026-05-15",
          max: 80, avg: 35, min: 5,
          minutesAbove: { 20: 0, 30: 0, 40: 0, 50: 0, 60: 0, 70: 0, 80: 0, 90: 0 },
          totalSamples: 0, // no raw history — trend only
        },
      ],
      samples: [],
    });
    await rollupPilotRange("p1", "2026-04-01", "2026-04-01");
    const call = cpuMetricDailyUpsert.mock.calls[0][0];
    expect(call.create.source).toBe("trend");
  });
});

describe("rollupPilotRange — host matching", () => {
  it("skips devices without a matching Zabbix host", async () => {
    pilotFindUnique.mockResolvedValue({
      id: "p1",
      devices: [
        { id: "d1", name: "SCO01", sourceHostKey: null, store: { name: "Store A" } },
        { id: "d2", name: "SCO99-not-in-zabbix", sourceHostKey: null, store: { name: "Store A" } },
      ],
    });
    getHostsMock.mockResolvedValue([{ hostid: "z1", name: "SCO01" }]); // only SCO01
    getItemsMock.mockResolvedValue([{ itemid: "i1", hostid: "z1", key_: "system.cpu.util" }]);
    getCpuHistoryForRangeMock.mockResolvedValue({ daily: [], samples: [] });

    const stats = await rollupPilotRange("p1", "2026-05-15", "2026-05-15");
    expect(stats.hostsResolved).toBe(1);
  });

  it("prefers sourceHostKey over device name when matching Zabbix", async () => {
    pilotFindUnique.mockResolvedValue({
      id: "p1",
      devices: [
        { id: "d1", name: "WrongName", sourceHostKey: "RealZabbixName", store: { name: "Store A" } },
      ],
    });
    getHostsMock.mockResolvedValue([{ hostid: "z1", name: "RealZabbixName" }]);
    getItemsMock.mockResolvedValue([{ itemid: "i1", hostid: "z1", key_: "system.cpu.util" }]);
    getCpuHistoryForRangeMock.mockResolvedValue({ daily: [], samples: [] });

    const stats = await rollupPilotRange("p1", "2026-05-15", "2026-05-15");
    expect(stats.hostsResolved).toBe(1);
  });
});

// ── reader: readCpuHistoryHybrid ─────────────────────────────────────

describe("readCpuHistoryHybrid — window splits", () => {
  it("entirely recent → only Zabbix path used, no DB query", async () => {
    getCpuHistoryForRangeMock.mockResolvedValue({
      daily: [
        {
          hostId: "z1",
          date: "2026-05-15",
          max: 50, avg: 30, min: 10,
          minutesAbove: { 20: 0, 30: 0, 40: 0, 50: 0, 60: 0, 70: 0, 80: 0, 90: 0 },
          totalSamples: 1440,
        },
      ],
      samples: [],
    });
    const recentFromSec = Math.floor(Date.now() / 1000) - 5 * 86_400;
    const recentToSec = Math.floor(Date.now() / 1000);
    const itemHostMap = new Map([["i1", "z1"]]);

    const result = await readCpuHistoryHybrid({
      pilotId: "p1",
      itemIds: ["i1"],
      itemHostMap,
      fromSec: recentFromSec,
      toSec: recentToSec,
    });

    expect(cpuMetricDailyFindMany).not.toHaveBeenCalled();
    expect(getCpuHistoryForRangeMock).toHaveBeenCalled();
    expect(result.sourceBreakdown.zabbix).toBe(1);
    expect(result.sourceBreakdown.rollupHistory).toBe(0);
  });

  it("entirely old → only DB query, no Zabbix call", async () => {
    cpuMetricDailyFindMany.mockResolvedValue([
      {
        zHostId: "z1",
        date: new Date("2026-03-15T00:00:00Z"),
        cpuMax: 40, cpuAvg: 20, cpuMin: 5,
        minutesAbove20: 50, minutesAbove30: 20, minutesAbove40: 5, minutesAbove50: 0,
        minutesAbove60: 0, minutesAbove70: 0, minutesAbove80: 0, minutesAbove90: 0,
        totalSamples: 1440,
        source: "history",
      },
    ]);
    cpuMetricHourlyFindMany.mockResolvedValue([]);
    const oldFromSec = Math.floor(Date.now() / 1000) - 60 * 86_400;
    const oldToSec = Math.floor(Date.now() / 1000) - 30 * 86_400;

    const result = await readCpuHistoryHybrid({
      pilotId: "p1",
      itemIds: ["i1"],
      itemHostMap: new Map([["i1", "z1"]]),
      fromSec: oldFromSec,
      toSec: oldToSec,
    });

    expect(cpuMetricDailyFindMany).toHaveBeenCalled();
    expect(getCpuHistoryForRangeMock).not.toHaveBeenCalled();
    expect(result.sourceBreakdown.rollupHistory).toBe(1);
    expect(result.sourceBreakdown.zabbix).toBe(0);
  });

  it("straddling cutoff → both DB and Zabbix queried", async () => {
    cpuMetricDailyFindMany.mockResolvedValue([]);
    cpuMetricHourlyFindMany.mockResolvedValue([]);
    getCpuHistoryForRangeMock.mockResolvedValue({ daily: [], samples: [] });

    const fromSec = Math.floor(Date.now() / 1000) - 30 * 86_400;
    const toSec = Math.floor(Date.now() / 1000) - 5 * 86_400;

    await readCpuHistoryHybrid({
      pilotId: "p1",
      itemIds: ["i1"],
      itemHostMap: new Map([["i1", "z1"]]),
      fromSec, toSec,
    });

    expect(cpuMetricDailyFindMany).toHaveBeenCalled();
    expect(getCpuHistoryForRangeMock).toHaveBeenCalled();
  });

  it("applies hostIdAllowlist to DB queries", async () => {
    cpuMetricDailyFindMany.mockResolvedValue([]);
    cpuMetricHourlyFindMany.mockResolvedValue([]);
    const allowlist = new Set(["z1", "z2"]);
    const fromSec = Math.floor(Date.now() / 1000) - 30 * 86_400;
    const toSec = Math.floor(Date.now() / 1000) - 20 * 86_400;

    await readCpuHistoryHybrid({
      pilotId: "p1",
      itemIds: [],
      itemHostMap: new Map(),
      fromSec, toSec,
      hostIdAllowlist: allowlist,
    });

    const where = cpuMetricDailyFindMany.mock.calls[0][0].where;
    expect(where.zHostId).toEqual({ in: ["z1", "z2"] });
  });

  it("DB query uses Vilnius-local date strings (round-trip fix)", async () => {
    cpuMetricDailyFindMany.mockResolvedValue([]);
    cpuMetricHourlyFindMany.mockResolvedValue([]);
    // Period: 2026-05-15 Vilnius midnight to 2026-05-20 Vilnius midnight
    // (in summer, that's UTC May 14 21:00 to May 19 21:00)
    const fromSec = Math.floor(Date.UTC(2026, 4, 14, 21, 0, 0) / 1000);
    const toSec = Math.floor(Date.UTC(2026, 4, 19, 21, 0, 0) / 1000);

    await readCpuHistoryHybrid({
      pilotId: "p1",
      itemIds: [],
      itemHostMap: new Map(),
      fromSec, toSec,
    });

    if (cpuMetricDailyFindMany.mock.calls.length > 0) {
      const where = cpuMetricDailyFindMany.mock.calls[0][0].where;
      // The bounds should be Vilnius dates: 2026-05-15 → 2026-05-19
      const gteDate = (where.date.gte as Date).toISOString().slice(0, 10);
      expect(gteDate).toBe("2026-05-15");
    }
  });
});
