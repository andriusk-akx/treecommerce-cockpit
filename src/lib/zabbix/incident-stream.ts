import { getZabbixClient } from "./client";
import { getClientForHost } from "./analytics";
import { cached } from "./cache";

export interface StreamEvent {
  id: string;
  eventId: string;
  time: Date;
  type: "PROBLEM" | "RESOLVED";
  name: string;
  severity: string;
  severityLevel: number;
  hostName: string;
  clientName: string | null;
  opdata: string;
  tags: { tag: string; value: string }[];
  acknowledged: boolean;
  // Categorization
  category: string;
  // Resolution link
  resolvedByEventId: string | null;
  resolvedAt: Date | null;
  durationMinutes: number | null;
}

const SEVERITY_LABELS: Record<string, string> = {
  "5": "Disaster", "4": "High", "3": "Average",
  "2": "Warning", "1": "Info", "0": "N/A",
};

function categorizeEvent(name: string, tags: { tag: string; value: string }[]): string {
  const lower = name.toLowerCase();
  const tagMap = Object.fromEntries(tags.map((t) => [t.tag, t.value]));

  // VMI / Fiscal
  if (lower.includes("vmi") || lower.includes("kvit") || lower.includes("sm status") || lower.includes("cr-0000")) return "VMI / Fiscal";
  if (tagMap["iEKA"]) return "VMI / Fiscal";

  // Services
  if (lower.includes("service") && lower.includes("not active")) return "Service";
  if (tagMap["ecli"] !== undefined) return "Service";

  // Payment / Terminal
  if (lower.includes("terminal") || lower.includes("verifone") || lower.includes("bankini")) return "Payment";

  // System restarts
  if (lower.includes("restarted") || lower.includes("uptime")) return "Restart";

  // Memory
  if (lower.includes("memory") || lower.includes("swap")) return "Memory";

  // CPU / Load
  if (lower.includes("load") || lower.includes("cpu")) return "CPU / Load";

  // Disk
  if (lower.includes("disk") || lower.includes("fs [")) return "Disk";

  // Network
  if (lower.includes("interface") || lower.includes("link down") || lower.includes("bandwidth")) return "Network";

  // Agent
  if (lower.includes("zabbix agent")) return "Agent";

  // Security / system changes
  if (lower.includes("passwd") || lower.includes("operating system")) return "System Change";

  // Component tag
  if (tagMap["component"]) {
    const comp = tagMap["component"];
    if (comp === "system") return "System";
    if (comp === "cpu") return "CPU / Load";
    if (comp === "memory") return "Memory";
    if (comp === "network") return "Network";
    if (comp === "os") return "System";
  }

  return "Other";
}

export async function getFullEventStream(
  daysBack: number = 30,
  clientStoreName: string | null = null
): Promise<StreamEvent[]> {
  const client = getZabbixClient();
  const safeDaysBack = Number.isFinite(daysBack) && daysBack > 0 ? Math.min(daysBack, 365) : 30;

  const timeFrom = Math.floor(Date.now() / 1000) - safeDaysBack * 24 * 3600;

  // PERF-002: Cache Zabbix API responses (60s TTL)
  const cacheKey = `stream_${timeFrom}`;
  const [events, triggers] = await cached(
    cacheKey,
    () => Promise.all([
      client.request("event.get", {
        output: "extend",
        selectTags: "extend",
        selectHosts: ["hostid", "host", "name"],
        selectAcknowledges: ["acknowledgeid"],
        time_from: String(timeFrom),
        sortfield: ["clock"],
        sortorder: "DESC",
        limit: 10000,
      }),
      client.request("trigger.get", {
        output: ["triggerid", "priority"],
        selectHosts: ["hostid", "host", "name"],
        limit: 500,
      }),
    ])
  );

  const triggerHostMap = new Map<string, string>();
  for (const t of triggers) {
    if (t.hosts && t.hosts.length > 0) {
      triggerHostMap.set(t.triggerid, t.hosts[0].name || t.hosts[0].host);
    }
  }

  // Build problem -> resolution pairs by objectid
  const problemsByObject = new Map<string, any[]>();
  const resolutionsByObject = new Map<string, any[]>();
  for (const e of events) {
    const objectId = e.objectid;
    if (e.value === "1") {
      if (!problemsByObject.has(objectId)) problemsByObject.set(objectId, []);
      problemsByObject.get(objectId)!.push(e);
    } else {
      if (!resolutionsByObject.has(objectId)) resolutionsByObject.set(objectId, []);
      resolutionsByObject.get(objectId)!.push(e);
    }
  }

  // PERF-001: Match resolutions to problems with O(n) pointer instead of O(n²) .find()
  const problemResolutionMap = new Map<string, any>(); // problemEventId -> resolution event
  for (const [objectId, problems] of problemsByObject) {
    const resolutions = (resolutionsByObject.get(objectId) || [])
      .sort((a: any, b: any) => parseInt(a.clock) - parseInt(b.clock));
    const sortedProbs = [...problems].sort((a: any, b: any) => parseInt(a.clock) - parseInt(b.clock));

    let resIdx = 0;
    for (const prob of sortedProbs) {
      const probClock = parseInt(prob.clock);
      while (resIdx < resolutions.length && parseInt(resolutions[resIdx].clock) <= probClock) {
        resIdx++;
      }
      if (resIdx < resolutions.length) {
        problemResolutionMap.set(prob.eventid, resolutions[resIdx]);
        resIdx++;
      }
    }
  }

  const stream: StreamEvent[] = [];

  for (const e of events) {
    // P0-3: Skip events with invalid clock values
    const clockVal = parseInt(e.clock);
    if (!clockVal || !Number.isFinite(clockVal) || clockVal <= 0) continue;

    const hostName =
      (e.hosts && e.hosts.length > 0 ? (e.hosts[0].name || e.hosts[0].host) : null) ||
      triggerHostMap.get(e.objectid) ||
      "Unknown";

    const clientName = getClientForHost(hostName);

    // Apply client filter
    if (clientStoreName && clientName !== clientStoreName) continue;

    const tags = (e.tags || []).map((t: any) => ({ tag: t.tag, value: t.value }));
    const sevLevel = parseInt(e.severity) || 0;
    const isProblem = e.value === "1";

    // Resolution info (only for problem events)
    let resolvedByEventId: string | null = null;
    let resolvedAt: Date | null = null;
    let durationMinutes: number | null = null;

    if (isProblem) {
      const resolution = problemResolutionMap.get(e.eventid);
      if (resolution) {
        resolvedByEventId = resolution.eventid;
        resolvedAt = new Date(parseInt(resolution.clock) * 1000);
        durationMinutes = Math.round(
          (parseInt(resolution.clock) - parseInt(e.clock)) / 60
        );
      }
    }

    stream.push({
      id: `evt-${e.eventid}`,
      eventId: e.eventid,
      time: new Date(parseInt(e.clock) * 1000),
      type: isProblem ? "PROBLEM" : "RESOLVED",
      name: e.name || "Unknown",
      severity: SEVERITY_LABELS[e.severity] || "N/A",
      severityLevel: sevLevel,
      hostName,
      clientName,
      opdata: e.opdata || "",
      tags,
      acknowledged: (e.acknowledges && e.acknowledges.length > 0) || e.acknowledged === "1",
      category: categorizeEvent(e.name || "", tags),
      resolvedByEventId,
      resolvedAt,
      durationMinutes,
    });
  }

  return stream;
}
