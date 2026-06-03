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
    // Minutes-above track follows the same null discipline so the UI can
    // render "—" identically for either track when there's no data.
    expect(r.onMinAvg).toBeNull();
    expect(r.offMinAvg).toBeNull();
    expect(r.onMinPeak).toBeNull();
    expect(r.offMinPeak).toBeNull();
    expect(r.deltaMin).toBeNull();
    expect(r.deltaMinRel).toBeNull();
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

  // ── Minutes-above-threshold track ────────────────────────────────
  //
  // Regression guard for the bug that shipped to prod (v0.1.233): the
  // CompareCard was wired to summary.onAvg/onPeak (CPU-percent track)
  // even when the user picked the "Min ≥ threshold" metric. The result
  // was that flipping the threshold (80 % → 90 %) left every card
  // value unchanged because CPU-avg is threshold-independent. The fix
  // added onMinAvg/onMinPeak (and the matching delta fields), which
  // ARE threshold-dependent because they're derived from d.minutesAbove
  // — and d.minutesAbove is computed at the threshold the route was
  // called with. Tests below pin down each track behaving correctly
  // in isolation.

  it("minutes-above track: averages and peaks daily minutesAbove counts", () => {
    // 3 ON days with 30 / 24 / 18 minutes above → mean 24, peak 30.
    // 3 OFF days with 6 / 4 / 2 minutes above   → mean 4,  peak 6.
    const r = compareOnOff([
      { agg: { date: "1", avg: 50, peak: 90, minutesAbove: 30, totalSamples: 1440 }, retellectOn: true },
      { agg: { date: "2", avg: 48, peak: 85, minutesAbove: 24, totalSamples: 1440 }, retellectOn: true },
      { agg: { date: "3", avg: 46, peak: 80, minutesAbove: 18, totalSamples: 1440 }, retellectOn: true },
      { agg: { date: "4", avg: 20, peak: 60, minutesAbove: 6, totalSamples: 1440 }, retellectOn: false },
      { agg: { date: "5", avg: 18, peak: 55, minutesAbove: 4, totalSamples: 1440 }, retellectOn: false },
      { agg: { date: "6", avg: 22, peak: 65, minutesAbove: 2, totalSamples: 1440 }, retellectOn: false },
    ]);
    expect(r.onMinAvg).toBe(24);
    expect(r.offMinAvg).toBe(4);
    expect(r.onMinPeak).toBe(30);
    expect(r.offMinPeak).toBe(6);
    expect(r.deltaMin).toBe(20);   // 24 - 4
    expect(r.deltaMinRel).toBe(500); // (24-4)/4 * 100
  });

  it("minutes-above and CPU tracks coexist independently in one summary", () => {
    // The CPU track sees identical daily-avg numbers across ON and OFF
    // (i.e., the threshold is the ONLY meaningful difference). Without
    // the minutes track, the user sees deltaPp = 0 even though Retellect
    // visibly drove samples over 80 %. With it, deltaMin > 0 surfaces.
    const r = compareOnOff([
      { agg: { date: "1", avg: 50, peak: 85, minutesAbove: 45, totalSamples: 1440 }, retellectOn: true },
      { agg: { date: "2", avg: 50, peak: 85, minutesAbove: 12, totalSamples: 1440 }, retellectOn: false },
    ]);
    expect(r.deltaPp).toBe(0);
    expect(r.deltaMin).toBe(33); // 45 - 12 — the real story the user wants
  });

  it("minutes-above track clamps relative delta to 0 when OFF baseline is 0", () => {
    // OFF days never went above threshold → offMinAvg = 0. Reporting
    // "+Infinity %" or NaN would be hostile in the UI; we report 0 and
    // let the absolute deltaMin carry the signal.
    const r = compareOnOff([
      { agg: { date: "1", avg: 50, peak: 90, minutesAbove: 18, totalSamples: 1440 }, retellectOn: true },
      { agg: { date: "2", avg: 30, peak: 60, minutesAbove: 0, totalSamples: 1440 }, retellectOn: false },
    ]);
    expect(r.offMinAvg).toBe(0);
    expect(r.deltaMin).toBe(18);
    expect(r.deltaMinRel).toBe(0);
  });

  it("minutes-above track null-side discipline matches CPU track", () => {
    const r = compareOnOff([
      { agg: { date: "1", avg: 50, peak: 80, minutesAbove: 12, totalSamples: 1440 }, retellectOn: true },
    ]);
    expect(r.onMinAvg).toBe(12);
    expect(r.offMinAvg).toBeNull();
    expect(r.deltaMin).toBeNull();
    expect(r.deltaMinRel).toBeNull();
  });
});

// ─── "Other" derivation (host CPU − monitored sum) ─────────────────
//
// This is the formula the API route applies per-minute when the user picks
// the "Other" category. Tested here as a pure function of the sysCpu and
// per-category per-minute values so we have a regression guard if anyone
// ever moves the math out of the route.

function deriveOtherPerMinute(
  sysCpu: number,
  rt: number,
  sa: number,
  db: number,
  sys: number,
): number {
  return Math.max(0, sysCpu - rt - sa - db - sys);
}

describe("deriveOtherPerMinute", () => {
  it("returns sysCpu when no categories are present (all CPU is 'other')", () => {
    expect(deriveOtherPerMinute(40, 0, 0, 0, 0)).toBe(40);
  });

  it("subtracts a single category cleanly", () => {
    // SCO App at 25%, host CPU 27% → other = 2%.
    expect(deriveOtherPerMinute(27, 0, 25, 0, 0)).toBe(2);
  });

  it("subtracts all four categories", () => {
    // 4-python retellect 20%, spss 15%, sql 5%, vm 3%, host 50% → other = 7%.
    expect(deriveOtherPerMinute(50, 20, 15, 5, 3)).toBe(7);
  });

  it("clamps at 0 when monitored exceeds host (rounding noise / overlap)", () => {
    // Per-process metrics can briefly sum higher than system.cpu.util
    // (rounding error or item value overlap). Negative "other" is meaningless
    // for the user — they'd see "-3% other" and panic. Clamp at 0.
    expect(deriveOtherPerMinute(50, 30, 25, 0, 0)).toBe(0);
  });

  it("handles zero host CPU gracefully", () => {
    expect(deriveOtherPerMinute(0, 0, 0, 0, 0)).toBe(0);
    expect(deriveOtherPerMinute(0, 5, 0, 0, 0)).toBe(0);
  });

  it("handles realistic Pavilnonys-style minute (Retellect ON heavy day)", () => {
    // SCO2 at hour 18, Retellect ON: sysCpu 65%, retellect 23%, scoApp 32%,
    // sql 4%, vm 2%. Other = 65 - 61 = 4%. Realistic — matches the SP admin's
    // hour-18 probe ("23% raw vs 27% sysCpu", with the gap mostly being
    // categorised system + small "other").
    expect(deriveOtherPerMinute(65, 23, 32, 4, 2)).toBe(4);
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
