/**
 * Pure helper functions for RtInventory component.
 * Extracted for unit testing.
 */

export type RtProcessStatus = "running" | "stopped" | "not-installed" | "unknown";

export interface ProcItemInput {
  hostId: string;
  key: string;
  name: string;
  value: number;
}

/** A single Python process CPU item used to judge Retellect liveness */
export interface RetellectProcSample {
  /** Short process name ("python", "python1", ...) */
  procName: string;
  /** Last reported CPU % */
  cpuValue: number;
  /** Unix seconds — 0 if never reported */
  lastClockUnix: number;
}

export interface RtStatusInput {
  retellectEnabled: boolean;
  zabbixHostExists: boolean;
  /**
   * Legacy: retellect proc item found via proc.num[retellect] etc. Still
   * consulted as a fallback, but the Rimi deployment does not publish
   * proc.num items — so in practice only `retellectProcs` drives status.
   */
  procMatch: { count: number } | null;
  /** Python process CPU samples for this host (python.cpu, python1.cpu, ...) */
  retellectProcs?: RetellectProcSample[] | null;
  /** Unix seconds — override for deterministic testing; defaults to Date.now()/1000 */
  nowUnix?: number;
}

export interface RtStatusResult {
  status: RtProcessStatus;
  processCount: number;
  /** Age of the freshest Python sample in seconds, or null if no samples */
  freshestAgeSec: number | null;
  /** Sum of all Python CPU % readings (Retellect contribution to host CPU) */
  retellectCpuTotal: number;
}

/**
 * Seconds: python.cpu is a 1-min average; give a 5-min grace window before flagging stopped.
 *
 * This is the "live" threshold — what the Connection Status header and
 * `determineRtStatus()` use to answer „is this host reporting right now?".
 *
 * On real Rimi Zabbix deployment (observed 2026-04-17), actual item lastClock
 * is routinely 15–60 min old even for items configured with 1-min polling
 * delay. This is an upstream Zabbix agent/proxy lag, not our bug — we keep
 * the 5-min threshold so the counter stays a useful liveness signal rather
 * than masking real reporting gaps.
 */
export const RT_FRESHNESS_THRESHOLD_SEC = 300;

/**
 * Seconds: anything older than this is considered "stale" — value may be shown
 * but visually de-emphasized. Between LIVE and STALE is "recently reported"
 * which we still trust to display.
 */
export const RT_STALE_THRESHOLD_SEC = 30 * 60;

/**
 * Determine Retellect process status for a host.
 *
 * Priority (post-HI-6 — Python telemetry authoritative):
 *  1) `retellectProcs` present with samples → age of freshest sample decides:
 *       < 5 min old  → running  (with processCount = number of python workers)
 *       ≥ 5 min old → stopped  (items configured but process silent)
 *  2) `retellectProcs` present but empty array on a Zabbix host:
 *       → not-installed  (Zabbix does not publish any python.cpu items)
 *  3) Legacy `procMatch` (proc.num[retellect]) — fallback if retellectProcs not supplied.
 *  4) DB `retellectEnabled` without any evidence → unknown (mismatch to flag in UI).
 *
 * The DB `retellectEnabled` flag becomes advisory ("is this host expected to run Retellect?")
 * — it no longer drives status. Real telemetry is the single source of truth.
 */
export function determineRtStatus(input: RtStatusInput): RtStatusResult {
  // Primary signal: Python process telemetry
  if (input.retellectProcs !== undefined && input.retellectProcs !== null) {
    const procs = input.retellectProcs;
    if (procs.length === 0) {
      // No python.cpu items in Zabbix for this host — Retellect not deployed here
      if (input.retellectEnabled && input.zabbixHostExists) {
        // DB says "expected" but telemetry disagrees — surface to the user
        return { status: "unknown", processCount: 0, freshestAgeSec: null, retellectCpuTotal: 0 };
      }
      return { status: "not-installed", processCount: 0, freshestAgeSec: null, retellectCpuTotal: 0 };
    }
    const now = input.nowUnix ?? Math.floor(Date.now() / 1000);
    let youngestClock = 0;
    let cpuSum = 0;
    for (const p of procs) {
      if (p.lastClockUnix > youngestClock) youngestClock = p.lastClockUnix;
      cpuSum += p.cpuValue;
    }
    const freshestAgeSec = youngestClock > 0 ? Math.max(0, now - youngestClock) : null;
    const running = freshestAgeSec !== null && freshestAgeSec < RT_FRESHNESS_THRESHOLD_SEC;
    return {
      status: running ? "running" : "stopped",
      processCount: procs.length,
      freshestAgeSec,
      retellectCpuTotal: Math.round(cpuSum * 10) / 10,
    };
  }

  // Legacy fallback — proc.num[retellect] items (not present in Rimi deployment)
  if (input.procMatch !== null) {
    return {
      status: input.procMatch.count > 0 ? "running" : "stopped",
      processCount: input.procMatch.count,
      freshestAgeSec: null,
      retellectCpuTotal: 0,
    };
  }
  if (input.retellectEnabled) {
    return { status: "unknown", processCount: 0, freshestAgeSec: null, retellectCpuTotal: 0 };
  }
  return { status: "not-installed", processCount: 0, freshestAgeSec: null, retellectCpuTotal: 0 };
}

/** Single row from `zabbix.procCpu` payload (see src/app/retellect/[pilotId]/page.tsx) */
export interface ProcCpuItemInput {
  hostId: string;
  key: string;
  name: string;
  procName: string;
  category: string;
  cpuValue: number;
  lastClockUnix: number;
}

/**
 * Group per-process CPU samples by host id, keeping only Retellect (python) entries.
 * Used to feed `determineRtStatus` and to render the per-host Python drill-down.
 */
export function buildRetellectProcsByHost(
  procCpuItems: ProcCpuItemInput[]
): Map<string, RetellectProcSample[]> {
  const byHost = new Map<string, RetellectProcSample[]>();
  for (const it of procCpuItems) {
    if (it.category !== "retellect") continue;
    const list = byHost.get(it.hostId);
    const sample: RetellectProcSample = {
      procName: it.procName,
      cpuValue: it.cpuValue,
      lastClockUnix: it.lastClockUnix,
    };
    if (list) {
      list.push(sample);
    } else {
      byHost.set(it.hostId, [sample]);
    }
  }
  // Sort each host's process list by procName for stable rendering (python, python1, python2, ...)
  for (const list of byHost.values()) {
    list.sort((a, b) => a.procName.localeCompare(b.procName, undefined, { numeric: true }));
  }
  return byHost;
}

/**
 * Build a map of hostId → retellect process info from Zabbix proc items.
 * Matches items whose key+name contains retellect/rt_agent/rtagent.
 */
export function buildProcByHost(
  procItems: ProcItemInput[]
): Map<string, { count: number; key: string }> {
  const procByHost = new Map<string, { count: number; key: string }>();
  for (const item of procItems) {
    const keyLower = (item.key + " " + item.name).toLowerCase();
    if (
      keyLower.includes("retellect") ||
      keyLower.includes("rt_agent") ||
      keyLower.includes("rtagent")
    ) {
      const existing = procByHost.get(item.hostId);
      if (!existing || item.value > existing.count) {
        procByHost.set(item.hostId, { count: item.value, key: item.key });
      }
    }
  }
  return procByHost;
}

/**
 * Determine if a period string is one of the preset periods.
 */
export const PRESET_PERIOD_IDS = ["1h", "1d", "7d", "14d", "30d", "90d"] as const;
export type PresetPeriodId = (typeof PRESET_PERIOD_IDS)[number];

export function isPresetPeriod(period: string): period is PresetPeriodId {
  return PRESET_PERIOD_IDS.includes(period as PresetPeriodId);
}

/**
 * Resolve period days from a period string.
 * Preset periods map to known day counts; custom periods are parsed as numbers.
 */
const PERIOD_DAYS: Record<string, number> = {
  "1h": 0,
  "1d": 1,
  "7d": 7,
  "14d": 14,
  "30d": 30,
  "90d": 90,
};

export function resolvePeriodDays(period: string): number {
  if (isPresetPeriod(period)) return PERIOD_DAYS[period] ?? 14;
  const parsed = Number(period);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 14;
}

/**
 * Validate and snap custom granularity to nearest valid 1440 divisor.
 */
const VALID_DIVISORS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 16, 18, 20, 24, 30, 36, 40, 45, 48, 60, 72, 80, 90, 120];

export function snapToValidGranularity(minutes: number): number {
  const clamped = Math.max(1, Math.min(120, Math.round(minutes)));
  if (1440 % clamped === 0) return clamped;
  return VALID_DIVISORS.reduce((a, b) =>
    Math.abs(b - clamped) < Math.abs(a - clamped) ? b : a
  );
}

// ─── Pure helpers used by RtInventory presentation layer ────────────────

/**
 * Minimal host-row shape needed for sorting. Intentionally narrower than the
 * full UI HostRow so the sorter stays reusable and trivially testable.
 */
export interface HostSortable {
  name: string;
  store: string;
  cpuModel: string;
  memTotalGb: number;
  rtProcessStatus: RtProcessStatus;
  cpuUser: number;
  cpuSystem: number;
  cpuTotal: number;
}

export type HostSortKey =
  | "name"
  | "store"
  | "cpuModel"
  | "ramGb"
  | "rtStatus"
  | "cpuUser"
  | "cpuSystem"
  | "cpuTotal";

export type HostSortDir = "asc" | "desc";

/** Sort priority for RT status column (running first, not-installed last) */
export const RT_STATUS_SORT_ORDER: Record<RtProcessStatus, number> = {
  running: 0,
  stopped: 1,
  unknown: 2,
  "not-installed": 3,
};

/**
 * Compare two hosts for the Host Inventory table.
 *
 * - Numeric comparisons tolerate NaN/Infinity by coercing to 0 (a Zabbix item
 *   that never reported a value lands at the bottom of a desc-sorted column
 *   rather than breaking Array.sort's contract).
 * - String comparisons use locale-aware natural ordering so "host2" &lt; "host10".
 * - Equal values fall back to a stable tiebreaker on `name` so the order is
 *   deterministic across renders.
 */
export function compareHosts(
  a: HostSortable,
  b: HostSortable,
  key: HostSortKey,
  dir: HostSortDir
): number {
  const sign = dir === "asc" ? 1 : -1;
  const safe = (n: number) => (Number.isFinite(n) ? n : 0);
  let cmp = 0;
  switch (key) {
    case "name":
      cmp = a.name.localeCompare(b.name, undefined, { numeric: true });
      break;
    case "store":
      cmp = a.store.localeCompare(b.store);
      break;
    case "cpuModel":
      cmp = a.cpuModel.localeCompare(b.cpuModel);
      break;
    case "ramGb":
      cmp = safe(a.memTotalGb) - safe(b.memTotalGb);
      break;
    case "rtStatus":
      cmp =
        RT_STATUS_SORT_ORDER[a.rtProcessStatus] -
        RT_STATUS_SORT_ORDER[b.rtProcessStatus];
      break;
    case "cpuUser":
      cmp = safe(a.cpuUser) - safe(b.cpuUser);
      break;
    case "cpuSystem":
      cmp = safe(a.cpuSystem) - safe(b.cpuSystem);
      break;
    case "cpuTotal":
      cmp = safe(a.cpuTotal) - safe(b.cpuTotal);
      break;
  }
  if (cmp === 0) {
    // Tiebreaker is intentionally direction-independent: equal rows always
    // alphabetize ascending so the eye can scan consistently whether the
    // primary column is asc or desc.
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  }
  return sign * cmp;
}

/**
 * Format an age-in-seconds value as a short human string.
 *   < 60s            → "Ns"
 *   60s – 3599s      → "Nm"
 *   3600s – 86399s   → "Nh"
 *   ≥ 86400s         → "Nd"
 * null / NaN / Infinity → "—"
 */
export function formatAgeShort(ageSec: number | null): string {
  if (ageSec === null || !Number.isFinite(ageSec)) return "—";
  if (ageSec < 60) return `${Math.max(0, Math.round(ageSec))}s`;
  if (ageSec < 3600) return `${Math.round(ageSec / 60)}m`;
  if (ageSec < 86400) return `${Math.round(ageSec / 3600)}h`;
  return `${Math.round(ageSec / 86400)}d`;
}

/**
 * Compute the host-level total CPU % shown in the inventory row.
 *
 * Zabbix hosts publish either (a) per-mode items `system.cpu.util[,user]` +
 * `system.cpu.util[,system]` or (b) a single aggregated `system.cpu.util` (or
 * `system.cpu.util[,,avg1]`). We prefer the per-mode breakdown when available
 * so the "user" and "system" columns stay in sync with the total column. Falls
 * back to the aggregated item when neither mode publishes a positive value.
 *
 * Always rounds to 1 decimal; negative/NaN values treated as 0.
 */
export function computeCpuTotal(
  userPct: number,
  systemPct: number,
  fallbackTotal: number
): number {
  const u = Number.isFinite(userPct) && userPct > 0 ? userPct : 0;
  const s = Number.isFinite(systemPct) && systemPct > 0 ? systemPct : 0;
  const combined = u + s;
  if (combined > 0) return Math.round(combined * 10) / 10;
  const fallback =
    Number.isFinite(fallbackTotal) && fallbackTotal > 0 ? fallbackTotal : 0;
  return Math.round(fallback * 10) / 10;
}

// ─── RT-CPUMODEL phase 1: hardware fallback resolution ──────────────────

/**
 * Resolve the CPU model string for a host row, preferring the DB-seeded value
 * but falling back to live Zabbix inventory when the DB column is null/empty.
 *
 * Phase-1 contract:
 *   - DB has a non-empty value          → DB wins (fast, stable, audit trail)
 *   - DB null/empty, inventory present  → inventory.cpuModel wins
 *   - both null/empty                   → returns the supplied placeholder
 *
 * "Empty" here covers: null, undefined, "", "—", "-", and the string "null"
 * (some legacy seed scripts wrote that literal). Phase 2 (RT-CPUMODEL seed
 * update) will backfill `Device.cpuModel` from this same Zabbix source so the
 * fallback path becomes a no-op for the Rimi fleet.
 */
export function resolveCpuModel(
  dbValue: string | null | undefined,
  inventoryValue: string | null | undefined,
  placeholder: string = "—",
): string {
  const clean = (v: string | null | undefined): string | null => {
    if (v === null || v === undefined) return null;
    const t = v.trim();
    if (t === "" || t === "—" || t === "-" || t.toLowerCase() === "null") return null;
    return t;
  };
  return clean(dbValue) ?? clean(inventoryValue) ?? placeholder;
}

/**
 * Same fallback pattern as `resolveCpuModel`, applied to OS strings. Kept as a
 * separate exported helper so callers don't accidentally pass a CPU value to
 * an OS slot — they're identical today but may diverge (e.g. OS could need
 * additional normalisation if Zabbix returns "Microsoft Windows...").
 */
export function resolveOs(
  dbValue: string | null | undefined,
  inventoryValue: string | null | undefined,
  placeholder: string = "—",
): string {
  return resolveCpuModel(dbValue, inventoryValue, placeholder);
}

/** Convert bytes (Zabbix `vm.memory.size[total]`) to GB with safe handling. */
export function bytesToGb(bytes: number | null | undefined): number {
  if (bytes === null || bytes === undefined) return 0;
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return bytes / 1024 / 1024 / 1024;
}

/** Narrow row shape needed to compute dashboard connection header counters. */
export interface ConnectionStatsInput {
  zabbixMatched: boolean;
  /** ISO string of last CPU sample (Zabbix lastclock) */
  lastClock: string | null;
  retellectEnabled: boolean;
  rtProcessStatus: RtProcessStatus;
}

export interface ConnectionStats {
  total: number;
  matched: number;
  reportingCpu: number;
  retellectExpected: number;
  retellectRunning: number;
}

/**
 * Compute dashboard connection-header counters.
 *
 * - `matched`: DB device resolved to a live Zabbix host
 * - `reportingCpu`: matched hosts whose last CPU sample is &lt; 5 min old
 * - `retellectExpected`: DB flag says this host should run Retellect
 * - `retellectRunning`: Python telemetry says Retellect is alive
 *
 * `nowUnix` (seconds) is injected so tests can pin time; defaults to wall clock.
 */
export function computeConnectionStats(
  hosts: ConnectionStatsInput[],
  nowUnix: number = Math.floor(Date.now() / 1000)
): ConnectionStats {
  const FRESH_SEC = RT_FRESHNESS_THRESHOLD_SEC;
  let matched = 0;
  let reportingCpu = 0;
  let retellectExpected = 0;
  let retellectRunning = 0;
  for (const h of hosts) {
    if (h.zabbixMatched) matched++;
    if (h.zabbixMatched && h.lastClock) {
      const ts = new Date(h.lastClock).getTime();
      if (Number.isFinite(ts)) {
        const ageSec = Math.max(0, nowUnix - Math.floor(ts / 1000));
        if (ageSec < FRESH_SEC) reportingCpu++;
      }
    }
    if (h.retellectEnabled) retellectExpected++;
    if (h.rtProcessStatus === "running") retellectRunning++;
  }
  return {
    total: hosts.length,
    matched,
    reportingCpu,
    retellectExpected,
    retellectRunning,
  };
}
