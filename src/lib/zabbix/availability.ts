/**
 * Centralized Host Availability & Offline Period Detection
 *
 * This module provides a single source of truth for detecting when devices
 * were offline. It uses three independent signals:
 *
 *   Signal 1 — Agent unavailability events
 *     Zabbix generates "agent is not available for Xh" when a host stops
 *     responding. These are the most reliable indicators of full offline.
 *
 *   Signal 2 — PROBLEM/OK event pairs
 *     Any trigger-based problem (service down, high CPU, etc.) is paired
 *     with its resolution. These represent individual issue downtime.
 *
 *   Signal 3 — Event gap detection
 *     If a host normally generates events every day (e.g. daily restarts)
 *     and suddenly has no events for >36 hours, the gap is flagged as a
 *     suspected offline period. This catches cases where the agent was
 *     completely unreachable and no events were generated at all.
 *
 * All functions work with any number of hosts/clients. When new devices
 * are added to Zabbix, they are automatically picked up — no code changes needed.
 */

import { getZabbixClient } from "./client";
import { getClientForHost } from "./analytics";
import { cached } from "./cache";

// ─── Types ───────────────────────────────────────────────────────────

export interface OfflinePeriod {
  hostName: string;
  hostId: string;
  clientName: string | null;
  start: Date;
  end: Date | null; // null = ongoing
  durationMinutes: number;
  source: "agent_unavailable" | "event_pair" | "event_gap";
  problemName: string;
  severity: number;
  objectId: string;
}

export interface HostAvailability {
  hostId: string;
  hostName: string;
  clientName: string | null;
  isOnline: boolean;
  offlinePeriods: OfflinePeriod[];
  totalOfflineMinutes: number;
  uptimePercent: number;
}

export interface DowntimeInterval {
  hostName: string;
  hostId: string;
  problemName: string;
  startMs: number;
  endMs: number; // Date.now() if ongoing
  severity: number;
  ongoing: boolean;
  source: "agent_unavailable" | "event_pair" | "event_gap";
  objectId: string;
}

// ─── Constants ───────────────────────────────────────────────────────

/** If a host has no events for longer than this, flag as suspected offline */
const GAP_THRESHOLD_HOURS = 36;

/**
 * Only these event patterns represent REAL device downtime.
 * Everything else (VMI errors, service issues, fiscal problems)
 * is a business incident — the device is still working.
 *
 * This list is intentionally permissive with case-insensitive matching.
 * New trigger types are automatically excluded from downtime unless they
 * match one of these patterns — this is the safe default.
 */
const DOWNTIME_EVENT_PATTERNS: RegExp[] = [
  /not available/i,           // Zabbix agent not available
  /link down/i,               // Network interface down
  /unreachable/i,             // Host unreachable
  /has been restarted/i,      // Device restart (short downtime)
];

// ─── Core: fetch events + build downtime intervals ───────────────────

/**
 * Fetches all events and builds a unified list of downtime intervals.
 * This is the single function that all pages should call.
 *
 * @param daysBack  How many days of history to analyze
 * @param clientStoreName  Optional: filter to a specific client
 * @param hostFilter  Optional: filter to a specific host name
 * @returns { intervals, events, triggerHostMap } — raw data + computed intervals
 */
export async function getDowntimeIntervals(
  daysBack: number = 30,
  clientStoreName: string | null = null,
  hostFilter: string | null = null
): Promise<{
  intervals: DowntimeInterval[];
  events: any[];
  triggerHostMap: Map<string, { hostName: string; hostId: string }>;
  hosts: any[];
}> {
  // P0-4: Snapshot Date.now() once — prevents time drift between calculations
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  // P0-7: Validate daysBack
  const safeDaysBack = Number.isFinite(daysBack) && daysBack > 0 ? Math.min(daysBack, 365) : 30;

  const client = getZabbixClient();
  const timeFrom = nowSec - safeDaysBack * 24 * 3600;

  // PERF-002: Cache Zabbix API responses (60s TTL) to avoid redundant calls
  // Include all filter params in cache key to avoid collisions between different clients
  const cacheKey = `downtime_${timeFrom}_${clientStoreName || "all"}_${hostFilter || "all"}`;
  const [events, triggers, hosts] = await cached(
    cacheKey,
    () => Promise.all([
      client.request("event.get", {
        output: ["eventid", "clock", "value", "severity", "name", "objectid"],
        selectHosts: ["hostid", "host", "name"],
        time_from: String(timeFrom),
        sortfield: ["clock"],
        sortorder: "ASC",
        limit: 10000,
      }),
      client.request("trigger.get", {
        output: ["triggerid"],
        selectHosts: ["hostid", "host", "name"],
        limit: 500,
      }),
      client.getHosts(),
    ])
  );

  // Build trigger → host map (fallback when event.hosts is empty)
  const triggerHostMap = new Map<string, { hostName: string; hostId: string }>();
  for (const t of triggers) {
    if (t.hosts?.[0]) {
      triggerHostMap.set(t.triggerid, {
        hostName: t.hosts[0].name || t.hosts[0].host,
        hostId: t.hosts[0].hostid,
      });
    }
  }

  // Helper: resolve host from event
  function resolveHost(e: any): { hostName: string; hostId: string } | null {
    if (e.hosts?.[0]) {
      return {
        hostName: e.hosts[0].name || e.hosts[0].host,
        hostId: e.hosts[0].hostid,
      };
    }
    return triggerHostMap.get(e.objectid) || null;
  }

  // Helper: should this event pass the client/host filter?
  function passesFilter(hostName: string): boolean {
    if (hostFilter && hostName !== hostFilter) return false;
    if (!hostFilter && clientStoreName && getClientForHost(hostName) !== clientStoreName) return false;
    return true;
  }

  // Filter events — skip invalid clock values (P0-3)
  const filtered = events.filter((e: any) => {
    const clock = parseInt(e.clock);
    if (!clock || !Number.isFinite(clock) || clock <= 0) return false;
    const host = resolveHost(e);
    if (!host) return false;
    return passesFilter(host.hostName);
  });

  // ── Signal 1 + 2: Pair PROBLEM/OK events by objectid ──

  const problemsByObject = new Map<string, any[]>();
  const resolutionsByObject = new Map<string, any[]>();

  for (const e of filtered) {
    const oid = e.objectid;
    if (!oid) continue;

    if (e.value === "1") {
      if (!problemsByObject.has(oid)) problemsByObject.set(oid, []);
      problemsByObject.get(oid)!.push(e);
    } else {
      if (!resolutionsByObject.has(oid)) resolutionsByObject.set(oid, []);
      resolutionsByObject.get(oid)!.push(e);
    }
  }

  const intervals: DowntimeInterval[] = [];

  // Pre-build per-host sorted event clocks — used to infer end time when no resolution exists
  const hostEventClocks = new Map<string, number[]>();
  for (const e of filtered) {
    const h = resolveHost(e);
    if (!h) continue;
    if (!hostEventClocks.has(h.hostName)) hostEventClocks.set(h.hostName, []);
    hostEventClocks.get(h.hostName)!.push(parseInt(e.clock) * 1000);
  }
  for (const clocks of hostEventClocks.values()) clocks.sort((a, b) => a - b);

  for (const [objectId, problems] of problemsByObject) {
    // PERF-001: Pre-sort resolutions once, then consume with pointer — O(n) instead of O(n²)
    const resolutions = (resolutionsByObject.get(objectId) || [])
      .sort((a: any, b: any) => parseInt(a.clock) - parseInt(b.clock));
    let resIdx = 0; // pointer — only moves forward

    for (const prob of problems) {
      const startMs = parseInt(prob.clock) * 1000;
      const host = resolveHost(prob);
      if (!host) continue;

      const name = prob.name || "";
      const sev = parseInt(prob.severity) || 0;

      // Only create downtime intervals for events that represent REAL device unavailability
      const isDeviceDowntime = DOWNTIME_EVENT_PATTERNS.some((p) => p.test(name));
      if (!isDeviceDowntime) continue;

      // PERF-001: Advance pointer to first resolution after this problem — O(1) amortized
      while (resIdx < resolutions.length && parseInt(resolutions[resIdx].clock) * 1000 <= startMs) {
        resIdx++;
      }
      const resolution = resIdx < resolutions.length ? resolutions[resIdx] : null;
      if (resolution) resIdx++; // consume it

      let endMs: number;
      let ongoing: boolean;

      if (resolution) {
        // Explicit resolution event — use it
        endMs = parseInt(resolution.clock) * 1000;
        ongoing = false;
      } else {
        // No resolution event. Check if the host sent ANY newer events after this problem.
        // If yes — the host recovered; use the first subsequent event as implicit end.
        const clocks = hostEventClocks.get(host.hostName) || [];
        // Binary search for first clock > startMs
        let lo = 0, hi = clocks.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (clocks[mid] <= startMs) lo = mid + 1; else hi = mid;
        }
        // Find first event that's meaningfully later (>5min after problem start)
        const implicitEnd = clocks.slice(lo).find((c) => c > startMs + 300000);
        if (implicitEnd) {
          endMs = implicitEnd;
          ongoing = false;
        } else {
          endMs = nowMs;
          ongoing = true;
        }
      }

      const isAgentUnavailable = name.toLowerCase().includes("not available");

      intervals.push({
        hostName: host.hostName,
        hostId: host.hostId,
        problemName: name,
        startMs,
        endMs,
        severity: sev,
        ongoing,
        source: isAgentUnavailable ? "agent_unavailable" : "event_pair",
        objectId,
      });
    }
  }

  // ── Signal 3: Event gap detection ──

  // Group events by host, find gaps
  const eventsByHost = new Map<string, { clock: number; hostId: string }[]>();
  for (const e of filtered) {
    const host = resolveHost(e);
    if (!host) continue;
    if (!eventsByHost.has(host.hostName)) eventsByHost.set(host.hostName, []);
    eventsByHost.get(host.hostName)!.push({
      clock: parseInt(e.clock) * 1000,
      hostId: host.hostId,
    });
  }

  const gapThresholdMs = GAP_THRESHOLD_HOURS * 3600 * 1000;
  const periodStartMs = nowMs - safeDaysBack * 24 * 3600 * 1000;

  // PERF-005: Pre-build host→intervals index for O(1) gap coverage checks
  const agentIntervalsByHost = new Map<string, DowntimeInterval[]>();
  for (const iv of intervals) {
    if (iv.source !== "agent_unavailable") continue;
    if (!agentIntervalsByHost.has(iv.hostName)) agentIntervalsByHost.set(iv.hostName, []);
    agentIntervalsByHost.get(iv.hostName)!.push(iv);
  }

  for (const [hostName, hostEvents] of eventsByHost) {
    if (hostEvents.length < 2) continue;

    const sorted = hostEvents.sort((a, b) => a.clock - b.clock);
    const hostId = sorted[0].hostId;
    const hostAgentIntervals = agentIntervalsByHost.get(hostName) || [];

    // Check gap at the start of the period
    if (sorted[0].clock - periodStartMs > gapThresholdMs) {
      const gapStart = periodStartMs;
      const gapEnd = sorted[0].clock;
      if (!isGapCovered(hostAgentIntervals, gapStart, gapEnd)) {
        intervals.push({
          hostName,
          hostId,
          problemName: "Įrenginys nepasiekiamas (nėra duomenų)",
          startMs: gapStart,
          endMs: gapEnd,
          severity: 3,
          ongoing: false,
          source: "event_gap",
          objectId: "gap_start",
        });
      }
    }

    // Check gaps between consecutive events
    for (let i = 0; i < sorted.length - 1; i++) {
      const gap = sorted[i + 1].clock - sorted[i].clock;
      if (gap > gapThresholdMs) {
        const gapStart = sorted[i].clock;
        const gapEnd = sorted[i + 1].clock;
        if (!isGapCovered(hostAgentIntervals, gapStart, gapEnd)) {
          intervals.push({
            hostName,
            hostId,
            problemName: "Įrenginys nepasiekiamas (nėra duomenų)",
            startMs: gapStart,
            endMs: gapEnd,
            severity: 3,
            ongoing: false,
            source: "event_gap",
            objectId: `gap_${i}`,
          });
        }
      }
    }

    // Check gap at the end (host stopped sending but no explicit "agent unavailable")
    const lastEvent = sorted[sorted.length - 1];
    if (nowMs - lastEvent.clock > gapThresholdMs) {
      const gapStart = lastEvent.clock;
      const gapEnd = nowMs;
      if (!isGapCovered(hostAgentIntervals, gapStart, gapEnd)) {
        intervals.push({
          hostName,
          hostId,
          problemName: "Įrenginys nepasiekiamas (nėra duomenų)",
          startMs: gapStart,
          endMs: gapEnd,
          severity: 3,
          ongoing: true,
          source: "event_gap",
          objectId: "gap_end",
        });
      }
    }
  }

  return { intervals, events: filtered, triggerHostMap, hosts };
}

/**
 * PERF-005: Check gap coverage using pre-indexed host intervals.
 * Takes the already-filtered array for this host — no re-filtering needed.
 */
function isGapCovered(
  hostAgentIntervals: DowntimeInterval[],
  gapStartMs: number,
  gapEndMs: number
): boolean {
  const gapDuration = gapEndMs - gapStartMs;
  for (const interval of hostAgentIntervals) {
    const overlapStart = Math.max(interval.startMs, gapStartMs);
    const overlapEnd = Math.min(interval.endMs, gapEndMs);
    const overlap = Math.max(0, overlapEnd - overlapStart);
    if (overlap > gapDuration * 0.5) return true;
  }
  return false;
}

// ─── High-level: per-host availability summary ──────────────────────

/**
 * Returns availability summary per host. Use this in the Uptime page
 * and Dashboard for an overview.
 */
export async function getHostAvailability(
  daysBack: number = 30,
  clientStoreName: string | null = null,
  hostFilter: string | null = null
): Promise<HostAvailability[]> {
  // daysBack is already validated inside getDowntimeIntervals
  const safeDaysBack = Number.isFinite(daysBack) && daysBack > 0 ? Math.min(daysBack, 365) : 30;
  const { intervals, hosts } = await getDowntimeIntervals(safeDaysBack, clientStoreName, hostFilter);

  const totalPeriodMinutes = safeDaysBack * 24 * 60;
  const byHost = new Map<string, DowntimeInterval[]>();

  // Initialize from known hosts
  for (const h of hosts) {
    const name = h.name || h.host;
    if (hostFilter && name !== hostFilter) continue;
    if (!hostFilter && clientStoreName && getClientForHost(name) !== clientStoreName) continue;
    if (!byHost.has(name)) byHost.set(name, []);
  }

  // Assign intervals to hosts
  for (const interval of intervals) {
    if (!byHost.has(interval.hostName)) byHost.set(interval.hostName, []);
    byHost.get(interval.hostName)!.push(interval);
  }

  const results: HostAvailability[] = [];

  for (const [hostName, hostIntervals] of byHost) {
    // Merge overlapping intervals to avoid double-counting
    const merged = mergeOverlapping(hostIntervals);
    const totalOffline = merged.reduce((sum, i) => sum + (i.endMs - i.startMs), 0);
    const totalOfflineMinutes = Math.round(totalOffline / 60000);
    const uptimePercent = totalPeriodMinutes > 0
      ? Math.min(100, Math.max(0, Math.round((1 - totalOfflineMinutes / totalPeriodMinutes) * 10000) / 100))
      : 100;

    const hostId = hostIntervals[0]?.hostId ||
      hosts.find((h: any) => (h.name || h.host) === hostName)?.hostid || "";

    const isOnline = !hostIntervals.some((i) => i.ongoing);

    results.push({
      hostId,
      hostName,
      clientName: getClientForHost(hostName),
      isOnline,
      offlinePeriods: hostIntervals
        .sort((a, b) => b.startMs - a.startMs)
        .map((i) => ({
          hostName: i.hostName,
          hostId: i.hostId,
          clientName: getClientForHost(i.hostName),
          start: new Date(i.startMs),
          end: i.ongoing ? null : new Date(i.endMs),
          durationMinutes: Math.round((i.endMs - i.startMs) / 60000),
          source: i.source,
          problemName: i.problemName,
          severity: i.severity,
          objectId: i.objectId,
        })),
      totalOfflineMinutes,
      uptimePercent,
    });
  }

  results.sort((a, b) => {
    if (a.isOnline !== b.isOnline) return a.isOnline ? 1 : -1;
    return b.totalOfflineMinutes - a.totalOfflineMinutes;
  });

  return results;
}

/**
 * Merge overlapping downtime intervals to avoid double-counting.
 * E.g., "agent unavailable for 12h" overlaps with "agent unavailable for 48h"
 * — we should only count the total continuous offline period once.
 */
function mergeOverlapping(intervals: DowntimeInterval[]): { startMs: number; endMs: number }[] {
  if (intervals.length === 0) return [];

  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
  const merged: { startMs: number; endMs: number }[] = [
    { startMs: sorted[0].startMs, endMs: sorted[0].endMs },
  ];

  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].startMs <= last.endMs) {
      // Overlapping — extend
      last.endMs = Math.max(last.endMs, sorted[i].endMs);
    } else {
      merged.push({ startMs: sorted[i].startMs, endMs: sorted[i].endMs });
    }
  }

  return merged;
}
