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
  for (const d of daily) {
    const deviceId = zHostToDeviceId.get(d.hostId);
    if (!deviceId) continue;
    const source = d.totalSamples > 0 ? "history" : "trend";
    await prisma.cpuMetricDaily.upsert({
      where: { zHostId_date: { zHostId: d.hostId, date: new Date(`${d.date}T00:00:00Z`) } },
      create: {
        pilotId, deviceId, zHostId: d.hostId,
        date: new Date(`${d.date}T00:00:00Z`),
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
    stats.dailyRowsUpserted += 1;
  }

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

  // ── Hourly upserts ───────────────────────────────────────────────
  for (const b of hourMap.values()) {
    await prisma.cpuMetricHourly.upsert({
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
    });
    stats.hourlyRowsUpserted += 1;
  }

  // Count distinct dates in the daily output (matches "days processed").
  stats.daysProcessed = new Set(daily.map((d) => d.date)).size;
  return stats;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * Roll up every Retellect pilot for the same window. Used by the daily
 * cron — picks up new pilots automatically.
 */
export async function rollupAllRetellectPilots(
  fromIso: string,
  toIso: string,
): Promise<IngestStats[]> {
  const pilots = await prisma.pilot.findMany({
    where: { productType: "RETELLECT" },
    select: { id: true },
  });
  const results: IngestStats[] = [];
  for (const p of pilots) {
    try {
      results.push(await rollupPilotRange(p.id, fromIso, toIso));
    } catch (e) {
      results.push({
        pilotId: p.id,
        daysProcessed: 0, dailyRowsUpserted: 0, hourlyRowsUpserted: 0, hostsResolved: 0,
        warnings: [`exception: ${e instanceof Error ? e.message : String(e)}`],
      });
    }
  }
  return results;
}
