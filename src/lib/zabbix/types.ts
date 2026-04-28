/**
 * Zabbix API type definitions.
 *
 * These types will be expanded as the Zabbix integration is built out.
 * For now they serve as documentation of the data structures we expect.
 */

/** Zabbix host object (simplified) */
export interface ZabbixHost {
  hostid: string;
  host: string;
  name: string;
  status: number; // 0 = monitored, 1 = unmonitored
  /** Optional: resolved hardware inventory (RT-CPUMODEL phase 1) */
  inventory?: HostInventory | null;
}

/**
 * Hardware inventory derived from Zabbix `host.get` `selectInventory` output.
 *
 * Zabbix's inventory subsystem is opt-in per host (`inventory_mode`):
 *   -1 → DISABLED  → API returns an empty array, all fields read as null here
 *    0 → MANUAL    → admin filled fields by hand
 *    1 → AUTOMATIC → discovery rules populate fields from system items
 *
 * The Rimi deployment currently has most hosts at `inventory_mode = -1`, which
 * is why `cpuModel` etc. arrive as null until SP admin enables inventory mode
 * (RT-CPUMODEL phase 2). We surface whatever IS populated as a runtime fallback
 * for the Host Inventory and CPU Threshold Timeline tabs.
 *
 * `cpuModel`: prefer `inventory.hardware_full` over `inventory.hardware`
 *   (the "_full" field is a longer human-readable string when both exist).
 * `os`:       prefer `inventory.os_full` over `inventory.os` (same rule).
 * `ramBytes`: Zabbix inventory does not have a dedicated RAM field — leave
 *   null and rely on the existing live `vm.memory.size[total]` item already
 *   plumbed via HostResources.memory.total.
 */
export interface HostInventory {
  cpuModel: string | null;
  ramBytes: number | null;
  os: string | null;
}

/** Zabbix problem object (simplified) */
export interface ZabbixProblem {
  eventid: string;
  objectid: string;
  name: string;
  severity: number; // 0-5: not classified, information, warning, average, high, disaster
  clock: string; // unix timestamp
  r_eventid: string; // recovery event ID (empty if unresolved)
}

/** Zabbix event object (simplified) */
export interface ZabbixEvent {
  eventid: string;
  source: number;
  object: number;
  objectid: string;
  clock: string;
  name: string;
  severity: number;
}

/** Zabbix trigger object (simplified) */
export interface ZabbixTrigger {
  triggerid: string;
  description: string;
  priority: number;
  status: number;
  value: number; // 0 = OK, 1 = PROBLEM
}

/** Resource metrics for a single host */
export interface HostResources {
  hostId: string;
  hostName: string;
  status: "up" | "down";
  cpu: { utilization: number; load: number; itemId: string; valueType: string } | null;
  memory: { utilization: number; available: number; total: number; itemId: string; valueType: string } | null;
  disk: { utilization: number; path: string; itemId: string; valueType: string } | null;
  network: { inBps: number; outBps: number; inItemId: string; outItemId: string; valueType: string } | null;
  /**
   * Hardware inventory carried over from `host.get` (RT-CPUMODEL phase 1).
   * `null` when the host has `inventory_mode = -1` or when none of the
   * requested inventory fields are populated.
   */
  inventory: HostInventory | null;
  items: any[];
}

/**
 * Classification of a process CPU metric. Reflects Retellect pilot domain:
 * - retellect: python, python1..N — all Retellect workers
 * - sco:       spss / sp.sss — StrongPoint SCO application
 * - db:        sqlservr / sql — local SQL database
 * - hw:        cs300sd / NHSTW32 / udm / UDMServer — peripheral drivers (scanner, UDM, etc.)
 * - sys:       vmware-vmx / vm — virtualization
 * - other:     anything else captured by the ".cpu" custom metric convention
 */
export type ProcessCategory = "retellect" | "sco" | "db" | "hw" | "sys" | "other";

/**
 * A per-process CPU % reading fetched from Zabbix custom "<proc>.cpu" items.
 * These are 1-minute averages collected by the Zabbix agent on each SCO host.
 */
export interface ProcessCpuItem {
  itemId: string;
  hostId: string;
  /** Human-friendly display name from Zabbix (e.g. "Python CPU usage") */
  name: string;
  /** Raw Zabbix key (e.g. "python1.cpu") */
  key: string;
  /** Short process identifier parsed from the key (e.g. "python1", "spss") */
  procName: string;
  /** Domain classification — drives Retellect vs. SCO vs. other breakdown */
  category: ProcessCategory;
  /** Last reported CPU %, or 0 if unavailable */
  cpuValue: number;
  /** Unix timestamp (seconds) of the last reported value; 0 if never */
  lastClock: number;
  units: string;
}
