"use client";

/**
 * Per-host "Process trend" card — sits under the CPU Timeline heatmap and
 * answers: "for the host I just drilled into, how did the chosen process's
 * daily CPU change across the last 14 days, and how does that compare with
 * the days when Retellect was running?"
 *
 * The card is collapsible and defaults closed so the heatmap workflow is
 * untouched. When expanded with no host drilled it shows an empty-state
 * prompt; when expanded with a drilled host it fetches /api/rt/process-trend
 * and renders a daily line chart (with Retellect ON/OFF bands behind) plus
 * an A/B compare row.
 *
 * Spec: spaces/.../memory/project_rt_process_trend.md
 */

import { useEffect, useMemo, useState } from "react";

// ─── Types (mirror the API response shape) ──────────────────────────

interface DayPoint {
  date: string;
  avg: number;
  peak: number;
  minutesAbove: number;
  totalSamples: number;
  retellectOn: boolean;
  /** Backend signals where the day's data came from. "trend" days have
   *  no honest minutesAbove reading (hourly aggregate ≠ minute counts). */
  source: "history" | "trend" | "none";
}

interface CompareSummary {
  onCount: number;
  offCount: number;
  onAvg: number | null;
  onPeak: number | null;
  offAvg: number | null;
  offPeak: number | null;
  deltaPp: number | null;
  deltaRel: number | null;
}

interface ApiResponse {
  days?: DayPoint[];
  summary?: CompareSummary;
  category?: string;
  threshold?: number;
  daysWindow?: number;
  hasData?: boolean;
  error?: string;
}

// ─── Constants ──────────────────────────────────────────────────────

// Categories mirror the existing CPU Timeline drill-down (RtTimeline.tsx).
// Order: SCO App first because it's the canonical "Retellect impact" lens
// for the SP admin investigation that drove this card's design.
//
// "Other" mirrors the same bucket the drill-down shows beneath the named
// processes — `system.cpu.util - (retellect + scoApp + db + system +
// besclient + elastic + osCore)` per minute. On hosts with the full
// 2026-05-12 telemetry this is what's genuinely unattributed (antivirus,
// scheduled tasks, processes outside the template). On hosts without
// BESClient / Elastic / kernel-CPU items the residual also still absorbs
// those cycles — useful for spotting where the new monitoring needs to
// roll out next.
const CATEGORIES = [
  { id: "scoApp", label: "SCO App (sp.sss)", color: "#f59f00" },
  { id: "retellect", label: "Retellect (python)", color: "#fa5252" },
  { id: "db", label: "DB (sqlservr)", color: "#9775fa" },
  { id: "system", label: "System (vmware-vmx)", color: "#0c8feb" },
  // 2026-05-12 — SP admin pulled BESClient, Elastic and the Windows OS
  // kernel out of "Other" on testlab_SPUB-P-SCO150. Each gets its own
  // dropdown option here so the user can trend any of them across days.
  // Hosts without the new items return zero series (UI shows "no data").
  { id: "besclient", label: "BESClient (BigFix)", color: "#10b981" },
  { id: "elastic", label: "Elastic (agent)", color: "#a3e635" },
  { id: "osCore", label: "OS Core (kernel)", color: "#f97316" },
  { id: "other", label: "Other (host − monitored)", color: "#94a3b8" },
  // "totalCpu" is the host-level CPU utilisation (system.cpu.util[,,avg1])
  // — the same value `sysCpuMax` / `sysCpuAvg` already drive in the
  // intra-day drill-down. Useful as a top-line "is this host busy at all?"
  // baseline against which the per-process slices can be compared.
  { id: "totalCpu", label: "Total host CPU", color: "#0f172a" },
] as const;
type CategoryId = typeof CATEGORIES[number]["id"];

const METRICS = [
  { id: "avg", label: "Daily avg" },
  { id: "peak", label: "Daily peak" },
  { id: "minAbove", label: "Min ≥ threshold" },
] as const;
type MetricId = typeof METRICS[number]["id"];

// Pulled from the same palette as RtTimeline's heatmap so the card visually
// belongs to the heatmap workspace rather than looking like a separate
// surface.
const C = {
  border: "#e9ecef",
  textSec: "#6c757d",
  textDim: "#94a3b8",
  bgPanel: "#fff",
  bgPage: "#fafbfc",
  onBandBg: "#fee2e2",
  onBandStroke: "#fca5a5",
  onText: "#7f1d1d",
  onSecondary: "#991b1b",
  offBandBg: "#f1f3f5",
  offText: "#212529",
  offSecondary: "#6c757d",
  deltaInfoBg: "#dbeafe",
  deltaInfoText: "#1e40af",
  deltaWarnBg: "#fef3c7",
  deltaWarnText: "#92400e",
} as const;

interface Props {
  /** Currently drilled host id (from RtTimeline drill state). null when no drill. */
  hostId: string | null;
  /** Drilled host display name — shown in card header when present. */
  displayName: string | null;
  /** Threshold from RtFiltersContext — drives Min≥threshold metric + chart guide line. */
  threshold: number;
  /**
   * Period in days from RtFiltersContext (1..365 — heatmap allows custom
   * windows). The card mirrors whatever the heatmap is showing exactly.
   * For periods within Zabbix's ~14 d raw history retention, every day is
   * `source: "history"` (sample-level accuracy + minutesAbove counter).
   * Older days fall back to `source: "trend"` (hourly aggregates only —
   * the minutesAbove metric stops being honest there and the UI hides it).
   */
  periodDays: number;
  /** Initial expanded state. Default false (preserves the heatmap-only workflow). */
  defaultExpanded?: boolean;
}

// Hard upper bound mirrored from the API route. Practically caps at Zabbix's
// trend retention (~365 d on a typical install).
const MAX_DAYS = 365;

// ─── Component ──────────────────────────────────────────────────────

export function RtProcessTrend({ hostId, displayName, threshold, periodDays, defaultExpanded = false }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [category, setCategory] = useState<CategoryId>("scoApp");
  const [metric, setMetric] = useState<MetricId>("avg");

  const [days, setDays] = useState<DayPoint[]>([]);
  const [summary, setSummary] = useState<CompareSummary | null>(null);
  // Index of the chart point the cursor is currently over. Drives the
  // hover tooltip shown above the chart. -1 = not hovering.
  const [hoveredIdx, setHoveredIdx] = useState<number>(-1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasData, setHasData] = useState(false);

  // Mirror whatever the heatmap is showing. The API route fetches BOTH
  // history.get (recent ≤14 d, sample-level) AND trend.get (older days,
  // hourly aggregate) and merges per day, so any window up to 365 d is
  // honestly served — the per-day `source` field then tells the UI which
  // metrics are trustworthy on each day.
  const effectiveDays = Math.max(1, Math.min(MAX_DAYS, Math.floor(periodDays)));

  // Fetch: only when the card is open AND a host is drilled. Closing the
  // card or clearing the drill resets local state so re-opening doesn't
  // briefly flash stale data from a different host.
  useEffect(() => {
    if (!expanded) return;
    if (!hostId) {
      setDays([]); setSummary(null); setHasData(false); setError(null);
      return;
    }
    let aborted = false;
    setLoading(true);
    setError(null);
    fetch(
      `/api/rt/process-trend?hostId=${encodeURIComponent(hostId)}&days=${effectiveDays}&category=${category}&threshold=${threshold}`,
    )
      .then((r) => r.json() as Promise<ApiResponse>)
      .then((d) => {
        if (aborted) return;
        if (d.error) {
          setError(d.error);
          setDays([]); setSummary(null); setHasData(false);
          return;
        }
        setDays(d.days ?? []);
        setSummary(d.summary ?? null);
        setHasData(!!d.hasData);
      })
      .catch((e: unknown) => {
        if (aborted) return;
        const msg = e instanceof Error ? e.message : "fetch failed";
        setError(msg);
        setDays([]); setSummary(null); setHasData(false);
      })
      .finally(() => { if (!aborted) setLoading(false); });
    return () => { aborted = true; };
  }, [expanded, hostId, category, threshold, effectiveDays]);

  const chosenColor = CATEGORIES.find((c) => c.id === category)!.color;
  const metricLabel = METRICS.find((m) => m.id === metric)!.label;

  // How many days in the response use trend.get hourly aggregates instead
  // of raw 1-min history. Drives a small "N d hourly-only" header chip and
  // the per-day dot tooltip so the user knows where Min-≥-threshold readings
  // start being unavailable.
  const trendOnlyDayCount = days.filter((d) => d.source === "trend").length;
  const hasTrendOnlyDays = trendOnlyDayCount > 0;

  // Chart layout — fixed pixel dimensions for SVG, scales via parent CSS.
  const chartW = 620;
  const chartH = 180;
  const padL = 40;
  const padR = 40;
  const padT = 16;
  const padB = 30;
  const innerW = chartW - padL - padR;
  const innerH = chartH - padT - padB;

  // All chart-derived data (axis scale + per-point coords) is computed in one
  // pass keyed off `days` + `metric`. Doing it as a single memoised block keeps
  // the React Compiler happy (no closure-captured helpers as inferred deps)
  // and avoids the prior shape where `metricValue` was a per-render closure.
  const chartData = useMemo(() => {
    // Map metric id → which DayPoint field to read.
    const metricValue = (d: DayPoint): number => {
      if (metric === "avg") return d.avg;
      if (metric === "peak") return d.peak;
      return d.minutesAbove;
    };

    // Y-axis scaling: percent metrics (avg/peak) lock to 0–100. minutesAbove
    // scales to the largest day's value (rounded up to 60m increments) so a
    // "max 5 min above" day uses the full chart height instead of looking flat
    // against an implicit 1440-cap.
    let yMin = 0;
    let yMax = 100;
    let yLabels: number[] = [0, 25, 50, 75, 100];
    let yIsTime = false;
    if (metric === "minAbove") {
      const peakAbove = days.reduce((m, d) => Math.max(m, d.minutesAbove), 0);
      const max = Math.max(60, Math.ceil(peakAbove / 60) * 60);
      yMin = 0;
      yMax = max;
      yLabels = [0, max / 4, max / 2, (3 * max) / 4, max].map((v) => Math.round(v));
      yIsTime = true;
    }

    const xForIdx = (i: number, n: number) => {
      if (n <= 1) return padL + innerW / 2;
      return padL + (innerW * i) / (n - 1);
    };
    const yForVal = (v: number) => {
      if (yMax <= yMin) return padT + innerH;
      const clamped = Math.max(yMin, Math.min(yMax, v));
      return padT + innerH * (1 - (clamped - yMin) / (yMax - yMin));
    };

    const points = days.map((d, i) => {
      // For Min-≥-threshold metric, treat trend-source days as "no data" —
      // hourly aggregates can't honestly say "X minutes above Y%". The day
      // still renders as a hollow tick so the gap is visible, just like
      // genuinely-empty days. Other metrics (avg, peak) work fine on trend.
      const honestForMetric =
        metric === "minAbove" ? d.source === "history" : d.source !== "none";
      return {
        i,
        x: xForIdx(i, days.length),
        y: yForVal(metricValue(d)),
        mv: metricValue(d),
        d,
        hasData: d.totalSamples > 0 && honestForMetric,
      };
    });
    const polyPoints = points
      .filter((p) => p.hasData)
      .map((p) => `${p.x},${p.y}`)
      .join(" ");
    return { yMin, yMax, yLabels, yIsTime, points, polyPoints, yForVal };
  }, [days, metric, innerH, innerW]);

  const { yMin, yMax, yLabels, yIsTime, points: chartPoints, polyPoints, yForVal } = chartData;

  // X-axis tick density — show every 3rd date so 14 dates = 5 visible labels.
  const tickEvery = days.length > 8 ? 3 : 1;

  // ─── Render ──────────────────────────────────────────────────────

  return (
    <section
      style={{
        marginTop: 16,
        background: C.bgPanel,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      {/* Header — always visible, click to expand/collapse */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          width: "100%",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 14px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
        }}
        title={expanded ? "Collapse" : "Expand"}
        aria-expanded={expanded}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 11, color: C.textDim, width: 10 }}>
            {expanded ? "▼" : "▶"}
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, color: "#212529" }}>
            Process trend
          </span>
          <span style={{ fontSize: 11, color: C.textSec }}>
            {hostId
              ? `— ${displayName ?? "selected host"} · ${effectiveDays} d`
              : "— pick a host in the heatmap"}
          </span>
          {hostId && hasTrendOnlyDays && (
            <span
              style={{ fontSize: 10, color: "#475569", background: "#f1f5f9", border: "1px solid #cbd5e1", borderRadius: 10, padding: "1px 6px" }}
              title={`Days older than Zabbix's raw-history window (~14 d) use hourly trend aggregates. avg / peak are still accurate; the "Min ≥ threshold" metric is hidden on those days because hourly aggregates can't honestly answer it.`}
            >
              {trendOnlyDayCount} d hourly-only
            </span>
          )}
        </div>
        {expanded && hostId && (
          <span style={{ fontSize: 10, color: C.textDim }}>
            {loading ? "loading…" : hasData ? "live" : "no data"}
          </span>
        )}
      </button>

      {/* Body — only rendered when expanded */}
      {expanded && (
        <div style={{ padding: "4px 14px 14px", borderTop: `1px solid ${C.border}` }}>
          {/* Controls row */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 10,
              padding: "10px 0",
            }}
          >
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: C.textSec }}>
              Process
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as CategoryId)}
                style={{
                  fontSize: 11,
                  padding: "3px 6px",
                  borderRadius: 4,
                  border: `1px solid ${C.border}`,
                  background: C.bgPanel,
                  color: "#212529",
                }}
              >
                {CATEGORIES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: C.textSec }}>
              Metric
              <select
                value={metric}
                onChange={(e) => setMetric(e.target.value as MetricId)}
                style={{
                  fontSize: 11,
                  padding: "3px 6px",
                  borderRadius: 4,
                  border: `1px solid ${C.border}`,
                  background: C.bgPanel,
                  color: "#212529",
                }}
              >
                {METRICS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id === "minAbove" ? `${m.label} (${threshold}%)` : m.label}
                  </option>
                ))}
              </select>
            </label>

            <span style={{ fontSize: 10, color: C.textDim, marginLeft: "auto", fontStyle: "italic" }}>
              Pasirink procesą, kurio elgseną tikrini
            </span>
          </div>

          {/* Empty / loading / error states. The empty-host state is the
              most common surface — shown the moment the user expands the
              card without having drilled into a host. */}
          {!hostId && (
            <EmptyState
              title="Drill into a host to see its trend"
              body="Click any host row above. The card then shows that host's per-day CPU for the chosen process across 14 days."
            />
          )}
          {hostId && loading && (
            <EmptyState title="Loading…" body="Fetching 14 days of per-process history from Zabbix." />
          )}
          {hostId && !loading && error && (
            <EmptyState
              title="Couldn't load"
              body={error}
              tone="error"
            />
          )}
          {hostId && !loading && !error && days.length > 0 && (
            <>
              {/* Legend row */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 14, fontSize: 10, color: C.textSec, marginBottom: 4 }}>
                <LegendChip color={C.onBandBg} border={C.onBandStroke} label="Retellect ON day" />
                <LegendChip color={C.offBandBg} border={C.border} label="Retellect OFF day" />
                <LegendLine color={chosenColor} label={`${CATEGORIES.find((c) => c.id === category)!.label} · ${metricLabel}${yIsTime ? " (min)" : " (%)"}`} />
                {!yIsTime && (
                  <LegendLine color="#cbd5e1" dashed label={`Threshold ${threshold}%`} />
                )}
              </div>

              {/* SVG chart wrapped in a relative-positioned container so
                  the hover tooltip below can absolutely-position itself
                  next to the active data point. The tooltip uses the
                  point's x as a percentage of the SVG viewBox width — so
                  it stays aligned even when the SVG scales responsively. */}
              <div style={{ position: "relative" }}>
              <svg
                viewBox={`0 0 ${chartW} ${chartH}`}
                xmlns="http://www.w3.org/2000/svg"
                style={{ width: "100%", height: chartH, display: "block" }}
                role="img"
                aria-label={`Per-day ${metricLabel} of ${CATEGORIES.find((c) => c.id === category)!.label} on ${displayName ?? "selected host"}, with Retellect ON/OFF day backgrounds.`}
                onMouseLeave={() => setHoveredIdx(-1)}
              >
                {/* Day backgrounds (Retellect ON/OFF bands). One rect per day,
                    each centred on its x-position so the user can map cell →
                    day visually. We compute width as the gap between adjacent
                    point x-positions, then expand by half on each side. */}
                {chartPoints.map((p, i) => {
                  const prev = chartPoints[i - 1];
                  const next = chartPoints[i + 1];
                  const leftEdge = prev ? (prev.x + p.x) / 2 : padL;
                  const rightEdge = next ? (p.x + next.x) / 2 : padL + innerW;
                  const w = Math.max(2, rightEdge - leftEdge);
                  const fill = p.d.retellectOn ? C.onBandBg : C.offBandBg;
                  return (
                    <rect
                      key={`bg-${p.d.date}`}
                      x={leftEdge}
                      y={padT}
                      width={w}
                      height={innerH}
                      fill={fill}
                      opacity={p.d.retellectOn ? 0.55 : 0.35}
                    />
                  );
                })}

                {/* Y gridlines + labels */}
                {yLabels.map((v) => (
                  <g key={`y-${v}`}>
                    <line
                      x1={padL}
                      y1={yForVal(v)}
                      x2={chartW - padR}
                      y2={yForVal(v)}
                      stroke={C.border}
                      strokeWidth={0.5}
                      strokeDasharray={v === yMin || v === yMax ? "0" : "2 3"}
                    />
                    <text
                      x={padL - 6}
                      y={yForVal(v) + 3}
                      fontSize={9}
                      fill={C.textDim}
                      textAnchor="end"
                    >
                      {v}
                    </text>
                  </g>
                ))}

                {/* Threshold reference line — only meaningful for percent metrics. */}
                {!yIsTime && (
                  <line
                    x1={padL}
                    y1={yForVal(threshold)}
                    x2={chartW - padR}
                    y2={yForVal(threshold)}
                    stroke="#cbd5e1"
                    strokeWidth={0.8}
                    strokeDasharray="4 3"
                  />
                )}

                {/* Line + dots */}
                {polyPoints.length > 0 && (
                  <polyline
                    points={polyPoints}
                    fill="none"
                    stroke={chosenColor}
                    strokeWidth={1.5}
                    strokeLinejoin="round"
                  />
                )}
                {chartPoints.map((p, i) => (
                  <g
                    key={`pt-${p.d.date}`}
                    onMouseEnter={() => setHoveredIdx(i)}
                    style={{ cursor: "default" }}
                  >
                    {/* Invisible hover-target — wide enough to make the
                        small dots forgiving to hover. Sits BEHIND the
                        visible mark so visuals don't change. */}
                    <rect
                      x={p.x - (innerW / Math.max(1, chartPoints.length - 1)) / 2}
                      y={padT}
                      width={Math.max(8, innerW / Math.max(1, chartPoints.length - 1))}
                      height={innerH}
                      fill="transparent"
                      pointerEvents="all"
                    />
                    {p.hasData ? (
                      <circle
                        cx={p.x}
                        cy={p.y}
                        r={hoveredIdx === i ? 4.2 : 2.8}
                        fill={chosenColor}
                        // Native SVG title is the keyboard-only fallback;
                        // the visible HTML tooltip below is the primary UX.
                      >
                        <title>{`${p.d.date} · ${metricLabel}: ${formatVal(p.mv, yIsTime)} · Retellect ${p.d.retellectOn ? "ON" : "OFF"}`}</title>
                      </circle>
                    ) : (
                      // No-data marker: small hollow circle near baseline so
                      // the user can see "we have a date here, just no data"
                      // instead of a missing tick.
                      <circle cx={p.x} cy={padT + innerH - 2} r={hoveredIdx === i ? 3 : 2} fill="#fff" stroke={C.textDim} strokeWidth={0.8}>
                        <title>{`${p.d.date} · no samples`}</title>
                      </circle>
                    )}
                  </g>
                ))}

                {/* X-axis labels (every Nth day) */}
                {chartPoints.map((p, i) => (
                  i % tickEvery === 0 ? (
                    <text
                      key={`x-${p.d.date}`}
                      x={p.x}
                      y={chartH - 8}
                      fontSize={9}
                      fill={C.textDim}
                      textAnchor="middle"
                    >
                      {p.d.date.slice(5)}
                    </text>
                  ) : null
                ))}
              </svg>

              {/* Hover tooltip — single absolute-positioned card aligned
                  to the active data point's x (as a percentage of the
                  SVG viewBox). React rebuilds it on every hoveredIdx
                  change, so updates feel instant. We position the
                  tooltip ABOVE the chart's centre line by default; if
                  the hovered point's x is on the right half of the
                  chart, we flip the card to the left of the cursor so
                  it doesn't overflow the container. */}
              {hoveredIdx >= 0 && hoveredIdx < chartPoints.length && (() => {
                const hp = chartPoints[hoveredIdx];
                const xPct = (hp.x / chartW) * 100;
                const flipLeft = xPct > 60;
                return (
                  <div
                    style={{
                      position: "absolute",
                      top: 4,
                      left: `${xPct}%`,
                      transform: flipLeft ? "translateX(calc(-100% - 6px))" : "translateX(6px)",
                      pointerEvents: "none",
                      background: "#fff",
                      border: `1px solid ${C.border}`,
                      borderRadius: 6,
                      padding: "6px 10px",
                      fontSize: 11,
                      color: "#212529",
                      whiteSpace: "nowrap",
                      boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
                      zIndex: 5,
                    }}
                  >
                    <div style={{ fontWeight: 600, marginBottom: 2 }}>{hp.d.date}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{
                        display: "inline-block", width: 8, height: 8, borderRadius: "50%",
                        background: chosenColor,
                      }} />
                      <span style={{ color: C.textSec }}>{metricLabel}:</span>
                      <span style={{ fontFamily: "'SF Mono','Cascadia Code',monospace", fontWeight: 600 }}>
                        {hp.d.totalSamples > 0 ? formatVal(hp.mv, yIsTime) : "—"}
                      </span>
                    </div>
                    <div style={{ fontSize: 10, color: C.textDim, marginTop: 2 }}>
                      Retellect{" "}
                      <span style={{ color: hp.d.retellectOn ? C.onSecondary : C.offSecondary, fontWeight: 600 }}>
                        {hp.d.retellectOn ? "ON" : "OFF"}
                      </span>
                      {hp.d.totalSamples > 0 && (
                        <span style={{ marginLeft: 6 }}>
                          · {hp.d.source === "trend" ? `${hp.d.totalSamples} hourly` : `${hp.d.totalSamples} samples`}
                        </span>
                      )}
                      {hp.d.totalSamples === 0 && (
                        <span style={{ marginLeft: 6 }}>· no samples</span>
                      )}
                    </div>
                  </div>
                );
              })()}
              </div>

              {/* A/B compare row */}
              {summary && (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr 1fr",
                    gap: 8,
                    marginTop: 12,
                  }}
                >
                  <CompareCard
                    label={`Retellect ON · ${summary.onCount} d`}
                    bg={C.onBandBg}
                    border={C.onBandStroke}
                    text={C.onText}
                    secondary={C.onSecondary}
                    avg={summary.onAvg}
                    peak={summary.onPeak}
                    yIsTime={yIsTime}
                    metric={metric}
                  />
                  <CompareCard
                    label={`Retellect OFF · ${summary.offCount} d`}
                    bg={C.offBandBg}
                    border={C.border}
                    text={C.offText}
                    secondary={C.offSecondary}
                    avg={summary.offAvg}
                    peak={summary.offPeak}
                    yIsTime={yIsTime}
                    metric={metric}
                  />
                  <DeltaCard
                    summary={summary}
                    metric={metric}
                    category={category}
                    yIsTime={yIsTime}
                  />
                </div>
              )}

              {/* No-data note */}
              {!hasData && (
                <p style={{ fontSize: 10, color: C.textDim, marginTop: 8, marginBottom: 0, fontStyle: "italic" }}>
                  This host has not published <code>{categoryItemHint(category)}</code> samples in the last 14 days.
                </p>
              )}
            </>
          )}
          {hostId && !loading && !error && days.length === 0 && (
            <EmptyState
              title="No data"
              body="Server returned no days. The host may have been added recently or is missing the per-process Zabbix items."
            />
          )}
        </div>
      )}
    </section>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────

function EmptyState({ title, body, tone = "info" }: { title: string; body: string; tone?: "info" | "error" }) {
  const bg = tone === "error" ? "#fef2f2" : "#f8fafc";
  const stroke = tone === "error" ? "#fecaca" : C.border;
  const titleColor = tone === "error" ? "#991b1b" : "#475569";
  return (
    <div
      style={{
        background: bg,
        border: `1px dashed ${stroke}`,
        borderRadius: 6,
        padding: "14px 16px",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, color: titleColor, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 11, color: C.textSec, lineHeight: 1.5 }}>{body}</div>
    </div>
  );
}

function LegendChip({ color, border, label }: { color: string; border: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span style={{
        display: "inline-block",
        width: 10,
        height: 10,
        background: color,
        border: `0.5px solid ${border}`,
        borderRadius: 2,
      }} />
      {label}
    </span>
  );
}

function LegendLine({ color, label, dashed = false }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <svg width="14" height="6" viewBox="0 0 14 6">
        <line
          x1="0"
          y1="3"
          x2="14"
          y2="3"
          stroke={color}
          strokeWidth="1.5"
          strokeDasharray={dashed ? "2 2" : undefined}
        />
      </svg>
      {label}
    </span>
  );
}

function CompareCard({
  label, bg, border, text, secondary, avg, peak, yIsTime, metric,
}: {
  label: string;
  bg: string; border: string; text: string; secondary: string;
  avg: number | null; peak: number | null;
  yIsTime: boolean;
  metric: MetricId;
}) {
  return (
    <div
      style={{
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: 6,
        padding: "10px 12px",
      }}
    >
      <div style={{ fontSize: 11, color: secondary, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: text, fontFamily: "'SF Mono','Cascadia Code',monospace" }}>
        {avg === null ? "—" : formatVal(avg, yIsTime)}{" "}
        <span style={{ fontSize: 11, color: secondary, fontWeight: 400 }}>
          {metric === "peak" ? "peak" : "avg"}
        </span>
      </div>
      <div style={{ fontSize: 11, color: secondary }}>
        {peak === null ? "—" : `peak ${formatVal(peak, yIsTime)}`}
      </div>
    </div>
  );
}

function DeltaCard({
  summary, metric, category, yIsTime,
}: {
  summary: CompareSummary;
  metric: MetricId;
  category: CategoryId;
  yIsTime: boolean;
}) {
  // For the retellect category itself, "Retellect OFF days have lower
  // python = expected, not a Retellect benefit". Show a neutral hint
  // instead of the ΔPp arrow which would always be confusing here.
  const isSelfReference = category === "retellect";

  if (summary.deltaPp === null || isSelfReference) {
    return (
      <div
        style={{
          background: C.bgPage,
          border: `1px solid ${C.border}`,
          borderRadius: 6,
          padding: "10px 12px",
        }}
      >
        <div style={{ fontSize: 11, color: C.textSec, marginBottom: 2 }}>Δ with Retellect</div>
        <div style={{ fontSize: 14, color: C.textSec, fontStyle: "italic" }}>
          {isSelfReference
            ? "n/a (own metric)"
            : "n/a (need ON & OFF days)"}
        </div>
      </div>
    );
  }
  // Negative ΔPp = CPU dropped when Retellect was ON → the win we want.
  // Positive = CPU went UP → flag it amber so the user notices.
  const win = summary.deltaPp < 0;
  const sign = summary.deltaPp > 0 ? "+" : "";
  const tone = win
    ? { bg: C.deltaInfoBg, border: "#bfdbfe", text: C.deltaInfoText }
    : { bg: C.deltaWarnBg, border: "#fde68a", text: C.deltaWarnText };
  return (
    <div
      style={{
        background: tone.bg,
        border: `1px solid ${tone.border}`,
        borderRadius: 6,
        padding: "10px 12px",
      }}
    >
      <div style={{ fontSize: 11, color: tone.text, marginBottom: 2 }}>Δ with Retellect</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: tone.text, fontFamily: "'SF Mono','Cascadia Code',monospace" }}>
        {sign}{formatVal(summary.deltaPp, yIsTime, true)}{" "}
        <span style={{ fontSize: 11, fontWeight: 400 }}>{yIsTime ? "min" : "pp"}</span>
      </div>
      <div style={{ fontSize: 11, color: tone.text }}>
        {summary.deltaRel === null
          ? ""
          : `${summary.deltaRel > 0 ? "+" : ""}${formatVal(summary.deltaRel, false, true)}% relative`}
      </div>
    </div>
  );
}

// ─── Format helpers ────────────────────────────────────────────────

function formatVal(v: number, isTime: boolean, signed: boolean = false): string {
  if (isTime) {
    // minutesAbove → human-friendly minutes / hours.
    const abs = Math.abs(v);
    const sign = signed && v < 0 ? "-" : "";
    if (abs >= 60) {
      const h = abs / 60;
      return `${sign}${Math.round(h * 10) / 10} h`;
    }
    return `${sign}${Math.round(abs)} min`;
  }
  return `${Math.round(v * 10) / 10}%`;
}

function categoryItemHint(c: CategoryId): string {
  if (c === "retellect") return "python.cpu / python1.cpu / …";
  if (c === "scoApp") return "spss.cpu / sp.sss.cpu";
  if (c === "db") return "sql.cpu / sqlservr.cpu";
  if (c === "system") return "vm.cpu / vmware-vmx.cpu";
  if (c === "besclient") return "besclient.cpu / perf_counter[\\Process(besclient)]";
  if (c === "elastic") return "elastic.cpu / perf_counter[\\Process(elastic-agent)]";
  if (c === "osCore") return "system.cpu.util[,system] (kernel-mode CPU)";
  if (c === "totalCpu") return "system.cpu.util[,,avg1] (host-level CPU utilisation)";
  return "system.cpu.util[,,avg1] (needed for Other = host − monitored)";
}
