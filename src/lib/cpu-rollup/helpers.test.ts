import { describe, it, expect } from "vitest";
import {
  round1,
  addDaysIso,
  isoToVilniusUnix,
  vilniusDateString,
  isoDateUtc,
  classifyDailySource,
  HISTORY_FULL_DAY_THRESHOLD,
  runInChunks,
  bucketSamplesByHour,
} from "./helpers";

// ─── round1 ──────────────────────────────────────────────────────────

describe("round1", () => {
  it("rounds to one decimal", () => {
    expect(round1(12.34)).toBe(12.3);
    expect(round1(12.36)).toBe(12.4);
    expect(round1(0)).toBe(0);
    expect(round1(99.95)).toBe(100); // standard rounding
  });
  it("handles negative values", () => {
    expect(round1(-12.34)).toBe(-12.3);
    // -0.05 rounds to -0 due to IEEE 754 / Math.round semantics. Equal to
    // +0 numerically but distinguishable with Object.is. Both are 0 in
    // Postgres double-precision so the DB doesn't care.
    expect(Object.is(round1(-0.05), -0) || Object.is(round1(-0.05), 0)).toBe(true);
  });
  it("clamps NaN to 0 (defensive against zero-division upstream)", () => {
    expect(round1(NaN)).toBe(0);
  });
  it("clamps Infinity to 0", () => {
    expect(round1(Infinity)).toBe(0);
    expect(round1(-Infinity)).toBe(0);
  });
});

// ─── addDaysIso ──────────────────────────────────────────────────────

describe("addDaysIso", () => {
  it("adds days within a month", () => {
    expect(addDaysIso("2026-05-15", 3)).toBe("2026-05-18");
    expect(addDaysIso("2026-05-15", 0)).toBe("2026-05-15");
  });
  it("subtracts days", () => {
    expect(addDaysIso("2026-05-15", -3)).toBe("2026-05-12");
    expect(addDaysIso("2026-05-01", -1)).toBe("2026-04-30");
  });
  it("crosses month boundary", () => {
    expect(addDaysIso("2026-05-30", 5)).toBe("2026-06-04");
    expect(addDaysIso("2026-01-31", 1)).toBe("2026-02-01");
  });
  it("crosses year boundary", () => {
    expect(addDaysIso("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysIso("2026-01-01", -1)).toBe("2025-12-31");
  });
  it("handles leap year February", () => {
    expect(addDaysIso("2028-02-28", 1)).toBe("2028-02-29"); // 2028 is leap
    expect(addDaysIso("2026-02-28", 1)).toBe("2026-03-01"); // 2026 is not
  });
});

// ─── isoToVilniusUnix ────────────────────────────────────────────────

describe("isoToVilniusUnix", () => {
  it("converts winter midnight (UTC+2)", () => {
    // 2026-01-15 00:00 Vilnius = 2026-01-14 22:00 UTC
    const got = isoToVilniusUnix("2026-01-15", 0);
    expect(got).toBe(Math.floor(Date.UTC(2026, 0, 14, 22, 0, 0) / 1000));
  });
  it("converts summer midnight (UTC+3, DST)", () => {
    // 2026-07-15 00:00 Vilnius = 2026-07-14 21:00 UTC
    const got = isoToVilniusUnix("2026-07-15", 0);
    expect(got).toBe(Math.floor(Date.UTC(2026, 6, 14, 21, 0, 0) / 1000));
  });
  it("round-trips with vilniusDateString", () => {
    const dates = ["2026-01-15", "2026-04-10", "2026-07-15", "2026-10-20", "2026-12-31"];
    for (const iso of dates) {
      const unix = isoToVilniusUnix(iso, 0);
      expect(vilniusDateString(unix)).toBe(iso);
    }
  });
  it("throws on DST spring-forward gap (2026 last Sunday of March)", () => {
    // Vilnius spring-forward 2026: 2026-03-29 02:59 → 04:00.
    // 03:00 doesn't exist. Function should throw.
    expect(() => isoToVilniusUnix("2026-03-29", 3)).toThrow(/DST gap/);
  });
  it("succeeds for 03:00 on a non-DST day in March", () => {
    // 2026-03-15 is before DST transition; 03:00 exists normally.
    expect(() => isoToVilniusUnix("2026-03-15", 3)).not.toThrow();
  });
});

// ─── vilniusDateString ───────────────────────────────────────────────

describe("vilniusDateString", () => {
  it("returns Vilnius local date for UTC midnight in winter", () => {
    // UTC 2026-01-15 00:00 = Vilnius 2026-01-15 02:00 → still Jan 15
    const unix = Math.floor(Date.UTC(2026, 0, 15, 0, 0, 0) / 1000);
    expect(vilniusDateString(unix)).toBe("2026-01-15");
  });
  it("returns previous day for UTC near-midnight in summer", () => {
    // UTC 2026-07-15 21:30 = Vilnius 2026-07-16 00:30 → next day
    const unix = Math.floor(Date.UTC(2026, 6, 15, 21, 30, 0) / 1000);
    expect(vilniusDateString(unix)).toBe("2026-07-16");
    // UTC 2026-07-15 20:30 = Vilnius 2026-07-15 23:30 → same day
    const unix2 = Math.floor(Date.UTC(2026, 6, 15, 20, 30, 0) / 1000);
    expect(vilniusDateString(unix2)).toBe("2026-07-15");
  });
  it("produces YYYY-MM-DD format", () => {
    const unix = Math.floor(Date.UTC(2026, 4, 15, 12, 0, 0) / 1000);
    const out = vilniusDateString(unix);
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ─── isoDateUtc ──────────────────────────────────────────────────────

describe("isoDateUtc", () => {
  it("formats UTC date components", () => {
    const d = new Date(Date.UTC(2026, 4, 15));
    expect(isoDateUtc(d)).toBe("2026-05-15");
  });
  it("zero-pads month and day", () => {
    const d = new Date(Date.UTC(2026, 0, 5));
    expect(isoDateUtc(d)).toBe("2026-01-05");
  });
  it("ignores time portion", () => {
    const d = new Date(Date.UTC(2026, 4, 15, 23, 59, 59));
    expect(isoDateUtc(d)).toBe("2026-05-15");
  });
});

// ─── classifyDailySource ─────────────────────────────────────────────

describe("classifyDailySource", () => {
  it("classifies zero samples as trend", () => {
    expect(classifyDailySource(0)).toBe("trend");
  });
  it("classifies low sample count as merged", () => {
    expect(classifyDailySource(1)).toBe("merged");
    expect(classifyDailySource(500)).toBe("merged");
    expect(classifyDailySource(HISTORY_FULL_DAY_THRESHOLD - 1)).toBe("merged");
  });
  it("classifies sample count at/above threshold as history", () => {
    expect(classifyDailySource(HISTORY_FULL_DAY_THRESHOLD)).toBe("history");
    expect(classifyDailySource(1440)).toBe("history");
    expect(classifyDailySource(1500)).toBe("history"); // DST fall-back day (1500 min) still history
  });
  it("DST spring-forward day (1380 min) still counts as history", () => {
    // Spring-forward day has 1380 minutes. With threshold 1320, fully
    // covered spring-forward → history. Without the tolerance, it would
    // misclassify as 'merged' twice a year.
    expect(classifyDailySource(1380)).toBe("history");
  });
});

// ─── runInChunks ─────────────────────────────────────────────────────

describe("runInChunks", () => {
  it("returns all results in order", async () => {
    const ops = [1, 2, 3, 4, 5].map((n) => Promise.resolve(n * 10));
    const out = await runInChunks(ops, 2);
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });
  it("handles empty input", async () => {
    expect(await runInChunks([], 8)).toEqual([]);
  });
  it("handles single-element input", async () => {
    expect(await runInChunks([Promise.resolve("x")], 4)).toEqual(["x"]);
  });
  it("propagates rejection from any operation", async () => {
    const ops = [Promise.resolve(1), Promise.reject(new Error("boom"))];
    await expect(runInChunks(ops, 4)).rejects.toThrow("boom");
  });
});

// ─── bucketSamplesByHour ─────────────────────────────────────────────

describe("bucketSamplesByHour", () => {
  it("groups samples by host and hour", () => {
    const samples = [
      { hostId: "h1", clockSec: 1717_200_000, value: 50 }, // 2024-06-01 00:00:00 UTC
      { hostId: "h1", clockSec: 1717_200_060, value: 60 }, // 2024-06-01 00:01:00 UTC (same hour)
      { hostId: "h1", clockSec: 1717_203_600, value: 80 }, // 2024-06-01 01:00:00 UTC (next hour)
      { hostId: "h2", clockSec: 1717_200_000, value: 30 }, // h2, hour 0
    ];
    const out = bucketSamplesByHour(samples);
    expect(out.size).toBe(3);
    const h1hr0 = out.get("h1|1717200000")!;
    expect(h1hr0.count).toBe(2);
    expect(h1hr0.sum).toBe(110);
    expect(h1hr0.max).toBe(60);
    expect(h1hr0.min).toBe(50);
    const h1hr1 = out.get("h1|1717203600")!;
    expect(h1hr1.count).toBe(1);
    expect(h1hr1.max).toBe(80);
  });
  it("skips non-finite values", () => {
    const samples = [
      { hostId: "h1", clockSec: 1717_200_000, value: 50 },
      { hostId: "h1", clockSec: 1717_200_060, value: NaN },
      { hostId: "h1", clockSec: 1717_200_120, value: Infinity },
      { hostId: "h1", clockSec: 1717_200_180, value: 60 },
    ];
    const out = bucketSamplesByHour(samples);
    const bucket = out.get("h1|1717200000")!;
    expect(bucket.count).toBe(2); // NaN + Infinity skipped
    expect(bucket.sum).toBe(110);
  });
  it("handles empty input", () => {
    expect(bucketSamplesByHour([])).toEqual(new Map());
  });
  it("aligns to hour boundary correctly", () => {
    // sample at second 3599 of hour 0 → still hour 0
    // sample at second 3600 of hour 0 → hour 1
    const samples = [
      { hostId: "h1", clockSec: 3599, value: 10 },
      { hostId: "h1", clockSec: 3600, value: 20 },
    ];
    const out = bucketSamplesByHour(samples);
    expect(out.has("h1|0")).toBe(true);
    expect(out.has("h1|3600")).toBe(true);
  });
});
