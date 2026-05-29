import { describe, it, expect } from "vitest";
import { aggregateProcessHours, type ProcessBucket } from "./writer-process";

// Helper: synthesise a minute-history bucket.
function minBkt(tsMs: number, spss: number | null, retellect: number | null, total: number | null): ProcessBucket {
  return { tsMs, weightMinutes: 1, source: "history", spssCpu: spss, retellectCpu: retellect, totalCpu: total };
}
function hrBkt(tsMs: number, spss: number | null, retellect: number | null, total: number | null): ProcessBucket {
  return { tsMs, weightMinutes: 60, source: "trend", spssCpu: spss, retellectCpu: retellect, totalCpu: total };
}

const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

describe("aggregateProcessHours", () => {
  it("returns empty when no buckets", () => {
    expect(aggregateProcessHours([], 0, HOUR_MS)).toEqual([]);
  });

  it("collapses 60 minute buckets into one hour aggregate", () => {
    const buckets: ProcessBucket[] = [];
    for (let i = 0; i < 60; i++) {
      buckets.push(minBkt(i * MIN_MS, 10, 5, 30));
    }
    const out = aggregateProcessHours([{ hostId: "h1", buckets }], 0, HOUR_MS);
    expect(out).toHaveLength(1);
    const row = out[0];
    expect(row.hostId).toBe("h1");
    expect(row.hourStartMs).toBe(0);
    expect(row.spssCpu).toBe(10); // mean of 60 × 10
    expect(row.retellectCpu).toBe(5);
    expect(row.totalCpu).toBe(30);
    expect(row.sawPython).toBe(true);
    expect(row.weightMinutes).toBe(60);
    expect(row.source).toBe("history");
  });

  it("differentiates 'Retellect not running' from 'reported 0%'", () => {
    // No python sample at all → retellectCpu null, sawPython false
    const noPython = aggregateProcessHours(
      [{ hostId: "h1", buckets: [minBkt(0, 5, null, 30)] }],
      0, HOUR_MS,
    );
    expect(noPython[0].retellectCpu).toBeNull();
    expect(noPython[0].sawPython).toBe(false);

    // Python reported but value 0 → retellectCpu 0, sawPython true
    const zeroPython = aggregateProcessHours(
      [{ hostId: "h1", buckets: [minBkt(0, 5, 0, 30)] }],
      0, HOUR_MS,
    );
    expect(zeroPython[0].retellectCpu).toBe(0);
    expect(zeroPython[0].sawPython).toBe(true);
  });

  it("filters buckets to the requested [fromMs, toMs) window", () => {
    const buckets: ProcessBucket[] = [
      minBkt(-MIN_MS, 1, 1, 1),    // before window — drop
      minBkt(0, 10, 5, 30),         // inclusive lower
      minBkt(30 * MIN_MS, 20, 10, 60), // inside
      minBkt(HOUR_MS, 99, 99, 99),  // exclusive upper — drop
    ];
    const out = aggregateProcessHours([{ hostId: "h1", buckets }], 0, HOUR_MS);
    expect(out).toHaveLength(1);
    expect(out[0].spssCpu).toBe(15);  // mean of 10, 20
    expect(out[0].retellectCpu).toBe(7.5); // mean of 5, 10
  });

  it("marks source as 'merged' when history and trend mix in same hour", () => {
    const buckets: ProcessBucket[] = [
      minBkt(0, 10, 5, 30),
      hrBkt(0, 12, 6, 32), // same hour, trend
    ];
    const out = aggregateProcessHours([{ hostId: "h1", buckets }], 0, HOUR_MS);
    expect(out[0].source).toBe("merged");
  });

  it("groups by hour boundary correctly", () => {
    const buckets: ProcessBucket[] = [
      minBkt(0, 10, 5, 30),               // hour 0
      minBkt(HOUR_MS - MIN_MS, 12, 6, 35), // still hour 0 (minute 59)
      minBkt(HOUR_MS, 20, 10, 60),         // hour 1
      minBkt(HOUR_MS + 30 * MIN_MS, 25, 12, 70), // hour 1
    ];
    const out = aggregateProcessHours([{ hostId: "h1", buckets }], 0, 2 * HOUR_MS);
    expect(out).toHaveLength(2);
    const sorted = [...out].sort((a, b) => a.hourStartMs - b.hourStartMs);
    expect(sorted[0].hourStartMs).toBe(0);
    expect(sorted[1].hourStartMs).toBe(HOUR_MS);
  });

  it("skips non-finite values (NaN, Infinity)", () => {
    const buckets: ProcessBucket[] = [
      minBkt(0, 10, 5, 30),
      minBkt(MIN_MS, NaN, Infinity, -Infinity), // all non-finite
      minBkt(2 * MIN_MS, 20, 10, 60),
    ];
    const out = aggregateProcessHours([{ hostId: "h1", buckets }], 0, HOUR_MS);
    expect(out[0].spssCpu).toBe(15); // mean of 10, 20 — NaN skipped
    expect(out[0].retellectCpu).toBe(7.5); // mean of 5, 10 — Infinity skipped
    expect(out[0].totalCpu).toBe(45);
  });

  it("caps weightMinutes at 60", () => {
    // Construct a degenerate case where buckets claim > 60 weight in one hour
    const buckets: ProcessBucket[] = [
      hrBkt(0, 10, 5, 30), // weight 60
      hrBkt(MIN_MS, 12, 6, 32), // weight 60, same hour → total would be 120
    ];
    const out = aggregateProcessHours([{ hostId: "h1", buckets }], 0, HOUR_MS);
    expect(out[0].weightMinutes).toBe(60);
  });

  it("separates hosts even when timestamps overlap", () => {
    const buckets1: ProcessBucket[] = [minBkt(0, 10, 5, 30)];
    const buckets2: ProcessBucket[] = [minBkt(0, 80, 40, 90)];
    const out = aggregateProcessHours(
      [{ hostId: "h1", buckets: buckets1 }, { hostId: "h2", buckets: buckets2 }],
      0, HOUR_MS,
    );
    expect(out).toHaveLength(2);
    const byHost = new Map(out.map((r) => [r.hostId, r]));
    expect(byHost.get("h1")!.spssCpu).toBe(10);
    expect(byHost.get("h2")!.spssCpu).toBe(80);
  });

  it("preserves null totalCpu when no system samples present", () => {
    const buckets: ProcessBucket[] = [minBkt(0, 10, 5, null)];
    const out = aggregateProcessHours([{ hostId: "h1", buckets }], 0, HOUR_MS);
    expect(out[0].totalCpu).toBeNull();
  });

  it("source stays consistent when only one kind of bucket present", () => {
    const trendOnly = aggregateProcessHours(
      [{ hostId: "h1", buckets: [hrBkt(0, 10, 5, 30)] }],
      0, HOUR_MS,
    );
    expect(trendOnly[0].source).toBe("trend");
    const historyOnly = aggregateProcessHours(
      [{ hostId: "h1", buckets: [minBkt(0, 10, 5, 30)] }],
      0, HOUR_MS,
    );
    expect(historyOnly[0].source).toBe("history");
  });
});
