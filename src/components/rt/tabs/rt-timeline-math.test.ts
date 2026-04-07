import { describe, it, expect } from "vitest";
import {
  heatCategory,
  countExceedDays,
  riskLevel,
  generateTimelineData,
  generateHourlyData,
  generateIntervalData,
} from "./rt-timeline-math";

// ─── heatCategory ───────────────────────────────────────────────────

describe("heatCategory", () => {
  it("returns 'none' when host has no Zabbix match", () => {
    expect(heatCategory(85, 70, false)).toBe("none");
  });

  it("returns 'below' when value < threshold", () => {
    expect(heatCategory(50, 70, true)).toBe("below");
    expect(heatCategory(69.9, 70, true)).toBe("below");
    expect(heatCategory(0, 70, true)).toBe("below");
  });

  it("returns 'threshold' when value >= threshold and < 80", () => {
    expect(heatCategory(70, 70, true)).toBe("threshold");
    expect(heatCategory(75, 70, true)).toBe("threshold");
    expect(heatCategory(79.9, 70, true)).toBe("threshold");
  });

  it("returns 'high' when value >= 80 and < 90", () => {
    expect(heatCategory(80, 70, true)).toBe("high");
    expect(heatCategory(85, 70, true)).toBe("high");
    expect(heatCategory(89.9, 70, true)).toBe("high");
  });

  it("returns 'critical' when value >= 90", () => {
    expect(heatCategory(90, 70, true)).toBe("critical");
    expect(heatCategory(95, 70, true)).toBe("critical");
    expect(heatCategory(100, 70, true)).toBe("critical");
  });

  it("respects different thresholds", () => {
    expect(heatCategory(55, 50, true)).toBe("threshold");
    expect(heatCategory(55, 60, true)).toBe("below");
    expect(heatCategory(85, 90, true)).toBe("high"); // 80-89 is always 'high'
  });
});

// ─── countExceedDays ────────────────────────────────────────────────

describe("countExceedDays", () => {
  it("counts days at or above threshold", () => {
    expect(countExceedDays([50, 70, 80, 90], 70)).toBe(3);
    expect(countExceedDays([50, 60, 65], 70)).toBe(0);
    expect(countExceedDays([70, 70, 70], 70)).toBe(3);
  });

  it("handles empty array", () => {
    expect(countExceedDays([], 70)).toBe(0);
  });
});

// ─── riskLevel ──────────────────────────────────────────────────────

describe("riskLevel", () => {
  it("returns 'ok' when no days exceeded", () => {
    expect(riskLevel(0, 14)).toBe("ok");
  });

  it("returns 'moderate' for low exceed count", () => {
    expect(riskLevel(1, 14)).toBe("moderate");
    expect(riskLevel(4, 14)).toBe("moderate");
  });

  it("returns 'high' when >35% exceeded", () => {
    expect(riskLevel(6, 14)).toBe("high"); // 6/14 = 42%
    expect(riskLevel(9, 14)).toBe("high"); // 9/14 = 64%
  });

  it("returns 'critical' when >70% exceeded", () => {
    expect(riskLevel(11, 14)).toBe("critical"); // 11/14 = 78%
    expect(riskLevel(14, 14)).toBe("critical");
  });
});

// ─── generateTimelineData ───────────────────────────────────────────

describe("generateTimelineData", () => {
  it("produces correct number of days", () => {
    expect(generateTimelineData(5, 14, 42)).toHaveLength(14);
    expect(generateTimelineData(5, 7, 42)).toHaveLength(7);
    expect(generateTimelineData(5, 1, 42)).toHaveLength(1);
  });

  it("is deterministic (same seed = same output)", () => {
    const a = generateTimelineData(5, 14, 12345);
    const b = generateTimelineData(5, 14, 12345);
    expect(a).toEqual(b);
  });

  it("produces different output for different seeds", () => {
    const a = generateTimelineData(5, 14, 100);
    const b = generateTimelineData(5, 14, 200);
    expect(a).not.toEqual(b);
  });

  it("all values are within [2, 98] range", () => {
    // Test with various CPU values
    for (const cpu of [0, 0.5, 1, 5, 25, 50]) {
      const peaks = generateTimelineData(cpu, 30, 999);
      for (const p of peaks) {
        expect(p).toBeGreaterThanOrEqual(2);
        expect(p).toBeLessThanOrEqual(98);
      }
    }
  });

  it("higher currentCpu produces higher average peaks", () => {
    const lowPeaks = generateTimelineData(1, 30, 42);
    const highPeaks = generateTimelineData(20, 30, 42);
    const lowAvg = lowPeaks.reduce((s, v) => s + v, 0) / lowPeaks.length;
    const highAvg = highPeaks.reduce((s, v) => s + v, 0) / highPeaks.length;
    expect(highAvg).toBeGreaterThan(lowAvg);
  });

  it("values are rounded to 1 decimal place", () => {
    const peaks = generateTimelineData(5, 14, 42);
    for (const p of peaks) {
      expect(Math.round(p * 10)).toBe(p * 10);
    }
  });

  it("basePeak formula: low CPU (<=2) uses linear + offset", () => {
    // currentCpu=0 → basePeak=max(8, 0*12+10)=10
    // currentCpu=1 → basePeak=max(8, 1*12+10)=22
    // currentCpu=2 → basePeak=max(8, 2*12+10)=34
    const peaks0 = generateTimelineData(0, 100, 42);
    const peaks1 = generateTimelineData(1, 100, 42);
    const peaks2 = generateTimelineData(2, 100, 42);
    const avg0 = peaks0.reduce((s, v) => s + v, 0) / 100;
    const avg1 = peaks1.reduce((s, v) => s + v, 0) / 100;
    const avg2 = peaks2.reduce((s, v) => s + v, 0) / 100;
    expect(avg0).toBeLessThan(avg1);
    expect(avg1).toBeLessThan(avg2);
  });
});

// ─── generateHourlyData ─────────────────────────────────────────────

describe("generateHourlyData", () => {
  it("produces 24 hours", () => {
    expect(generateHourlyData(80, 42)).toHaveLength(24);
  });

  it("is deterministic", () => {
    const a = generateHourlyData(80, 42);
    const b = generateHourlyData(80, 42);
    expect(a).toEqual(b);
  });

  it("all component values are non-negative", () => {
    const hours = generateHourlyData(90, 42);
    for (const h of hours) {
      expect(h.retellect).toBeGreaterThanOrEqual(0);
      expect(h.scoApp).toBeGreaterThanOrEqual(0);
      expect(h.system).toBeGreaterThanOrEqual(0);
      expect(h.free).toBeGreaterThanOrEqual(0);
    }
  });

  it("components sum to ~100% for each hour", () => {
    const hours = generateHourlyData(80, 42);
    for (const h of hours) {
      const total = h.retellect + h.scoApp + h.system + h.free;
      expect(total).toBeCloseTo(100, 0); // within 1%
    }
  });

  it("peak hours (10-14) have higher CPU than night (0-5)", () => {
    const hours = generateHourlyData(80, 42);
    const peakCpu = hours
      .filter((h) => h.hour >= 10 && h.hour <= 14)
      .map((h) => h.retellect + h.scoApp + h.system);
    const nightCpu = hours
      .filter((h) => h.hour >= 0 && h.hour <= 5)
      .map((h) => h.retellect + h.scoApp + h.system);
    const avgPeak = peakCpu.reduce((s, v) => s + v, 0) / peakCpu.length;
    const avgNight = nightCpu.reduce((s, v) => s + v, 0) / nightCpu.length;
    expect(avgPeak).toBeGreaterThan(avgNight);
  });

  it("retellect is the largest component during peak hours", () => {
    const hours = generateHourlyData(80, 42);
    const peakHours = hours.filter((h) => h.hour >= 10 && h.hour <= 14);
    for (const h of peakHours) {
      expect(h.retellect).toBeGreaterThanOrEqual(h.system);
    }
  });
});

// ─── generateIntervalData tests ──────────────────────────────────────

describe("generateIntervalData", () => {
  it("returns 24 slots for 60-minute granularity", () => {
    const slots = generateIntervalData(80, 42, 60);
    expect(slots).toHaveLength(24);
    expect(slots[0].hour).toBe(0);
    expect(slots[0].minute).toBe(0);
    expect(slots[0].label).toBe("00:00");
    expect(slots[23].hour).toBe(23);
    expect(slots[23].label).toBe("23:00");
  });

  it("returns 96 slots for 15-minute granularity", () => {
    const slots = generateIntervalData(80, 42, 15);
    expect(slots).toHaveLength(96);
    expect(slots[0].label).toBe("00:00");
    expect(slots[1].label).toBe("00:15");
    expect(slots[2].label).toBe("00:30");
    expect(slots[3].label).toBe("00:45");
    expect(slots[4].label).toBe("01:00");
    expect(slots[95].label).toBe("23:45");
  });

  it("returns 288 slots for 5-minute granularity", () => {
    const slots = generateIntervalData(80, 42, 5);
    expect(slots).toHaveLength(288);
    expect(slots[0].label).toBe("00:00");
    expect(slots[1].label).toBe("00:05");
    expect(slots[287].label).toBe("23:55");
  });

  it("components sum to ~100% for every slot at 15min", () => {
    const slots = generateIntervalData(80, 42, 15);
    for (const s of slots) {
      const total = s.retellect + s.scoApp + s.system + s.free;
      expect(total).toBeCloseTo(100, 0);
    }
  });

  it("components sum to ~100% for every slot at 5min", () => {
    const slots = generateIntervalData(70, 99, 5);
    for (const s of slots) {
      const total = s.retellect + s.scoApp + s.system + s.free;
      expect(total).toBeCloseTo(100, 0);
    }
  });

  it("is deterministic — same seed produces same results", () => {
    const a = generateIntervalData(80, 42, 15);
    const b = generateIntervalData(80, 42, 15);
    expect(a).toEqual(b);
  });

  it("different seeds produce different results", () => {
    const a = generateIntervalData(80, 42, 15);
    const b = generateIntervalData(80, 99, 15);
    expect(a[50].retellect).not.toEqual(b[50].retellect);
  });

  it("peak period (10-14) has higher CPU than night (0-5) at 15min", () => {
    const slots = generateIntervalData(80, 42, 15);
    const peak = slots.filter(s => s.hour >= 10 && s.hour <= 14);
    const night = slots.filter(s => s.hour >= 0 && s.hour <= 5);
    const avgPeak = peak.reduce((sum, s) => sum + s.retellect + s.scoApp + s.system, 0) / peak.length;
    const avgNight = night.reduce((sum, s) => sum + s.retellect + s.scoApp + s.system, 0) / night.length;
    expect(avgPeak).toBeGreaterThan(avgNight);
  });

  it("slot indices are sequential 0..N-1", () => {
    const slots = generateIntervalData(80, 42, 5);
    slots.forEach((s, i) => expect(s.slot).toBe(i));
  });
});
