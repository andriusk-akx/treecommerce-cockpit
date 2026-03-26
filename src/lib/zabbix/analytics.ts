import { getZabbixClient } from "./client";
import { cached } from "./cache";

// Map Zabbix host names to client (store) names
const CLIENT_HOST_PREFIXES: Record<string, string[]> = {
  "12eat": ["12eat"],
  "Widen Arena": ["widen_arena"],
  "TreeCom": ["TreeCom"],
};

export function getClientForHost(hostName: string): string | null {
  for (const [clientName, prefixes] of Object.entries(CLIENT_HOST_PREFIXES)) {
    if (prefixes.some((p) => hostName.toLowerCase().startsWith(p.toLowerCase()))) {
      return clientName;
    }
  }
  return null;
}

function hostBelongsToClient(hostName: string, clientStoreName: string | null): boolean {
  if (!clientStoreName) return true; // no filter
  return getClientForHost(hostName) === clientStoreName;
}

export interface HostDowntime {
  hostId: string;
  hostName: string;
  totalDowntimeMinutes: number;
  incidentCount: number;
  avgResolutionMinutes: number;
  uptimePercent: number;
  lastIncident: string | null;
}

export interface ProblemFrequency {
  name: string;
  count: number;
  hosts: string[];
  avgDurationMinutes: number;
  severity: string;
}

export interface DailyIncidentCount {
  date: string;
  count: number;
  resolved: number;
}

export interface AnalyticsData {
  period: string;
  totalEvents: number;
  totalProblems: number;
  totalResolved: number;
  avgResolutionMinutes: number;
  hostDowntimes: HostDowntime[];
  topProblems: ProblemFrequency[];
  dailyCounts: DailyIncidentCount[];
  activeTriggersByHost: { hostName: string; triggerCount: number; activeProblemCount: number }[];
}

export async function getAnalytics(daysBack: number = 30, clientStoreName: string | null = null): Promise<AnalyticsData> {
  const client = getZabbixClient();
  const safeDaysBack = Number.isFinite(daysBack) && daysBack > 0 ? Math.min(daysBack, 365) : 30;

  // PERF-002: Cache Zabbix API responses (60s TTL)
  const [events, hosts, triggers] = await cached(
    `analytics_${safeDaysBack}`,
    () => Promise.all([
      client.getEventsForPeriod(safeDaysBack, 1000),
      client.getHosts(),
      client.getAllTriggers(500),
    ])
  );

  const periodMs = safeDaysBack * 24 * 3600 * 1000;
  const periodStart = Date.now() - periodMs;

  // Build host name map from triggers
  const hostNameMap = new Map<string, string>();
  for (const t of triggers) {
    if (t.hosts) {
      for (const h of t.hosts) {
        hostNameMap.set(h.hostid, h.name || h.host);
      }
    }
  }
  for (const h of hosts) {
    hostNameMap.set(h.hostid, h.name || h.host);
  }

  // Build trigger -> host map (filtered by client)
  const triggerHostMap = new Map<string, string[]>();
  for (const t of triggers) {
    if (t.hosts) {
      const filteredHosts = t.hosts
        .map((h: any) => h.name || h.host)
        .filter((name: string) => hostBelongsToClient(name, clientStoreName));
      if (filteredHosts.length > 0) {
        triggerHostMap.set(t.triggerid, filteredHosts);
      }
    }
  }

  // Separate problem events (value=1) and resolution events (value=0)
  // When filtering by client, only include events whose trigger is mapped to that client
  const problemEvents = events.filter((e: any) => {
    if (e.value !== "1") return false;
    if (!clientStoreName) return true;
    return triggerHostMap.has(e.objectid);
  });
  const resolutionEvents = events.filter((e: any) => e.value === "0");

  // Match problems with resolutions
  const resolvedProblems: { name: string; severity: string; startClock: number; endClock: number; objectid: string; hosts: string[] }[] = [];

  for (const prob of problemEvents) {
    const resolution = resolutionEvents.find(
      (r: any) => r.objectid === prob.objectid && parseInt(r.clock) > parseInt(prob.clock)
    );

    const startClock = parseInt(prob.clock);
    const endClock = resolution ? parseInt(resolution.clock) : Math.floor(Date.now() / 1000);
    const hosts = triggerHostMap.get(prob.objectid) || [];

    resolvedProblems.push({
      name: prob.name,
      severity: prob.severity,
      startClock,
      endClock,
      objectid: prob.objectid,
      hosts,
    });
  }

  // Calculate total resolution stats
  const resolvedOnly = resolvedProblems.filter((p) => p.endClock !== Math.floor(Date.now() / 1000));
  const totalResolutionMinutes = resolvedOnly.reduce((sum, p) => sum + (p.endClock - p.startClock) / 60, 0);
  const avgResolutionMinutes = resolvedOnly.length > 0 ? Math.round(totalResolutionMinutes / resolvedOnly.length) : 0;

  // Host downtimes
  const hostDowntimeMap = new Map<string, { totalMinutes: number; count: number; resolutionSum: number; resolvedCount: number; lastIncident: number }>();

  for (const prob of resolvedProblems) {
    for (const hostName of prob.hosts) {
      const existing = hostDowntimeMap.get(hostName) || { totalMinutes: 0, count: 0, resolutionSum: 0, resolvedCount: 0, lastIncident: 0 };
      const durationMinutes = (prob.endClock - prob.startClock) / 60;
      existing.totalMinutes += durationMinutes;
      existing.count++;
      if (prob.endClock !== Math.floor(Date.now() / 1000)) {
        existing.resolutionSum += durationMinutes;
        existing.resolvedCount++;
      }
      if (prob.startClock > existing.lastIncident) {
        existing.lastIncident = prob.startClock;
      }
      hostDowntimeMap.set(hostName, existing);
    }
  }

  const totalPeriodMinutes = safeDaysBack * 24 * 60;
  const hostDowntimes: HostDowntime[] = Array.from(hostDowntimeMap.entries())
    .map(([hostName, data]) => ({
      hostId: hostName,
      hostName,
      totalDowntimeMinutes: Math.round(data.totalMinutes),
      incidentCount: data.count,
      avgResolutionMinutes: data.resolvedCount > 0 ? Math.round(data.resolutionSum / data.resolvedCount) : 0,
      uptimePercent: Math.min(100, Math.max(0, Math.round((1 - data.totalMinutes / totalPeriodMinutes) * 10000) / 100)),
      lastIncident: data.lastIncident > 0 ? new Date(data.lastIncident * 1000).toISOString() : null,
    }))
    .sort((a, b) => b.totalDowntimeMinutes - a.totalDowntimeMinutes);

  // Top problems by frequency
  const problemCountMap = new Map<string, { count: number; hosts: Set<string>; totalDuration: number; severity: string }>();
  for (const prob of resolvedProblems) {
    const key = prob.name;
    const existing = problemCountMap.get(key) || { count: 0, hosts: new Set<string>(), totalDuration: 0, severity: prob.severity };
    existing.count++;
    prob.hosts.forEach((h) => existing.hosts.add(h));
    existing.totalDuration += (prob.endClock - prob.startClock) / 60;
    problemCountMap.set(key, existing);
  }

  const severityLabels: Record<string, string> = { "5": "Disaster", "4": "High", "3": "Average", "2": "Warning", "1": "Info", "0": "N/A" };

  const topProblems: ProblemFrequency[] = Array.from(problemCountMap.entries())
    .map(([name, data]) => ({
      name,
      count: data.count,
      hosts: Array.from(data.hosts),
      avgDurationMinutes: Math.round(data.totalDuration / data.count),
      severity: severityLabels[data.severity] || "Unknown",
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Daily incident counts
  const dailyMap = new Map<string, { count: number; resolved: number }>();
  for (let d = 0; d < safeDaysBack; d++) {
    const date = new Date(Date.now() - d * 24 * 3600 * 1000);
    const key = date.toISOString().slice(0, 10);
    dailyMap.set(key, { count: 0, resolved: 0 });
  }

  for (const prob of resolvedProblems) {
    const date = new Date(prob.startClock * 1000).toISOString().slice(0, 10);
    const existing = dailyMap.get(date);
    if (existing) {
      existing.count++;
    }
  }
  for (const res of resolvedOnly) {
    const date = new Date(res.endClock * 1000).toISOString().slice(0, 10);
    const existing = dailyMap.get(date);
    if (existing) {
      existing.resolved++;
    }
  }

  const dailyCounts: DailyIncidentCount[] = Array.from(dailyMap.entries())
    .map(([date, data]) => ({ date, count: data.count, resolved: data.resolved }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Active triggers per host (filtered by client)
  const activeTriggersByHost = new Map<string, { triggerCount: number; activeProblemCount: number }>();
  for (const t of triggers) {
    if (t.hosts) {
      for (const h of t.hosts) {
        const name = h.name || h.host;
        if (!hostBelongsToClient(name, clientStoreName)) continue;
        const existing = activeTriggersByHost.get(name) || { triggerCount: 0, activeProblemCount: 0 };
        existing.triggerCount++;
        if (t.value === "1") existing.activeProblemCount++;
        activeTriggersByHost.set(name, existing);
      }
    }
  }

  return {
    period: `${safeDaysBack} days`,
    totalEvents: events.length,
    totalProblems: problemEvents.length,
    totalResolved: resolvedOnly.length,
    avgResolutionMinutes,
    hostDowntimes,
    topProblems,
    dailyCounts,
    activeTriggersByHost: Array.from(activeTriggersByHost.entries())
      .map(([hostName, data]) => ({ hostName, ...data }))
      .sort((a, b) => b.activeProblemCount - a.activeProblemCount),
  };
}
