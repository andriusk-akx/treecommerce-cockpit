"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CompareMeta, CompareOverlay, OverlayPoint } from "./types";
import { exportOverlayPng } from "./CompareExports";

/**
 * Overlay timeline chart for the Compare-periods sub-view.
 *
 * Two stacked line/area curves (A blue, B orange) on a single x-axis. The
 * x-axis is one of:
 *   - "time-of-day"      → 0..1440 minutes (24h cycle)
 *   - "absolute-offset"  → 0..periodLengthDays*1440 minutes
 *
 * Custom SVG (no recharts dep) — matches the rest of the rt/ codebase's
 * chart style (RtTimeline heatmap, RtRolloutInsights are also hand-rolled
 * SVG). Spec §6.3.
 */

const PALETTE = {
  aLine: "#2563eb",
  aFill: "rgba(37, 99, 235, 0.10)",
  bLine: "#f97316",
  bFill: "rgba(249, 115, 22, 0.10)",
  threshold: "#ef4444",
  grid: "#e2e8f0",
  axisText: "#64748b",
  text: "#0f172a",
  border: "#e2e8f0",
  card: "#ffffff",
} as const;

const VB_W = 1240;
const VB_H = 280;
const PAD_LEFT = 56;
const PAD_RIGHT = 24;
const PAD_TOP = 16;
const PAD_BOTTOM = 36;

interface Props {
  overlay: CompareOverlay;
  meta: CompareMeta;
}

export function CompareOverlayChart({ overlay, meta }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [exporting, setExporting] = useState(false);
  const onExport = async () => {
    if (!svgRef.current) return;
    setExporting(true);
    try {
      await exportOverlayPng(svgRef.current, meta);
    } catch (e) {
      console.error("[CompareOverlayChart] PNG export failed:", e);
    } finally {
      setExporting(false);
    }
  };
  const innerW = VB_W - PAD_LEFT - PAD_RIGHT;
  const innerH = VB_H - PAD_TOP - PAD_BOTTOM;

  // X scale: bucket index → pixel. Y scale: CPU% (0..100) → pixel.
  const xs = useMemo(() => {
    const totalX = Math.max(overlay.totalSlots - 1, 1);
    return (idx: number) => PAD_LEFT + (idx / totalX) * innerW;
  }, [overlay.totalSlots, innerW]);
  const ys = useMemo(() => (v: number) => PAD_TOP + (1 - Math.min(100, Math.max(0, v)) / 100) * innerH, [innerH]);

  // Build A and B path d-strings. Null values create gaps (M without L).
  const { aLine, aFill, bLine, bFill } = useMemo(() => buildPaths(overlay.points, xs, ys), [overlay.points, xs, ys]);

  // Threshold horizontal line.
  const yThr = ys(meta.threshold);

  // X axis tick labels: every 4 hours for time-of-day, DOW-aligned for
  // absolute-offset (DOW names since both periods share the start DOW).
  const xTicks = useMemo(() => buildXTicks(overlay, meta.periodA.from), [overlay, meta.periodA.from]);

  // ── Hover state ────────────────────────────────────────────────────
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  // Reset hover index when the overlay payload changes (new Run, new
  // alignment). Without this, an idx pointing into the old `points` array
  // can land out-of-bounds for the new array and render a phantom hover
  // marker outside the chart bounds.
  useEffect(() => {
    setHoverIdx(null);
  }, [overlay.points, overlay.alignment, overlay.slotMinutes]);
  const onMove = (evt: React.MouseEvent<SVGSVGElement>) => {
    const svg = evt.currentTarget;
    const rect = svg.getBoundingClientRect();
    // Map pixel x → viewBox x → bucket idx.
    const vx = ((evt.clientX - rect.left) / rect.width) * VB_W;
    if (vx < PAD_LEFT - 4 || vx > VB_W - PAD_RIGHT + 4) {
      setHoverIdx(null);
      return;
    }
    const totalX = Math.max(overlay.totalSlots - 1, 1);
    const t = (vx - PAD_LEFT) / innerW;
    const idx = Math.max(0, Math.min(overlay.totalSlots - 1, Math.round(t * totalX)));
    setHoverIdx(idx);
  };
  const onLeave = () => setHoverIdx(null);
  // Defensive bounds check — overlay.points length can change before the
  // useEffect above runs (during the same render after a payload swap).
  const hovered = hoverIdx != null && hoverIdx < overlay.points.length
    ? overlay.points[hoverIdx]
    : null;

  return (
    <div style={{
      background: PALETTE.card,
      border: `1px solid ${PALETTE.border}`,
      borderRadius: 8,
      padding: 16,
      marginBottom: 16,
    }}>
      <ChartHeader meta={meta} alignment={overlay.alignment} slotMinutes={overlay.slotMinutes} onExport={onExport} exporting={exporting} />
      <div style={{ position: "relative" }}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          // Default preserveAspectRatio = "xMidYMid meet" keeps the chart's
          // intrinsic aspect ratio so hover dots stay circular instead of
          // being squashed to ellipses by `none` stretching. The container
          // has a fixed 320px height so the chart still fills horizontally.
          style={{ width: "100%", height: 320, display: "block", userSelect: "none" }}
          onMouseMove={onMove}
          onMouseLeave={onLeave}
        >
          {/* Y grid + labels */}
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={v}>
              <line
                x1={PAD_LEFT} y1={ys(v)} x2={VB_W - PAD_RIGHT} y2={ys(v)}
                stroke={PALETTE.grid} strokeWidth={1}
              />
              <text x={PAD_LEFT - 8} y={ys(v) + 3} textAnchor="end" fontSize={10} fill={PALETTE.axisText}>
                {v}%
              </text>
            </g>
          ))}
          {/* Threshold line */}
          <line
            x1={PAD_LEFT} y1={yThr} x2={VB_W - PAD_RIGHT} y2={yThr}
            stroke={PALETTE.threshold} strokeWidth={1.2} strokeDasharray="4 4"
          />
          <text x={VB_W - PAD_RIGHT + 2} y={yThr + 3} fontSize={10} fill={PALETTE.threshold}>
            {meta.threshold}%
          </text>

          {/* Period A area + line */}
          <path d={aFill} fill={PALETTE.aFill} stroke="none" />
          <path d={aLine} stroke={PALETTE.aLine} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />
          {/* Period B area + line */}
          <path d={bFill} fill={PALETTE.bFill} stroke="none" />
          <path d={bLine} stroke={PALETTE.bLine} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />

          {/* X axis ticks */}
          {xTicks.map((t, i) => (
            <g key={`xt-${i}`}>
              <line x1={xs(t.idx)} y1={PAD_TOP + innerH} x2={xs(t.idx)} y2={PAD_TOP + innerH + 4} stroke={PALETTE.grid} strokeWidth={1} />
              <text x={xs(t.idx)} y={PAD_TOP + innerH + 18} textAnchor="middle" fontSize={10} fill={PALETTE.axisText}>
                {t.label}
              </text>
            </g>
          ))}

          {/* Hover crosshair + dots */}
          {hovered && hoverIdx != null && (
            <g pointerEvents="none">
              <line x1={xs(hoverIdx)} y1={PAD_TOP} x2={xs(hoverIdx)} y2={PAD_TOP + innerH} stroke="#0f172a" strokeWidth={1} strokeDasharray="2 2" />
              {hovered.aCpu !== null && (
                <circle cx={xs(hoverIdx)} cy={ys(hovered.aCpu)} r={3.5} fill={PALETTE.aLine} stroke="#fff" strokeWidth={1.5} />
              )}
              {hovered.bCpu !== null && (
                <circle cx={xs(hoverIdx)} cy={ys(hovered.bCpu)} r={3.5} fill={PALETTE.bLine} stroke="#fff" strokeWidth={1.5} />
              )}
            </g>
          )}

          {/* Hover tooltip */}
          {hovered && hoverIdx != null && (
            <foreignObject x={Math.min(xs(hoverIdx) + 8, VB_W - PAD_RIGHT - 200)} y={PAD_TOP + 8} width={200} height={80}>
              <div style={{
                background: "#fff", border: `1px solid ${PALETTE.border}`,
                borderRadius: 4, padding: "6px 8px", fontSize: 11, color: PALETTE.text,
                boxShadow: "0 2px 6px rgba(15,23,42,0.10)",
              }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                  {formatHoverLabel(overlay, hovered, new Date(`${meta.periodA.from}T00:00:00Z`).getUTCDay())}
                </div>
                <Row color={PALETTE.aLine} label={meta.periodA.label ?? "Period A"} value={hovered.aCpu} />
                <Row color={PALETTE.bLine} label={meta.periodB.label ?? "Period B"} value={hovered.bCpu} />
                {hovered.aCpu !== null && hovered.bCpu !== null && (
                  <div style={{ marginTop: 4, fontSize: 11 }}>
                    Δ <strong>{formatDelta(hovered.aCpu, hovered.bCpu)}</strong>
                  </div>
                )}
              </div>
            </foreignObject>
          )}
        </svg>
      </div>
    </div>
  );
}

function Row({ color, label, value }: { color: string; label: string; value: number | null }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
      <span style={{ width: 8, height: 8, background: color, borderRadius: 2, display: "inline-block" }} />
      <span style={{ flex: 1, color: "#64748b" }}>{label}</span>
      <strong style={{ fontVariantNumeric: "tabular-nums" }}>
        {value === null ? "—" : `${value.toFixed(1)}%`}
      </strong>
    </div>
  );
}

function formatDelta(a: number, b: number): string {
  const d = b - a;
  const sign = d > 0 ? "+" : "";
  return `${sign}${d.toFixed(1)} pp`;
}

function formatHoverLabel(overlay: CompareOverlay, p: OverlayPoint, startDow: number): string {
  if (overlay.alignment === "time-of-day") {
    const h = Math.floor(p.offsetMin / 60);
    const m = p.offsetMin % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  // absolute-offset: DOW + time. Both periods share the start DOW since
  // the picker enforces same-DOW selection, so a single label suffices.
  const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const day = Math.floor(p.offsetMin / 1440);
  const minOfDay = p.offsetMin % 1440;
  const h = Math.floor(minOfDay / 60);
  const m = minOfDay % 60;
  const dow = DOW_NAMES[(startDow + day) % 7];
  return `${dow} ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function buildXTicks(overlay: CompareOverlay, periodAFromIso: string): Array<{ idx: number; label: string }> {
  if (overlay.alignment === "time-of-day") {
    // Tick every 4 hours: 00, 04, 08, 12, 16, 20, 24.
    const ticks: Array<{ idx: number; label: string }> = [];
    for (let h = 0; h <= 24; h += 4) {
      const idx = Math.min(overlay.totalSlots - 1, Math.round((h * 60) / overlay.slotMinutes));
      ticks.push({ idx, label: `${String(h).padStart(2, "0")}:00` });
    }
    return ticks;
  }
  // absolute-offset, day-of-week aligned: one tick at the start of each day.
  // Labels use the short DOW name (Mon, Tue, ...) — same DOW for both A
  // and B since the picker forces matching start DOW. For multi-week
  // periods we suffix with the week number (W2 Mon, W3 Mon, ...).
  const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const startDow = new Date(`${periodAFromIso}T00:00:00Z`).getUTCDay();
  const totalDays = Math.ceil((overlay.totalSlots * overlay.slotMinutes) / 1440);
  const ticks: Array<{ idx: number; label: string }> = [];
  // Pick an interval that keeps tick count under ~8 even for 28-day periods.
  const stride = totalDays <= 7 ? 1 : totalDays <= 14 ? 2 : 4;
  for (let day = 0; day < totalDays; day += stride) {
    const idx = Math.min(overlay.totalSlots - 1, Math.round((day * 1440) / overlay.slotMinutes));
    const dow = DOW_NAMES[(startDow + day) % 7];
    const weekNum = Math.floor(day / 7) + 1;
    const label = totalDays <= 7 ? dow : `W${weekNum} ${dow}`;
    ticks.push({ idx, label });
  }
  return ticks;
}

function buildPaths(
  points: OverlayPoint[],
  xs: (i: number) => number,
  ys: (v: number) => number,
): { aLine: string; aFill: string; bLine: string; bFill: string } {
  const buildLine = (pick: (p: OverlayPoint) => number | null): string => {
    let d = "";
    let pen = false;
    points.forEach((p, i) => {
      const v = pick(p);
      if (v === null) {
        pen = false;
        return;
      }
      const cmd = pen ? "L" : "M";
      d += `${cmd}${xs(i).toFixed(1)},${ys(v).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  };
  const buildFill = (pick: (p: OverlayPoint) => number | null): string => {
    // Build a fill path by stitching together each continuous segment.
    const segments: string[] = [];
    let segStart = -1;
    let segPath = "";
    let pen = false;
    points.forEach((p, i) => {
      const v = pick(p);
      if (v === null) {
        if (pen && segStart >= 0) {
          // Close segment.
          const lastX = xs(i - 1).toFixed(1);
          const startX = xs(segStart).toFixed(1);
          const baseY = ys(0).toFixed(1);
          segments.push(`${segPath} L${lastX},${baseY} L${startX},${baseY} Z`);
        }
        pen = false;
        segPath = "";
        segStart = -1;
        return;
      }
      if (!pen) {
        segStart = i;
        segPath = `M${xs(i).toFixed(1)},${ys(v).toFixed(1)}`;
      } else {
        segPath += ` L${xs(i).toFixed(1)},${ys(v).toFixed(1)}`;
      }
      pen = true;
      // Close trailing segment.
      if (i === points.length - 1) {
        const startX = xs(segStart).toFixed(1);
        const baseY = ys(0).toFixed(1);
        const endX = xs(i).toFixed(1);
        segments.push(`${segPath} L${endX},${baseY} L${startX},${baseY} Z`);
      }
    });
    return segments.join(" ");
  };
  return {
    aLine: buildLine((p) => p.aCpu),
    aFill: buildFill((p) => p.aCpu),
    bLine: buildLine((p) => p.bCpu),
    bFill: buildFill((p) => p.bCpu),
  };
}

function ChartHeader({
  meta, alignment, slotMinutes, onExport, exporting,
}: {
  meta: CompareMeta; alignment: CompareOverlay["alignment"]; slotMinutes: number;
  onExport: () => void; exporting: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 16, marginBottom: 8, flexWrap: "wrap" }}>
      <strong style={{ fontSize: 13, color: PALETTE.text }}>Mean CPU across selected hosts</strong>
      <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 11, color: PALETTE.axisText }}>
        <Legend color={PALETTE.aLine} label={meta.periodA.label || `${meta.periodA.from} → ${meta.periodA.to}`} subtitle={meta.periodA.label ? `${meta.periodA.from} → ${meta.periodA.to}` : ""} />
        <Legend color={PALETTE.bLine} label={meta.periodB.label || `${meta.periodB.from} → ${meta.periodB.to}`} subtitle={meta.periodB.label ? `${meta.periodB.from} → ${meta.periodB.to}` : ""} />
      </div>
      <span style={{ marginLeft: "auto", fontSize: 10, color: "#94a3b8" }}>
        {alignment === "time-of-day" ? "Aligned by time-of-day" : "Aligned by absolute offset"} · {slotMinutes}-min slots
      </span>
      <button
        type="button"
        onClick={onExport}
        disabled={exporting}
        style={{
          padding: "4px 10px", fontSize: 11, fontWeight: 500,
          background: "#fff", color: PALETTE.text,
          border: `1px solid ${PALETTE.border}`, borderRadius: 4,
          cursor: exporting ? "wait" : "pointer",
        }}
      >
        {exporting ? "Exporting…" : "⬇ Export PNG"}
      </button>
    </div>
  );
}

function Legend({ color, label, subtitle }: { color: string; label: string; subtitle: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 10, height: 10, background: color, borderRadius: 2 }} />
      <strong style={{ color: PALETTE.text }}>{label}</strong>
      {subtitle && <span>· {subtitle}</span>}
    </span>
  );
}
