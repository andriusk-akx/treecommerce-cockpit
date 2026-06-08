/**
 * Retellect Configuration Tracking — domain types.
 *
 * PARAMETER-LEVEL model (NOT "config profiles"). Each host carries an
 * independent set of parameters; any single one can change on its own date.
 *
 * Data source is REAL: three Zabbix log-monitoring items the StrongPoint
 * admin configured on the Rimi SCO hosts —
 *   • `log[…server.log,"config.ini",…]`  → the Retellect server config dump
 *     (resolution = video1.capture_width×height, camera index, model.version,
 *     inference backend, …). See `parse.ts`.
 *   • `log[…server.log,"Starting server",…]` → Retellect server version (e.g. "1.68")
 *   • `log[E:\logs\spsss\app.log,"DEBUG.*evtAppStart",…]` → SCO/SPSSS version (e.g. "26.05.00")
 *
 * Coverage is genuinely partial today (only a subset of hosts have a parsed
 * config.ini snapshot), which is exactly what the "Missing latest snapshot"
 * KPI surfaces. Change history is derived by diffing each item's `history.get`
 * snapshots, so a host with a steady config shows an empty timeline — honest.
 */

/** Tracked parameters. resolution / retellectVersion / scoVersion are the
 *  high-priority trio. The rest are surfaced for operational context. */
export type ConfigParamKey =
  | "resolution"
  | "cameraSource"
  | "retellectVersion"
  | "scoVersion"
  | "modelVersion"
  | "inferenceBackend"
  | "onnxProviders"
  | "enablePrediction"
  | "numberOfResults";

export interface ConfigParamDef {
  key: ConfigParamKey;
  label: string;
  /** High-priority params drive the headline KPI: resolution + both versions. */
  highPriority: boolean;
}

/** Canonical parameter list — also the render order in the detail view. */
export const CONFIG_PARAMS: ConfigParamDef[] = [
  { key: "resolution", label: "Resolution", highPriority: true },
  { key: "retellectVersion", label: "Retellect version", highPriority: true },
  { key: "scoVersion", label: "SCO version", highPriority: true },
  { key: "modelVersion", label: "Model version", highPriority: false },
  { key: "inferenceBackend", label: "Inference backend", highPriority: false },
  { key: "onnxProviders", label: "ONNX providers", highPriority: false },
  { key: "cameraSource", label: "Camera source", highPriority: false },
  { key: "enablePrediction", label: "Prediction enabled", highPriority: false },
  { key: "numberOfResults", label: "Results returned", highPriority: false },
];

export const HIGH_PRIORITY_PARAMS: ConfigParamKey[] = CONFIG_PARAMS
  .filter((p) => p.highPriority)
  .map((p) => p.key);

/** A single parameter-level change event. Carries enough identity
 *  (`hostId`, `param`, `date`) to later deep-link into before/after CPU
 *  impact analysis — not implemented yet, but the seam is here. */
export interface ConfigChange {
  hostId: string;
  /** ISO date "YYYY-MM-DD" (Vilnius-local day the change was observed). */
  date: string;
  /** Unix milliseconds of the change — the precise sort key (the day
   *  string alone can't order two changes on the same calendar day). */
  clock: number;
  param: ConfigParamKey;
  paramLabel: string;
  before: string;
  after: string;
  highPriority: boolean;
}

export interface HostConfig {
  hostId: string;
  hostName: string;
  storeName: string;
  cpuModel: string;
  country: string | null;
  /** Current value of every tracked parameter. "unknown" when not present
   *  in the host's latest snapshot. */
  params: Record<ConfigParamKey, string>;
  /** Per-parameter last-changed date (YYYY-MM-DD), or absent if unchanged
   *  within the history horizon. */
  paramLastChanged: Partial<Record<ConfigParamKey, string>>;
  /** Lower-priority detector / synthetic settings parsed from config.ini,
   *  shown only in the host detail "Advanced" block. */
  extras: { label: string; value: string }[];
  /** Full change history (newest first) across the fetched horizon. */
  changes: ConfigChange[];

  // ── Derived flags for the SELECTED window ──
  changedParamCount: number;
  lastConfigChange: string | null;
  highPriorityChange: boolean;
  resolutionChanged: boolean;
  versionChanged: boolean;

  // ── Snapshot freshness (visibility gap signal) ──
  /** False = no recent configuration snapshot (config.ini) for this host. */
  snapshotFresh: boolean;
  /** Age of the latest snapshot in days, or null when never seen. */
  snapshotAgeDays: number | null;
}

export interface ConfigKpis {
  highPriorityChanges: number;
  resolutionChanges: number;
  versionChanges: number;
  missingSnapshot: number;
  trackedHosts: number;
  pctHighPriority: number;
}

export interface ConfigTrackingData {
  hosts: HostConfig[];
  kpis: ConfigKpis;
  windowDays: number;
  /** "live" once fed from real Zabbix items; "derived" only for fixtures. */
  dataMode: "live" | "derived";
  /** Freshness of the underlying Zabbix fetch (mirrors the rest of the app). */
  sourceStatus: "live" | "cached" | "unavailable";
  /** Hosts that have a config.ini snapshot at all (for the coverage line). */
  hostsWithSnapshot: number;
  retellectVersions: string[];
  scoVersions: string[];
  cpuModels: string[];
}
