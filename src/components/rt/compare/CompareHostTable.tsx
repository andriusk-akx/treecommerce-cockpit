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
  | "aMean" | "bMean" | "aP95" | "bP95";
type SortDir = "asc" | "desc";

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

  const sorted = useMemo(() => sortRows(rows, sortKey, sortDir), [rows, sortKey, sortDir]);

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
      <div style={{ display: "flex", alignItems: "baseline", marginBottom: 8, gap: 8 }}>
        <strong style={{ fontSize: 13, color: PALETTE.text }}>Per-host comparison</strong>
        <span style={{ marginLeft: "auto", fontSize: 11, color: PALETTE.textSec }}>
          {rows.length} hosts · sorted by {sortKey} {sortDir === "asc" ? "↑" : "↓"}
        </span>
        <button
          type="button"
          onClick={() => exportHostsCsv(meta, rows)}
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
        <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse", minWidth: 980 }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${PALETTE.border}` }}>
              <Th label="Host" k="host" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="left" />
              <Th label="Store" k="store" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="left" />
              <Th label="CPU" k="cpu" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="left" />
              <Th label={`Min>${threshold} A`} k="aMinutes" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
              <Th label={`Min>${threshold} B`} k="bMinutes" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
              <Th label="Δ abs" k="deltaAbs" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
              <Th label="Δ %" k="deltaPct" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
              <Th label="Mean A" k="aMean" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
              <Th label="Mean B" k="bMean" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
              <Th label="P95 A" k="aP95" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
              <Th label="P95 B" k="bP95" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
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
  row, idx, expanded, onToggle, threshold, periodLengthDays,
}: {
  row: CompareHostRow; idx: number; expanded: boolean; onToggle: () => void;
  threshold: number; periodLengthDays: number;
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
          <span style={{ fontWeight: 500 }}>{row.hostName}</span>
          {row.hostScope === "added-in-b" && (
            <span style={badge("#dcfce7", "#166534")}>added in B</span>
          )}
          {row.hostScope === "removed-before-b" && (
            <span style={badge("#fee2e2", "#991b1b")}>removed before B</span>
          )}
        </td>
        <td style={td}>{row.storeName}</td>
        <td style={td}>
          {row.cpuModel ?? "—"}
          {row.cpuCores ? <span style={{ color: PALETTE.textSec, marginLeft: 4 }}>· {row.cpuCores}c</span> : null}
        </td>
        <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{valueA}</td>
        <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{valueB}</td>
        <td style={{ ...td, textAlign: "right", color, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>{deltaText}</td>
        <td style={{ ...td, textAlign: "right", color, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>{deltaPctText}</td>
        <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{row.aMeanCpu}%</td>
        <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{row.bMeanCpu}%</td>
        <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{row.aP95Cpu}%</td>
        <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{row.bP95Cpu}%</td>
        <td style={{ padding: "4px 8px" }}>
          <Sparkline a={row.aSparkline} b={row.bSparkline} periodLengthDays={periodLengthDays} />
        </td>
      </tr>
      {expanded && (
        <tr style={{ background: PALETTE.drilldownBg }}>
          <td colSpan={12} style={{ padding: 0 }}>
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

function sortRows(rows: CompareHostRow[], k: SortKey, dir: SortDir): CompareHostRow[] {
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
      case "aP95": return r.aP95Cpu;
      case "bP95": return r.bP95Cpu;
    }
  };
  return [...rows].sort((x, y) => {
    const xv = get(x);
    const yv = get(y);
    if (typeof xv === "number" && typeof yv === "number") return (xv - yv) * sign;
    return String(xv).localeCompare(String(yv)) * sign;
  });
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
