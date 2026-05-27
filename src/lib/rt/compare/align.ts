/**
 * Overlay alignment helpers for the CPU Timeline Compare-periods sub-view.
 *
 * Two alignment modes (spec §6.3):
 *
 *   - "absolute-offset": the x-axis is "minutes since period start". Period A
 *     minute 0 lines up with Period B minute 0. Useful when the user thinks
 *     of the periods as identical-shape windows (e.g. "the 7 days after
 *     rollout vs the 7 days before").
 *
 *   - "time-of-day": the x-axis is "minutes since midnight" (0..1440).
 *     Both periods collapse onto a single 24h cycle, sharing the same Tue
 *     10:00 slot regardless of which calendar Tuesday they fall on. Useful
 *     for retail traffic where daily seasonality dominates the signal.
 *
 * The shared output shape is bucketed by `slotMinutes`. We default to 5-min
 * slots for time-of-day (288 slots / period) and 30-min slots for absolute
 * (cap at ~336 slots even for 7-day windows, so recharts/SVG stays light).
 * Slot width scales with period length to keep total slot count manageable.
 */
import type { CompareAlignment, OverlayPoint } from "@/components/rt/compare/types";

export interface RawSample {
  hostId: string;
  clockSec: number;
  value: number;
}

export interface AlignInput {
  /** Period A samples (raw 1-min CPU values). */
  aSamples: RawSample[];
  /** Period B samples. */
  bSamples: RawSample[];
  /** Period A window — Unix seconds inclusive of fromSec, exclusive of toSec. */
  aFromSec: number;
  aToSec: number;
  /** Period B window. */
  bFromSec: number;
  bToSec: number;
  /** Threshold % for the minutesAbove counter. */
  threshold: number;
  /** How to lay the two periods on a shared x-axis. */
  alignment: CompareAlignment;
}

export interface AlignOutput {
  alignment: CompareAlignment;
  totalSlots: number;
  slotMinutes: number;
  points: OverlayPoint[];
}

/**
 * Pick a slot width that keeps the output ≤ MAX_SLOTS while staying a clean
 * multiple of 60 seconds. Time-of-day always uses 5-min slots (the 24h cycle
 * is fixed). Absolute-offset slot width depends on period length.
 */
function pickSlotMinutes(alignment: CompareAlignment, periodSeconds: number): number {
  if (alignment === "time-of-day") return 5;
  const MAX_SLOTS = 336;
  const periodMinutes = Math.ceil(periodSeconds / 60);
  if (periodMinutes <= MAX_SLOTS) return 1;
  // Round up to the next multiple of 5 that keeps us under MAX_SLOTS.
  for (const slot of [5, 10, 15, 30, 60, 120, 240]) {
    if (Math.ceil(periodMinutes / slot) <= MAX_SLOTS) return slot;
  }
  return 240;
}

interface SlotAccum {
  /** Sum of CPU values landing in this slot. */
  sum: number;
  /** Count of values landing in this slot. */
  count: number;
  /** Count of values strictly above the threshold. */
  above: number;
}

function emptySlots(n: number): SlotAccum[] {
  const arr = new Array<SlotAccum>(n);
  for (let i = 0; i < n; i++) arr[i] = { sum: 0, count: 0, above: 0 };
  return arr;
}

/**
 * Bucket samples into either an absolute-offset axis or a time-of-day axis.
 *
 * For time-of-day we use Vilnius local minute-of-day so the bins match what
 * the operator sees on the clock in front of the kasa.
 */
function bucketSamples(
  samples: RawSample[],
  fromSec: number,
  toSec: number,
  alignment: CompareAlignment,
  slotMinutes: number,
  threshold: number,
): { slots: SlotAccum[]; totalSlots: number } {
  if (alignment === "time-of-day") {
    const totalSlots = Math.floor(1440 / slotMinutes);
    const slots = emptySlots(totalSlots);
    for (const s of samples) {
      if (s.clockSec < fromSec || s.clockSec >= toSec) continue;
      // Convert to Vilnius local minute-of-day. Vilnius offset varies
      // (DST), so we use Intl rather than a fixed offset.
      const localMinute = vilniusMinuteOfDay(s.clockSec);
      const idx = Math.floor(localMinute / slotMinutes);
      if (idx < 0 || idx >= totalSlots) continue;
      const slot = slots[idx];
      slot.sum += s.value;
      slot.count += 1;
      if (s.value > threshold) slot.above += 1;
    }
    return { slots, totalSlots };
  }

  // absolute-offset
  const periodSec = toSec - fromSec;
  const totalSlots = Math.ceil(periodSec / 60 / slotMinutes);
  const slots = emptySlots(totalSlots);
  for (const s of samples) {
    if (s.clockSec < fromSec || s.clockSec >= toSec) continue;
    const offsetMin = (s.clockSec - fromSec) / 60;
    const idx = Math.floor(offsetMin / slotMinutes);
    if (idx < 0 || idx >= totalSlots) continue;
    const slot = slots[idx];
    slot.sum += s.value;
    slot.count += 1;
    if (s.value > threshold) slot.above += 1;
  }
  return { slots, totalSlots };
}

function vilniusMinuteOfDay(clockSec: number): number {
  // Intl-based — handles DST automatically. The cost is one Intl call per
  // sample; for a 7d × 6-host fleet that's ~60k calls per overlay build
  // (~10–20 ms in V8). Acceptable for an interactive query.
  const d = new Date(clockSec * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Vilnius",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  let h = 0;
  let m = 0;
  for (const p of parts) {
    if (p.type === "hour") h = parseInt(p.value, 10);
    if (p.type === "minute") m = parseInt(p.value, 10);
  }
  if (h === 24) h = 0; // en-CA renders midnight as "24:00" in some impls
  return h * 60 + m;
}

export function alignSamples(input: AlignInput): AlignOutput {
  const slotMinutes = pickSlotMinutes(input.alignment, input.aToSec - input.aFromSec);

  const a = bucketSamples(input.aSamples, input.aFromSec, input.aToSec, input.alignment, slotMinutes, input.threshold);
  const b = bucketSamples(input.bSamples, input.bFromSec, input.bToSec, input.alignment, slotMinutes, input.threshold);

  // The two periods produce identically-sized bucket arrays for both
  // alignment modes (time-of-day = fixed 1440 minutes; absolute-offset
  // depends on (toSec − fromSec), and periods are guaranteed equal length
  // by API validation).
  const totalSlots = Math.max(a.totalSlots, b.totalSlots);
  const points: OverlayPoint[] = [];
  for (let i = 0; i < totalSlots; i++) {
    const aSlot = a.slots[i];
    const bSlot = b.slots[i];
    const aCpu = aSlot && aSlot.count > 0 ? Math.round((aSlot.sum / aSlot.count) * 10) / 10 : null;
    const bCpu = bSlot && bSlot.count > 0 ? Math.round((bSlot.sum / bSlot.count) * 10) / 10 : null;
    points.push({
      offsetMin: i * slotMinutes,
      aCpu,
      bCpu,
      // Each "above" sample represents 1 minute (history.get's native rate).
      // For trend-derived slots (>14d back), `count` may be hourly-weighted
      // and the above counter is 0 — the warning chip in the UI tells the
      // user this is partial.
      aMinutesAbove: aSlot ? aSlot.above : 0,
      bMinutesAbove: bSlot ? bSlot.above : 0,
    });
  }

  return {
    alignment: input.alignment,
    totalSlots,
    slotMinutes,
    points,
  };
}
