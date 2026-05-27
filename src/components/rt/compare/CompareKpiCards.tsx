"use client";

import type { CompareKpis } from "./types";

/**
 * Four headline KPI cards for the Compare-periods sub-view.
 *
 * Spec §6 — Δ colour: green for improvement, red for regression, neutral
 * within ±2pp noise band. "lowerIsBetter" is true for all four current
 * metrics because the dashboard's goal is to surface CPU pressure reduction.
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
} as const;

interface KpiSpec {
  label: string;
  a: number;
  b: number;
  deltaAbs: number;
  deltaPct: number | null;
  /** "%": values displayed as percentages, deltaAbs in pp. "pp": already in
   *  pp (no separate unit suffix). "min": minutes. */
  unit: "%" | "pp" | "min";
}

export function CompareKpiCards({ kpis, threshold }: { kpis: CompareKpis; threshold: number }) {
  const cards: KpiSpec[] = [
    { label: `Minutes above ${threshold}%`, ...kpis.minutesAboveThreshold, unit: "min" },
    { label: "Mean CPU", ...kpis.meanCpu, unit: "%" },
    { label: "P95 CPU", ...kpis.p95Cpu, unit: "%" },
    { label: `% time above ${threshold}%`, ...kpis.pctTimeAboveThreshold, unit: "pp" },
  ];

  return (
    <div style={{
      display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 16,
    }}>
      {cards.map((c, i) => (
        <KpiCard key={i} {...c} />
      ))}
    </div>
  );
}

function classifyDelta(deltaAbs: number, unit: KpiSpec["unit"]): "improve" | "regress" | "neutral" {
  // Noise floor: ±2 in pp/% space, ±5 in minutes (the latter is generous
  // because daily host noise easily reaches 5 sample-minutes).
  const noise = unit === "min" ? 5 : 2;
  if (Math.abs(deltaAbs) <= noise) return "neutral";
  // All current metrics are "lower is better" — improvement means delta < 0.
  return deltaAbs < 0 ? "improve" : "regress";
}

function KpiCard({ label, a, b, deltaAbs, deltaPct, unit }: KpiSpec) {
  const cls = classifyDelta(deltaAbs, unit);
  const color = cls === "improve" ? PALETTE.improve : cls === "regress" ? PALETTE.regress : PALETTE.neutral;
  const valueSuffix = unit === "%" || unit === "pp" ? "%" : "";
  // Δ always in pp for %/pp units (delta of percentages is in
  // percentage points), and in min for the minutes metric.
  const deltaSuffix = unit === "min" ? " min" : " pp";

  return (
    <div style={{
      background: PALETTE.card,
      border: `1px solid ${PALETTE.border}`,
      borderRadius: 8,
      padding: 14,
      minHeight: 134,
      display: "flex",
      flexDirection: "column",
    }}>
      <div style={{ fontSize: 11, color: PALETTE.textSec, fontWeight: 500 }}>{label}</div>
      <div style={{ marginTop: 8, display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={miniBadge(PALETTE.aBlueBg, PALETTE.aBlue)}>A</span>
        <span style={{ fontSize: 18, fontWeight: 700, color: PALETTE.text, fontVariantNumeric: "tabular-nums" }}>
          {fmtValue(a, unit)}{valueSuffix}
        </span>
      </div>
      <div style={{ marginTop: 4, display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={miniBadge(PALETTE.bOrangeBg, PALETTE.bOrange)}>B</span>
        <span style={{ fontSize: 18, fontWeight: 700, color: PALETTE.text, fontVariantNumeric: "tabular-nums" }}>
          {fmtValue(b, unit)}{valueSuffix}
        </span>
      </div>
      <div style={{ marginTop: "auto", paddingTop: 8, fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
        <span style={{ color: PALETTE.textSec, marginRight: 4 }}>Δ</span>
        <span style={{ color, fontWeight: 600 }}>
          {deltaAbs > 0 ? "+" : ""}{deltaAbs}{deltaSuffix}
        </span>
        {deltaPct !== null && (
          <span style={{ color, marginLeft: 6 }}>
            ({deltaPct > 0 ? "+" : ""}{deltaPct}%)
          </span>
        )}
        {cls === "neutral" && (
          <span style={{
            marginLeft: 8, fontSize: 10, padding: "1px 6px", borderRadius: 10,
            background: "#fef3c7", color: "#92400e", fontWeight: 600,
          }}>noise</span>
        )}
      </div>
    </div>
  );
}

function fmtValue(v: number, unit: KpiSpec["unit"]): string {
  if (unit === "min") return v.toLocaleString("en-US");
  return String(v);
}

function miniBadge(bg: string, color: string): React.CSSProperties {
  return {
    display: "inline-block",
    padding: "1px 5px",
    fontSize: 10,
    fontWeight: 700,
    borderRadius: 3,
    background: bg,
    color,
  };
}
