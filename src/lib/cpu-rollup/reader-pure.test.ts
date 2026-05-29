import { describe, it, expect } from "vitest";
import {
  todayMidnightVilniusUnix,
  computeCutoffSec,
  splitHybridWindow,
  dataQualityFromBreakdown,
} from "./reader-pure";
import { vilniusDateString } from "./helpers";

// ─── todayMidnightVilniusUnix ────────────────────────────────────────

describe("todayMidnightVilniusUnix", () => {
  it("returns Vilnius midnight for a winter 'now' (UTC+2)", () => {
    // 2026-01-15 12:00 UTC = 14:00 Vilnius. Today midnight Vilnius =
    // 2026-01-15 00:00 Vilnius = 2026-01-14 22:00 UTC.
    const now = new Date(Date.UTC(2026, 0, 15, 12, 0, 0));
    const got = todayMidnightVilniusUnix(now);
    expect(got).toBe(Math.floor(Date.UTC(2026, 0, 14, 22, 0, 0) / 1000));
  });
  it("returns Vilnius midnight for a summer 'now' (UTC+3)", () => {
    // 2026-07-15 12:00 UTC = 15:00 Vilnius. Today midnight Vilnius =
    // 2026-07-15 00:00 Vilnius = 2026-07-14 21:00 UTC.
    const now = new Date(Date.UTC(2026, 6, 15, 12, 0, 0));
    const got = todayMidnightVilniusUnix(now);
    expect(got).toBe(Math.floor(Date.UTC(2026, 6, 14, 21, 0, 0) / 1000));
  });
  it("round-trips with vilniusDateString — midnight of today", () => {
    const now = new Date(Date.UTC(2026, 4, 15, 12, 0, 0));
    const midnight = todayMidnightVilniusUnix(now);
    // Midnight Vilnius today → Vilnius date string = today
    expect(vilniusDateString(midnight)).toBe("2026-05-15");
  });
  it("handles a moment just after Vilnius midnight (still 'today')", () => {
    // 2026-07-15 21:01 UTC = 2026-07-16 00:01 Vilnius (just past midnight)
    const now = new Date(Date.UTC(2026, 6, 15, 21, 1, 0));
    const got = todayMidnightVilniusUnix(now);
    // "Today" is now July 16 in Vilnius. So Vilnius midnight of July 16
    // is exactly 2026-07-15 21:00 UTC.
    expect(got).toBe(Math.floor(Date.UTC(2026, 6, 15, 21, 0, 0) / 1000));
  });
});

// ─── computeCutoffSec ────────────────────────────────────────────────

describe("computeCutoffSec", () => {
  it("returns midnight 14 days ago", () => {
    const now = new Date(Date.UTC(2026, 6, 15, 12, 0, 0));
    const cutoff = computeCutoffSec(now);
    const todayMidnight = todayMidnightVilniusUnix(now);
    expect(todayMidnight - cutoff).toBe(14 * 86_400);
  });
});

// ─── splitHybridWindow ───────────────────────────────────────────────

describe("splitHybridWindow", () => {
  it("entire window after cutoff → all Zabbix, no DB", () => {
    const now = new Date(Date.UTC(2026, 6, 30, 12, 0, 0));
    const cutoff = computeCutoffSec(now);
    const fromSec = cutoff + 86_400; // 1 day after cutoff
    const toSec = cutoff + 7 * 86_400; // 7 days after cutoff
    const split = splitHybridWindow(fromSec, toSec, now);
    expect(split.zabbixFromSec).toBe(fromSec);
    expect(split.zabbixToSec).toBe(toSec);
    expect(split.dbFromSec >= split.dbToSec).toBe(true); // empty DB range
  });
  it("entire window before cutoff → all DB, no Zabbix", () => {
    const now = new Date(Date.UTC(2026, 6, 30, 12, 0, 0));
    const cutoff = computeCutoffSec(now);
    const fromSec = cutoff - 30 * 86_400;
    const toSec = cutoff - 7 * 86_400;
    const split = splitHybridWindow(fromSec, toSec, now);
    expect(split.dbFromSec).toBe(fromSec);
    expect(split.dbToSec).toBe(toSec);
    expect(split.zabbixFromSec >= split.zabbixToSec).toBe(true);
  });
  it("window straddles cutoff → both halves", () => {
    const now = new Date(Date.UTC(2026, 6, 30, 12, 0, 0));
    const cutoff = computeCutoffSec(now);
    const fromSec = cutoff - 7 * 86_400;
    const toSec = cutoff + 7 * 86_400;
    const split = splitHybridWindow(fromSec, toSec, now);
    expect(split.dbFromSec).toBe(fromSec);
    expect(split.dbToSec).toBe(cutoff);
    expect(split.zabbixFromSec).toBe(cutoff);
    expect(split.zabbixToSec).toBe(toSec);
  });
});

// ─── dataQualityFromBreakdown ────────────────────────────────────────

describe("dataQualityFromBreakdown", () => {
  it("returns partial-missing when nothing came back", () => {
    expect(dataQualityFromBreakdown({ zabbix: 0, rollupHistory: 0, rollupTrend: 0 })).toBe("partial-missing");
  });
  it("returns full when Zabbix served any rows", () => {
    expect(dataQualityFromBreakdown({ zabbix: 1, rollupHistory: 0, rollupTrend: 0 })).toBe("full");
    expect(dataQualityFromBreakdown({ zabbix: 5, rollupHistory: 3, rollupTrend: 7 })).toBe("full");
  });
  it("returns full when DB history (not trend) served any rows", () => {
    expect(dataQualityFromBreakdown({ zabbix: 0, rollupHistory: 1, rollupTrend: 0 })).toBe("full");
    expect(dataQualityFromBreakdown({ zabbix: 0, rollupHistory: 3, rollupTrend: 5 })).toBe("full");
  });
  it("returns trend-only when only DB trend rows came back", () => {
    expect(dataQualityFromBreakdown({ zabbix: 0, rollupHistory: 0, rollupTrend: 1 })).toBe("trend-only");
    expect(dataQualityFromBreakdown({ zabbix: 0, rollupHistory: 0, rollupTrend: 100 })).toBe("trend-only");
  });
});
