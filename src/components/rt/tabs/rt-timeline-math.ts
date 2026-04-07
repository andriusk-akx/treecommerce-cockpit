/**
 * Pure math/data functions for RtTimeline component.
 * Extracted for unit testing.
 */

/** Heatmap cell color classification */
export function heatCategory(
  value: number,
  threshold: number,
  hasMatch: boolean
): "none" | "below" | "threshold" | "high" | "critical" {
  if (!hasMatch) return "none";
  if (value >= 90) return "critical";
  if (value >= 80) return "high";
  if (value >= threshold) return "threshold";
  return "below";
}

/** Count how many days exceed a threshold */
export function countExceedDays(peaks: number[], threshold: number): number {
  return peaks.filter((p) => p >= threshold).length;
}

/** Risk level from exceed count */
export function riskLevel(exceedCount: number, totalDays: number): "critical" | "high" | "moderate" | "ok" {
  const ratio = exceedCount / totalDays;
  if (ratio > 0.7) return "critical";
  if (ratio > 0.35) return "high";
  if (exceedCount > 0) return "moderate";
  return "ok";
}

/**
 * Generate simulated daily peak data from current CPU snapshot.
 * Deterministic given the same seed.
 */
export function generateTimelineData(
  currentCpu: number,
  days: number,
  seed: number
): number[] {
  const peaks: number[] = [];
  let s = seed;
  const nextRand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s % 1000) / 1000;
  };

  const hostCharacter = nextRand();
  const basePeak = 30 + hostCharacter * 50 + Math.min(15, currentCpu * 1.5);

  for (let i = 0; i < days; i++) {
    const r = nextRand();
    const dayOfWeek = (new Date().getDay() - (days - 1 - i) + 7) % 7;
    const weekendFactor = (dayOfWeek === 0 || dayOfWeek === 6) ? 0.65 : 1.0;
    const dailyVariance = 0.7 + r * 0.6;
    const spike = nextRand() > 0.85 ? 1.2 + nextRand() * 0.25 : 1.0;
    const peak = basePeak * weekendFactor * dailyVariance * spike;
    peaks.push(Math.round(Math.max(2, Math.min(98, peak)) * 10) / 10);
  }
  return peaks;
}

/** Interval slot data for drill-down at any granularity */
export interface IntervalSlot {
  /** Slot index (0-based) */
  slot: number;
  /** Hour (0–23) */
  hour: number;
  /** Minute within the hour (0, 5, 10, 15, ...) */
  minute: number;
  /** Time label "HH:MM" */
  label: string;
  retellect: number;
  scoApp: number;
  system: number;
  free: number;
}

/**
 * Generate hourly CPU breakdown for drill-down view.
 * Simulates business-hour patterns.
 * Legacy 1h wrapper — delegates to generateIntervalData.
 */
export function generateHourlyData(
  peakCpu: number,
  seed: number
): { hour: number; retellect: number; scoApp: number; system: number; free: number }[] {
  return generateIntervalData(peakCpu, seed, 60).map((s) => ({
    hour: s.hour,
    retellect: s.retellect,
    scoApp: s.scoApp,
    system: s.system,
    free: s.free,
  }));
}

/**
 * Generate interval CPU breakdown at configurable granularity.
 * @param peakCpu - day peak CPU %
 * @param seed - deterministic seed
 * @param minutesPerSlot - 60 (1h), 15 (15min), or 5 (5min)
 * @returns Array of IntervalSlot (24 for 1h, 96 for 15min, 288 for 5min)
 */
export function generateIntervalData(
  peakCpu: number,
  seed: number,
  minutesPerSlot: number
): IntervalSlot[] {
  const slotsPerDay = Math.floor(1440 / minutesPerSlot);
  const slots: IntervalSlot[] = [];
  let s = seed;
  const nextRand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s % 1000) / 1000;
  };

  // Pre-compute hour-level base targets for smooth intra-hour variation
  const hourBases: number[] = [];
  // Use a separate seed stream for hour bases so results are consistent
  let hs = seed * 3 + 7;
  const nextHourRand = () => {
    hs = (hs * 1103515245 + 12345) & 0x7fffffff;
    return (hs % 1000) / 1000;
  };
  for (let h = 0; h < 24; h++) {
    const hourFactor =
      h >= 10 && h <= 14 ? 1.0 :
      h >= 8 && h <= 18 ? 0.7 :
      h >= 6 && h <= 20 ? 0.4 : 0.15;
    hourBases.push(peakCpu * hourFactor * (0.8 + nextHourRand() * 0.4));
  }

  for (let i = 0; i < slotsPerDay; i++) {
    const totalMinutes = i * minutesPerSlot;
    const hour = Math.floor(totalMinutes / 60);
    const minute = totalMinutes % 60;
    const label = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

    // Interpolate between hour bases for sub-hour smoothness
    const fractionalHour = totalMinutes / 60;
    const hourIdx = Math.min(23, Math.floor(fractionalHour));
    const nextHourIdx = Math.min(23, hourIdx + 1);
    const frac = fractionalHour - hourIdx;
    const baseTarget = hourBases[hourIdx] * (1 - frac) + hourBases[nextHourIdx] * frac;

    // Add per-slot noise — finer granularity gets more micro-variance
    const noiseFactor = minutesPerSlot <= 5 ? 0.25 : minutesPerSlot <= 15 ? 0.15 : 0.05;
    const noise = 1 - noiseFactor + nextRand() * noiseFactor * 2;
    const total = Math.min(98, Math.max(1, baseTarget * noise));

    const retellect = Math.round(total * (0.3 + nextRand() * 0.15) * 10) / 10;
    const scoApp = Math.round(total * (0.25 + nextRand() * 0.1) * 10) / 10;
    const system = Math.round(total * (0.1 + nextRand() * 0.08) * 10) / 10;
    const free = Math.round(Math.max(0, 100 - retellect - scoApp - system) * 10) / 10;

    slots.push({ slot: i, hour, minute, label, retellect, scoApp, system, free });
  }
  return slots;
}
