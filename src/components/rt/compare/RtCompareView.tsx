"use client";

/**
 * RtCompareView — root component for the "Compare two periods" sub-view of
 * the Retellect CPU Timeline tab.
 *
 * Spec: docs/specs/cpu-timeline-compare-periods-spec.md
 *
 * This file orchestrates filter state, validation, the API call, and
 * stitches together the KPI cards, overlay chart, and host delta table.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { RtPilotData, ZabbixData } from "../RtPilotWorkspace";
import { useRtFilters } from "../RtFiltersContext";
import {
  COMPARE_THRESHOLDS,
  type CompareAlignment,
  type CompareResponse,
  type CompareThreshold,
} from "./types";
import { CompareKpiCards } from "./CompareKpiCards";
import { CompareOverlayChart } from "./CompareOverlayChart";
import { CompareHostTable } from "./CompareHostTable";

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
  aLabel: string;
  bLabel: string;
  threshold: CompareThreshold;
  alignment: CompareAlignment;
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
  void zabbix; // Phase-2 wiring lives in the API endpoint, not the view.
  const { filters } = useRtFilters();
  const persisted = useMemo(() => loadPersisted(pilot.id), [pilot.id]);

  // Default range: most recent week vs week before.
  const today = todayIsoUtc();
  const defaultAFrom = persisted?.aFrom ?? addDaysIso(today, -14);
  const defaultATo = persisted?.aTo ?? addDaysIso(today, -8);
  const defaultBFrom = persisted?.bFrom ?? addDaysIso(today, -7);

  const [aFrom, setAFrom] = useState(defaultAFrom);
  const [aTo, setATo] = useState(defaultATo);
  const [bFrom, setBFrom] = useState(defaultBFrom);
  const [aLabel, setALabel] = useState(persisted?.aLabel ?? "");
  const [bLabel, setBLabel] = useState(persisted?.bLabel ?? "");
  const [alignment, setAlignment] = useState<CompareAlignment>(persisted?.alignment ?? "time-of-day");

  const [threshold, setThresholdState] = useState<CompareThreshold>(() => {
    const inherited = filters.threshold;
    if (persisted?.threshold && COMPARE_THRESHOLDS.includes(persisted.threshold as CompareThreshold)) {
      return persisted.threshold;
    }
    if (COMPARE_THRESHOLDS.includes(inherited as CompareThreshold)) {
      return inherited as CompareThreshold;
    }
    return 70;
  });
  // Hint chip: show "inherited from Heatmap (N%)" until first Run or user override.
  const [showInheritedHint, setShowInheritedHint] = useState(() => persisted?.threshold == null);

  // B "to" is locked — derived from B "from" + (A length − 1) days.
  const aLength = daysInclusive(aFrom, aTo);
  const bTo = addDaysIso(bFrom, aLength - 1);

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
  const [useMock, setUseMock] = useState(false);

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
      url.searchParams.set("alignment", alignment);
      if (aLabel) url.searchParams.set("aLabel", aLabel);
      if (bLabel) url.searchParams.set("bLabel", bLabel);
      if (useMock) url.searchParams.set("mock", "1");
      const res = await fetch(url.toString(), { cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${res.status}`);
      }
      const payload = (await res.json()) as CompareResponse;
      setData(payload);
      setShowInheritedHint(false);
      savePersisted(pilot.id, { aFrom, aTo, bFrom, aLabel, bLabel, threshold, alignment });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load comparison");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [aFrom, aTo, bFrom, bTo, aLabel, bLabel, threshold, alignment, pilot.id, validationError, useMock]);

  useEffect(() => {
    savePersisted(pilot.id, { aFrom, aTo, bFrom, aLabel, bLabel, threshold, alignment });
  }, [pilot.id, aFrom, aTo, bFrom, aLabel, bLabel, threshold, alignment]);

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
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
          <span style={periodBadge(PALETTE.aBlueBg, PALETTE.aBlue)}>Period A</span>
          <label style={lbl}>From</label>
          <input type="date" value={aFrom} onChange={(e) => setAFrom(e.target.value)} style={dateInput} />
          <label style={lbl}>To</label>
          <input type="date" value={aTo} onChange={(e) => setATo(e.target.value)} style={dateInput} />
          <span style={{ ...lbl }}>({aLength} day{aLength === 1 ? "" : "s"})</span>
          <label style={{ ...lbl, marginLeft: 6 }}>Label</label>
          <input
            type="text"
            placeholder="e.g. Pre BES rollout"
            value={aLabel}
            maxLength={60}
            onChange={(e) => setALabel(e.target.value)}
            style={{ ...dateInput, width: 220 }}
          />
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
          <span style={periodBadge(PALETTE.bOrangeBg, PALETTE.bOrange)}>Period B</span>
          <label style={lbl}>From</label>
          <input type="date" value={bFrom} onChange={(e) => setBFrom(e.target.value)} style={dateInput} />
          <label style={lbl}>To</label>
          <input
            type="date"
            value={bTo}
            readOnly
            tabIndex={-1}
            title={`Auto-locked to match Period A length (${aLength} day${aLength === 1 ? "" : "s"})`}
            style={{ ...dateInput, background: PALETTE.panelBg, color: PALETTE.textSec, cursor: "not-allowed" }}
          />
          <span style={lbl}>(auto, {aLength} day{aLength === 1 ? "" : "s"})</span>
          <label style={{ ...lbl, marginLeft: 6 }}>Label</label>
          <input
            type="text"
            placeholder="e.g. Post BES rollout"
            value={bLabel}
            maxLength={60}
            onChange={(e) => setBLabel(e.target.value)}
            style={{ ...dateInput, width: 220 }}
          />
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <label style={lbl}>Threshold</label>
          <div style={{ display: "inline-flex", gap: 4 }}>
            {COMPARE_THRESHOLDS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => { setThresholdState(t); setShowInheritedHint(false); }}
                style={{
                  ...segButton,
                  background: threshold === t ? PALETTE.text : "#fff",
                  color: threshold === t ? "#fff" : PALETTE.text,
                  borderColor: threshold === t ? PALETTE.text : PALETTE.border,
                }}
              >
                {t}%
              </button>
            ))}
            {showInheritedHint && (
              <span style={{
                marginLeft: 6, alignSelf: "center", fontSize: 10, color: PALETTE.textSec, fontStyle: "italic",
              }}>
                inherited from Heatmap ({filters.threshold}%)
              </span>
            )}
          </div>

          <span style={{ width: 1, alignSelf: "stretch", background: PALETTE.border, margin: "0 4px" }} />

          <label style={lbl}>Alignment</label>
          <div style={{ display: "inline-flex", gap: 0 }}>
            <button
              type="button"
              onClick={() => setAlignment("time-of-day")}
              style={{
                ...segButton,
                borderTopRightRadius: 0, borderBottomRightRadius: 0,
                background: alignment === "time-of-day" ? PALETTE.text : "#fff",
                color: alignment === "time-of-day" ? "#fff" : PALETTE.text,
                borderColor: alignment === "time-of-day" ? PALETTE.text : PALETTE.border,
              }}
            >
              Time of day
            </button>
            <button
              type="button"
              onClick={() => setAlignment("absolute-offset")}
              style={{
                ...segButton,
                borderTopLeftRadius: 0, borderBottomLeftRadius: 0,
                background: alignment === "absolute-offset" ? PALETTE.text : "#fff",
                color: alignment === "absolute-offset" ? "#fff" : PALETTE.text,
                borderColor: alignment === "absolute-offset" ? PALETTE.text : PALETTE.border,
              }}
            >
              Absolute offset
            </button>
          </div>

          <label style={{ ...lbl, marginLeft: 6 }} title="Use deterministic seed-based fake data instead of hitting Zabbix. Helpful for UI dev / demos when the real path is slow.">
            <input
              type="checkbox"
              checked={useMock}
              onChange={(e) => setUseMock(e.target.checked)}
              style={{ marginRight: 4, verticalAlign: "middle" }}
            />
            Mock data
          </label>

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

      {/* Warnings ribbon */}
      {data?.meta.dataQuality.warnings.length ? (
        <div style={{
          background: PALETTE.amberBg, color: PALETTE.amberText,
          padding: "8px 14px", borderRadius: 6, marginBottom: 12, fontSize: 12,
        }}>
          {data.meta.dataQuality.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
        </div>
      ) : null}

      {/* Error ribbon */}
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
        <>
          <CompareKpiCards kpis={data.kpis} threshold={data.meta.threshold} />
          <CompareOverlayChart overlay={data.overlay} meta={data.meta} />
          <CompareHostTable
            rows={data.hostRows}
            threshold={data.meta.threshold}
            periodLengthDays={data.meta.periodLengthDays}
            meta={data.meta}
          />
          <div style={{ marginTop: 10, fontSize: 10, color: "#94a3b8", textAlign: "right" }}>
            Generated {new Date(data.meta.generatedAt).toLocaleString("lt-LT")} ·
            data quality: A {data.meta.dataQuality.periodA}, B {data.meta.dataQuality.periodB}
          </div>
        </>
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

const dateInput: React.CSSProperties = {
  padding: "4px 8px",
  fontSize: 12,
  border: `1px solid ${PALETTE.border}`,
  borderRadius: 4,
  background: "#fff",
  color: PALETTE.text,
};

const segButton: React.CSSProperties = {
  padding: "4px 10px",
  fontSize: 12,
  fontWeight: 500,
  border: `1px solid ${PALETTE.border}`,
  borderRadius: 4,
  cursor: "pointer",
};

const lbl: React.CSSProperties = { fontSize: 11, color: PALETTE.textSec };

function periodBadge(bg: string, color: string): React.CSSProperties {
  return {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 12,
    background: bg,
    color,
    fontWeight: 600,
    fontSize: 11,
  };
}
