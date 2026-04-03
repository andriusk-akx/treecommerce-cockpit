"use client";

import { useState, useRef, useCallback, useMemo } from "react";
import type { TimelineSlot, DowntimeBar, TimelineEvent } from "@/lib/zabbix/patterns";

// ─── Types ────────────────────────────────────────────────────────────

interface TooltipData {
  x: number;
  y: number;
  type: "downtime" | "event";
  bar?: DowntimeBar;
  date?: string;
  hour?: number;
  count?: number;
}

interface SelectedItem {
  type: "downtime" | "hour";
  intervalId?: string; // groups multi-day bars as one event
  bar?: DowntimeBar;   // the "representative" bar (has original timestamps)
  date?: string;
  hour?: number;
  events: TimelineEvent[];
  // Other DISTINCT intervals for the same host (different intervalId)
  otherIntervals: { intervalId: string; bar: DowntimeBar; daySpan: number }[];
}

// ─── Props ────────────────────────────────────────────────────────────

interface TimelineChartProps {
  timeline: TimelineSlot[];
  totalDowntimeMinutes: number;
}

// ─── Severity helpers ─────────────────────────────────────────────────

const SEV_LABELS: Record<number, string> = {
  0: "Neklasifikuota", 1: "Informacija", 2: "Įspėjimas",
  3: "Vidutinė", 4: "Aukšta", 5: "Katastrofa",
};

const SEV_COLORS: Record<number, string> = {
  0: "#94a3b8", 1: "#60a5fa", 2: "#fbbf24",
  3: "#f97316", 4: "#ef4444", 5: "#dc2626",
};

const SEV_BG: Record<number, string> = {
  0: "#f1f5f9", 1: "#eff6ff", 2: "#fffbeb",
  3: "#fff7ed", 4: "#fef2f2", 5: "#fef2f2",
};

const SOURCE_LABELS: Record<string, string> = {
  agent_unavailable: "Agentas nepasiekiamas",
  event_pair: "Problema",
  event_gap: "Nėra duomenų",
};

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString("lt-LT", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString("lt-LT", { year: "numeric", month: "2-digit", day: "2-digit" }) +
    " " + d.toLocaleTimeString("lt-LT", { hour: "2-digit", minute: "2-digit" });
}

function formatDuration(minutes: number): string {
  if (minutes < 1) return "<1min";
  if (minutes < 60) return `${minutes}min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h < 24) return m > 0 ? `${h}h ${m}min` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}

// ─── Component ────────────────────────────────────────────────────────

export default function TimelineChart({ timeline, totalDowntimeMinutes }: TimelineChartProps) {
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  const [selected, setSelected] = useState<SelectedItem | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // ── Pre-compute: all bars indexed by intervalId (for multi-day grouping) ──
  const allBarsByInterval = useMemo(() => {
    const map = new Map<string, { bars: DowntimeBar[]; dates: Set<string> }>();
    for (const slot of timeline) {
      for (const bar of slot.downtimeBars) {
        if (!map.has(bar.intervalId)) map.set(bar.intervalId, { bars: [], dates: new Set() });
        const entry = map.get(bar.intervalId)!;
        entry.bars.push(bar);
        entry.dates.add(slot.date);
      }
    }
    return map;
  }, [timeline]);

  // ── Hover handlers ──

  const handleBarHover = useCallback(
    (e: React.MouseEvent, bar: DowntimeBar, date: string) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setTooltip({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        type: "downtime",
        bar,
        date,
      });
    },
    []
  );

  const handleDotHover = useCallback(
    (e: React.MouseEvent, date: string, hour: number, count: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setTooltip({ x: e.clientX - rect.left, y: e.clientY - rect.top, type: "event", date, hour, count });
    },
    []
  );

  const handleMouseLeave = useCallback(() => setTooltip(null), []);

  // ── Click: downtime bar → group as single event across all days ──

  const handleBarClick = useCallback(
    (bar: DowntimeBar) => {
      const iid = bar.intervalId;
      const group = allBarsByInterval.get(iid);
      const affectedDates = group ? group.dates : new Set([]);

      // Collect ALL events across all days this interval spans (±30min buffer)
      const relatedEvents: TimelineEvent[] = [];
      for (const slot of timeline) {
        if (!affectedDates.has(slot.date)) continue;
        for (const ev of slot.events) {
          const evMs = ev.clock * 1000;
          if (evMs >= bar.originalStartMs - 1800000 && evMs <= bar.originalEndMs + 1800000) {
            relatedEvents.push(ev);
          }
        }
      }

      // Find other DISTINCT intervals for the same host (different intervalId)
      const otherIntervals: SelectedItem["otherIntervals"] = [];
      const seen = new Set<string>();
      for (const slot of timeline) {
        for (const b of slot.downtimeBars) {
          if (b.intervalId === iid || b.hostName !== bar.hostName || seen.has(b.intervalId)) continue;
          seen.add(b.intervalId);
          const g = allBarsByInterval.get(b.intervalId);
          otherIntervals.push({
            intervalId: b.intervalId,
            bar: b,
            daySpan: g ? g.dates.size : 1,
          });
        }
      }

      setSelected({
        type: "downtime",
        intervalId: iid,
        bar,
        events: relatedEvents,
        otherIntervals,
      });
    },
    [timeline, allBarsByInterval]
  );

  // ── Click: event dot ──

  const handleDotClick = useCallback(
    (slot: TimelineSlot, hour: number) => {
      const hourEvents = slot.events.filter((ev) => new Date(ev.clock * 1000).getHours() === hour);
      setSelected({
        type: "hour",
        date: slot.date,
        hour,
        events: hourEvents,
        otherIntervals: [],
      });
    },
    []
  );

  const clearSelection = useCallback(() => setSelected(null), []);

  // ── Is this bar part of the selected interval? (for highlighting across days) ──
  const isBarSelected = useCallback(
    (bar: DowntimeBar) => {
      if (!selected || selected.type !== "downtime" || !selected.intervalId) return false;
      return bar.intervalId === selected.intervalId;
    },
    [selected]
  );

  // ── Render ──

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5 mb-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
            Laiko juosta — events + downtime
          </h3>
          <p className="text-[10px] text-gray-400 mt-0.5">
            Spauskite ant downtime juostos arba evento taško — apačioje pasirodys detali informacija.
          </p>
        </div>
        {totalDowntimeMinutes > 0 && (
          <span className="text-[10px] text-orange-600 font-medium">
            {formatDuration(totalDowntimeMinutes)} total downtime
          </span>
        )}
      </div>

      {/* Chart area */}
      <div ref={containerRef} className="relative">
        {/* Hour axis */}
        <div className="flex ml-[52px] mb-1">
          {Array.from({ length: 24 }, (_, i) => (
            <div key={i} className="flex-1 text-center text-[8px] text-gray-300">
              {i % 4 === 0 ? String(i).padStart(2, "0") : ""}
            </div>
          ))}
        </div>

        {/* Timeline rows */}
        {timeline.map((slot) => {
          const hasDowntime = slot.downtimeBars.length > 0;
          const isWeekend = slot.dayOfWeek >= 5;
          // Highlight row if any bar in it belongs to selected interval
          const rowHasSelectedBar = selected?.type === "downtime" && slot.downtimeBars.some((b) => isBarSelected(b));

          return (
            <div
              key={slot.date}
              className={`flex items-center ${hasDowntime ? "mb-[2px]" : "mb-[1px]"} ${rowHasSelectedBar ? "ring-1 ring-blue-400 ring-offset-1 rounded-[3px]" : ""}`}
            >
              {/* Date label */}
              <div className="w-[52px] flex items-center gap-1 pr-2">
                <span className={`text-[8px] ${isWeekend ? "text-blue-400" : "text-gray-300"}`}>
                  {slot.dayLabel}
                </span>
                <span className={`text-[9px] font-medium ${hasDowntime ? "text-gray-700" : "text-gray-400"}`}>
                  {slot.date.slice(5)}
                </span>
              </div>

              {/* Track */}
              <div className={`flex-1 relative ${hasDowntime ? "h-[22px]" : "h-[14px]"} bg-gray-50 rounded-[2px] overflow-hidden`}>
                {/* Hour grid lines */}
                <div className="absolute inset-0 flex pointer-events-none">
                  {Array.from({ length: 24 }, (_, h) => (
                    <div key={h} className="flex-1" style={{ borderRight: h < 23 ? "1px solid #f0f0f0" : "none" }} />
                  ))}
                </div>

                {/* Downtime bars */}
                {slot.downtimeBars.map((bar, bi) => {
                  const isOffline = bar.source === "agent_unavailable" || bar.source === "event_gap";
                  const isSel = isBarSelected(bar);
                  const bg = isOffline
                    ? "rgba(220, 38, 38, 0.40)"
                    : bar.severity >= 4
                      ? "rgba(234, 88, 12, 0.55)"
                      : "rgba(251, 146, 60, 0.50)";
                  const border = isOffline
                    ? "2px solid rgba(220, 38, 38, 0.7)"
                    : "2px solid rgba(234, 88, 12, 0.8)";

                  return (
                    <div
                      key={`dt-${bi}`}
                      className={`absolute rounded-[2px] cursor-pointer transition-all ${isSel ? "ring-2 ring-blue-500 z-10" : "hover:brightness-110"}`}
                      style={{
                        left: `${bar.startPct}%`,
                        width: `${Math.max(bar.widthPct, 0.5)}%`,
                        top: hasDowntime ? "2px" : "1px",
                        bottom: hasDowntime ? "2px" : "1px",
                        backgroundColor: bg,
                        borderLeft: border,
                      }}
                      onMouseMove={(e) => handleBarHover(e, bar, slot.date)}
                      onMouseLeave={handleMouseLeave}
                      onClick={() => handleBarClick(bar)}
                    />
                  );
                })}

                {/* Event dots */}
                {slot.hours.map((h) => {
                  const leftPct = (h.hour / 24) * 100;
                  const dotColor = h.severity >= 4 ? "#dc2626" : h.severity >= 2 ? "#3b82f6" : "#9ca3af";
                  const isSelDot = selected?.type === "hour" && selected?.hour === h.hour && selected?.date === slot.date;

                  return (
                    <div
                      key={`ev-${h.hour}`}
                      className={`absolute rounded-full cursor-pointer transition-all ${isSelDot ? "ring-2 ring-blue-500 z-10" : "hover:scale-150"}`}
                      style={{
                        left: `calc(${leftPct}% + ${100 / 48}%)`,
                        top: "50%",
                        transform: "translate(-50%, -50%)",
                        width: `${Math.min(4 + h.count * 1.5, 10)}px`,
                        height: `${Math.min(4 + h.count * 1.5, 10)}px`,
                        backgroundColor: dotColor,
                        opacity: 0.85,
                      }}
                      onMouseMove={(e) => handleDotHover(e, slot.date, h.hour, h.count)}
                      onMouseLeave={handleMouseLeave}
                      onClick={() => handleDotClick(slot, h.hour)}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}

        {/* Legend */}
        <div className="flex items-center gap-4 mt-4 ml-[52px]">
          <div className="flex items-center gap-1.5">
            <div className="w-6 h-3 rounded-[2px]" style={{ backgroundColor: "rgba(220, 38, 38, 0.40)", borderLeft: "2px solid rgba(220, 38, 38, 0.7)" }} />
            <span className="text-[9px] text-gray-500 font-medium">Offline</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-6 h-3 rounded-[2px]" style={{ backgroundColor: "rgba(251, 146, 60, 0.50)", borderLeft: "2px solid rgba(234, 88, 12, 0.8)" }} />
            <span className="text-[9px] text-gray-500 font-medium">Problema</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-red-600 opacity-85" />
            <span className="text-[9px] text-gray-400">High/Disaster</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-blue-500 opacity-85" />
            <span className="text-[9px] text-gray-400">Warning</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-gray-400 opacity-85" />
            <span className="text-[9px] text-gray-400">Info</span>
          </div>
        </div>

        {/* ── Tooltip ── */}
        {tooltip && (
          <div
            className="absolute z-50 pointer-events-none bg-gray-900 text-white rounded-lg px-3 py-2 text-[11px] shadow-xl max-w-[340px]"
            style={{
              left: Math.min(tooltip.x + 12, (containerRef.current?.clientWidth || 600) - 260),
              top: tooltip.y - 60,
            }}
          >
            {tooltip.type === "downtime" && tooltip.bar && (() => {
              const b = tooltip.bar;
              const daySpan = allBarsByInterval.get(b.intervalId)?.dates.size || 1;
              return (
                <>
                  <div className="font-semibold text-[12px] mb-1">{b.hostName}</div>
                  <div className="text-gray-300 mb-1">{b.problemName}</div>
                  <div className="flex items-center gap-3 text-[10px] flex-wrap">
                    <span>
                      <span className="text-gray-400">Nuo: </span>
                      {formatDateTime(b.originalStartMs)}
                    </span>
                    <span>
                      <span className="text-gray-400">Iki: </span>
                      {b.originalOngoing ? "tęsiasi..." : formatDateTime(b.originalEndMs)}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-[10px]">
                    <span>
                      <span className="text-gray-400">Trukmė: </span>
                      <span className="font-semibold text-white">{formatDuration(b.totalDurationMinutes)}</span>
                    </span>
                    {daySpan > 1 && (
                      <span className="text-yellow-300 font-medium">
                        tęsiasi {daySpan} dienas
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-1 text-[10px]">
                    <span
                      className="px-1.5 py-0.5 rounded text-white font-medium"
                      style={{ backgroundColor: SEV_COLORS[b.severity] || "#94a3b8" }}
                    >
                      {SEV_LABELS[b.severity] || "?"}
                    </span>
                    <span className="text-gray-400">{SOURCE_LABELS[b.source] || b.source}</span>
                  </div>
                </>
              );
            })()}
            {tooltip.type === "event" && (
              <>
                <div className="font-semibold">
                  {tooltip.date} {String(tooltip.hour).padStart(2, "0")}:00
                </div>
                <div className="text-gray-300 mt-0.5">
                  {tooltip.count} {tooltip.count === 1 ? "įvykis" : "įvykiai"}
                </div>
              </>
            )}
            <div className="text-[9px] text-gray-500 mt-1">Paspauskite daugiau info ↓</div>
          </div>
        )}
      </div>

      {/* ══════════════════════════════════════════════════════════════════
          DETAIL PANEL — appears below chart when something is selected
         ══════════════════════════════════════════════════════════════════ */}
      {selected && (
        <div className="mt-4 border-t border-gray-200 pt-4">
          {/* Header with close */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              {selected.type === "downtime" && selected.bar && (() => {
                const b = selected.bar;
                const daySpan = allBarsByInterval.get(b.intervalId)?.dates.size || 1;
                return (
                  <>
                    <span
                      className="px-2 py-1 rounded text-white text-[10px] font-bold"
                      style={{ backgroundColor: SEV_COLORS[b.severity] || "#94a3b8" }}
                    >
                      {SEV_LABELS[b.severity]}
                    </span>
                    <span className="text-sm font-semibold text-gray-800">{b.hostName}</span>
                    <span className="text-[10px] text-gray-400">{SOURCE_LABELS[b.source]}</span>
                    {daySpan > 1 && (
                      <span className="text-[10px] text-orange-600 font-medium bg-orange-50 px-1.5 py-0.5 rounded">
                        {daySpan} dienos
                      </span>
                    )}
                  </>
                );
              })()}
              {selected.type === "hour" && (
                <>
                  <span className="text-sm font-semibold text-gray-800">
                    {selected.date} {String(selected.hour).padStart(2, "0")}:00 — {String(selected.hour).padStart(2, "0")}:59
                  </span>
                  <span className="text-[10px] text-gray-400">
                    {selected.events.length} {selected.events.length === 1 ? "įvykis" : "įvykiai"}
                  </span>
                </>
              )}
            </div>
            <button onClick={clearSelection} className="text-gray-400 hover:text-gray-600 text-lg leading-none px-2">
              ✕
            </button>
          </div>

          {/* Downtime detail card — shows FULL interval (not per-day) */}
          {selected.type === "downtime" && selected.bar && (() => {
            const b = selected.bar;
            return (
              <div className="rounded-lg border border-gray-200 p-4 mb-3" style={{ backgroundColor: SEV_BG[b.severity] || "#f8fafc" }}>
                <div className="text-sm font-semibold text-gray-800 mb-2">{b.problemName}</div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[11px]">
                  <div>
                    <span className="text-gray-400 block">Pradžia</span>
                    <span className="font-medium text-gray-800">{formatDateTime(b.originalStartMs)}</span>
                  </div>
                  <div>
                    <span className="text-gray-400 block">Pabaiga</span>
                    <span className="font-medium text-gray-800">
                      {b.originalOngoing ? (
                        <span className="text-red-600 font-bold">⬤ Tęsiasi dabar</span>
                      ) : (
                        formatDateTime(b.originalEndMs)
                      )}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-400 block">Bendra trukmė</span>
                    <span className="font-bold text-gray-900 text-[13px]">{formatDuration(b.totalDurationMinutes)}</span>
                  </div>
                  <div>
                    <span className="text-gray-400 block">Tipas</span>
                    <span className="font-medium text-gray-800">{SOURCE_LABELS[b.source]}</span>
                  </div>
                </div>

                {/* Other distinct intervals for same host */}
                {selected.otherIntervals.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-gray-200/60">
                    <span className="text-[10px] text-gray-400 font-medium uppercase tracking-wider">
                      Kiti {b.hostName} downtime periodai ({selected.otherIntervals.length})
                    </span>
                    <div className="mt-1.5 space-y-1">
                      {selected.otherIntervals.map((other) => (
                        <div
                          key={other.intervalId}
                          className="flex items-center gap-2 text-[10px] text-gray-600 cursor-pointer hover:bg-white/60 rounded px-1.5 py-0.5"
                          onClick={() => handleBarClick(other.bar)}
                        >
                          <span
                            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                            style={{ backgroundColor: SEV_COLORS[other.bar.severity] || "#94a3b8" }}
                          />
                          <span className="text-gray-400">
                            {formatDateTime(other.bar.originalStartMs)} — {other.bar.originalOngoing ? "tęsiasi" : formatDateTime(other.bar.originalEndMs)}
                          </span>
                          <span className="font-medium">{formatDuration(other.bar.totalDurationMinutes)}</span>
                          {other.daySpan > 1 && (
                            <span className="text-orange-500">({other.daySpan}d)</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {/* Events list */}
          {selected.events.length > 0 && (
            <div>
              <div className="text-[10px] text-gray-400 font-medium uppercase tracking-wider mb-2">
                {selected.type === "downtime" ? "Susiję įvykiai" : "Įvykiai"}
                <span className="ml-2 text-gray-300">({selected.events.length})</span>
              </div>
              <div className="space-y-0.5 max-h-[300px] overflow-y-auto">
                {selected.events
                  .sort((a, b) => a.clock - b.clock)
                  .map((ev, i) => {
                    const isProblem = ev.value === "1";
                    return (
                      <div
                        key={ev.eventId || i}
                        className="flex items-center gap-2 px-3 py-1.5 rounded hover:bg-gray-50 text-[11px]"
                      >
                        {/* Date + Time */}
                        <span className="text-gray-400 font-mono w-[100px] flex-shrink-0">
                          {new Date(ev.clock * 1000).toLocaleDateString("lt-LT", { month: "2-digit", day: "2-digit" })}{" "}
                          {formatTime(ev.clock * 1000)}
                        </span>

                        {/* Problem/OK badge */}
                        <span
                          className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded flex-shrink-0 ${
                            isProblem ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"
                          }`}
                        >
                          {isProblem ? "PROB" : "OK"}
                        </span>

                        {/* Severity dot */}
                        <span
                          className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                          style={{ backgroundColor: SEV_COLORS[ev.severity] || "#94a3b8" }}
                        />

                        {/* Host */}
                        <span className="text-gray-500 font-medium flex-shrink-0 max-w-[140px] truncate">
                          {ev.hostName.replace(/^(12eat_|widen_arena_|TreeCom_)/i, "")}
                        </span>

                        {/* Event name */}
                        <span className="text-gray-700 truncate flex-1">{ev.name || "—"}</span>
                      </div>
                    );
                  })}
              </div>
              {selected.events.length > 15 && (
                <div className="text-[10px] text-gray-400 text-center mt-2">
                  Rodomi visi {selected.events.length} įvykiai — slinkite žemyn
                </div>
              )}
            </div>
          )}

          {selected.events.length === 0 && (
            <div className="text-[11px] text-gray-400 text-center py-4">
              Šiuo laikotarpiu susijusių įvykių nerasta
            </div>
          )}
        </div>
      )}
    </div>
  );
}
