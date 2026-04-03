import { getZabbixClient } from "./client";
import { getClientForHost } from "./analytics";
import { getDowntimeIntervals, type DowntimeInterval } from "./availability";

// ─── Types ───────────────────────────────────────────────────────────

export interface HeatmapCell {
  day: number; // 0=Mon, 6=Sun
  hour: number; // 0-23
  count: number;
  problems: number;
  resolutions: number;
}

export interface HourSummary {
  hour: number;
  count: number;
  problems: number;
}

export interface DaySummary {
  day: number;
  dayLabel: string;
  count: number;
  problems: number;
}

export interface DowntimeBar {
  hostName: string;
  problemName: string;
  startPct: number; // 0-100 position in 24h
  widthPct: number; // 0-100 width in 24h
  severity: number;
  ongoing: boolean;
  source: "agent_unavailable" | "event_pair" | "event_gap";
  startMs: number;           // clipped to this day
  endMs: number;             // clipped to this day
  originalStartMs: number;   // full interval start
  originalEndMs: number;     // full interval end
  originalOngoing: boolean;  // is the FULL interval still ongoing?
  durationMinutes: number;   // clipped day duration
  totalDurationMinutes: number; // FULL interval duration
  objectId: string;
  intervalId: string;        // unique: objectId_hostName — groups bars across days
}

export interface TimelineEvent {
  eventId: string;
  clock: number;    // unix seconds
  hostName: string;
  hostId: string;
  name: string;
  severity: number;
  value: string;    // "1"=problem, "0"=ok
  objectId: string;
}

export interface TimelineSlot {
  date: string; // YYYY-MM-DD
  dayLabel: string;
  dayOfWeek: number;
  hours: { hour: number; count: number; severity: number }[];
  downtimeBars: DowntimeBar[];
  events: TimelineEvent[]; // all events for this day (for detail panel)
}

export interface PatternData {
  heatmap: HeatmapCell[];
  hourSummary: HourSummary[];
  daySummary: DaySummary[];
  timeline: TimelineSlot[];
  maxCount: number;
  totalEvents: number;
  peakHour: number;
  peakDay: string;
  quietHour: number;
  quietDay: string;
  totalDowntimeMinutes: number;
  downtimeHosts: string[];
}

const DAY_LABELS = ["Pr", "An", "Tr", "Ke", "Pe", "Še", "Se"];
const DAY_LABELS_FULL = ["Pirmadienis", "Antradienis", "Trečiadienis", "Ketvirtadienis", "Penktadienis", "Šeštadienis", "Sekmadienis"];

// ─── Host list for device picker ─────────────────────────────────────

export interface HostInfo {
  hostId: string;
  hostName: string;
  clientName: string | null;
}

export async function getAvailableHosts(): Promise<HostInfo[]> {
  const client = getZabbixClient();
  const hosts = await client.getHosts();
  return hosts.map((h: any) => ({
    hostId: h.hostid,
    hostName: h.name || h.host,
    clientName: getClientForHost(h.name || h.host),
  }));
}

// ─── Main pattern data function ──────────────────────────────────────

export async function getPatternData(
  daysBack: number = 30,
  clientStoreName: string | null = null,
  hostFilter: string | null = null
): Promise<PatternData> {
  // Use centralized availability module for downtime detection
  // This single call handles all 3 signals: agent unavailable, event pairs, event gaps
  const { intervals, events, triggerHostMap } = await getDowntimeIntervals(daysBack, clientStoreName, hostFilter);

  // Helper: resolve host from event
  function resolveHost(e: any): { hostName: string; hostId: string } | null {
    if (e.hosts?.[0]) return { hostName: e.hosts[0].name || e.hosts[0].host, hostId: e.hosts[0].hostid };
    return triggerHostMap.get(e.objectid) || null;
  }

  // ── Build heatmap + timeline from events ──

  const grid: { count: number; problems: number; resolutions: number }[][] = [];
  for (let d = 0; d < 7; d++) {
    grid[d] = [];
    for (let h = 0; h < 24; h++) {
      grid[d][h] = { count: 0, problems: 0, resolutions: 0 };
    }
  }

  const timelineMap = new Map<string, { hours: Map<number, { count: number; maxSev: number }> }>();
  // Build per-day events list for detail panel
  const eventsByDate = new Map<string, TimelineEvent[]>();

  for (const e of events) {
    const ts = new Date(parseInt(e.clock) * 1000);
    const jsDay = ts.getDay();
    const day = jsDay === 0 ? 6 : jsDay - 1;
    const hour = ts.getHours();
    const isProblem = e.value === "1";
    const host = resolveHost(e);

    // Store per-day event for detail panel
    const dateKey = ts.toISOString().slice(0, 10);
    if (!eventsByDate.has(dateKey)) eventsByDate.set(dateKey, []);
    eventsByDate.get(dateKey)!.push({
      eventId: e.eventid,
      clock: parseInt(e.clock),
      hostName: host?.hostName || "Unknown",
      hostId: host?.hostId || "",
      name: e.name || "",
      severity: parseInt(e.severity) || 0,
      value: e.value,
      objectId: e.objectid || "",
    });

    grid[day][hour].count++;
    if (isProblem) grid[day][hour].problems++;
    else grid[day][hour].resolutions++;

    if (!timelineMap.has(dateKey)) {
      timelineMap.set(dateKey, { hours: new Map() });
    }
    const dayData = timelineMap.get(dateKey)!;
    const hourData = dayData.hours.get(hour) || { count: 0, maxSev: 0 };
    hourData.count++;
    const sev = parseInt(e.severity) || 0;
    if (sev > hourData.maxSev) hourData.maxSev = sev;
    dayData.hours.set(hour, hourData);
  }

  // Flatten heatmap
  const heatmap: HeatmapCell[] = [];
  let maxCount = 0;
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      const cell = grid[d][h];
      heatmap.push({ day: d, hour: h, ...cell });
      if (cell.count > maxCount) maxCount = cell.count;
    }
  }

  // Hour summary
  const hourSummary: HourSummary[] = [];
  for (let h = 0; h < 24; h++) {
    let total = 0, probs = 0;
    for (let d = 0; d < 7; d++) {
      total += grid[d][h].count;
      probs += grid[d][h].problems;
    }
    hourSummary.push({ hour: h, count: total, problems: probs });
  }

  // Day summary
  const daySummary: DaySummary[] = [];
  for (let d = 0; d < 7; d++) {
    let total = 0, probs = 0;
    for (let h = 0; h < 24; h++) {
      total += grid[d][h].count;
      probs += grid[d][h].problems;
    }
    daySummary.push({ day: d, dayLabel: DAY_LABELS[d], count: total, problems: probs });
  }

  // ── Downtime total (from centralized module, with overlap merging) ──

  const downtimeHostsSet = new Set<string>();
  for (const i of intervals) downtimeHostsSet.add(i.hostName);

  // Merge overlapping intervals for accurate total
  const merged = mergeOverlapping(intervals);
  const totalDowntimeMinutes = Math.round(
    merged.reduce((sum, m) => sum + (m.endMs - m.startMs), 0) / 60000
  );

  // ── Build timeline with downtime bars ──

  const allDates = new Set<string>();
  for (let d = 0; d < daysBack; d++) {
    const date = new Date(Date.now() - d * 24 * 3600 * 1000).toISOString().slice(0, 10);
    allDates.add(date);
  }
  for (const key of timelineMap.keys()) allDates.add(key);

  const timeline: TimelineSlot[] = Array.from(allDates)
    .sort()
    .map((date) => {
      const d = new Date(date + "T12:00:00");
      const jsDay = d.getDay();
      const dayOfWeek = jsDay === 0 ? 6 : jsDay - 1;

      // Event dots
      const tmData = timelineMap.get(date);
      const hours: { hour: number; count: number; severity: number }[] = [];
      if (tmData) {
        for (let h = 0; h < 24; h++) {
          const hd = tmData.hours.get(h);
          if (hd) hours.push({ hour: h, count: hd.count, severity: hd.maxSev });
        }
      }

      // Downtime bars from centralized intervals
      const dayStartMs = new Date(date + "T00:00:00").getTime();
      const dayEndMs = dayStartMs + 24 * 3600 * 1000;

      const downtimeBars: DowntimeBar[] = [];
      for (const interval of intervals) {
        if (interval.endMs <= dayStartMs || interval.startMs >= dayEndMs) continue;

        const clipStart = Math.max(interval.startMs, dayStartMs);
        const clipEnd = Math.min(interval.endMs, dayEndMs);
        const startPct = ((clipStart - dayStartMs) / (24 * 3600 * 1000)) * 100;
        const widthPct = ((clipEnd - clipStart) / (24 * 3600 * 1000)) * 100;

        if (widthPct < 0.1) continue;

        const totalDur = interval.endMs - interval.startMs;
        downtimeBars.push({
          hostName: interval.hostName,
          problemName: interval.problemName,
          startPct,
          widthPct,
          severity: interval.severity,
          ongoing: interval.ongoing && clipEnd >= dayEndMs - 60000,
          source: interval.source,
          startMs: clipStart,
          endMs: clipEnd,
          originalStartMs: interval.startMs,
          originalEndMs: interval.endMs,
          originalOngoing: interval.ongoing,
          durationMinutes: Math.round((clipEnd - clipStart) / 60000),
          totalDurationMinutes: Math.round(totalDur / 60000),
          objectId: interval.objectId,
          intervalId: `${interval.objectId}_${interval.hostName}_${interval.startMs}`,
        });
      }

      // Events for this day (for detail panel)
      const dayEvents = eventsByDate.get(date) || [];

      return { date, dayLabel: DAY_LABELS[dayOfWeek], dayOfWeek, hours, downtimeBars, events: dayEvents };
    });

  // Peak / quiet stats — guard against empty arrays
  // hourSummary and daySummary are always 24 and 7 elements respectively, but add guards for safety
  const peakHourIdx = hourSummary.length > 0 ? hourSummary.reduce((max, h, i) => h.count > hourSummary[max].count ? i : max, 0) : 0;
  const quietHourIdx = hourSummary.length > 0 ? hourSummary.reduce((min, h, i) => h.count < hourSummary[min].count ? i : min, 0) : 0;
  const peakDayIdx = daySummary.length > 0 ? daySummary.reduce((max, d, i) => d.count > daySummary[max].count ? i : max, 0) : 0;
  const quietDayIdx = daySummary.length > 0 ? daySummary.reduce((min, d, i) => d.count < daySummary[min].count ? i : min, 0) : 0;

  return {
    heatmap,
    hourSummary,
    daySummary,
    timeline,
    maxCount,
    totalEvents: events.length,
    peakHour: peakHourIdx,
    peakDay: DAY_LABELS_FULL[peakDayIdx],
    quietHour: quietHourIdx,
    quietDay: DAY_LABELS_FULL[quietDayIdx],
    totalDowntimeMinutes,
    downtimeHosts: Array.from(downtimeHostsSet),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function mergeOverlapping(intervals: DowntimeInterval[]): { startMs: number; endMs: number }[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
  const merged: { startMs: number; endMs: number }[] = [
    { startMs: sorted[0].startMs, endMs: sorted[0].endMs },
  ];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, sorted[i].endMs);
    } else {
      merged.push({ startMs: sorted[i].startMs, endMs: sorted[i].endMs });
    }
  }
  return merged;
}
