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

export interface RtStatusInput {
  retellectEnabled: boolean;
  zabbixHostExists: boolean;
  /** Retellect proc item found for this host (from Zabbix proc.num[retellect] etc.) */
  procMatch: { count: number } | null;
}

export interface RtStatusResult {
  status: RtProcessStatus;
  processCount: number;
}

/**
 * Determine Retellect process status for a host.
 * Priority: 1) Zabbix proc item (if configured), 2) DB retellectEnabled + Zabbix host match
 */
export function determineRtStatus(input: RtStatusInput): RtStatusResult {
  if (input.procMatch !== null) {
    // Zabbix has retellect-specific process monitoring
    return {
      status: input.procMatch.count > 0 ? "running" : "stopped",
      processCount: input.procMatch.count,
    };
  }
  if (input.retellectEnabled && input.zabbixHostExists) {
    // DB says enabled + Zabbix host matched → assume running
    return { status: "running", processCount: 0 };
  }
  if (input.retellectEnabled && !input.zabbixHostExists) {
    // DB says enabled but no Zabbix match → unknown
    return { status: "unknown", processCount: 0 };
  }
  // Not enabled in DB
  return { status: "not-installed", processCount: 0 };
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
