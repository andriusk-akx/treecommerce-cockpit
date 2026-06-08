/**
 * Retellect Configuration Tracking — builder (REAL data).
 *
 * Assembles the per-host configuration state + parameter-level change
 * timeline from the raw Zabbix log items fetched by
 * `src/lib/zabbix/config.ts`, parsed via `./parse.ts`.
 *
 * Change detection: each item's `history.get` snapshots are walked in
 * chronological order; a {@link ConfigChange} is emitted only when a tracked
 * field's value actually differs from the previous snapshot (config re-logs
 * on every restart, so most consecutive snapshots are identical and produce
 * nothing — a steady host has an empty timeline, which is the truth).
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
import { parseConfigIni, parseVersion } from "./parse";
import type { RawHostConfig } from "@/lib/zabbix/config";

/** Device shape the builder needs (subset of RtPilotData.devices). */
export interface ConfigDeviceInput {
  id: string;
  name: string;
  sourceHostKey: string | null;
  storeName: string;
  cpuModel: string;
  country: string | null;
  retellectEnabled: boolean;
}

/** A host is considered to have a current snapshot if its config.ini was
 *  seen within this many days. Hosts beyond it (or with no config.ini at
 *  all) feed the "Missing latest snapshot" KPI. */
const STALE_DAYS = 7;

const PARAM_LABEL = new Map(CONFIG_PARAMS.map((p) => [p.key, p.label] as const));
const PARAM_HP = new Map(CONFIG_PARAMS.map((p) => [p.key, p.highPriority] as const));

/** Vilnius-local "YYYY-MM-DD" — matches the day boundaries used across the app. */
const vilniusDayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Vilnius",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
function fmtDay(ms: number): string {
  return vilniusDayFmt.format(new Date(ms));
}

/** Whole-calendar-day difference between two instants, in Vilnius-local
 *  days — matches the day semantics used for change dates and STALE_DAYS
 *  (an elapsed-seconds floor was off by one near midnight / DST). */
function vilniusDayDiff(laterMs: number, earlierMs: number): number {
  return Math.round((Date.parse(fmtDay(laterMs)) - Date.parse(fmtDay(earlierMs))) / 86400000);
}

/** Tracked params that come from config.ini (versions are handled separately). */
const INI_PARAMS: ConfigParamKey[] = [
  "resolution",
  "cameraSource",
  "modelVersion",
  "inferenceBackend",
  "onnxProviders",
  "enablePrediction",
  "numberOfResults",
];

/** Emit a change event when `cur` differs from `prev` (both defined). */
function pushChange(
  out: ConfigChange[],
  hostId: string,
  param: ConfigParamKey,
  prev: string | undefined,
  cur: string | undefined,
  dateMs: number,
) {
  if (prev === undefined || cur === undefined) return;
  if (prev === cur) return;
  out.push({
    hostId,
    date: fmtDay(dateMs),
    clock: dateMs,
    param,
    paramLabel: PARAM_LABEL.get(param) ?? param,
    before: prev,
    after: cur,
    highPriority: PARAM_HP.get(param) ?? false,
  });
}

function detectChanges(hostId: string, raw: RawHostConfig): ConfigChange[] {
  const changes: ConfigChange[] = [];

  // config.ini-derived params.
  let prevIni: Partial<Record<ConfigParamKey, string>> = {};
  let first = true;
  for (const snap of raw.configIniHistory) {
    const { params } = parseConfigIni(snap.value);
    if (!first) {
      for (const key of INI_PARAMS) pushChange(changes, hostId, key, prevIni[key], params[key], snap.clock * 1000);
    }
    // Carry forward last-known values so a snapshot missing a field doesn't
    // register a phantom change.
    prevIni = { ...prevIni, ...params };
    first = false;
  }

  // Version params.
  const walkVersion = (key: ConfigParamKey, hist: RawHostConfig["rtVersionHistory"]) => {
    let prev: string | undefined;
    let firstV = true;
    for (const snap of hist) {
      const v = parseVersion(snap.value) ?? undefined;
      if (v === undefined) continue;
      if (!firstV) pushChange(changes, hostId, key, prev, v, snap.clock * 1000);
      prev = v;
      firstV = false;
    }
  };
  walkVersion("retellectVersion", raw.rtVersionHistory);
  walkVersion("scoVersion", raw.scoVersionHistory);

  // Newest first by precise clock (not the day string) so same-day changes
  // — and ini-walk vs version-walk events — order by real time, which is
  // what `paramLastChanged` / `lastConfigChange` rely on.
  changes.sort((a, b) => b.clock - a.clock);
  return changes;
}

function unknownParams(): Record<ConfigParamKey, string> {
  const p = {} as Record<ConfigParamKey, string>;
  for (const def of CONFIG_PARAMS) p[def.key] = "unknown";
  return p;
}

/**
 * Build the configuration-tracking dataset.
 *
 * @param devices  pilot devices (joined to Zabbix config by name / sourceHostKey)
 * @param byHostName  raw config items keyed by Zabbix host name
 * @param windowDays  selected change window (7 / 30 / 90)
 * @param sourceStatus  freshness of the underlying Zabbix fetch
 * @param nowMs  reference "now" (injectable for tests)
 */
export function buildConfigTracking(
  devices: ConfigDeviceInput[],
  byHostName: Map<string, RawHostConfig>,
  windowDays: number,
  sourceStatus: "live" | "cached" | "unavailable" = "live",
  nowMs: number = Date.now(),
): ConfigTrackingData {
  const windowCutoff = fmtDay(nowMs - windowDays * 86400000);
  const hosts: HostConfig[] = [];

  for (const dev of devices) {
    const raw = byHostName.get(dev.sourceHostKey || "") ?? byHostName.get(dev.name) ?? null;

    const params = unknownParams();
    const paramLastChanged: Partial<Record<ConfigParamKey, string>> = {};
    let extras: { label: string; value: string }[] = [];
    let changes: ConfigChange[] = [];
    let snapshotAgeDays: number | null = null;
    let hasIniSnapshot = false;

    if (raw) {
      if (raw.configIni) {
        const parsed = parseConfigIni(raw.configIni.value);
        for (const key of INI_PARAMS) if (parsed.params[key] !== undefined) params[key] = parsed.params[key]!;
        extras = parsed.extras;
        snapshotAgeDays = Math.max(0, vilniusDayDiff(nowMs, raw.configIni.clock * 1000));
        hasIniSnapshot = true;
      }
      const rtv = parseVersion(raw.rtVersion?.value);
      if (rtv) params.retellectVersion = rtv;
      const scov = parseVersion(raw.scoVersion?.value);
      if (scov) params.scoVersion = scov;

      changes = detectChanges(dev.id, raw);
      for (const c of changes) {
        if (!(c.param in paramLastChanged)) paramLastChanged[c.param] = c.date; // changes are newest-first
      }
    }

    const snapshotFresh = hasIniSnapshot && snapshotAgeDays !== null && snapshotAgeDays <= STALE_DAYS;

    const inWindow = changes.filter((c) => c.date >= windowCutoff);
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
      extras,
      changes,
      changedParamCount: changedParams.size,
      lastConfigChange: inWindow[0]?.date ?? null,
      highPriorityChange,
      resolutionChanged,
      versionChanged,
      snapshotFresh,
      snapshotAgeDays,
    });
  }

  hosts.sort(compareHostConfig);

  const kpis = computeKpis(hosts);
  const retellectVersions = distinctSorted(hosts.map((h) => h.params.retellectVersion).filter((v) => v !== "unknown"));
  const scoVersions = distinctSorted(hosts.map((h) => h.params.scoVersion).filter((v) => v !== "unknown"));
  const cpuModels = distinctSorted(hosts.map((h) => h.cpuModel).filter((v) => v && v !== "—"));

  return {
    hosts,
    kpis,
    windowDays,
    dataMode: "live",
    sourceStatus,
    hostsWithSnapshot: hosts.filter((h) => h.snapshotFresh).length,
    retellectVersions,
    scoVersions,
    cpuModels,
  };
}

/** Primary sort: fresh+high-priority first → most-recent change → stale last. */
export function compareHostConfig(a: HostConfig, b: HostConfig): number {
  if (a.snapshotFresh !== b.snapshotFresh) return a.snapshotFresh ? -1 : 1;
  if (a.highPriorityChange !== b.highPriorityChange) return a.highPriorityChange ? -1 : 1;
  const ad = a.lastConfigChange ?? "";
  const bd = b.lastConfigChange ?? "";
  if (ad !== bd) return ad < bd ? 1 : -1;
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
