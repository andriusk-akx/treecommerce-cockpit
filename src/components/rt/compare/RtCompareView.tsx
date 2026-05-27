"use client";

/**
 * RtCompareView — root component for the "Compare two periods" sub-view of
 * the Retellect CPU Timeline tab.
 *
 * Spec: docs/specs/cpu-timeline-compare-periods-spec.md
 *
 * Phase 1 (this file, this commit):
 *   - Skeleton + filter form (date pickers A & B, labels, threshold,
 *     alignment toggle, hosts dropdown placeholder).
 *   - Calls /api/rt/cpu-compare with a Run button.
 *   - Renders KPI cards and a minimal placeholder for overlay/table.
 *
 * Phase 2 (next commits) fills in the real overlay chart, host table,
 * drill-down, and exports.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { RtPilotData, ZabbixData } from "../RtPilotWorkspace";
import { useRtFilters } from "../RtFiltersContext";
import {
  COMPARE_THRESHOLDS,
  type CompareResponse,
  type CompareThreshold,
} from "./types";

// ── Local UI palette — re-uses the rt/* visual language without importing
//    private constants from RtTimeline (which keeps its own `C` map). Kept
//    flat and small; the spec calls for plain CSS-in-JS to match the rest
//    of the rt/ tab components.
const PALETTE = {
  aBlue: "#2563eb",
  aBlueBg: "#dbeafe",
  bOrange: "#f97316",
  bOrangeBg: "#ffedd5",
  improve: "#16a34a",
  regress: "#ef4444",
  text: "#0f172a",
  textSec: "#64748b",
  border: "#e2e8f0",
  panelBg: "#f8fafc",
  card: "#ffffff",
  amberBg: "#fef3c7",
  amberText: "#92400e",
} as const;

/** localStorage key — isolated from rtFilters per spec §7.8. */
const compareStorageKey = (pilotId: string) => `rtCompare:${pilotId}`;

interface PersistedState {
  aFrom: string;
  aTo: string;
  bFrom: string;
  bTo: string;
  aLabel: string;
  bLabel: string;
  threshold: CompareThreshold;
}

function todayIsoUtc(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function addDaysIso(iso: string, deltaDays: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function daysInclusive(fromIso: string, toIso: string): number {
  const a = new Date(`${fromIso}T00:00:00Z`).getTime();
  const b = new Date(`${toIso}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000) + 1;
}

function rangesOverlap(aFrom: string, aTo: string, bFrom: string, bTo: string): boolean {
  return !(aTo < bFrom || bTo < aFrom);
}

function loadPersisted(pilotId: string): Partial<PersistedState> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(compareStorageKey(pilotId));
    return raw ? (JSON.parse(raw) as Partial<PersistedState>) : null;
  } catch {
    return null;
  }
}

function savePersisted(pilotId: string, state: Partial<PersistedState>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(compareStorageKey(pilotId), JSON.stringify(state));
  } catch {
    // Quota / serialization — non-fatal.
  }
}

export function RtCompareView({ pilot, zabbix }: { pilot: RtPilotData; zabbix: ZabbixData }) {
  // `zabbix` is wired through from the workspace so Phase 2 can read live
  // host metadata without an extra fetch — held as a stable reference now
  // so the prop is observable in the React tree from day one.
  void zabbix;
  // Inherit default threshold from RtFiltersContext (spec D1) but never write
  // back into it — Compare and Heatmap thresholds stay isolated.
  const { filters } = useRtFilters();
  const persisted = useMemo(() => loadPersisted(pilot.id), [pilot.id]);

  // Default range: most recent week vs week before.
  const today = todayIsoUtc();
  const defaultLength = 7;
  const defaultAFrom = persisted?.aFrom ?? addDaysIso(today, -14);
  const defaultATo = persisted?.aTo ?? addDaysIso(today, -8);
  const defaultBFrom = persisted?.bFrom ?? addDaysIso(today, -7);
  const defaultBTo = persisted?.bTo ?? addDaysIso(today, -1);

  const [aFrom, setAFrom] = useState(defaultAFrom);
  const [aTo, setATo] = useState(defaultATo);
  const [bFrom, setBFrom] = useState(defaultBFrom);
  const [aLabel, setALabel] = useState(persisted?.aLabel ?? "");
  const [bLabel, setBLabel] = useState(persisted?.bLabel ?? "");
  const [threshold, setThresholdState] = useState<CompareThreshold>(() => {
    // Inherited from RtFiltersContext only if context value is a supported bin.
    const inherited = filters.threshold;
    if (COMPARE_THRESHOLDS.includes(inherited as CompareThreshold)) {
      return (persisted?.threshold ?? inherited) as CompareThreshold;
    }
    return persisted?.threshold ?? 70;
  });

  // B "to" is locked — derived from B "from" + (A length − 1) days.
  const aLength = daysInclusive(aFrom, aTo);
  const bTo = addDaysIso(bFrom, aLength - 1);
  void defaultBTo; // intentional: bTo is derived, not stored, but we keep the persisted hint above.
  void defaultLength;

  // ── Validation ──────────────────────────────────────────────────────
  const validationError = useMemo<string | null>(() => {
    if (aFrom > aTo) return "Period A: start date must be on or before end date.";
    if (bFrom > bTo) return "Period B: start date must be on or before end date.";
    if (aLength < 1) return "Periods must be at least 1 day long.";
    if (aLength > 42) return "Periods cannot exceed 42 days (Zabbix retention).";
    if (rangesOverlap(aFrom, aTo, bFrom, bTo)) return "Period A and Period B must not overlap.";
    return null;
  }, [aFrom, aTo, bFrom, bTo, aLength]);

  // ── Data fetch ──────────────────────────────────────────────────────
  const [data, setData] = useState<CompareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runComparison = useCallback(async () => {
    if (validationError) return;
    setLoading(true);
    setError(null);
    try {
      const url = new URL("/api/rt/cpu-compare", window.location.origin);
      url.searchParams.set("pilotId", pilot.id);
      url.searchParams.set("aFrom", aFrom);
      url.searchParams.set("aTo", aTo);
      url.searchParams.set("bFrom", bFrom);
      url.searchParams.set("bTo", bTo);
      url.searchParams.set("threshold", String(threshold));
      if (aLabel) url.searchParams.set("aLabel", aLabel);
      if (bLabel) url.searchParams.set("bLabel", bLabel);
      const res = await fetch(url.toString(), { cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${res.status}`);
      }
      const payload = (await res.json()) as CompareResponse;
      setData(payload);
      savePersisted(pilot.id, { aFrom, aTo, bFrom, bTo, aLabel, bLabel, threshold });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load comparison");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [aFrom, aTo, bFrom, bTo, aLabel, bLabel, threshold, pilot.id, validationError]);

  // Persist non-data state on every change (so a reload restores the picker
  // values even without a Run). Data itself is intentionally NOT cached.
  useEffect(() => {
    savePersisted(pilot.id, { aFrom, aTo, bFrom, bTo, aLabel, bLabel, threshold });
  }, [pilot.id, aFrom, aTo, bFrom, bTo, aLabel, bLabel, threshold]);

  return (
    <div style={{ padding: "8px 0 24px" }}>
      <h2 style={{ fontSize: 17, fontWeight: 600, color: PALETTE.text, marginBottom: 4 }}>
        Compare two periods
      </h2>
      <p style={{ fontSize: 13, color: PALETTE.textSec, marginBottom: 12 }}>
        Pick two equal-length date ranges to compare CPU behaviour before and after a configuration change.
        Period B&apos;s end date is locked to match Period A&apos;s length.
      </p>

      {/* ── Filter bar ─────────────────────────────────────────────── */}
      <div style={{
        border: `1px solid ${PALETTE.border}`,
        background: PALETTE.card,
        borderRadius: 8,
        padding: 16,
        marginBottom: 12,
      }}>
        {/* Period A row */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
          <span style={{
            display: "inline-block", padding: "2px 8px", borderRadius: 12,
            background: PALETTE.aBlueBg, color: PALETTE.aBlue, fontWeight: 600, fontSize: 11,
          }}>Period A</span>
          <label style={{ fontSize: 11, color: PALETTE.textSec }}>From</label>
          <input
            type="date"
            value={aFrom}
            onChange={(e) => setAFrom(e.target.value)}
            style={dateInputStyle}
          />
          <label style={{ fontSize: 11, color: PALETTE.textSec }}>To</label>
          <input
            type="date"
            value={aTo}
            onChange={(e) => setATo(e.target.value)}
            style={dateInputStyle}
          />
          <span style={{ fontSize: 11, color: PALETTE.textSec }}>({aLength} day{aLength === 1 ? "" : "s"})</span>
          <label style={{ fontSize: 11, color: PALETTE.textSec, marginLeft: 6 }}>Label</label>
          <input
            type="text"
            placeholder="e.g. Pre BES rollout"
            value={aLabel}
            maxLength={60}
            onChange={(e) => setALabel(e.target.value)}
            style={{ ...dateInputStyle, width: 220 }}
          />
        </div>

        {/* Period B row */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
          <span style={{
            display: "inline-block", padding: "2px 8px", borderRadius: 12,
            background: PALETTE.bOrangeBg, color: PALETTE.bOrange, fontWeight: 600, fontSize: 11,
          }}>Period B</span>
          <label style={{ fontSize: 11, color: PALETTE.textSec }}>From</label>
          <input
            type="date"
            value={bFrom}
            onChange={(e) => setBFrom(e.target.value)}
            style={dateInputStyle}
          />
          <label style={{ fontSize: 11, color: PALETTE.textSec }}>To</label>
          <input
            type="date"
            value={bTo}
            readOnly
            tabIndex={-1}
            title={`Auto-locked to match Period A length (${aLength} day${aLength === 1 ? "" : "s"})`}
            style={{ ...dateInputStyle, background: PALETTE.panelBg, color: PALETTE.textSec, cursor: "not-allowed" }}
          />
          <span style={{ fontSize: 11, color: PALETTE.textSec }}>(auto, {aLength} day{aLength === 1 ? "" : "s"})</span>
          <label style={{ fontSize: 11, color: PALETTE.textSec, marginLeft: 6 }}>Label</label>
          <input
            type="text"
            placeholder="e.g. Post BES rollout"
            value={bLabel}
            maxLength={60}
            onChange={(e) => setBLabel(e.target.value)}
            style={{ ...dateInputStyle, width: 220 }}
          />
        </div>

        {/* Threshold + run row */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <label style={{ fontSize: 11, color: PALETTE.textSec }}>Threshold</label>
          <div style={{ display: "inline-flex", gap: 4 }}>
            {COMPARE_THRESHOLDS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setThresholdState(t)}
                style={{
                  ...segButtonStyle,
                  background: threshold === t ? PALETTE.text : "#fff",
                  color: threshold === t ? "#fff" : PALETTE.text,
                  borderColor: threshold === t ? PALETTE.text : PALETTE.border,
                }}
              >
                {t}%
              </button>
            ))}
          </div>
          {validationError && (
            <span style={{ marginLeft: 8, fontSize: 12, color: PALETTE.regress, fontWeight: 500 }}>
              {validationError}
            </span>
          )}
          <button
            type="button"
            disabled={loading || !!validationError}
            onClick={runComparison}
            style={{
              marginLeft: "auto",
              padding: "8px 18px",
              fontSize: 13,
              fontWeight: 600,
              color: "#fff",
              background: loading || validationError ? "#94a3b8" : PALETTE.aBlue,
              border: "none",
              borderRadius: 6,
              cursor: loading || validationError ? "not-allowed" : "pointer",
            }}
          >
            {loading ? "Running…" : "▶ Run comparison"}
          </button>
        </div>
      </div>

      {/* Warnings */}
      {data?.meta.dataQuality.warnings.length ? (
        <div style={{
          background: PALETTE.amberBg, color: PALETTE.amberText,
          padding: "8px 14px", borderRadius: 6, marginBottom: 12, fontSize: 12,
        }}>
          {data.meta.dataQuality.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
        </div>
      ) : null}

      {/* Error */}
      {error && (
        <div style={{
          background: "#fee2e2", color: "#991b1b",
          padding: "8px 14px", borderRadius: 6, marginBottom: 12, fontSize: 12,
        }}>
          ⚠ {error}
        </div>
      )}

      {/* Results */}
      {data ? (
        <CompareResultsPlaceholder data={data} />
      ) : (
        <div style={{
          border: `1px dashed ${PALETTE.border}`,
          borderRadius: 8,
          padding: 32,
          textAlign: "center",
          color: PALETTE.textSec,
          fontSize: 13,
        }}>
          Pick two periods and press <strong>Run comparison</strong> to see KPIs, overlay timeline, and per-host deltas.
        </div>
      )}
    </div>
  );
}

// ── Phase 1: placeholder results panel. Full KPI cards / overlay / table
//    land in Phase 3 commit (UI components). For now we render the KPI
//    numbers in a flat layout so the data path is observable end-to-end.
function CompareResultsPlaceholder({ data }: { data: CompareResponse }) {
  const kpis = data.kpis;
  return (
    <div>
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 16,
      }}>
        <KpiCard label="Minutes above threshold" {...kpis.minutesAboveThreshold} unit="min" lowerIsBetter />
        <KpiCard label="Mean CPU" {...kpis.meanCpu} unit="%" lowerIsBetter />
        <KpiCard label="P95 CPU" {...kpis.p95Cpu} unit="%" lowerIsBetter />
        <KpiCard label="% time above threshold" {...kpis.pctTimeAboveThreshold} unit="pp" lowerIsBetter />
      </div>

      <div style={{
        background: PALETTE.card, border: `1px solid ${PALETTE.border}`,
        borderRadius: 8, padding: 16, marginBottom: 16,
      }}>
        <strong style={{ fontSize: 13, color: PALETTE.text }}>Overlay timeline</strong>
        <div style={{ fontSize: 12, color: PALETTE.textSec, marginTop: 4 }}>
          {data.overlay.points.length} slots · alignment: {data.overlay.alignment} ·{" "}
          {data.overlay.slotMinutes} min/slot
        </div>
        <div style={{
          marginTop: 12, padding: 24, textAlign: "center", color: PALETTE.textSec,
          background: PALETTE.panelBg, borderRadius: 6, fontSize: 12,
        }}>
          (overlay chart lands in the next commit — see spec §6.3)
        </div>
      </div>

      <div style={{
        background: PALETTE.card, border: `1px solid ${PALETTE.border}`,
        borderRadius: 8, padding: 16,
      }}>
        <strong style={{ fontSize: 13, color: PALETTE.text }}>Per-host comparison</strong>
        <div style={{ fontSize: 12, color: PALETTE.textSec, marginTop: 4, marginBottom: 8 }}>
          {data.hostRows.length} hosts · sorted by Δ% ascending
        </div>
        <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${PALETTE.border}`, textAlign: "left" }}>
              <th style={thStyle}>Host</th>
              <th style={thStyle}>Store</th>
              <th style={thStyle}>CPU</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Min&gt;{data.meta.threshold} A</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Min&gt;{data.meta.threshold} B</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Δ abs</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Δ %</th>
            </tr>
          </thead>
          <tbody>
            {[...data.hostRows]
              .sort((x, y) => (x.deltaMinutesPct ?? 9999) - (y.deltaMinutesPct ?? 9999))
              .map((r) => {
                const noisy = r.deltaMinutesPct != null && Math.abs(r.deltaMinutesPct) <= 2;
                const positive = r.deltaMinutesPct != null && r.deltaMinutesPct > 2;
                const negative = r.deltaMinutesPct != null && r.deltaMinutesPct < -2;
                const color = noisy ? PALETTE.textSec : positive ? PALETTE.regress : negative ? PALETTE.improve : PALETTE.textSec;
                return (
                  <tr key={r.hostId} style={{ borderBottom: `1px solid ${PALETTE.border}` }}>
                    <td style={tdStyle}>
                      <span style={{ fontWeight: 500 }}>{r.hostName}</span>
                      {r.hostScope === "added-in-b" && (
                        <span style={badgeStyle("#dcfce7", "#166534")}>added in B</span>
                      )}
                      {r.hostScope === "removed-before-b" && (
                        <span style={badgeStyle("#fee2e2", "#991b1b")}>removed before B</span>
                      )}
                    </td>
                    <td style={tdStyle}>{r.storeName}</td>
                    <td style={tdStyle}>
                      {r.cpuModel ?? "—"}{r.cpuCores ? ` · ${r.cpuCores}c` : ""}
                    </td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>{r.hostScope === "added-in-b" ? "—" : r.aMinutesAbove}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>{r.bMinutesAbove}</td>
                    <td style={{ ...tdStyle, textAlign: "right", color, fontWeight: 500 }}>
                      {r.hostScope === "added-in-b" ? "—" : r.deltaMinutesAbs > 0 ? `+${r.deltaMinutesAbs}` : r.deltaMinutesAbs}
                    </td>
                    <td style={{ ...tdStyle, textAlign: "right", color, fontWeight: 500 }}>
                      {r.deltaMinutesPct == null ? "—" : `${r.deltaMinutesPct > 0 ? "+" : ""}${r.deltaMinutesPct}%`}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function KpiCard({
  label, a, b, deltaAbs, deltaPct, unit, lowerIsBetter,
}: {
  label: string;
  a: number;
  b: number;
  deltaAbs: number;
  deltaPct: number | null;
  unit: string;
  lowerIsBetter: boolean;
}) {
  const isImprovement = lowerIsBetter ? deltaAbs < -0.1 : deltaAbs > 0.1;
  const isRegression = lowerIsBetter ? deltaAbs > 0.1 : deltaAbs < -0.1;
  const color = isImprovement ? PALETTE.improve : isRegression ? PALETTE.regress : PALETTE.textSec;
  return (
    <div style={{
      background: PALETTE.card, border: `1px solid ${PALETTE.border}`,
      borderRadius: 8, padding: 14,
    }}>
      <div style={{ fontSize: 11, color: PALETTE.textSec, fontWeight: 500 }}>{label}</div>
      <div style={{ marginTop: 8, display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={{ ...miniBadge(PALETTE.aBlueBg, PALETTE.aBlue) }}>A</span>
        <span style={{ fontSize: 16, fontWeight: 600, color: PALETTE.text }}>{a}{unit === "%" || unit === "pp" ? "%" : ""}</span>
      </div>
      <div style={{ marginTop: 4, display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={{ ...miniBadge(PALETTE.bOrangeBg, PALETTE.bOrange) }}>B</span>
        <span style={{ fontSize: 16, fontWeight: 600, color: PALETTE.text }}>{b}{unit === "%" || unit === "pp" ? "%" : ""}</span>
      </div>
      <div style={{ marginTop: 10, fontSize: 12 }}>
        <span style={{ color: PALETTE.textSec, marginRight: 4 }}>Δ</span>
        <span style={{ color, fontWeight: 600 }}>
          {deltaAbs > 0 ? "+" : ""}{deltaAbs}{unit === "min" ? " min" : unit === "pp" ? " pp" : "%"}
        </span>
        {deltaPct !== null && (
          <span style={{ color, marginLeft: 6 }}>
            ({deltaPct > 0 ? "+" : ""}{deltaPct}%)
          </span>
        )}
      </div>
    </div>
  );
}

const dateInputStyle: React.CSSProperties = {
  padding: "4px 8px",
  fontSize: 12,
  border: `1px solid ${PALETTE.border}`,
  borderRadius: 4,
  background: "#fff",
  color: PALETTE.text,
};

const segButtonStyle: React.CSSProperties = {
  padding: "4px 10px",
  fontSize: 12,
  fontWeight: 500,
  border: `1px solid ${PALETTE.border}`,
  borderRadius: 4,
  cursor: "pointer",
};

const thStyle: React.CSSProperties = {
  padding: "6px 8px",
  fontWeight: 600,
  color: PALETTE.text,
  fontSize: 11,
};

const tdStyle: React.CSSProperties = {
  padding: "6px 8px",
  color: PALETTE.text,
};

function badgeStyle(bg: string, color: string): React.CSSProperties {
  return {
    display: "inline-block",
    marginLeft: 6,
    padding: "1px 6px",
    fontSize: 10,
    fontWeight: 600,
    borderRadius: 10,
    background: bg,
    color,
  };
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
