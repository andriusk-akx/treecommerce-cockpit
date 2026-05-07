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
// "Other" mirrors the same bucket the drill-down shows beneath the four
// monitored processes — it's `system.cpu.util - (retellect + scoApp + db +
// system)` per minute, i.e. the CPU consumed by processes we don't track
// by name (kernel, services, IBM BigFix endpoint mgmt before it was
// categorised, antivirus, etc.). Useful when the user wants to see whether
// the "non-monitored" bucket is the actual mover.
const CATEGORIES = [
  { id: "scoApp", label: "SCO App (sp.sss)", color: "#f59f00" },
  { id: "retellect", label: "Retellect (python)", color: "#fa5252" },
  { id: "db", label: "DB (sqlservr)", color: "#9775fa" },
  { id: "system", label: "System (vmware-vmx)", color: "#0c8feb" },
  { id: "other", label: "Other (host − monitored)", color: "#94a3b8" },
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
   * windows). The card requests min(periodDays, MAX_TREND_DAYS) so the user
   * sees what's actually available. When the user picked a larger window
   * than Zabbix retains, we show a small note explaining the cap so the
   * mismatch with the heatmap header isn't confusing.
   */
  periodDays: number;
  /** Initial expanded state. Default false (preserves the heatmap-only workflow). */
  defaultExpanded?: boolean;
}

// Zabbix raw 1-min history retention on this deployment. Same constant
// `getCpuHistoryDaily` uses (effectiveDays = Math.min(days, 14)).
const MAX_TREND_DAYS = 14;

// ─── Component ──────────────────────────────────────────────────────

export function RtProcessTrend({ hostId, displayName, threshold, periodDays, defaultExpanded = false }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [category, setCategory] = useState<CategoryId>("scoApp");
  const [metric, setMetric] = useState<MetricId>("avg");

  const [days, setDays] = useState<DayPoint[]>([]);
  const [summary, setSummary] = useState<CompareSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasData, setHasData] = useState(false);

  // Effective fetch days = min(user's period, Zabbix retention cap). The
  // heatmap allows custom windows up to 365 d; raw 1-min history is only
  // retained ~14 d on this Zabbix, so anything beyond that returns empty
  // days. We clamp here and surface a tiny "capped at 14d" note when the
  // user asked for more, so the discrepancy with the heatmap header is
  // honest rather than silent.
  const requestedDays = Math.max(1, Math.floor(periodDays));
  const effectiveDays = Math.min(requestedDays, MAX_TREND_DAYS);
  const isCapped = requestedDays > effectiveDays;

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

    const points = days.map((d, i) => ({
      i,
      x: xForIdx(i, days.length),
      y: yForVal(metricValue(d)),
      mv: metricValue(d),
      d,
      hasData: d.totalSamples > 0,
    }));
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
          {hostId && isCapped && (
            <span
              style={{ fontSize: 10, color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, padding: "1px 6px" }}
              title={`Heatmap is showing ${requestedDays} d, but per-process Zabbix history is only retained for ${MAX_TREND_DAYS} d. The trend below covers the available window.`}
            >
              capped at {MAX_TREND_DAYS} d
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

              {/* SVG chart */}
              <svg
                viewBox={`0 0 ${chartW} ${chartH}`}
                xmlns="http://www.w3.org/2000/svg"
                style={{ width: "100%", height: chartH, display: "block" }}
                role="img"
                aria-label={`Per-day ${metricLabel} of ${CATEGORIES.find((c) => c.id === category)!.label} on ${displayName ?? "selected host"}, with Retellect ON/OFF day backgrounds.`}
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
                {chartPoints.map((p) => (
                  <g key={`pt-${p.d.date}`}>
                    {p.hasData ? (
                      <circle cx={p.x} cy={p.y} r={2.8} fill={chosenColor}>
                        <title>{`${p.d.date} · ${metricLabel}: ${formatVal(p.mv, yIsTime)} · Retellect ${p.d.retellectOn ? "ON" : "OFF"} (${p.d.totalSamples} samples)`}</title>
                      </circle>
                    ) : (
                      // No-data marker: small hollow circle near baseline so
                      // the user can see "we have a date here, just no data"
                      // instead of a missing tick.
                      <circle cx={p.x} cy={padT + innerH - 2} r={2} fill="#fff" stroke={C.textDim} strokeWidth={0.8}>
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
  return "system.cpu.util[,,avg1] (needed for Other = host − monitored)";
}
