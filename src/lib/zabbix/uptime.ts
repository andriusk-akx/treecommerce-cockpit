import { getZabbixClient } from "./client";
import { getClientForHost } from "./analytics";
import { getDowntimeIntervals } from "./availability";

export interface EventTag {
  tag: string;
  value: string;
}

export interface DowntimePeriod {
  start: Date;
  end: Date | null;
  durationMinutes: number;
  problemName: string;
  severity: string;
  severityLevel: number;
  source: "agent_unavailable" | "event_pair" | "event_gap";
  // Context fields
  tags: EventTag[];
  triggerExpression: string;
  triggerComment: string;
  relatedItems: { name: string; lastValue: string; units: string }[];
  precedingEvents: { time: Date; name: string; type: "PROBLEM" | "RESOLVED" }[];
}

export interface HostUptime {
  hostId: string;
  hostName: string;
  clientName: string | null;
  status: "up" | "down";
  uptimePercent: number;
  totalDowntimeMinutes: number;
  incidentCount: number;
  mttrMinutes: number;
  longestOutageMinutes: number;
  downtimePeriods: DowntimePeriod[];
}

const SEVERITY_LABELS: Record<string, string> = {
  "5": "Disaster", "4": "High", "3": "Average",
  "2": "Warning", "1": "Info", "0": "N/A",
};

export async function getDeviceUptimeData(
  daysBack: number = 30,
  clientStoreName: string | null = null
): Promise<HostUptime[]> {
  const safeDaysBack = Number.isFinite(daysBack) && daysBack > 0 ? Math.min(daysBack, 365) : 30;
  const client = getZabbixClient();

  // 1. Get centralized downtime intervals (handles all 3 signals)
  const { intervals, events, hosts } = await getDowntimeIntervals(safeDaysBack, clientStoreName);

  // 2. Also fetch triggers with items for context enrichment
  const triggers = await client.request("trigger.get", {
    output: ["triggerid", "description", "priority", "lastchange", "value", "status", "comments", "expression", "opdata", "event_name"],
    selectHosts: ["hostid", "host", "name"],
    selectItems: ["itemid", "name", "key_", "lastvalue", "units"],
    expandDescription: true,
    expandComment: true,
    expandExpression: true,
    limit: 500,
  });

  const triggerMap = new Map<string, any>();
  for (const t of triggers) {
    triggerMap.set(t.triggerid, t);
  }

  // 3. Build host events index for preceding events lookup
  const hostEventsMap = new Map<string, any[]>();
  for (const e of events) {
    const hostName = e.hosts?.[0]?.name || e.hosts?.[0]?.host || "";
    if (!hostName) continue;
    if (!hostEventsMap.has(hostName)) hostEventsMap.set(hostName, []);
    hostEventsMap.get(hostName)!.push(e);
  }

  // 4. Group intervals by host
  const allHosts = new Map<string, string>(); // hostName → hostId
  for (const h of hosts) {
    const name = h.name || h.host;
    if (clientStoreName && getClientForHost(name) !== clientStoreName) continue;
    allHosts.set(name, h.hostid);
  }

  const hostPeriodsMap = new Map<string, {
    hostId: string;
    hostName: string;
    periods: DowntimePeriod[];
    currentlyDown: boolean;
  }>();

  // Initialize all known hosts
  for (const [hostName, hostId] of allHosts) {
    hostPeriodsMap.set(hostName, {
      hostId,
      hostName,
      periods: [],
      currentlyDown: false,
    });
  }

  // 5. Convert centralized intervals to rich DowntimePeriods with context
  for (const interval of intervals) {
    if (!hostPeriodsMap.has(interval.hostName)) {
      hostPeriodsMap.set(interval.hostName, {
        hostId: interval.hostId,
        hostName: interval.hostName,
        periods: [],
        currentlyDown: false,
      });
    }

    const hostData = hostPeriodsMap.get(interval.hostName)!;
    if (interval.ongoing) hostData.currentlyDown = true;

    // Enrich with trigger context (only for event_pair source)
    const trigger = triggerMap.get(interval.objectId);
    const triggerExpression = trigger?.expression || "";
    const triggerComment = trigger?.comments || "";
    const relatedItems = (trigger?.items || []).map((item: any) => ({
      name: item.name,
      lastValue: item.lastvalue || "",
      units: item.units || "",
    }));

    // Preceding events (within 24h before this downtime start)
    const hostEvents = hostEventsMap.get(interval.hostName) || [];
    const precedingEvents = hostEvents
      .filter((e: any) => {
        const eClock = parseInt(e.clock) * 1000;
        return eClock < interval.startMs && eClock > interval.startMs - 24 * 3600 * 1000;
      })
      .sort((a: any, b: any) => parseInt(b.clock) - parseInt(a.clock))
      .slice(0, 5)
      .map((e: any) => ({
        time: new Date(parseInt(e.clock) * 1000),
        name: e.name || "Unknown",
        type: (e.value === "1" ? "PROBLEM" : "RESOLVED") as "PROBLEM" | "RESOLVED",
      }));

    // Tags from the original event (find it in events array)
    const originalEvent = events.find(
      (e: any) => e.objectid === interval.objectId && e.value === "1" &&
        Math.abs(parseInt(e.clock) * 1000 - interval.startMs) < 2000
    );
    const tags: EventTag[] = (originalEvent?.tags || []).map((t: any) => ({
      tag: t.tag,
      value: t.value,
    }));

    hostData.periods.push({
      start: new Date(interval.startMs),
      end: interval.ongoing ? null : new Date(interval.endMs),
      durationMinutes: Math.round((interval.endMs - interval.startMs) / 60000),
      problemName: interval.problemName,
      severity: SEVERITY_LABELS[String(interval.severity)] || "Unknown",
      severityLevel: interval.severity,
      source: interval.source,
      tags,
      triggerExpression,
      triggerComment,
      relatedItems,
      precedingEvents,
    });
  }

  // 6. Calculate stats
  const totalPeriodMinutes = safeDaysBack * 24 * 60;
  const results: HostUptime[] = [];

  for (const [, data] of hostPeriodsMap) {
    const periods = data.periods.sort((a, b) => b.start.getTime() - a.start.getTime());

    // Merge overlapping for accurate total (e.g., 12h + 48h agent unavailable overlap)
    const mergedMs = mergeOverlappingPeriods(periods);
    const totalDowntime = mergedMs / 60000;

    const resolvedPeriods = periods.filter((p) => p.end !== null);
    const mttr = resolvedPeriods.length > 0
      ? Math.round(resolvedPeriods.reduce((s, p) => s + p.durationMinutes, 0) / resolvedPeriods.length)
      : 0;
    const longest = periods.length > 0 ? Math.max(...periods.map((p) => p.durationMinutes)) : 0;
    const uptimePercent = totalPeriodMinutes > 0
      ? Math.min(100, Math.max(0, Math.round((1 - totalDowntime / totalPeriodMinutes) * 10000) / 100))
      : 100;

    results.push({
      hostId: data.hostId,
      hostName: data.hostName,
      clientName: getClientForHost(data.hostName),
      status: data.currentlyDown ? "down" : "up",
      uptimePercent,
      totalDowntimeMinutes: Math.round(totalDowntime),
      incidentCount: periods.length,
      mttrMinutes: mttr,
      longestOutageMinutes: Math.round(longest),
      downtimePeriods: periods,
    });
  }

  results.sort((a, b) => {
    if (a.status !== b.status) return a.status === "down" ? -1 : 1;
    return b.totalDowntimeMinutes - a.totalDowntimeMinutes;
  });

  return results;
}

/**
 * Merge overlapping periods and return total downtime in milliseconds.
 * Prevents double-counting when "agent not available 12h" and "48h" overlap.
 */
function mergeOverlappingPeriods(periods: DowntimePeriod[]): number {
  if (periods.length === 0) return 0;

  const sorted = [...periods].sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: { start: number; end: number }[] = [{
    start: sorted[0].start.getTime(),
    end: sorted[0].end?.getTime() || Date.now(),
  }];

  for (let i = 1; i < sorted.length; i++) {
    const startMs = sorted[i].start.getTime();
    const endMs = sorted[i].end?.getTime() || Date.now();
    const last = merged[merged.length - 1];
    if (startMs <= last.end) {
      last.end = Math.max(last.end, endMs);
    } else {
      merged.push({ start: startMs, end: endMs });
    }
  }

  return merged.reduce((sum, m) => sum + (m.end - m.start), 0);
}
