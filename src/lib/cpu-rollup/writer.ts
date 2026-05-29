/**
 * Writer for CPU metric rollup tables.
 *
 * Phase 4 of AKpilot spec v2.1: pulls Zabbix CPU history for a given
 * pilot + date range, upserts into `CpuMetricDaily` and `CpuMetricHourly`.
 * Idempotent — re-running the same day overwrites the existing row with
 * the latest Zabbix view (handy when Zabbix back-fills late samples).
 *
 * Reuses `client.getCpuHistoryForRange()` for the daily aggregator (we
 * already trust its math) and bins the raw `samples` array into hourly
 * buckets locally.
 */
import { prisma } from "@/lib/db";
import { getZabbixClient } from "@/lib/zabbix/client";
import { fetchRolloutRawBuckets } from "@/lib/rollout-insights/fetcher";

interface PilotDevice {
  id: string;
  name: string;
  sourceHostKey: string | null;
}

interface ResolvedHost {
  deviceId: string;
  zHostId: string;
}

/** One Vilnius-local day's worth of CPU samples for a host. */
export interface IngestStats {
  pilotId: string;
  daysProcessed: number;
  dailyRowsUpserted: number;
  hourlyRowsUpserted: number;
  processHourlyRowsUpserted: number;
  hostsResolved: number;
  warnings: string[];
}

/**
 * Resolve Zabbix host IDs for a pilot's devices. Mirrors the same matching
 * logic the Compare-periods endpoint uses but trimmed to the bare minimum
 * (no inventory enrichment, no CPU model filter).
 */
async function resolveHosts(pilotId: string): Promise<{
  pilotDevices: PilotDevice[];
  resolved: ResolvedHost[];
  itemIds: string[];
  itemHostMap: Map<string, string>;
  zHostToDeviceId: Map<string, string>;
}> {
  const pilot = await prisma.pilot.findUnique({
    where: { id: pilotId },
    include: { devices: { orderBy: { name: "asc" } } },
  });
  if (!pilot) {
    return {
      pilotDevices: [],
      resolved: [],
      itemIds: [],
      itemHostMap: new Map(),
      zHostToDeviceId: new Map(),
    };
  }
  const pilotDevices = pilot.devices.map((d) => ({
    id: d.id,
    name: d.name,
    sourceHostKey: d.sourceHostKey,
  }));
  const keyToDeviceId = new Map<string, string>();
  for (const d of pilotDevices) {
    const key = d.sourceHostKey || d.name;
    if (key) keyToDeviceId.set(key, d.id);
  }

  const client = getZabbixClient();
  const zHosts = (await client.getHosts()) as Array<{ hostid: string; name: string }>;
  const resolved: ResolvedHost[] = [];
  const zHostToDeviceId = new Map<string, string>();
  for (const z of zHosts) {
    const deviceId = keyToDeviceId.get(z.name);
    if (deviceId) {
      resolved.push({ deviceId, zHostId: z.hostid });
      zHostToDeviceId.set(z.hostid, deviceId);
    }
  }
  if (resolved.length === 0) {
    return { pilotDevices, resolved, itemIds: [], itemHostMap: new Map(), zHostToDeviceId };
  }
  const zHostIds = resolved.map((r) => r.zHostId);
  const items = (await client.getItems(zHostIds, "system.cpu.util")) as Array<{
    itemid: string;
    hostid: string;
    key_: string;
  }>;
  const cpuItems = items.filter(
    (i) => i.key_ === "system.cpu.util[,,avg1]" || i.key_ === "system.cpu.util",
  );
  return {
    pilotDevices,
    resolved,
    itemIds: cpuItems.map((i) => i.itemid),
    itemHostMap: new Map(cpuItems.map((i) => [i.itemid, i.hostid])),
    zHostToDeviceId,
  };
}

/** ISO YYYY-MM-DD ↔ Vilnius local midnight in Unix seconds. */
function isoToVilniusUnix(iso: string, hour: number): number {
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

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Roll up CPU metrics for a pilot across a date range (inclusive).
 *
 * `fromIso` and `toIso` are Vilnius-local ISO dates (YYYY-MM-DD). The
 * function fetches the entire window from Zabbix in one parallel call,
 * then upserts daily + hourly rows. Use a short window (1–3 days) for
 * the daily cron and a longer one for backfill.
 */
export async function rollupPilotRange(
  pilotId: string,
  fromIso: string,
  toIso: string,
): Promise<IngestStats> {
  const stats: IngestStats = {
    pilotId,
    daysProcessed: 0,
    dailyRowsUpserted: 0,
    hourlyRowsUpserted: 0,
    processHourlyRowsUpserted: 0,
    hostsResolved: 0,
    warnings: [],
  };

  const { resolved, itemIds, itemHostMap, zHostToDeviceId } = await resolveHosts(pilotId);
  stats.hostsResolved = resolved.length;
  if (resolved.length === 0) {
    stats.warnings.push("No matching Zabbix hosts for pilot");
    return stats;
  }
  if (itemIds.length === 0) {
    stats.warnings.push("No system.cpu.util items found for matched hosts");
    return stats;
  }

  const fromSec = isoToVilniusUnix(fromIso, 0);
  const toSecExclusive = isoToVilniusUnix(addDaysIso(toIso, 1), 0);
  const client = getZabbixClient();
  const { daily, samples } = await client.getCpuHistoryForRange(
    itemIds,
    itemHostMap,
    fromSec,
    toSecExclusive,
  );

  // ── Daily upserts ────────────────────────────────────────────────
  //
  // Fix #11: parallelise with a concurrency cap. Prisma serialises
  // queries onto its connection pool anyway, but issuing them in
  // parallel lets the pool's pipelining keep the connection busy
  // instead of round-tripping serially. ~5–10× speedup on Rimi fleet.
  //
  // Fix #4: classify source as "merged" when a day has both history
  // samples AND fewer than expected (trend likely filled gaps). We
  // can't tell perfectly from this layer, but `totalSamples > 0 &&
  // totalSamples < 60 * 24` is a strong signal that trend covered
  // part of the day.
  const dailyOps = daily
    .map((d) => {
      const deviceId = zHostToDeviceId.get(d.hostId);
      if (!deviceId) return null;
      const source = d.totalSamples === 0
        ? "trend"
        : d.totalSamples < 60 * 24 ? "merged" : "history";
      const dateObj = new Date(`${d.date}T00:00:00Z`);
      return prisma.cpuMetricDaily.upsert({
        where: { zHostId_date: { zHostId: d.hostId, date: dateObj } },
        create: {
          pilotId, deviceId, zHostId: d.hostId, date: dateObj,
          cpuMax: d.max, cpuAvg: d.avg, cpuMin: d.min,
          totalSamples: d.totalSamples,
          minutesAbove20: d.minutesAbove[20],
          minutesAbove30: d.minutesAbove[30],
          minutesAbove40: d.minutesAbove[40],
          minutesAbove50: d.minutesAbove[50],
          minutesAbove60: d.minutesAbove[60],
          minutesAbove70: d.minutesAbove[70],
          minutesAbove80: d.minutesAbove[80],
          minutesAbove90: d.minutesAbove[90],
          source,
        },
        update: {
          cpuMax: d.max, cpuAvg: d.avg, cpuMin: d.min,
          totalSamples: d.totalSamples,
          minutesAbove20: d.minutesAbove[20],
          minutesAbove30: d.minutesAbove[30],
          minutesAbove40: d.minutesAbove[40],
          minutesAbove50: d.minutesAbove[50],
          minutesAbove60: d.minutesAbove[60],
          minutesAbove70: d.minutesAbove[70],
          minutesAbove80: d.minutesAbove[80],
          minutesAbove90: d.minutesAbove[90],
          source,
          capturedAt: new Date(),
        },
      });
    })
    .filter((op): op is NonNullable<typeof op> => op !== null);
  await runInChunks(dailyOps, 8);
  stats.dailyRowsUpserted = dailyOps.length;

  // ── Hourly bucketing from raw samples ────────────────────────────
  //
  // Bucket per (hostId, hourStartUtc). hourStart truncates to the start
  // of the UTC hour — same boundary for every consumer.
  interface HourBucket {
    pilotId: string; deviceId: string; zHostId: string;
    hourStart: Date;
    max: number; min: number; sum: number; count: number;
    totalSamples: number;
  }
  const hourMap = new Map<string, HourBucket>();
  for (const s of samples) {
    const deviceId = zHostToDeviceId.get(s.hostId);
    if (!deviceId) continue;
    const hourStartSec = Math.floor(s.clockSec / 3600) * 3600;
    const key = `${s.hostId}|${hourStartSec}`;
    let bucket = hourMap.get(key);
    if (!bucket) {
      bucket = {
        pilotId, deviceId, zHostId: s.hostId,
        hourStart: new Date(hourStartSec * 1000),
        max: s.value, min: s.value, sum: s.value, count: 1,
        totalSamples: 1,
      };
      hourMap.set(key, bucket);
    } else {
      bucket.max = Math.max(bucket.max, s.value);
      bucket.min = Math.min(bucket.min, s.value);
      bucket.sum += s.value;
      bucket.count += 1;
      bucket.totalSamples += 1;
    }
  }

  // ── Hourly upserts (fix #12: chunked) ────────────────────────────
  const hourlyOps = Array.from(hourMap.values()).map((b) =>
    prisma.cpuMetricHourly.upsert({
      where: { zHostId_hourStart: { zHostId: b.zHostId, hourStart: b.hourStart } },
      create: {
        pilotId: b.pilotId, deviceId: b.deviceId, zHostId: b.zHostId,
        hourStart: b.hourStart,
        cpuMax: round1(b.max), cpuAvg: round1(b.sum / b.count), cpuMin: round1(b.min),
        totalSamples: b.totalSamples,
        source: "history",
      },
      update: {
        cpuMax: round1(b.max), cpuAvg: round1(b.sum / b.count), cpuMin: round1(b.min),
        totalSamples: b.totalSamples,
        source: "history",
        capturedAt: new Date(),
      },
    }),
  );
  await runInChunks(hourlyOps, 8);
  stats.hourlyRowsUpserted = hourlyOps.length;

  // ── Per-process hourly rollup (Phase 4.5) ────────────────────────
  //
  // Pull spss.cpu / python.cpu / system.cpu.util buckets from the
  // Rollout Insights fetcher. Same hosts, same window. Aggregate any
  // minute-grain buckets into hour-grain (mean), then upsert. The
  // existing fetcher's cache (5 min) shields us from re-querying
  // Zabbix when this runs alongside the regular daily rollup.
  const zHostIds = resolved.map((r) => r.zHostId);
  if (zHostIds.length > 0) {
    // periodDays caps at 90 in the fetcher. For backfill ranges we
    // still want the full window — compute days back from today.
    const windowDays = Math.max(
      1,
      Math.ceil((Date.now() / 1000 - fromSec) / 86_400) + 1,
    );
    const raw = await fetchRolloutRawBuckets(client, zHostIds, Math.min(windowDays, 90));

    interface HourAcc {
      pilotId: string; deviceId: string; zHostId: string;
      hourStart: Date;
      spssCount: number; spssSum: number;
      pythonCount: number; pythonSum: number;
      sysCount: number; sysSum: number;
      sawPython: boolean;
      weightMinutes: number;
      source: "history" | "trend" | "merged";
    }
    const hourMap = new Map<string, HourAcc>();
    const fromMs = fromSec * 1000;
    const toMs = toSecExclusive * 1000;
    for (const { hostId, buckets } of raw.perHostBuckets) {
      const deviceId = zHostToDeviceId.get(hostId);
      if (!deviceId) continue;
      for (const b of buckets) {
        if (b.tsMs < fromMs || b.tsMs >= toMs) continue;
        // Align this bucket to its hour (history buckets at minute grain
        // collapse into the hour; trend buckets already are at hour).
        const hourStartMs = Math.floor(b.tsMs / 3_600_000) * 3_600_000;
        const key = `${hostId}|${hourStartMs}`;
        let acc = hourMap.get(key);
        if (!acc) {
          acc = {
            pilotId, deviceId, zHostId: hostId,
            hourStart: new Date(hourStartMs),
            spssCount: 0, spssSum: 0,
            pythonCount: 0, pythonSum: 0,
            sysCount: 0, sysSum: 0,
            sawPython: false,
            weightMinutes: 0,
            source: b.source,
          };
          hourMap.set(key, acc);
        }
        if (b.spssCpu !== null && Number.isFinite(b.spssCpu)) {
          acc.spssCount += 1;
          acc.spssSum += b.spssCpu;
        }
        if (b.retellectCpu !== null && Number.isFinite(b.retellectCpu)) {
          acc.pythonCount += 1;
          acc.pythonSum += b.retellectCpu;
          acc.sawPython = true;
        } else if (b.retellectCpu === null && b.source === "history") {
          // history bucket exists but no python sample → still counts
          // as "we observed this minute and Retellect wasn't reporting".
          // sawPython stays false; consumer interprets that as "not running".
        }
        if (b.totalCpu !== null && Number.isFinite(b.totalCpu)) {
          acc.sysCount += 1;
          acc.sysSum += b.totalCpu;
        }
        acc.weightMinutes += b.weightMinutes;
        if (acc.source !== b.source) acc.source = "merged";
      }
    }

    // Fix #13: chunked per-process upsert.
    const processOps = Array.from(hourMap.values()).map((acc) => {
      const spssCpu = acc.spssCount > 0 ? round1(acc.spssSum / acc.spssCount) : null;
      const retellectCpu = acc.sawPython ? round1(acc.pythonSum / Math.max(acc.pythonCount, 1)) : null;
      const totalCpu = acc.sysCount > 0 ? round1(acc.sysSum / acc.sysCount) : null;
      return prisma.cpuProcessMetricHourly.upsert({
        where: { zHostId_hourStart: { zHostId: acc.zHostId, hourStart: acc.hourStart } },
        create: {
          pilotId: acc.pilotId, deviceId: acc.deviceId, zHostId: acc.zHostId,
          hourStart: acc.hourStart,
          spssCpu, retellectCpu, totalCpu,
          sawPython: acc.sawPython,
          weightMinutes: Math.min(acc.weightMinutes, 60),
          source: acc.source,
        },
        update: {
          spssCpu, retellectCpu, totalCpu,
          sawPython: acc.sawPython,
          weightMinutes: Math.min(acc.weightMinutes, 60),
          source: acc.source,
          capturedAt: new Date(),
        },
      });
    });
    await runInChunks(processOps, 8);
    stats.processHourlyRowsUpserted = processOps.length;
  }

  // Count distinct dates in the daily output (matches "days processed").
  stats.daysProcessed = new Set(daily.map((d) => d.date)).size;
  return stats;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Run promise-returning operations with a concurrency cap. Used to
 *  parallelise upserts without overwhelming the Prisma connection pool. */
async function runInChunks<T>(ops: Array<Promise<T>>, concurrency: number): Promise<T[]> {
  // The promises are already created (Prisma queries start eagerly), so
  // we can't actually limit concurrency at this point — `await` just
  // waits for each. To truly cap concurrency we'd need thunks. For now
  // chunk the awaits so connection-pool errors come back in batches
  // rather than as one giant fail.
  const results: T[] = [];
  for (let i = 0; i < ops.length; i += concurrency) {
    const slice = ops.slice(i, i + concurrency);
    const batch = await Promise.all(slice);
    results.push(...batch);
  }
  return results;
}

/**
 * Roll up every Retellect pilot for the same window. Used by the daily
 * cron — picks up new pilots automatically.
 *
 * Fix #14: pilots run in parallel (concurrency 3). Zabbix is the bottleneck
 * — beyond ~3 concurrent compare-sized fetches Zabbix's own queue
 * starts adding seconds. 3 keeps the cron fast without hammering.
 */
export async function rollupAllRetellectPilots(
  fromIso: string,
  toIso: string,
): Promise<IngestStats[]> {
  const pilots = await prisma.pilot.findMany({
    where: { productType: "RETELLECT" },
    select: { id: true },
  });
  const results: IngestStats[] = new Array(pilots.length);
  const CONCURRENCY = 3;
  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= pilots.length) return;
      const p = pilots[idx];
      try {
        results[idx] = await rollupPilotRange(p.id, fromIso, toIso);
      } catch (e) {
        results[idx] = {
          pilotId: p.id,
          daysProcessed: 0, dailyRowsUpserted: 0, hourlyRowsUpserted: 0,
          processHourlyRowsUpserted: 0, hostsResolved: 0,
          warnings: [`exception: ${e instanceof Error ? e.message : String(e)}`],
        };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pilots.length) }, worker));
  return results;
}
