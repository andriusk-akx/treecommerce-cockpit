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

import { useEffect, useMemo, useRef, useState } from "react";
import type { RtPilotData, ZabbixData } from "../RtPilotWorkspace";
import { useRtFilters } from "../RtFiltersContext";
import {
  COMPARE_THRESHOLDS,
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
  bFrom: string;
  lengthDays: number;
  aLabel: string;
  bLabel: string;
  threshold: CompareThreshold;
  cpuModel: string;
}

/** Period length presets the dashboard offers. Each is a whole number of
 *  weeks so the day-of-week alignment (Mon-A vs Mon-B etc.) is exact. */
const LENGTH_PRESETS = [
  { id: "1w", label: "1 week", days: 7 },
  { id: "2w", label: "2 weeks", days: 14 },
  { id: "4w", label: "4 weeks", days: 28 },
] as const;

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

/** 0 = Sunday, 1 = Monday, …, 6 = Saturday. UTC-based so the value is
 *  stable regardless of the browser's local timezone. */
function dayOfWeekUtc(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

/** Snap a date forward/backward to the nearest one matching the target
 *  day-of-week. If the input already matches, returned unchanged.
 *  We prefer moving backward (older date) so the suggestion lands inside
 *  retention rather than blowing past today. */
function snapToDow(iso: string, targetDow: number): string {
  const current = dayOfWeekUtc(iso);
  if (current === targetDow) return iso;
  // Diff in [-6, +6]. Prefer negative (older) value.
  let diff = targetDow - current;
  if (diff > 0) diff -= 7;
  return addDaysIso(iso, diff);
}

/** Locale-aware "Mon, Apr 27" rendering for date labels. */
function formatDow(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
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

  // Default: most-recent full week (Period A) vs previous full week (Period B),
  // both starting on Monday. Lazy init keeps `todayIsoUtc()` from re-evaluating.
  // The whole picker now revolves around two start dates + a length; ends are
  // derived. Snapping enforces same DOW for both starts so day-of-week always
  // pairs up Mon→Mon, Tue→Tue, etc.
  const [lengthDays, setLengthDays] = useState<number>(() => persisted?.lengthDays ?? 7);
  const [aFrom, setAFromRaw] = useState<string>(() => {
    if (persisted?.aFrom) return persisted.aFrom;
    // Start of most-recent full Monday: today's Monday minus 7d.
    const today = todayIsoUtc();
    const todayDow = dayOfWeekUtc(today);
    // Monday = 1; back up to last Mon then one more week.
    const offsetToLastMon = todayDow === 0 ? -6 : -(todayDow - 1) - 7;
    return addDaysIso(today, offsetToLastMon);
  });
  const [bFrom, setBFromRaw] = useState<string>(() => {
    if (persisted?.bFrom) return persisted.bFrom;
    // Default: one period earlier than A (so length=7 → 7 days before A).
    const len = persisted?.lengthDays ?? 7;
    const a = persisted?.aFrom ?? (() => {
      const today = todayIsoUtc();
      const todayDow = dayOfWeekUtc(today);
      const offsetToLastMon = todayDow === 0 ? -6 : -(todayDow - 1) - 7;
      return addDaysIso(today, offsetToLastMon);
    })();
    return addDaysIso(a, -len);
  });
  const [aLabel, setALabel] = useState(persisted?.aLabel ?? "");
  const [bLabel, setBLabel] = useState(persisted?.bLabel ?? "");
  // CPU model filter — defaults to "all"; the dropdown options are a union
  // of (a) what Device.cpuModel already carries in the DB and (b) the
  // resolved cpuModel values seen in the most recent API response. The
  // server uses the same resolveCpuModel fallback chain the CPU Timeline
  // does (Device → Zabbix inventory), so after one Run the dropdown
  // typically grows to cover every model in the fleet — even those whose
  // Device row hasn't been backfilled yet.
  const [cpuModel, setCpuModel] = useState<string>(() => persisted?.cpuModel ?? "all");

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

  // Derived: end dates from start + length.
  const aTo = addDaysIso(aFrom, lengthDays - 1);
  const bTo = addDaysIso(bFrom, lengthDays - 1);
  const aLength = lengthDays;

  // Snap B start to match A's day-of-week whenever either changes.
  const setAFrom = (next: string) => {
    setAFromRaw(next);
    // Re-snap B so it stays on A's DOW.
    const targetDow = dayOfWeekUtc(next);
    setBFromRaw((prev) => (dayOfWeekUtc(prev) === targetDow ? prev : snapToDow(prev, targetDow)));
  };
  const setBFrom = (next: string) => {
    const targetDow = dayOfWeekUtc(aFrom);
    setBFromRaw(dayOfWeekUtc(next) === targetDow ? next : snapToDow(next, targetDow));
  };

  // ── Validation ──────────────────────────────────────────────────────
  // With end dates derived from start + lengthDays, and B snapped to A's
  // DOW, the only remaining failure modes are: range overlap, retention
  // overshoot, and (theoretically) length > 42d if a future custom preset
  // lands. Day-of-week mismatch is impossible by construction.
  const validationError = useMemo<string | null>(() => {
    if (lengthDays > 42) return "Periods cannot exceed 42 days (Zabbix retention).";
    if (rangesOverlap(aFrom, aTo, bFrom, bTo)) return "Period A and Period B must not overlap.";
    const today = todayIsoUtc();
    const ageA = daysInclusive(aFrom, today) - 1;
    const ageB = daysInclusive(bFrom, today) - 1;
    const oldest = Math.max(ageA, ageB);
    if (oldest > 42) return `Period start is older than 42 days (current oldest = ${oldest}d). Zabbix history retention won't cover it.`;
    return null;
  }, [aFrom, aTo, bFrom, bTo, lengthDays]);

  // ── Data fetch ──────────────────────────────────────────────────────
  const [data, setData] = useState<CompareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Build dropdown options. Pre-Run: DB cpuModels only. Post-Run: union
  // of DB cpuModels + resolved cpuModels in the response. The "real CPU
  // model" heuristic is intentionally strict (must start with Intel/AMD/
  // Ryzen/etc.) so multi-line concatenated junk from Zabbix inventory
  // doesn't pollute the dropdown — those rows still aggregate into the
  // Unknown bucket in the host table.
  const cpuModelOptions = useMemo(() => {
    const VENDOR_PREFIXES = [
      "intel", "amd", "apple", "arm", "qualcomm", "snapdragon",
      "ryzen", "epyc", "threadripper", "xeon", "core", "pentium",
      "celeron", "atom",
    ];
    const BOGUS = /\b(SCO\d+|Rimi|Maxima|IKI|MHM|SHM|HM\d|Panorama|Mal[uū]no|Vilnius|Kaunas|Klaip[eė]da|Šiauliai|Panev[eė]žys|Pavilnionys|Pilait[eė]|Saul[eė]s)\b/i;
    const passesShape = (s: string): boolean => {
      if (s === "" || s === "—" || s === "-") return false;
      if (s.length > 50) return false;
      if (/[\r\n]/.test(s)) return false;
      if (!/\d/.test(s)) return false;
      const lower = s.toLowerCase();
      return VENDOR_PREFIXES.some((p) => lower.startsWith(p));
    };
    const extract = (s: string | null | undefined): string | null => {
      if (!s) return null;
      const t = s.trim();
      if (t === "") return null;
      if (!BOGUS.test(t) && passesShape(t)) return t;
      const m = t.match(BOGUS);
      if (m && m.index != null && m.index > 0) {
        const prefix = t.substring(0, m.index).trim();
        if (prefix && !BOGUS.test(prefix) && passesShape(prefix)) return prefix;
      }
      return null;
    };
    const set = new Set<string>();
    for (const d of pilot.devices) {
      const cleaned = extract(d.cpuModel);
      if (cleaned) set.add(cleaned);
    }
    if (data) {
      for (const r of data.hostRows) {
        const cleaned = extract(r.cpuModel);
        if (cleaned) set.add(cleaned);
      }
    }
    return ["all", ...Array.from(set).sort()];
  }, [pilot.devices, data]);
  // Abort the in-flight request if the user clicks Run again before it
  // completes — without this, the slower response can overwrite the newer
  // one and the user sees stale data.
  const abortRef = useRef<AbortController | null>(null);

  // Plain function — useCallback would only matter if a child memoised on
  // this reference, which none do.
  const runComparison = async () => {
    if (validationError) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
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
      // Always use absolute-offset alignment now that periods are
      // guaranteed to start on the same day-of-week — minute N in A
      // pairs with minute N in B at the same DOW + same time-of-day.
      url.searchParams.set("alignment", "absolute-offset");
      if (cpuModel && cpuModel !== "all") url.searchParams.set("cpuModel", cpuModel);
      if (aLabel) url.searchParams.set("aLabel", aLabel);
      if (bLabel) url.searchParams.set("bLabel", bLabel);
      const res = await fetch(url.toString(), { cache: "no-store", signal: controller.signal });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${res.status}`);
      }
      const payload = (await res.json()) as CompareResponse;
      // Bail if a newer request superseded us between fetch and resolve.
      if (abortRef.current !== controller) return;
      setData(payload);
      setShowInheritedHint(false);
      savePersisted(pilot.id, { aFrom, bFrom, lengthDays, aLabel, bLabel, threshold, cpuModel });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : "Failed to load comparison");
      setData(null);
    } finally {
      if (abortRef.current === controller) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    savePersisted(pilot.id, { aFrom, bFrom, lengthDays, aLabel, bLabel, threshold, cpuModel });
  }, [pilot.id, aFrom, bFrom, lengthDays, aLabel, bLabel, threshold, cpuModel]);

  return (
    <div style={{ padding: "8px 0 24px" }}>
      <h2 style={{ fontSize: 17, fontWeight: 600, color: PALETTE.text, marginBottom: 4 }}>
        Compare two periods
      </h2>
      <p style={{ fontSize: 13, color: PALETTE.textSec, marginBottom: 12 }}>
        Pick a period length, then choose the start date for each period.
        Both periods always begin on the same day of the week so Monday compares with Monday,
        Tuesday with Tuesday, and so on.
      </p>

      {/* ── Filter bar ─────────────────────────────────────────────── */}
      <div style={{
        border: `1px solid ${PALETTE.border}`,
        background: PALETTE.card,
        borderRadius: 8,
        padding: 16,
        marginBottom: 12,
      }}>
        {/* Row 1 — period length preset */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
          <label style={lbl}>Period length</label>
          <div style={{ display: "inline-flex", gap: 0 }}>
            {LENGTH_PRESETS.map((p, i) => {
              const active = lengthDays === p.days;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setLengthDays(p.days)}
                  style={{
                    ...segButton,
                    background: active ? PALETTE.text : "#fff",
                    color: active ? "#fff" : PALETTE.text,
                    borderColor: active ? PALETTE.text : PALETTE.border,
                    borderTopLeftRadius: i === 0 ? 4 : 0,
                    borderBottomLeftRadius: i === 0 ? 4 : 0,
                    borderTopRightRadius: i === LENGTH_PRESETS.length - 1 ? 4 : 0,
                    borderBottomRightRadius: i === LENGTH_PRESETS.length - 1 ? 4 : 0,
                    marginLeft: i === 0 ? 0 : -1,
                  }}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Row 2 — Period A */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
          <span style={periodBadge(PALETTE.aBlueBg, PALETTE.aBlue)}>Period A</span>
          <label style={lbl}>Starts</label>
          <input type="date" value={aFrom} onChange={(e) => setAFrom(e.target.value)} style={dateInput} />
          <span style={{ ...lbl, color: PALETTE.text }}>
            {formatDow(aFrom)} → {formatDow(aTo)}
          </span>
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

        {/* Row 3 — Period B */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
          <span style={periodBadge(PALETTE.bOrangeBg, PALETTE.bOrange)}>Period B</span>
          <label style={lbl}>Starts</label>
          <input
            type="date"
            value={bFrom}
            onChange={(e) => setBFrom(e.target.value)}
            style={dateInput}
            title="Auto-snaps to match Period A's day-of-week so Monday compares with Monday, etc."
          />
          <span style={{ ...lbl, color: PALETTE.text }}>
            {formatDow(bFrom)} → {formatDow(bTo)}
          </span>
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

          <label style={lbl}>CPU model</label>
          <select
            value={cpuModel}
            onChange={(e) => setCpuModel(e.target.value)}
            style={{
              ...dateInput, padding: "4px 6px", maxWidth: 220,
            }}
            title="Restrict the comparison to hosts with this CPU model. Useful when comparing the same configuration change across different hardware generations."
          >
            {cpuModelOptions.map((m) => (
              <option key={m} value={m}>{m === "all" ? "All models" : m}</option>
            ))}
          </select>

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
