import { describe, it, expect } from "vitest";
import {
  aggregateHost,
  computeBaseline,
  mergeOnOff,
  vilniusHour,
  weightedAvg,
  MIN_BASELINE_SAMPLES_DEFAULT,
  RETELLECT_ON_CUTOFF_PCT_DEFAULT,
  type HostBucket,
} from "./aggregate";
import { emptyOnOffAggregate } from "./types";

// ─── Helpers ────────────────────────────────────────────────────────

/** Unix-ms for a wall-clock Europe/Vilnius date+hour. EET = UTC+2; EEST = UTC+3.
 *  Tests use winter (UTC+2) dates so the offset is deterministic — DST
 *  transitions get a dedicated test below. */
function vilniusWinterTs(yyyymmdd: string, hour: number, minute: number = 0): number {
  // 2026-01-15 03:00 Vilnius (winter) = 2026-01-15 01:00 UTC.
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  return Date.UTC(y, m - 1, d, hour - 2, minute, 0);
}

/** Synthesise a minute-history bucket with given signals. */
function bucket(
  tsMs: number,
  spssCpu: number | null,
  retellectCpu: number | null,
  totalCpu: number | null,
  source: "history" | "trend" = "history",
): HostBucket {
  return {
    tsMs,
    weightMinutes: source === "trend" ? 60 : 1,
    source,
    spssCpu,
    retellectCpu,
    totalCpu,
  };
}

// ─── vilniusHour ────────────────────────────────────────────────────

describe("vilniusHour", () => {
  it("returns wall-clock Vilnius hour for a winter timestamp", () => {
    // 2026-02-10 03:00 Vilnius (winter, UTC+2) = 01:00 UTC
    expect(vilniusHour(Date.UTC(2026, 1, 10, 1, 0, 0))).toBe(3);
    expect(vilniusHour(Date.UTC(2026, 1, 10, 22, 0, 0))).toBe(0); // midnight
  });
  it("handles DST: summer (EEST, UTC+3)", () => {
    // 2026-07-10 03:00 Vilnius (summer) = 00:00 UTC
    expect(vilniusHour(Date.UTC(2026, 6, 10, 0, 0, 0))).toBe(3);
  });
});

// ─── computeBaseline ────────────────────────────────────────────────

describe("computeBaseline", () => {
  it("returns null and 0 samples on empty input", () => {
    const r = computeBaseline([]);
    expect(r.baseline).toBeNull();
    expect(r.sampleCount).toBe(0);
    expect(r.hasAnySamples).toBe(false);
  });

  it("returns null when fewer than minSamples night points are available", () => {
    // 5 night samples — well under the default 30
    const buckets: HostBucket[] = [];
    for (let i = 0; i < 5; i++) {
      buckets.push(bucket(vilniusWinterTs("2026-02-10", 3, i), 1.5, 0, 5));
    }
    const r = computeBaseline(buckets);
    expect(r.baseline).toBeNull();
    expect(r.sampleCount).toBe(5);
    expect(r.hasAnySamples).toBe(true);
  });

  it("ignores trend buckets even when they fall in the night window", () => {
    // 40 trend buckets in the night window — none should count toward baseline
    const buckets: HostBucket[] = [];
    for (let i = 0; i < 40; i++) {
      buckets.push({
        tsMs: vilniusWinterTs("2026-02-10", 3, 0) + i * 60_000,
        weightMinutes: 60,
        source: "trend",
        spssCpu: 1.5,
        retellectCpu: 0,
        totalCpu: 5,
      });
    }
    const r = computeBaseline(buckets);
    expect(r.baseline).toBeNull();
    expect(r.sampleCount).toBe(0);
  });

  it("returns the median of night-window spss samples once minSamples is met", () => {
    // 35 night samples; values 1..35 → median = 18
    const buckets: HostBucket[] = [];
    for (let i = 1; i <= 35; i++) {
      buckets.push(bucket(vilniusWinterTs("2026-02-10", 3, i % 60), i, 0, 5));
    }
    const r = computeBaseline(buckets);
    expect(r.baseline).toBe(18);
    expect(r.sampleCount).toBe(35);
  });

  it("excludes daytime samples even when they swamp the night ones", () => {
    // 100 daytime samples at 80% would skew a mean baseline; median over
    // night-only must stay near the night samples.
    const buckets: HostBucket[] = [];
    for (let i = 0; i < 100; i++) {
      buckets.push(bucket(vilniusWinterTs("2026-02-10", 14, i % 60), 80, 5, 90));
    }
    for (let i = 0; i < 30; i++) {
      buckets.push(bucket(vilniusWinterTs("2026-02-10", 3, i % 60), 1.5, 0, 5));
    }
    const r = computeBaseline(buckets);
    expect(r.baseline).toBe(1.5);
    expect(r.sampleCount).toBe(30);
  });
});

// ─── aggregateHost ──────────────────────────────────────────────────

describe("aggregateHost", () => {
  it("returns empty aggregates when baseline cannot be computed", () => {
    // No night samples at all
    const buckets = [bucket(vilniusWinterTs("2026-02-10", 14, 0), 70, 10, 90)];
    const entry = aggregateHost("h1", buckets, 2);
    expect(entry.baselineSpssCpu).toBeNull();
    expect(entry.on.realActiveMinutes).toBe(0);
    expect(entry.off.realActiveMinutes).toBe(0);
  });

  it("classifies an active minute with retellect > cutoff into the ON bucket", () => {
    const buckets: HostBucket[] = [];
    // 30 baseline-night samples at 2 %
    for (let i = 0; i < 30; i++) buckets.push(bucket(vilniusWinterTs("2026-02-10", 3, i), 2, 0, 5));
    // 5 active daytime minutes: spss 10 %, retellect 1.5 %, totalCpu 25 %
    for (let i = 0; i < 5; i++) buckets.push(bucket(vilniusWinterTs("2026-02-10", 14, i), 10, 1.5, 25));
    const entry = aggregateHost("h1", buckets, 2);
    expect(entry.baselineSpssCpu).toBe(2);
    // 5 active minutes, all classified Retellect ON
    expect(entry.on.realActiveMinutes).toBe(5);
    expect(entry.off.realActiveMinutes).toBe(0);
    expect(entry.on.sumTotalCpu).toBe(5 * 25);
    expect(entry.on.sumRetellectCpu).toBe(5 * 1.5);
    expect(entry.on.peakTotalCpu).toBe(25);
  });

  it("classifies retellect at or below the ON cutoff as OFF", () => {
    const buckets: HostBucket[] = [];
    for (let i = 0; i < 30; i++) buckets.push(bucket(vilniusWinterTs("2026-02-10", 3, i), 2, 0, 5));
    // retellect exactly at the cutoff (0.5) — strict `>` means it should be OFF
    buckets.push(bucket(vilniusWinterTs("2026-02-10", 14, 0), 10, RETELLECT_ON_CUTOFF_PCT_DEFAULT, 25));
    // retellect just above the cutoff → ON
    buckets.push(bucket(vilniusWinterTs("2026-02-10", 14, 1), 10, RETELLECT_ON_CUTOFF_PCT_DEFAULT + 0.01, 25));
    const entry = aggregateHost("h1", buckets, 2);
    expect(entry.off.realActiveMinutes).toBe(1);
    expect(entry.on.realActiveMinutes).toBe(1);
  });

  it("excludes idle minutes (spss <= baseline + threshold) from both ON and OFF", () => {
    const buckets: HostBucket[] = [];
    for (let i = 0; i < 30; i++) buckets.push(bucket(vilniusWinterTs("2026-02-10", 3, i), 2, 0, 5));
    // 5 idle minutes at baseline + 1.5 pp (below the 2 pp threshold)
    for (let i = 0; i < 5; i++) buckets.push(bucket(vilniusWinterTs("2026-02-10", 14, i), 3.5, 5, 30));
    const entry = aggregateHost("h1", buckets, 2);
    expect(entry.on.realActiveMinutes).toBe(0);
    expect(entry.off.realActiveMinutes).toBe(0);
    // totalMinutes still counts the seen buckets (active + idle) — drives
    // the "agent broken vs idle" UI distinction.
    // 30 baseline + 5 daytime = 35 total
    expect(entry.totalMinutes).toBe(35);
  });

  it("trend buckets contribute weight 60 to the active minute counters", () => {
    const buckets: HostBucket[] = [];
    for (let i = 0; i < 30; i++) buckets.push(bucket(vilniusWinterTs("2026-02-10", 3, i), 2, 0, 5));
    // One trend hour bucket, classified active+ON
    buckets.push(bucket(vilniusWinterTs("2026-02-10", 14, 0), 10, 1.5, 25, "trend"));
    const entry = aggregateHost("h1", buckets, 2);
    expect(entry.on.realActiveMinutes).toBe(0);
    expect(entry.on.syntheticActiveMinutes).toBe(60);
    expect(entry.on.sumTotalCpu).toBe(60 * 25); // weighted by 60
  });

  it("missing totalCpu does not block active classification but reduces sum", () => {
    const buckets: HostBucket[] = [];
    for (let i = 0; i < 30; i++) buckets.push(bucket(vilniusWinterTs("2026-02-10", 3, i), 2, 0, 5));
    // Active minute with totalCpu null
    buckets.push(bucket(vilniusWinterTs("2026-02-10", 14, 0), 10, 1.5, null));
    const entry = aggregateHost("h1", buckets, 2);
    expect(entry.on.realActiveMinutes).toBe(1);
    expect(entry.on.sumTotalCpu).toBe(0); // nothing to add
    expect(entry.on.peakTotalCpu).toBeNull(); // no totalCpu observed
  });

  it("missing retellectCpu is treated as OFF (conservative)", () => {
    const buckets: HostBucket[] = [];
    for (let i = 0; i < 30; i++) buckets.push(bucket(vilniusWinterTs("2026-02-10", 3, i), 2, 0, 5));
    buckets.push(bucket(vilniusWinterTs("2026-02-10", 14, 0), 10, null, 25));
    const entry = aggregateHost("h1", buckets, 2);
    expect(entry.on.realActiveMinutes).toBe(0);
    expect(entry.off.realActiveMinutes).toBe(1);
  });

  it("accumulates minutes-above-threshold counters per bucket band (strict >, ALL minutes)", () => {
    const buckets: HostBucket[] = [];
    for (let i = 0; i < 30; i++) buckets.push(bucket(vilniusWinterTs("2026-02-10", 3, i), 2, 0, 5));
    // 3 ON active minutes at totalCpu 75 → above 50, 60, 70 but NOT 80/90
    for (let i = 0; i < 3; i++) buckets.push(bucket(vilniusWinterTs("2026-02-10", 14, i), 10, 2, 75));
    // 2 ON active minutes at totalCpu 92 → above 50, 60, 70, 80, 90
    for (let i = 3; i < 5; i++) buckets.push(bucket(vilniusWinterTs("2026-02-10", 14, i), 10, 2, 92));
    // 1 ON active minute exactly at 70 (strict >, so does NOT increment 70)
    buckets.push(bucket(vilniusWinterTs("2026-02-10", 14, 5), 10, 2, 70));
    const entry = aggregateHost("h1", buckets, 2);
    expect(entry.on.minutesAboveThreshold[50]).toBe(6); // all 6 ON busy min
    expect(entry.on.minutesAboveThreshold[60]).toBe(6);
    expect(entry.on.minutesAboveThreshold[70]).toBe(5); // 70 itself excluded
    expect(entry.on.minutesAboveThreshold[80]).toBe(2); // only the 92s
    expect(entry.on.minutesAboveThreshold[90]).toBe(2);
    expect(entry.off.minutesAboveThreshold[50]).toBe(0);
  });

  it("counts minutes-above-threshold for IDLE minutes too (consistency with Timeline)", () => {
    const buckets: HostBucket[] = [];
    for (let i = 0; i < 30; i++) buckets.push(bucket(vilniusWinterTs("2026-02-10", 3, i), 2, 0, 5));
    // Idle from spss perspective (1% << baseline+2pp = 4%) but totalCpu=95
    // — e.g. SQL backup running while SCO is quiet. Should still count
    // toward minutesAboveThreshold[90] so Timeline and Rollout agree.
    buckets.push(bucket(vilniusWinterTs("2026-02-10", 14, 0), 1, 0, 95));
    const entry = aggregateHost("h1", buckets, 2);
    // No retellect signal → bucket is classified OFF
    expect(entry.off.minutesAboveThreshold[90]).toBe(1);
    expect(entry.off.minutesAboveThreshold[70]).toBe(1);
    expect(entry.off.realActiveMinutes).toBe(0); // not active — spss too low
    // realTrackedMinutes counts every bucket with totalCpu: 30 night baseline + 1 daytime
    expect(entry.off.realTrackedMinutes).toBe(31);
  });

  it("trend buckets contribute weight 60 to the above-threshold counters", () => {
    const buckets: HostBucket[] = [];
    for (let i = 0; i < 30; i++) buckets.push(bucket(vilniusWinterTs("2026-02-10", 3, i), 2, 0, 5));
    // One trend hour at totalCpu 85 → contributes 60 minutes regardless of active
    buckets.push(bucket(vilniusWinterTs("2026-02-10", 14, 0), 10, 1.5, 85, "trend"));
    const entry = aggregateHost("h1", buckets, 2);
    expect(entry.on.minutesAboveThreshold[70]).toBe(60);
    expect(entry.on.minutesAboveThreshold[80]).toBe(60);
    expect(entry.on.minutesAboveThreshold[90]).toBe(0);
    expect(entry.on.syntheticTrackedMinutes).toBe(60);
  });

  it("populates threshold counters even when baseline is null (sparse night data)", () => {
    // Only 5 night samples — under default min 30 → baseline = null
    const buckets: HostBucket[] = [];
    for (let i = 0; i < 5; i++) buckets.push(bucket(vilniusWinterTs("2026-02-10", 3, i), 2, 0, 5));
    // 2 daytime busy-from-CPU minutes at 80 % — should count toward 70/80 buckets
    buckets.push(bucket(vilniusWinterTs("2026-02-10", 14, 0), null, 0, 80));
    buckets.push(bucket(vilniusWinterTs("2026-02-10", 14, 1), null, 0, 80));
    const entry = aggregateHost("h1", buckets, 2);
    expect(entry.baselineSpssCpu).toBeNull();
    expect(entry.off.minutesAboveThreshold[70]).toBe(2); // counted despite null baseline
    expect(entry.off.realActiveMinutes).toBe(0); // active classification unavailable
  });
});

// ─── mergeOnOff + weightedAvg ───────────────────────────────────────

describe("mergeOnOff", () => {
  it("sums minute counts and accumulators", () => {
    const a = { ...emptyOnOffAggregate(), realActiveMinutes: 10, sumTotalCpu: 100, sumRetellectCpu: 20, sumSpssCpu: 50, peakTotalCpu: 30 };
    const b = { ...emptyOnOffAggregate(), realActiveMinutes: 5, syntheticActiveMinutes: 60, sumTotalCpu: 150, sumRetellectCpu: 30, sumSpssCpu: 25, peakTotalCpu: 45 };
    const m = mergeOnOff(a, b);
    expect(m.realActiveMinutes).toBe(15);
    expect(m.syntheticActiveMinutes).toBe(60);
    expect(m.sumTotalCpu).toBe(250);
    expect(m.sumRetellectCpu).toBe(50);
    expect(m.sumSpssCpu).toBe(75);
    expect(m.peakTotalCpu).toBe(45); // max
  });
  it("handles null peakTotalCpu on either side", () => {
    const a = { ...emptyOnOffAggregate(), peakTotalCpu: null };
    const b = { ...emptyOnOffAggregate(), peakTotalCpu: 30 };
    expect(mergeOnOff(a, b).peakTotalCpu).toBe(30);
    expect(mergeOnOff(b, a).peakTotalCpu).toBe(30);
    expect(mergeOnOff(a, a).peakTotalCpu).toBeNull();
  });
});

describe("weightedAvg", () => {
  it("returns null when no active minutes are accumulated", () => {
    const empty = emptyOnOffAggregate();
    expect(weightedAvg(empty, "sumTotalCpu")).toBeNull();
  });
  it("divides sum by total minutes (real + synthetic) regardless of source", () => {
    const a = { ...emptyOnOffAggregate(), realActiveMinutes: 10, syntheticActiveMinutes: 60, sumTotalCpu: 350 };
    // 350 / (10 + 60) = 5
    expect(weightedAvg(a, "sumTotalCpu")).toBe(5);
  });
});

// ─── End-to-end: a small synthetic scenario ─────────────────────────

describe("aggregateHost — small end-to-end scenario", () => {
  it("matches expected ON / OFF averages on a hand-built bucket set", () => {
    const buckets: HostBucket[] = [];
    // Baseline: 30 night samples at 1.0 %
    for (let i = 0; i < 30; i++) buckets.push(bucket(vilniusWinterTs("2026-02-10", 3, i), 1.0, 0, 4));
    // Active ON: 3 minutes with spss=8, retellect=2, total=22 (above 1.0 + 2 = 3 pp)
    for (let i = 0; i < 3; i++) buckets.push(bucket(vilniusWinterTs("2026-02-10", 14, i), 8, 2, 22));
    // Active OFF: 2 minutes with spss=8, retellect=0.1 (below 0.5 cutoff), total=18
    for (let i = 3; i < 5; i++) buckets.push(bucket(vilniusWinterTs("2026-02-10", 14, i), 8, 0.1, 18));
    // Idle: 4 minutes with spss=2 (above baseline but not + 2 pp), total=6 — excluded
    for (let i = 5; i < 9; i++) buckets.push(bucket(vilniusWinterTs("2026-02-10", 14, i), 2, 0, 6));

    const entry = aggregateHost("h1", buckets, 2);
    expect(entry.baselineSpssCpu).toBe(1.0);
    expect(entry.on.realActiveMinutes).toBe(3);
    expect(entry.off.realActiveMinutes).toBe(2);
    expect(weightedAvg(entry.on, "sumTotalCpu")).toBe(22);
    expect(weightedAvg(entry.on, "sumRetellectCpu")).toBe(2);
    expect(weightedAvg(entry.off, "sumTotalCpu")).toBe(18);
    expect(weightedAvg(entry.off, "sumRetellectCpu")).toBeCloseTo(0.1);
  });

  // Sanity guard: the default constants stay in their documented ranges.
  it("uses sensible defaults", () => {
    expect(MIN_BASELINE_SAMPLES_DEFAULT).toBe(30);
    expect(RETELLECT_ON_CUTOFF_PCT_DEFAULT).toBe(0.5);
  });
});
