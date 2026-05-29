"use client";

import { useMemo, useState } from "react";
import type { CompareHostRow, CompareMeta } from "./types";
import { exportHostsCsv } from "./CompareExports";

/**
 * Sortable host delta table with inline sparklines and drill-down expansion.
 *
 * Spec §6.4:
 *   - default sort by deltaMinutesPct ascending (best improvements first)
 *   - colour Δ column: green improvement, red regression, neutral ±2pp noise
 *   - sparkline overlays per-day minutesAbove counts for periods A & B
 *   - row click toggles per-day breakdown sub-row
 */

const PALETTE = {
  aBlue: "#2563eb",
  aBlueBg: "#dbeafe",
  bOrange: "#f97316",
  bOrangeBg: "#ffedd5",
  improve: "#16a34a",
  regress: "#ef4444",
  neutral: "#64748b",
  text: "#0f172a",
  textSec: "#64748b",
  border: "#e2e8f0",
  card: "#ffffff",
  rowAlt: "#f8fafc",
  rowOpen: "#eff6ff",
  drilldownBg: "#f8fafc",
} as const;

type SortKey =
  | "host" | "store" | "cpu"
  | "aMinutes" | "bMinutes" | "deltaAbs" | "deltaPct"
  | "aMean" | "bMean";
type SortDir = "asc" | "desc";
type GroupBy = "host" | "cpuModel";

export function CompareHostTable({
  rows,
  threshold,
  periodLengthDays,
  meta,
}: {
  rows: CompareHostRow[];
  threshold: number;
  periodLengthDays: number;
  meta: CompareMeta;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("deltaPct");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [expandedHostId, setExpandedHostId] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>("host");

  // When groupBy = "cpuModel", collapse the host list into one synthetic row
  // per CPU model that sums minutes, weight-averages mean CPU, and
  // element-wise sums sparklines across member hosts.
  const displayRows = useMemo(
    () => (groupBy === "cpuModel" ? aggregateByCpuModel(rows, periodLengthDays) : rows),
    [rows, groupBy, periodLengthDays],
  );
  const sorted = useMemo(() => sortRows(displayRows, sortKey, sortDir, groupBy), [displayRows, sortKey, sortDir, groupBy]);

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(k);
      // Numeric defaults make sense as asc; text defaults to asc anyway.
      setSortDir("asc");
    }
  };

  // Fleet summary for the footer ribbon.
  const summary = useMemo(() => {
    let improved = 0, regressed = 0, neutral = 0, netDelta = 0;
    for (const r of rows) {
      if (r.hostScope !== "both") continue;
      netDelta += r.deltaMinutesAbs;
      if (r.deltaMinutesPct == null) { neutral++; continue; }
      if (Math.abs(r.deltaMinutesPct) <= 2) neutral++;
      else if (r.deltaMinutesPct < 0) improved++;
      else regressed++;
    }
    return { improved, regressed, neutral, netDelta };
  }, [rows]);

  return (
    <div style={{
      background: PALETTE.card,
      border: `1px solid ${PALETTE.border}`,
      borderRadius: 8,
      padding: 16,
    }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 8, gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 13, color: PALETTE.text }}>
          {groupBy === "cpuModel" ? "Per-CPU-model comparison" : "Per-host comparison"}
        </strong>
        <span style={{ fontSize: 11, color: PALETTE.textSec }}>
          {groupBy === "cpuModel" ? `${displayRows.length} models, ${rows.length} hosts` : `${rows.length} hosts`}
          {" · "}sorted by {sortKey} {sortDir === "asc" ? "↑" : "↓"}
        </span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: PALETTE.textSec }}>Group by</span>
        <div style={{ display: "inline-flex", gap: 0 }}>
          <button
            type="button"
            onClick={() => { setGroupBy("host"); setExpandedHostId(null); }}
            style={groupBtnStyle(groupBy === "host", "left")}
          >Host</button>
          <button
            type="button"
            onClick={() => { setGroupBy("cpuModel"); setExpandedHostId(null); }}
            style={groupBtnStyle(groupBy === "cpuModel", "right")}
          >CPU model</button>
        </div>
        <button
          type="button"
          onClick={() => exportHostsCsv(meta, displayRows)}
          style={{
            padding: "4px 10px", fontSize: 11, fontWeight: 500,
            background: "#fff", color: PALETTE.text,
            border: `1px solid ${PALETTE.border}`, borderRadius: 4,
            cursor: "pointer",
          }}
        >
          ⬇ Export CSV
        </button>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse", minWidth: 820 }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${PALETTE.border}` }}>
              <Th label={groupBy === "cpuModel" ? "CPU model" : "Host"} k="host" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="left" />
              {groupBy === "host" && (
                <Th label="Store" k="store" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="left" />
              )}
              {groupBy === "host" && (
                <Th label="CPU" k="cpu" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="left" />
              )}
              {groupBy === "cpuModel" && (
                <th style={{ padding: "6px 8px", fontSize: 11, fontWeight: 600, textAlign: "right", color: PALETTE.text }}>Hosts</th>
              )}
              <Th label={`Min>${threshold} A`} k="aMinutes" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
              <Th label={`Min>${threshold} B`} k="bMinutes" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
              <Th label="Δ abs" k="deltaAbs" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
              <Th label="Δ %" k="deltaPct" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
              <Th label="Mean A" k="aMean" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
              <Th label="Mean B" k="bMean" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
              <th style={{ padding: "6px 8px", fontSize: 11, fontWeight: 600, textAlign: "center", color: PALETTE.text }}>Per-day</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, i) => (
              <HostRow
                key={row.hostId}
                row={row}
                idx={i}
                expanded={expandedHostId === row.hostId}
                onToggle={() => setExpandedHostId(expandedHostId === row.hostId ? null : row.hostId)}
                threshold={threshold}
                periodLengthDays={periodLengthDays}
                groupBy={groupBy}
              />
            ))}
          </tbody>
        </table>
      </div>

      <div style={{
        marginTop: 12, padding: "8px 12px",
        background: PALETTE.rowAlt, borderRadius: 6,
        fontSize: 11, color: PALETTE.textSec,
        display: "flex", gap: 16, flexWrap: "wrap",
      }}>
        <span><strong style={{ color: PALETTE.text }}>{rows.length}</strong> hosts ·</span>
        <span style={{ color: PALETTE.improve }}>● {summary.improved} improved</span>
        <span style={{ color: PALETTE.regress }}>● {summary.regressed} regressed</span>
        <span>● {summary.neutral} noise</span>
        <span style={{ marginLeft: "auto" }}>
          Net Δ across fleet:{" "}
          <strong style={{ color: summary.netDelta < 0 ? PALETTE.improve : summary.netDelta > 0 ? PALETTE.regress : PALETTE.neutral }}>
            {summary.netDelta > 0 ? "+" : ""}{summary.netDelta} min above {threshold}%
          </strong>
        </span>
      </div>
    </div>
  );
}

function Th({
  label, k, sortKey, sortDir, onSort, align,
}: {
  label: string; k: SortKey; sortKey: SortKey; sortDir: SortDir;
  onSort: (k: SortKey) => void; align: "left" | "right";
}) {
  const active = k === sortKey;
  return (
    <th
      onClick={() => onSort(k)}
      style={{
        padding: "6px 8px", fontSize: 11, fontWeight: 600,
        color: PALETTE.text, textAlign: align,
        cursor: "pointer", userSelect: "none",
        whiteSpace: "nowrap",
        background: active ? "#f1f5f9" : "transparent",
      }}
    >
      {label}
      <span style={{ marginLeft: 4, color: active ? PALETTE.text : "#cbd5e1" }}>
        {active ? (sortDir === "asc" ? "↑" : "↓") : "↕"}
      </span>
    </th>
  );
}

function HostRow({
  row, idx, expanded, onToggle, threshold, periodLengthDays, groupBy,
}: {
  row: CompareHostRow; idx: number; expanded: boolean; onToggle: () => void;
  threshold: number; periodLengthDays: number; groupBy: GroupBy;
}) {
  const noisy = row.deltaMinutesPct != null && Math.abs(row.deltaMinutesPct) <= 2;
  const positive = row.deltaMinutesPct != null && row.deltaMinutesPct > 2;
  const negative = row.deltaMinutesPct != null && row.deltaMinutesPct < -2;
  const color = noisy ? PALETTE.neutral : positive ? PALETTE.regress : negative ? PALETTE.improve : PALETTE.neutral;
  const rowBg = expanded ? PALETTE.rowOpen : (idx % 2 === 1 ? PALETTE.rowAlt : PALETTE.card);
  const valueA = row.hostScope === "added-in-b" ? "—" : row.aMinutesAbove.toLocaleString("en-US");
  const valueB = row.bMinutesAbove.toLocaleString("en-US");
  const deltaText = row.hostScope === "added-in-b" ? "—"
    : row.deltaMinutesAbs > 0 ? `+${row.deltaMinutesAbs}` : `${row.deltaMinutesAbs}`;
  const deltaPctText = row.deltaMinutesPct == null ? "—"
    : `${row.deltaMinutesPct > 0 ? "+" : ""}${row.deltaMinutesPct}%`;

  return (
    <>
      <tr style={{ background: rowBg, borderBottom: `1px solid ${PALETTE.border}`, cursor: "pointer" }} onClick={onToggle}>
        <td style={td}>
          <span style={{ marginRight: 6, color: PALETTE.textSec }}>{expanded ? "▾" : "▸"}</span>
          <span style={{ fontWeight: 500 }}>
            {groupBy === "cpuModel" ? (row.cpuModel ?? "Unknown CPU") : row.hostName}
          </span>
          {row.hostScope === "added-in-b" && (
            <span style={badge("#dcfce7", "#166534")}>added in B</span>
          )}
          {row.hostScope === "removed-before-b" && (
            <span style={badge("#fee2e2", "#991b1b")}>removed before B</span>
          )}
        </td>
        {groupBy === "host" && <td style={td}>{row.storeName}</td>}
        {groupBy === "host" && (
          <td style={td}>
            {row.cpuModel ?? "—"}
            {row.cpuCores ? <span style={{ color: PALETTE.textSec, marginLeft: 4 }}>· {row.cpuCores}c</span> : null}
          </td>
        )}
        {groupBy === "cpuModel" && (
          <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
            {/* hostCount is encoded into aSamples-as-row-count when grouped; show it instead. */}
            {row.cpuCores ?? "—"}
          </td>
        )}
        <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{valueA}</td>
        <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{valueB}</td>
        <td style={{ ...td, textAlign: "right", color, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>{deltaText}</td>
        <td style={{ ...td, textAlign: "right", color, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>{deltaPctText}</td>
        <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{row.aMeanCpu}%</td>
        <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{row.bMeanCpu}%</td>
        <td style={{ padding: "4px 8px" }}>
          <Sparkline a={row.aSparkline} b={row.bSparkline} periodLengthDays={periodLengthDays} />
        </td>
      </tr>
      {expanded && (
        <tr style={{ background: PALETTE.drilldownBg }}>
          <td colSpan={groupBy === "host" ? 10 : 9} style={{ padding: 0 }}>
            <Drilldown row={row} periodLengthDays={periodLengthDays} threshold={threshold} />
          </td>
        </tr>
      )}
    </>
  );
}

function Sparkline({ a, b, periodLengthDays }: { a: number[]; b: number[]; periodLengthDays: number }) {
  const days = Math.max(periodLengthDays, 1);
  // For very long periods (42-day max) the bars would be sub-pixel narrow at
  // the default 120 px width. Scale the chart width proportionally so each
  // A/B bar pair is at least ~3 px wide.
  const MIN_PAIR_PX = 3;
  const W = Math.max(120, days * MIN_PAIR_PX * 2 + 4);
  const H = 32;
  const PAD = 1;
  // max is guaranteed ≥ 1 by Math.max(1, ...), so the previous `max === 0`
  // branch was dead; height math below assumes positive max.
  const max = Math.max(1, ...a, ...b);
  // Pad both sparklines to periodLengthDays length so missing days render as 0.
  const padTo = (arr: number[]) => {
    if (arr.length >= days) return arr.slice(0, days);
    const out = arr.slice();
    while (out.length < days) out.push(0);
    return out;
  };
  const aPad = padTo(a);
  const bPad = padTo(b);
  // Two bars per day (A then B) with a 1-unit gap between them.
  const slotW = (W - PAD * 2) / days;
  const barW = Math.max(1, slotW / 2 - 0.5);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ display: "block" }}>
      {aPad.map((v, i) => {
        const x = PAD + i * slotW;
        const h = (v / max) * (H - 2);
        const y = H - 1 - h;
        return <rect key={`a-${i}`} x={x} y={y} width={barW} height={h} fill={PALETTE.aBlue} rx={1} />;
      })}
      {bPad.map((v, i) => {
        const x = PAD + i * slotW + barW + 0.5;
        const h = (v / max) * (H - 2);
        const y = H - 1 - h;
        return <rect key={`b-${i}`} x={x} y={y} width={barW} height={h} fill={PALETTE.bOrange} rx={1} />;
      })}
    </svg>
  );
}

function Drilldown({
  row, periodLengthDays, threshold,
}: {
  row: CompareHostRow; periodLengthDays: number; threshold: number;
}) {
  const days = Array.from({ length: periodLengthDays }, (_, i) => i);
  const aPad = padArray(row.aSparkline, periodLengthDays);
  const bPad = padArray(row.bSparkline, periodLengthDays);

  return (
    <div style={{ padding: "12px 24px" }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: PALETTE.text }}>
        Per-day minutes above {threshold}% — {row.hostName}
      </div>
      {/* Horizontal scroll for long periods — 42-day max would otherwise
          squeeze each column to ~15-20px, making the numbers unreadable. */}
      <div style={{ overflowX: "auto" }}>
      <table style={{ fontSize: 11, borderCollapse: "collapse", minWidth: "100%" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left", padding: "4px 8px", color: PALETTE.textSec, fontWeight: 600 }}>Day</th>
            {days.map((d) => (
              <th key={d} style={{ textAlign: "center", padding: "4px 6px", color: PALETTE.textSec, fontWeight: 600 }}>
                D{d + 1}
              </th>
            ))}
            <th style={{ textAlign: "right", padding: "4px 8px", color: PALETTE.textSec, fontWeight: 600 }}>Total</th>
          </tr>
        </thead>
        <tbody>
          <tr style={{ borderTop: `1px solid ${PALETTE.border}` }}>
            <td style={{ padding: "4px 8px" }}>
              <span style={badge(PALETTE.aBlueBg, PALETTE.aBlue)}>A</span>
            </td>
            {aPad.map((v, i) => (
              <td key={i} style={{ textAlign: "center", padding: "4px 6px", fontVariantNumeric: "tabular-nums", color: v > 0 ? PALETTE.text : PALETTE.textSec }}>
                {v || "·"}
              </td>
            ))}
            <td style={{ textAlign: "right", padding: "4px 8px", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
              {row.aMinutesAbove}
            </td>
          </tr>
          <tr style={{ borderTop: `1px solid ${PALETTE.border}` }}>
            <td style={{ padding: "4px 8px" }}>
              <span style={badge(PALETTE.bOrangeBg, PALETTE.bOrange)}>B</span>
            </td>
            {bPad.map((v, i) => (
              <td key={i} style={{ textAlign: "center", padding: "4px 6px", fontVariantNumeric: "tabular-nums", color: v > 0 ? PALETTE.text : PALETTE.textSec }}>
                {v || "·"}
              </td>
            ))}
            <td style={{ textAlign: "right", padding: "4px 8px", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
              {row.bMinutesAbove}
            </td>
          </tr>
        </tbody>
      </table>
      </div>
    </div>
  );
}

function padArray(arr: number[], n: number): number[] {
  if (arr.length >= n) return arr.slice(0, n);
  const out = arr.slice();
  while (out.length < n) out.push(0);
  return out;
}

/** Token used as the CPU-model key for everything that isn't a recognisable
 *  CPU string (null, blank, bogus values like "SCO35" that leaked from
 *  Zabbix hostnames into the hardware inventory field). Centralised so
 *  aggregation and sort agree on a single sentinel. */
const UNKNOWN_CPU_LABEL = "Unknown CPU";

/**
 * Real-CPU vendor prefixes we recognise. Anything not starting with one
 * of these is treated as a data-quality residual (Zabbix hostnames, store
 * labels concatenated into the hardware inventory field, etc.) and folded
 * into the Unknown bucket.
 *
 * Match is case-insensitive and applied AFTER trimming leading whitespace.
 * The previous "space + digit" heuristic accepted bogus multi-line values
 * like "SCO35\nRimi MHM Malūno" because the newline counted as whitespace
 * — using an explicit vendor allow-list closes that hole.
 */
const CPU_VENDOR_PREFIXES = [
  "intel", "amd", "apple", "arm", "qualcomm", "snapdragon",
  "ryzen", "epyc", "threadripper", "xeon", "core", "pentium",
  "celeron", "atom",
];
/** Mirror of resolve.ts BOGUS_VALUE_MARKERS — keep in sync. */
const BOGUS_VALUE_MARKERS = /\b(SCO\d+|Rimi|Maxima|IKI|MHM|SHM|HM\d|Panorama|Mal[uū]no|Vilnius|Kaunas|Klaip[eė]da|Šiauliai|Panev[eė]žys|Pavilnionys|Pilait[eė]|Saul[eė]s)\b/i;

function passesBasicShape(s: string): boolean {
  if (s === "" || s === "—" || s === "-") return false;
  if (s.length > 50) return false;
  if (/[\r\n]/.test(s)) return false;
  if (!/\d/.test(s)) return false;
  const lower = s.toLowerCase();
  return CPU_VENDOR_PREFIXES.some((p) => lower.startsWith(p));
}

/**
 * Mirror of resolve.ts `extractCleanCpuModel`. Same logic: strip polluted
 * suffixes ("Intel Celeron J3060 SCO35 ..." → "Intel Celeron J3060"),
 * return null for unrecoverable values. Server already runs this; client
 * mirror handles the case where a stale browser bundle is rendering an
 * older payload that wasn't extracted upstream.
 */
function extractCleanCpuModel(s: string | null | undefined): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (trimmed === "") return null;
  if (!BOGUS_VALUE_MARKERS.test(trimmed) && passesBasicShape(trimmed)) {
    return trimmed;
  }
  const match = trimmed.match(BOGUS_VALUE_MARKERS);
  if (match && match.index != null && match.index > 0) {
    const prefix = trimmed.substring(0, match.index).trim();
    if (prefix && !BOGUS_VALUE_MARKERS.test(prefix) && passesBasicShape(prefix)) {
      return prefix;
    }
  }
  return null;
}

function isLikelyRealCpuModel(s: string | null | undefined): boolean {
  return extractCleanCpuModel(s) !== null;
}

function sortRows(rows: CompareHostRow[], k: SortKey, dir: SortDir, groupBy: GroupBy): CompareHostRow[] {
  const sign = dir === "asc" ? 1 : -1;
  const get = (r: CompareHostRow): string | number => {
    switch (k) {
      case "host": return r.hostName.toLowerCase();
      case "store": return r.storeName.toLowerCase();
      case "cpu": return (r.cpuModel ?? "").toLowerCase();
      case "aMinutes": return r.aMinutesAbove;
      case "bMinutes": return r.bMinutesAbove;
      case "deltaAbs": return r.deltaMinutesAbs;
      case "deltaPct": return r.deltaMinutesPct ?? Number.POSITIVE_INFINITY;
      case "aMean": return r.aMeanCpu;
      case "bMean": return r.bMeanCpu;
    }
  };
  const compare = (x: CompareHostRow, y: CompareHostRow) => {
    const xv = get(x);
    const yv = get(y);
    if (typeof xv === "number" && typeof yv === "number") return (xv - yv) * sign;
    return String(xv).localeCompare(String(yv)) * sign;
  };
  // Always push "unknown CPU" rows to the END of the list regardless of
  // sort column (Andrius's call 2026-05-28). Two flavours:
  //   - cpuModel-group mode: the single Unknown bucket row.
  //   - host mode: individual hosts whose cpuModel string doesn't look
  //     like a real CPU model (data-quality residuals).
  const isUnknown = groupBy === "cpuModel"
    ? (r: CompareHostRow) => r.cpuModel === UNKNOWN_CPU_LABEL
    : (r: CompareHostRow) => !isLikelyRealCpuModel(r.cpuModel);
  const real = rows.filter((r) => !isUnknown(r)).sort(compare);
  const unknown = rows.filter(isUnknown).sort(compare);
  return [...real, ...unknown];
}

/**
 * Collapse per-host rows into one synthetic row per CPU model.
 *
 * Aggregations:
 *   - aMinutesAbove / bMinutesAbove: SUM across member hosts.
 *   - aMeanCpu / bMeanCpu: sample-weighted mean (mean × samples summed,
 *     then divided by total samples). For hosts with 0 samples in that
 *     period (added-in-b / removed-before-b), the corresponding mean
 *     contribution is dropped from that side.
 *   - aSparkline / bSparkline: element-wise sum of per-day totals.
 *   - cpuCores stores the HOST COUNT of the group (overload for the
 *     "Hosts" column when grouped — saves a separate field on the type).
 *   - hostName mirrors the CPU model so existing sort-by-name works.
 *   - hostId is `cpu:<model>` so React keys stay stable.
 *
 * Δ% is recomputed from the summed minutes so it tells the truth about
 * the group, not the average of per-host percentages.
 */
function aggregateByCpuModel(rows: CompareHostRow[], periodLengthDays: number): CompareHostRow[] {
  const byModel = new Map<string, CompareHostRow[]>();
  for (const r of rows) {
    // Extract a clean CPU model string if possible; everything that
    // can't be salvaged folds into the single Unknown bucket. The
    // extractor handles both "SCO35" (returns null) and "Intel Celeron
    // J3060 SCO35 Rimi MHM Maluno" (returns "Intel Celeron J3060").
    const cleaned = extractCleanCpuModel(r.cpuModel);
    const key = cleaned ?? UNKNOWN_CPU_LABEL;
    const bucket = byModel.get(key);
    if (bucket) bucket.push(r);
    else byModel.set(key, [r]);
  }
  const out: CompareHostRow[] = [];
  for (const [model, members] of byModel) {
    const aSum = members.reduce((s, m) => s + m.aMinutesAbove, 0);
    const bSum = members.reduce((s, m) => s + m.bMinutesAbove, 0);
    let aMeanWeighted = 0, aWeight = 0, bMeanWeighted = 0, bWeight = 0;
    for (const m of members) {
      if (m.aSamples > 0) { aMeanWeighted += m.aMeanCpu * m.aSamples; aWeight += m.aSamples; }
      if (m.bSamples > 0) { bMeanWeighted += m.bMeanCpu * m.bSamples; bWeight += m.bSamples; }
    }
    const aMean = aWeight > 0 ? aMeanWeighted / aWeight : 0;
    const bMean = bWeight > 0 ? bMeanWeighted / bWeight : 0;
    const aSpark: number[] = new Array(periodLengthDays).fill(0);
    const bSpark: number[] = new Array(periodLengthDays).fill(0);
    for (const m of members) {
      for (let i = 0; i < Math.min(periodLengthDays, m.aSparkline.length); i++) aSpark[i] += m.aSparkline[i];
      for (let i = 0; i < Math.min(periodLengthDays, m.bSparkline.length); i++) bSpark[i] += m.bSparkline[i];
    }
    const aSamples = members.reduce((s, m) => s + m.aSamples, 0);
    const bSamples = members.reduce((s, m) => s + m.bSamples, 0);
    const scope: CompareHostRow["hostScope"] =
      aSamples === 0 && bSamples > 0 ? "added-in-b"
      : bSamples === 0 && aSamples > 0 ? "removed-before-b"
      : "both";
    out.push({
      hostId: `cpu:${model}`,
      hostName: model,
      storeName: `${members.length} host${members.length === 1 ? "" : "s"}`,
      cpuModel: model,
      // Re-purpose cpuCores as the host count for the grouped display.
      cpuCores: members.length,
      aMinutesAbove: aSum,
      bMinutesAbove: bSum,
      deltaMinutesAbs: bSum - aSum,
      deltaMinutesPct: aSum === 0 ? null : Math.round(((bSum - aSum) / aSum) * 1000) / 10,
      aMeanCpu: Math.round(aMean * 10) / 10,
      bMeanCpu: Math.round(bMean * 10) / 10,
      aSamples,
      bSamples,
      aSparkline: aSpark,
      bSparkline: bSpark,
      dataQuality: members.every((m) => m.dataQuality === "full") ? "full"
        : members.some((m) => m.dataQuality === "partial-missing") ? "partial-missing"
        : "trend-only",
      hostScope: scope,
    });
  }
  return out;
}

function groupBtnStyle(active: boolean, side: "left" | "right"): React.CSSProperties {
  return {
    padding: "3px 10px", fontSize: 11, fontWeight: 500,
    background: active ? PALETTE.text : "#fff",
    color: active ? "#fff" : PALETTE.text,
    border: `1px solid ${active ? PALETTE.text : PALETTE.border}`,
    borderTopLeftRadius: side === "left" ? 4 : 0,
    borderBottomLeftRadius: side === "left" ? 4 : 0,
    borderTopRightRadius: side === "right" ? 4 : 0,
    borderBottomRightRadius: side === "right" ? 4 : 0,
    cursor: "pointer",
  };
}

const td: React.CSSProperties = {
  padding: "6px 8px",
  color: PALETTE.text,
};

function badge(bg: string, color: string): React.CSSProperties {
  return {
    display: "inline-block",
    marginLeft: 6,
    padding: "1px 6px",
    fontSize: 10,
    fontWeight: 700,
    borderRadius: 10,
    background: bg,
    color,
  };
}
