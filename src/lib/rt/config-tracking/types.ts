/**
 * Retellect Configuration Tracking — domain types.
 *
 * This is a PARAMETER-LEVEL model, deliberately NOT a "config profile"
 * model. Each host carries an independent set of parameters; any single
 * parameter (resolution, frame rate, Retellect version, SCO version, …)
 * can change on its own, on its own date. The page tracks current values
 * plus a parameter-by-parameter change history so operators can answer
 * "what is installed now?" and "what changed, where, and when?".
 *
 * Data provenance: until the daily configuration-snapshot ingestion
 * (RT-CFG) lands, `buildConfigTracking()` returns DERIVED placeholder
 * values (deterministic per host) rather than live Zabbix reads. The
 * `dataMode` flag on {@link ConfigTrackingData} surfaces this to the UI so
 * the page can label it honestly. When the real feed ships, only the
 * builder changes — these types and the page stay put.
 */

/** Every tracked parameter. `retellectEnabled` is the only one derivable
 *  from today's real device data; the rest are placeholders until RT-CFG. */
export type ConfigParamKey =
  | "resolution"
  | "frameRate"
  | "retellectVersion"
  | "scoVersion"
  | "inferenceMode"
  | "captureMode"
  | "cameraSource"
  | "retellectEnabled";

export interface ConfigParamDef {
  key: ConfigParamKey;
  label: string;
  /** High-priority params drive the headline KPI: resolution + the two
   *  versions. A change to any of these flags the host for review first. */
  highPriority: boolean;
}

/** Canonical parameter list — also the render order in the detail view. */
export const CONFIG_PARAMS: ConfigParamDef[] = [
  { key: "resolution", label: "Resolution", highPriority: true },
  { key: "frameRate", label: "Frame rate", highPriority: false },
  { key: "retellectVersion", label: "Retellect version", highPriority: true },
  { key: "scoVersion", label: "SCO version", highPriority: true },
  { key: "inferenceMode", label: "Inference mode", highPriority: false },
  { key: "captureMode", label: "Capture mode", highPriority: false },
  { key: "cameraSource", label: "Camera source", highPriority: false },
  { key: "retellectEnabled", label: "Retellect enabled", highPriority: false },
];

export const HIGH_PRIORITY_PARAMS: ConfigParamKey[] = CONFIG_PARAMS
  .filter((p) => p.highPriority)
  .map((p) => p.key);

/** A single parameter-level change event. Carries enough identity
 *  (`hostId`, `param`, `date`) to later deep-link into before/after CPU
 *  impact analysis — not implemented yet, but the seam is here. */
export interface ConfigChange {
  hostId: string;
  /** ISO date "YYYY-MM-DD" (the day the change was first observed). */
  date: string;
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
  /** Current value of every parameter. "unknown" when the host has no
   *  recent snapshot (see `snapshotFresh`). */
  params: Record<ConfigParamKey, string>;
  /** Per-parameter last-changed date (YYYY-MM-DD), or null if it has not
   *  changed within the tracked horizon. */
  paramLastChanged: Partial<Record<ConfigParamKey, string>>;
  /** Full change history (newest first), across the full 90d horizon. The
   *  page filters this to the selected window for counts. */
  changes: ConfigChange[];

  // ── Derived flags for the SELECTED window (set by buildConfigTracking) ──
  /** Distinct params changed within the selected window. */
  changedParamCount: number;
  /** Newest change date within the window, or null. */
  lastConfigChange: string | null;
  /** Resolution / Retellect version / SCO version changed in window. */
  highPriorityChange: boolean;
  resolutionChanged: boolean;
  versionChanged: boolean;

  // ── Snapshot freshness (visibility gap signal) ──
  /** False = no recent configuration snapshot for this host. Drives the
   *  "Missing latest snapshot" KPI and the stale row treatment. */
  snapshotFresh: boolean;
  /** Age of the latest snapshot in days, or null when never seen. */
  snapshotAgeDays: number | null;
}

export interface ConfigKpis {
  /** Hosts where resolution, Retellect version, or SCO version changed. */
  highPriorityChanges: number;
  /** Hosts where resolution changed. */
  resolutionChanges: number;
  /** Hosts where Retellect or SCO version changed. */
  versionChanges: number;
  /** Hosts without a recent configuration snapshot. */
  missingSnapshot: number;
  /** Estate size — shown as a low-weight line, NOT a headline KPI. */
  trackedHosts: number;
  /** highPriorityChanges as a % of trackedHosts (rounded to 1 dp). */
  pctHighPriority: number;
}

export interface ConfigTrackingData {
  hosts: HostConfig[];
  kpis: ConfigKpis;
  /** Selected change window in days (7 / 30 / 90). */
  windowDays: number;
  /** "derived" until the daily snapshot ingestion (RT-CFG) is wired. */
  dataMode: "derived" | "live";
  /** Distinct values present in the estate — populate the filter dropdowns. */
  retellectVersions: string[];
  scoVersions: string[];
  cpuModels: string[];
}
