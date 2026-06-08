/**
 * Retellect Configuration Tracking — builder.
 *
 * `buildConfigTracking()` is the single adapter seam between the page and
 * the data source. TODAY it returns DETERMINISTIC DERIVED placeholders
 * (seeded per host, stable across reloads) because the real per-host
 * configuration items — Retellect version, SCO version, resolution, frame
 * rate, … — are not yet ingested into Zabbix. `retellectEnabled` and
 * `cpuModel` come from real device data; everything else is a stand-in.
 *
 * When the daily configuration-snapshot ingestion (RT-CFG) lands, replace
 * the body of this function with reads from the snapshot table / Zabbix
 * config items and flip `dataMode` to "live". The page consumes only the
 * typed {@link ConfigTrackingData} output, so the UI does not change.
 *
 * Determinism matters: the same host always yields the same current values
 * and the same change history, so the page is stable to look at and the
 * unit tests can assert exact counts.
 */
import {
  CONFIG_PARAMS,
  HIGH_PRIORITY_PARAMS,
  type ConfigChange,
  type ConfigParamKey,
  type ConfigTrackingData,
  type HostConfig,
  type ConfigKpis,
} from "./types";

/** Minimal device shape the builder needs (subset of RtPilotData.devices). */
export interface ConfigDeviceInput {
  id: string;
  name: string;
  storeName: string;
  cpuModel: string;
  country: string | null;
  retellectEnabled: boolean;
}

const VALUE_POOLS: Record<Exclude<ConfigParamKey, "retellectEnabled">, string[]> = {
  // Ordered worst→best for resolution so the "downgrade" diff reads naturally.
  resolution: ["480p", "720p", "1080p"],
  frameRate: ["5 fps", "8 fps", "10 fps", "15 fps"],
  retellectVersion: ["v1.14", "v1.15", "v1.16"],
  scoVersion: ["7.2.3", "7.2.4", "7.3.1"],
  inferenceMode: ["lite", "standard", "high-accuracy"],
  captureMode: ["triggered", "continuous"],
  cameraSource: ["USB Cam 1", "USB Cam 2", "IP Cam"],
};

// Probability a given parameter has changed at least once in the 90d
// horizon. High-priority params are intentionally a bit more volatile so
// the headline KPIs have signal; low-priority ones rarely move.
const CHANGE_PROB: Record<ConfigParamKey, number> = {
  resolution: 0.16,
  retellectVersion: 0.22,
  scoVersion: 0.2,
  frameRate: 0.14,
  inferenceMode: 0.08,
  captureMode: 0.06,
  cameraSource: 0.05,
  retellectEnabled: 0, // treated as derived-real; no synthetic history
};

const HORIZON_DAYS = 90;

/** Tiny deterministic string hash → 31-bit seed. */
function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 0x7fffffff || 1;
}

function makeRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

/**
 * Build the change chain for one parameter: a sequence of distinct values
 * with ascending dates, ending at the CURRENT value. Returns the current
 * value plus the change events (before/after pairs). Guarantees the most
 * recent change's `after` equals the current value, so the snapshot and
 * the timeline never contradict each other.
 */
function buildParamHistory(
  rng: () => number,
  hostId: string,
  key: Exclude<ConfigParamKey, "retellectEnabled">,
  nowMs: number,
): { current: string; lastChanged: string | null; changes: ConfigChange[] } {
  const pool = VALUE_POOLS[key];
  const def = CONFIG_PARAMS.find((p) => p.key === key)!;
  const changes: ConfigChange[] = [];

  const willChange = rng() < CHANGE_PROB[key];
  if (!willChange) {
    return { current: pick(rng, pool), lastChanged: null, changes: [] };
  }

  // 1 change usually, occasionally 2.
  const nChanges = rng() < 0.78 ? 1 : 2;
  // Distinct day offsets (days ago), newest is the smaller offset.
  const offsets: number[] = [];
  for (let i = 0; i < nChanges; i++) {
    offsets.push(1 + Math.floor(rng() * (HORIZON_DAYS - 2)));
  }
  offsets.sort((a, b) => b - a); // oldest first

  // Value chain: nChanges+1 values, consecutive distinct.
  const values: string[] = [pick(rng, pool)];
  for (let i = 0; i < nChanges; i++) {
    let next = pick(rng, pool);
    let guard = 0;
    while (next === values[values.length - 1] && guard++ < 8) next = pick(rng, pool);
    values.push(next);
  }

  for (let i = 0; i < nChanges; i++) {
    const date = fmtDate(nowMs - offsets[i] * 86400000);
    changes.push({
      hostId,
      date,
      param: key,
      paramLabel: def.label,
      before: values[i],
      after: values[i + 1],
      highPriority: def.highPriority,
    });
  }
  // Newest first.
  changes.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return {
    current: values[values.length - 1],
    lastChanged: changes[0]?.date ?? null,
    changes,
  };
}

/**
 * Build the full configuration-tracking dataset for a set of devices.
 *
 * @param devices  real device rows (cpuModel/retellectEnabled are honoured)
 * @param windowDays  selected change window (7 / 30 / 90)
 * @param nowMs  reference "now" (injectable for tests); defaults to Date.now()
 */
export function buildConfigTracking(
  devices: ConfigDeviceInput[],
  windowDays: number,
  nowMs: number = Date.now(),
): ConfigTrackingData {
  const windowCutoff = fmtDate(nowMs - windowDays * 86400000);
  const hosts: HostConfig[] = [];

  for (const dev of devices) {
    const rng = makeRng(hashSeed(`${dev.id}|${dev.name}`));

    // ~8% of hosts have no recent snapshot → configuration is invisible.
    const stale = rng() < 0.08;

    const params = {} as Record<ConfigParamKey, string>;
    const paramLastChanged: Partial<Record<ConfigParamKey, string>> = {};
    let allChanges: ConfigChange[] = [];

    if (stale) {
      // No visibility: high-priority params read "unknown", history blank.
      for (const def of CONFIG_PARAMS) params[def.key] = "unknown";
      params.retellectEnabled = dev.retellectEnabled ? "true" : "false";
    } else {
      for (const def of CONFIG_PARAMS) {
        if (def.key === "retellectEnabled") {
          // Derived from real device data — no synthetic change history.
          params.retellectEnabled = dev.retellectEnabled ? "true" : "false";
          continue;
        }
        const h = buildParamHistory(rng, dev.id, def.key, nowMs);
        params[def.key] = h.current;
        if (h.lastChanged) paramLastChanged[def.key] = h.lastChanged;
        allChanges = allChanges.concat(h.changes);
      }
      allChanges.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    }

    const snapshotAgeDays = stale ? 4 + Math.floor(rng() * 30) : rng() < 0.5 ? 0 : 1;

    // Window-scoped flags.
    const inWindow = allChanges.filter((c) => c.date >= windowCutoff);
    const changedParams = new Set(inWindow.map((c) => c.param));
    const resolutionChanged = changedParams.has("resolution");
    const versionChanged = changedParams.has("retellectVersion") || changedParams.has("scoVersion");
    const highPriorityChange = HIGH_PRIORITY_PARAMS.some((k) => changedParams.has(k));

    hosts.push({
      hostId: dev.id,
      hostName: dev.name,
      storeName: dev.storeName,
      cpuModel: dev.cpuModel,
      country: dev.country,
      params,
      paramLastChanged,
      changes: allChanges,
      changedParamCount: changedParams.size,
      lastConfigChange: inWindow[0]?.date ?? null,
      highPriorityChange,
      resolutionChanged,
      versionChanged,
      snapshotFresh: !stale,
      snapshotAgeDays,
    });
  }

  // Default sort: high-priority changes first → newest change → stale last.
  hosts.sort((a, b) => compareHostConfig(a, b));

  const kpis = computeKpis(hosts);
  const retellectVersions = distinctSorted(hosts.map((h) => h.params.retellectVersion).filter((v) => v !== "unknown"));
  const scoVersions = distinctSorted(hosts.map((h) => h.params.scoVersion).filter((v) => v !== "unknown"));
  const cpuModels = distinctSorted(hosts.map((h) => h.cpuModel).filter(Boolean));

  return {
    hosts,
    kpis,
    windowDays,
    dataMode: "derived",
    retellectVersions,
    scoVersions,
    cpuModels,
  };
}

/** Primary sort: high-priority changes first, then most-recent change,
 *  then missing-snapshot hosts sink to the bottom. Stable tiebreak on
 *  host name so order is deterministic across renders. */
export function compareHostConfig(a: HostConfig, b: HostConfig): number {
  // Missing-snapshot hosts always sink (they have no actionable change).
  if (a.snapshotFresh !== b.snapshotFresh) return a.snapshotFresh ? -1 : 1;
  if (a.highPriorityChange !== b.highPriorityChange) return a.highPriorityChange ? -1 : 1;
  const ad = a.lastConfigChange ?? "";
  const bd = b.lastConfigChange ?? "";
  if (ad !== bd) return ad < bd ? 1 : -1; // newer date first
  if (a.changedParamCount !== b.changedParamCount) return b.changedParamCount - a.changedParamCount;
  return a.hostName.localeCompare(b.hostName, undefined, { numeric: true });
}

export function computeKpis(hosts: HostConfig[]): ConfigKpis {
  const trackedHosts = hosts.length;
  const highPriorityChanges = hosts.filter((h) => h.snapshotFresh && h.highPriorityChange).length;
  const resolutionChanges = hosts.filter((h) => h.snapshotFresh && h.resolutionChanged).length;
  const versionChanges = hosts.filter((h) => h.snapshotFresh && h.versionChanged).length;
  const missingSnapshot = hosts.filter((h) => !h.snapshotFresh).length;
  const pctHighPriority = trackedHosts > 0 ? Math.round((highPriorityChanges / trackedHosts) * 1000) / 10 : 0;
  return { highPriorityChanges, resolutionChanges, versionChanges, missingSnapshot, trackedHosts, pctHighPriority };
}

function distinctSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
