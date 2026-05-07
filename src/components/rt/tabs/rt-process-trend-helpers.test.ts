import { describe, it, expect } from "vitest";
import {
  bucketSamplesByDay,
  aggregateDay,
  isRetellectOnDay,
  compareOnOff,
  listDateRange,
} from "./rt-process-trend-helpers";

// Helper: build a Unix-second clock for a Europe/Vilnius local date+time.
// Construct via UTC math so the test stays deterministic regardless of the
// host's local TZ (CI runs in UTC; dev machines run in EEST).
//
// Approach: pretend the wallclock is UTC, ask Intl for the Vilnius offset
// at that instant, then subtract that offset to land on the actual UTC
// timestamp that, when re-rendered in Vilnius, equals the wallclock.
//
// Why "longOffset" rather than parsing "longGeneric" / "short": longOffset
// returns "GMT+03:00" deterministically across Node versions; the localised
// names ("Eastern European Summer Time") differ.
function vilniusClock(date: string, hourMin: string = "10:00"): number {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mn] = hourMin.split(":").map(Number);
  const utcGuess = Date.UTC(y, m - 1, d, h, mn, 0);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Vilnius",
    timeZoneName: "longOffset",
  });
  const parts = fmt.formatToParts(new Date(utcGuess));
  const tzPart = parts.find((p) => p.type === "timeZoneName")?.value || "GMT+00:00";
  const matched = tzPart.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!matched) return Math.floor(utcGuess / 1000);
  const sign = matched[1] === "+" ? 1 : -1;
  const offsetMs = sign * (parseInt(matched[2]) * 60 + parseInt(matched[3])) * 60_000;
  return Math.floor((utcGuess - offsetMs) / 1000);
}

// ─── bucketSamplesByDay ─────────────────────────────────────────────

describe("bucketSamplesByDay", () => {
  it("returns empty map for empty input", () => {
    const r = bucketSamplesByDay([]);
    expect(r.size).toBe(0);
  });

  it("groups samples by Vilnius local date", () => {
    const samples = [
      { clock: vilniusClock("2026-05-01", "08:00"), value: 10 },
      { clock: vilniusClock("2026-05-01", "23:00"), value: 20 },
      { clock: vilniusClock("2026-05-02", "00:30"), value: 30 },
    ];
    const r = bucketSamplesByDay(samples);
    expect(r.size).toBe(2);
    expect(r.get("2026-05-01")).toHaveLength(2);
    expect(r.get("2026-05-02")).toHaveLength(1);
    expect(r.get("2026-05-02")![0].value).toBe(30);
  });

  it("preserves the original sample objects in each bucket", () => {
    const s = { clock: vilniusClock("2026-04-15"), value: 42 };
    const r = bucketSamplesByDay([s]);
    expect(r.get("2026-04-15")![0]).toBe(s);
  });
});

// ─── aggregateDay ──────────────────────────────────────────────────

describe("aggregateDay", () => {
  it("returns zero aggregate for empty input", () => {
    const r = aggregateDay([], 70);
    expect(r).toEqual({ date: "", avg: 0, peak: 0, minutesAbove: 0, totalSamples: 0 });
  });

  it("computes avg, peak, minutesAbove for a known set", () => {
    const samples = [
      { clock: 1, value: 10 },
      { clock: 2, value: 50 },
      { clock: 3, value: 95 },
      { clock: 4, value: 70 },
      { clock: 5, value: 60 },
    ];
    const r = aggregateDay(samples, 70);
    expect(r.totalSamples).toBe(5);
    expect(r.avg).toBe(57); // (10+50+95+70+60)/5 = 57.0
    expect(r.peak).toBe(95);
    expect(r.minutesAbove).toBe(2); // 95, 70 (≥70)
  });

  it("threshold is inclusive (≥)", () => {
    const r = aggregateDay([
      { clock: 1, value: 70 },
      { clock: 2, value: 70 },
      { clock: 3, value: 50 },
    ], 70);
    expect(r.minutesAbove).toBe(2);
  });

  it("rounds avg and peak to one decimal", () => {
    const r = aggregateDay([
      { clock: 1, value: 99.444 },
      { clock: 2, value: 33.333 },
    ], 70);
    expect(r.peak).toBe(99.4);
    expect(r.avg).toBe(66.4); // (99.444+33.333)/2 = 66.388 → 66.4
  });

  it("handles single-sample day", () => {
    const r = aggregateDay([{ clock: 1, value: 80 }], 70);
    expect(r.totalSamples).toBe(1);
    expect(r.avg).toBe(80);
    expect(r.peak).toBe(80);
    expect(r.minutesAbove).toBe(1);
  });
});

// ─── isRetellectOnDay ──────────────────────────────────────────────

describe("isRetellectOnDay", () => {
  it("returns false for empty samples (no python activity)", () => {
    expect(isRetellectOnDay([])).toBe(false);
  });

  it("returns true when ≥10% of day-windows had python activity", () => {
    // 200 samples ≥ 0.5% out of 1440 minute slots = 13.9% → ON.
    const samples = Array.from({ length: 200 }, (_, i) => ({ clock: i, value: 5 }));
    expect(isRetellectOnDay(samples)).toBe(true);
  });

  it("returns false when <10% of day-windows had python activity", () => {
    // 100 active samples = 6.9% < 10% → OFF.
    const samples = Array.from({ length: 100 }, (_, i) => ({ clock: i, value: 5 }));
    expect(isRetellectOnDay(samples)).toBe(false);
  });

  it("ignores near-zero samples (process exists but idle)", () => {
    // 500 samples but all <0.5% — Zabbix emits these when the python process
    // is alive but doing nothing. They should NOT mark the day as Retellect ON.
    const samples = Array.from({ length: 500 }, (_, i) => ({ clock: i, value: 0.1 }));
    expect(isRetellectOnDay(samples)).toBe(false);
  });

  it("counts only samples ≥ minSampleValue", () => {
    // 50 idle samples + 200 active samples → 200/1440 = 13.9% → ON.
    const samples = [
      ...Array.from({ length: 50 }, (_, i) => ({ clock: i, value: 0.1 })),
      ...Array.from({ length: 200 }, (_, i) => ({ clock: 50 + i, value: 5 })),
    ];
    expect(isRetellectOnDay(samples)).toBe(true);
  });

  it("respects custom minPctCoverage threshold", () => {
    // 100 samples = 6.9% — not enough at default 10%, but enough at 5%.
    const samples = Array.from({ length: 100 }, (_, i) => ({ clock: i, value: 5 }));
    expect(isRetellectOnDay(samples, { minPctCoverage: 5 })).toBe(true);
    expect(isRetellectOnDay(samples, { minPctCoverage: 10 })).toBe(false);
  });

  it("guards against zero/negative expectedMinutesPerDay", () => {
    expect(isRetellectOnDay(
      [{ clock: 1, value: 50 }],
      { expectedMinutesPerDay: 0 },
    )).toBe(false);
    expect(isRetellectOnDay(
      [{ clock: 1, value: 50 }],
      { expectedMinutesPerDay: -5 },
    )).toBe(false);
  });
});

// ─── compareOnOff ──────────────────────────────────────────────────

describe("compareOnOff", () => {
  it("returns null sides when no days have data", () => {
    const r = compareOnOff([]);
    expect(r.onCount).toBe(0);
    expect(r.offCount).toBe(0);
    expect(r.onAvg).toBeNull();
    expect(r.offAvg).toBeNull();
    expect(r.deltaPp).toBeNull();
    expect(r.deltaRel).toBeNull();
  });

  it("computes simple ON vs OFF means and delta", () => {
    const r = compareOnOff([
      // ON days: avg 30, 28, 26 → mean 28
      { agg: { date: "1", avg: 30, peak: 45, minutesAbove: 0, totalSamples: 1000 }, retellectOn: true },
      { agg: { date: "2", avg: 28, peak: 50, minutesAbove: 0, totalSamples: 1000 }, retellectOn: true },
      { agg: { date: "3", avg: 26, peak: 41, minutesAbove: 0, totalSamples: 1000 }, retellectOn: true },
      // OFF days: avg 60, 56, 58 → mean 58
      { agg: { date: "4", avg: 60, peak: 79, minutesAbove: 0, totalSamples: 1000 }, retellectOn: false },
      { agg: { date: "5", avg: 56, peak: 75, minutesAbove: 0, totalSamples: 1000 }, retellectOn: false },
      { agg: { date: "6", avg: 58, peak: 78, minutesAbove: 0, totalSamples: 1000 }, retellectOn: false },
    ]);
    expect(r.onCount).toBe(3);
    expect(r.offCount).toBe(3);
    expect(r.onAvg).toBe(28);
    expect(r.offAvg).toBe(58);
    expect(r.onPeak).toBe(50);
    expect(r.offPeak).toBe(79);
    expect(r.deltaPp).toBe(-30); // 28 - 58
    // (28 - 58) / 58 * 100 = -51.7 → rounded to one decimal place
    expect(r.deltaRel).toBe(-51.7);
  });

  it("excludes empty-sample days from both counts", () => {
    // A day with totalSamples=0 must not pollute the average even when it
    // has retellectOn=true (no signal → don't claim a day either way).
    const r = compareOnOff([
      { agg: { date: "1", avg: 30, peak: 40, minutesAbove: 0, totalSamples: 1000 }, retellectOn: true },
      { agg: { date: "2", avg: 0, peak: 0, minutesAbove: 0, totalSamples: 0 }, retellectOn: true },
      { agg: { date: "3", avg: 60, peak: 80, minutesAbove: 0, totalSamples: 1000 }, retellectOn: false },
    ]);
    expect(r.onCount).toBe(1);
    expect(r.offCount).toBe(1);
    expect(r.onAvg).toBe(30);
    expect(r.offAvg).toBe(60);
  });

  it("returns null deltas when one side is empty", () => {
    const r = compareOnOff([
      { agg: { date: "1", avg: 30, peak: 40, minutesAbove: 0, totalSamples: 1000 }, retellectOn: true },
    ]);
    expect(r.onCount).toBe(1);
    expect(r.offCount).toBe(0);
    expect(r.onAvg).toBe(30);
    expect(r.offAvg).toBeNull();
    expect(r.deltaPp).toBeNull();
    expect(r.deltaRel).toBeNull();
  });

  it("deltaRel is 0 (not NaN) when offAvg is 0", () => {
    const r = compareOnOff([
      { agg: { date: "1", avg: 30, peak: 40, minutesAbove: 0, totalSamples: 1000 }, retellectOn: true },
      { agg: { date: "2", avg: 0, peak: 0, minutesAbove: 0, totalSamples: 1000 }, retellectOn: false },
    ]);
    expect(r.offAvg).toBe(0);
    expect(r.deltaPp).toBe(30);
    expect(r.deltaRel).toBe(0);
  });

  it("positive delta when Retellect makes things WORSE (sanity check)", () => {
    const r = compareOnOff([
      { agg: { date: "1", avg: 70, peak: 90, minutesAbove: 0, totalSamples: 1000 }, retellectOn: true },
      { agg: { date: "2", avg: 50, peak: 65, minutesAbove: 0, totalSamples: 1000 }, retellectOn: false },
    ]);
    expect(r.deltaPp).toBe(20);
    expect(r.deltaRel).toBe(40); // (70-50)/50*100
  });
});

// ─── listDateRange ─────────────────────────────────────────────────

describe("listDateRange", () => {
  it("returns the requested number of dates, oldest first", () => {
    // Use a fixed `now` at midday to avoid TZ-edge flapping.
    const now = new Date(Date.UTC(2026, 4, 7, 12, 0, 0));
    const r = listDateRange(3, now);
    expect(r).toHaveLength(3);
    // Each entry is YYYY-MM-DD.
    for (const d of r) {
      expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // Strictly ascending.
    expect(r[0] < r[1]).toBe(true);
    expect(r[1] < r[2]).toBe(true);
    expect(r[2]).toBe("2026-05-07");
  });

  it("returns empty array for daysBack=0", () => {
    expect(listDateRange(0, new Date())).toEqual([]);
  });

  it("handles 14-day window — the canonical period for the heatmap", () => {
    const r = listDateRange(14, new Date(Date.UTC(2026, 4, 7, 12, 0, 0)));
    expect(r).toHaveLength(14);
    expect(r[0]).toBe("2026-04-24");
    expect(r[13]).toBe("2026-05-07");
  });
});
