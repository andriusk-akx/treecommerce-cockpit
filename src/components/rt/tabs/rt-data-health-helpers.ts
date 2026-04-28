/**
 * Helpers for the Data Health tab — per-store grouping with sibling-contrast
 * detection.
 *
 * The MON-1 view exists to separate "host-level monitoring gap" from
 * "Retellect not running". A host with > 50 % of items in
 * `ZBX_NOTSUPPORTED` reads as "0 % CPU" on every other tab, which looks
 * identical to "process is idle". When we group hosts by store and notice
 * that one host in a store is healthy while a sibling is broken, the issue
 * is almost certainly host-level (perfcounter / agent privileges), not a
 * site-wide deployment problem. That's the "Mixed — host-level issue"
 * signal — same as the v7 prototype.
 *
 * Pure functions, no React, fully unit-testable.
 */

import {
  classifyAgentHealth,
  type AgentHealthBucket,
} from "./rt-agent-health-helpers";

/**
 * One row of the per-store breakdown — one DB device, joined to its Zabbix
 * agent-health summary if one exists. `bucket` collapses the four item-state
 * buckets onto a single label the table shows in the "Agent" column.
 */
export interface DataHealthHostRow {
  /** DB device id — stable React key. */
  deviceId: string;
  /** DB-side device name (mono font in the table). */
  hostName: string;
  /** Store name from the DB device record (group key). */
  storeName: string;
  /** Resolved Zabbix host name, or null when the device isn't matched. */
  zabbixHostName: string | null;
  /**
   * Whether the DB device resolves to a Zabbix host. False rows count as
   * `unmatched` — distinct from `no-data` (host exists but template empty).
   */
  zabbixMatched: boolean;
  /** Whether the DB device is flagged retellect-enabled in Prisma. */
  retellectEnabled: boolean;
  /** Live process status (running / stopped / unknown / not-installed). */
  rtStatus: "running" | "stopped" | "unknown" | "not-installed";
  /** Counts that drove the agent classification (for the "Items OK" cell). */
  supported: number;
  unsupported: number;
  totalEnabled: number;
  /**
   * Agent-health bucket. Reuses the existing `classifyAgentHealth` taxonomy:
   *   healthy / partial / broken / no-data
   * Plus a synthetic `unmatched` for DB devices with no Zabbix host —
   * conceptually closest to the prototype's `unenrolled`.
   */
  bucket: DataHealthBucket;
  /** ISO of the freshest Zabbix sample, or null. */
  lastUpdate: string | null;
}

/**
 * The five surface-level buckets the table renders. `unmatched` is a
 * dashboard concept (no Zabbix host found for this DB device), the other
 * four are item-state buckets from `classifyAgentHealth`.
 */
export type DataHealthBucket = AgentHealthBucket | "unmatched";

/**
 * One per-store group. `hosts` is the row list; the booleans are the
 * sibling-contrast signal — when both are true, the group header gets the
 * "Mixed — host-level issue" pill.
 */
export interface DataHealthStoreGroup {
  storeName: string;
  hosts: DataHealthHostRow[];
  /** At least one host in this store is `healthy`. */
  hasHealthy: boolean;
  /** At least one host in this store is `partial` or `broken`. */
  hasIssue: boolean;
  /**
   * Convenience: hasHealthy && hasIssue. UI uses this directly to decide
   * whether to render the contrast pill.
   */
  isMixed: boolean;
}

/**
 * Top-level summary for the 4-card KPI strip (counts of hosts in each
 * surface-level bucket). `unmatched` is excluded from the prototype's KPI
 * cards (which only show healthy/partial/broken/unenrolled), but we expose
 * the count so the consumer can show it elsewhere if it wants. The current
 * UI surfaces unmatched separately rather than mixing it into the agent
 * KPI strip.
 */
export interface DataHealthSummary {
  healthy: number;
  partial: number;
  broken: number;
  /**
   * "Unenrolled" in the prototype. Equivalent to:
   *   - DB device with no Zabbix host (truly not registered in monitoring), OR
   *   - Zabbix host present but no items enabled on it (the helper's
   *     `no-data` bucket).
   */
  unenrolled: number;
  total: number;
}

/**
 * Bucket a single DB device given its agent-health entry (or absence of one).
 *
 *   matched=false               → "unmatched"
 *   matched && no entry         → "no-data" (Zabbix host exists, but template empty)
 *   matched && entry            → classifyAgentHealth(entry.supported, ...)
 */
export function classifyDataHealth(
  matched: boolean,
  entry:
    | { supported: number; unsupported: number; totalEnabled: number }
    | null
    | undefined,
): DataHealthBucket {
  if (!matched) return "unmatched";
  if (!entry) return "no-data";
  return classifyAgentHealth(
    entry.supported,
    entry.unsupported,
    entry.totalEnabled,
  );
}

/**
 * Group the supplied rows by `storeName`, preserving first-seen order so the
 * UI is deterministic across renders. Computes `hasHealthy` / `hasIssue` /
 * `isMixed` for the contrast pill.
 *
 * Hosts inside each group are sorted alphabetically by `hostName` (numeric
 * compare so SCO1 / SCO2 / SCO10 sort the way humans expect).
 */
export function groupByStore(
  rows: DataHealthHostRow[],
): DataHealthStoreGroup[] {
  const order: string[] = [];
  const map = new Map<string, DataHealthHostRow[]>();
  for (const row of rows) {
    const existing = map.get(row.storeName);
    if (existing) {
      existing.push(row);
    } else {
      map.set(row.storeName, [row]);
      order.push(row.storeName);
    }
  }
  return order.map((storeName) => {
    const hosts = (map.get(storeName) ?? []).slice().sort((a, b) =>
      a.hostName.localeCompare(b.hostName, undefined, { numeric: true }),
    );
    let hasHealthy = false;
    let hasIssue = false;
    for (const h of hosts) {
      if (h.bucket === "healthy") hasHealthy = true;
      if (h.bucket === "partial" || h.bucket === "broken") hasIssue = true;
    }
    return {
      storeName,
      hosts,
      hasHealthy,
      hasIssue,
      isMixed: hasHealthy && hasIssue,
    };
  });
}

/**
 * Roll up bucket counts for the KPI strip. `unmatched` and `no-data` are
 * folded into "unenrolled" — both mean "no monitoring data for this host",
 * which is what the prototype KPI conveys.
 */
export function summarize(rows: DataHealthHostRow[]): DataHealthSummary {
  let healthy = 0;
  let partial = 0;
  let broken = 0;
  let unenrolled = 0;
  for (const r of rows) {
    if (r.bucket === "healthy") healthy++;
    else if (r.bucket === "partial") partial++;
    else if (r.bucket === "broken") broken++;
    else unenrolled++; // unmatched + no-data
  }
  return {
    healthy,
    partial,
    broken,
    unenrolled,
    total: rows.length,
  };
}

/**
 * Diagnosis copy keyed by bucket. Centralised so the table cells, tooltips,
 * and any future "details" panel stay in lockstep.
 */
export function diagnosisFor(bucket: DataHealthBucket): string {
  switch (bucket) {
    case "broken":
      return (
        "Most items report ZBX_NOTSUPPORTED. Likely host-side: agent missing " +
        "Performance Monitor Users group, corrupt PDH counters (try `lodctr /R`), " +
        "or stuck WMI provider. Same-store siblings may still be healthy — " +
        "this is host-level."
      );
    case "partial":
      return (
        "A subset of items unsupported — per-process CPU may be incomplete. " +
        "Verify perf_counter keys and sampling interval with the SP Zabbix admin."
      );
    case "no-data":
      return (
        "Zabbix host found but no items enabled — monitoring template not attached."
      );
    case "unmatched":
      return "Host not registered in Zabbix monitoring.";
    case "healthy":
      return "Agent reporting normally.";
  }
}
