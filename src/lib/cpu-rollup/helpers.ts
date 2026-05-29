/**
 * Pure helpers extracted from writer.ts and reader.ts so they can be
 * unit-tested without mocking Prisma or the Zabbix client. Anything in
 * here is fully deterministic given its inputs (no DB, no network, no
 * Date.now() unless explicitly threaded through a parameter).
 */

/** Round a number to one decimal place. Guards against NaN propagation
 *  into the DB by clamping non-finite inputs to 0. */
export function round1(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 10) / 10;
}

/** Add `days` days to a YYYY-MM-DD string. Operates in UTC so the result
 *  is independent of the runtime's local timezone. */
export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Translate a Vilnius-local ISO date (YYYY-MM-DD) + hour into the Unix
 *  second when that wall-clock time hits in Vilnius. Throws when the
 *  combination falls inside a DST gap (e.g. 03:00 on spring-forward day).
 *
 *  Implementation: try both possible UTC offsets (-3 winter, -2 summer
 *  ... wait, Vilnius is UTC+2/+3, so the OFFSET from UTC midnight to
 *  Vilnius midnight is -2 or -3 hours). Confirm which one round-trips
 *  back to the same date+hour via Intl. */
export function isoToVilniusUnix(iso: string, hour: number): number {
  const guessUtc = Date.UTC(
    Number(iso.slice(0, 4)),
    Number(iso.slice(5, 7)) - 1,
    Number(iso.slice(8, 10)),
    hour, 0, 0,
  );
  for (const offsetHours of [-3, -2]) {
    const candidate = guessUtc + offsetHours * 3600 * 1000;
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Vilnius",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date(candidate));
    let y = "", m = "", d = "", h = "";
    for (const p of parts) {
      if (p.type === "year") y = p.value;
      else if (p.type === "month") m = p.value;
      else if (p.type === "day") d = p.value;
      else if (p.type === "hour") h = p.value;
    }
    const formattedIso = `${y}-${m}-${d}`;
    const formattedHour = parseInt(h === "24" ? "0" : h, 10);
    if (formattedIso === iso && formattedHour === hour) {
      return Math.floor(candidate / 1000);
    }
  }
  throw new Error(`isoToVilniusUnix: could not resolve ${iso} ${hour}:00 — DST gap or Intl misconfiguration`);
}

/** Vilnius local YYYY-MM-DD for a Unix-second timestamp. Asserts the
 *  Intl output matches the expected format so a future runtime with
 *  weird locale handling fails loudly rather than corrupting queries. */
export function vilniusDateString(unixSec: number): string {
  const s = new Date(unixSec * 1000).toLocaleDateString("en-CA", { timeZone: "Europe/Vilnius" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`vilniusDateString: unexpected Intl output "${s}" for unix=${unixSec}; en-CA + Europe/Vilnius should produce YYYY-MM-DD`);
  }
  return s;
}

/** Format YYYY-MM-DD from a Date that already represents a UTC calendar
 *  day (i.e. constructed with `new Date("YYYY-MM-DDT00:00:00Z")`). Used
 *  to translate `CpuMetricDaily.date` rows back to the wire format. */
export function isoDateUtc(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Source classification for a daily CPU rollup row.
 *
 *  - 0 samples           → "trend" (only trend.get covered the day)
 *  - 1..HISTORY_FULL-1   → "merged" (history partial, trend filled gaps)
 *  - HISTORY_FULL..      → "history" (full minute-grain coverage)
 *
 *  Threshold of 1320 = 1440 (normal day) minus 120 (a tolerance that
 *  covers DST spring-forward dropping 60 minutes plus minor Zabbix
 *  reporting gaps). Without the tolerance, every Mar/Oct DST date
 *  misclassifies. */
export const HISTORY_FULL_DAY_THRESHOLD = 1320;

export type CpuMetricSource = "history" | "merged" | "trend";

export function classifyDailySource(totalSamples: number): CpuMetricSource {
  if (totalSamples === 0) return "trend";
  if (totalSamples < HISTORY_FULL_DAY_THRESHOLD) return "merged";
  return "history";
}

/** Run a batch of already-issued promises in await chunks. Keeps memory
 *  pressure low by waiting on `concurrency` results before moving to
 *  the next slice. Operations are still all eagerly created (Prisma
 *  queries start immediately), but the chunked awaits ensure errors
 *  surface in batches rather than as one giant fail. */
export async function runInChunks<T>(ops: Array<Promise<T>>, concurrency: number): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < ops.length; i += concurrency) {
    const slice = ops.slice(i, i + concurrency);
    const batch = await Promise.all(slice);
    results.push(...batch);
  }
  return results;
}

/** Pure bucket-aggregation helper. Given a list of raw history samples
 *  (one per minute), group them by host + hour and compute max/avg/min.
 *  Used by writer.ts hourly rollup. */
export interface RawCpuSample {
  hostId: string;
  clockSec: number;
  value: number;
}

export interface HourBucketAgg {
  hostId: string;
  hourStartSec: number;
  max: number;
  min: number;
  sum: number;
  count: number;
}

export function bucketSamplesByHour(samples: RawCpuSample[]): Map<string, HourBucketAgg> {
  const out = new Map<string, HourBucketAgg>();
  for (const s of samples) {
    if (!Number.isFinite(s.value)) continue;
    const hourStartSec = Math.floor(s.clockSec / 3600) * 3600;
    const key = `${s.hostId}|${hourStartSec}`;
    let bucket = out.get(key);
    if (!bucket) {
      bucket = { hostId: s.hostId, hourStartSec, max: s.value, min: s.value, sum: s.value, count: 1 };
      out.set(key, bucket);
    } else {
      if (s.value > bucket.max) bucket.max = s.value;
      if (s.value < bucket.min) bucket.min = s.value;
      bucket.sum += s.value;
      bucket.count += 1;
    }
  }
  return out;
}
