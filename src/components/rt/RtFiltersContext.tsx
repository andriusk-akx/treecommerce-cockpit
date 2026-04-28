"use client";

/**
 * Dashboard-wide filter store.
 *
 * Filters live above the tabs so navigating between Overview / Timeline /
 * Host Inventory / etc. preserves the user's selections. State is also
 * persisted to localStorage keyed by pilot id so a page reload (or returning
 * to the dashboard from elsewhere) restores the previous filter set.
 *
 * Defaults are centralised: see `defaultFilters` below. The UI considers a
 * filter "active" when its current value differs from the default — that's
 * what drives the chip bar above the tabs and the Clear all button.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

export interface DashboardFilters {
  /** Store name filter ("all" = no filter). Applied across Overview, Timeline, Inventory. */
  store: string;
  /** CPU model filter ("all" = no filter). Lets the user narrow the heatmap
   * to one hardware class — useful when comparing same-spec hosts. */
  cpuModel: string;
  /** Free-text search over host name / device type / CPU model. */
  search: string;
  /** Retellect-installed filter. null = no filter, true = only installed, false = only not installed. */
  retellectInstalled: boolean | null;
  /** Timeline period — preset id ("14d", "30d", "90d") or numeric custom days as string. */
  period: string;
  /** Timeline threshold (used by heatmap colour and exceed count). */
  threshold: number;
  /** Drill-down granularity in minutes (1, 5, 15, 60). 1m = native sample rate. */
  granularity: number;
  /** Drill-down chart mode. */
  chartMode: "bars" | "area";
}

export const defaultFilters: DashboardFilters = {
  store: "all",
  cpuModel: "all",
  search: "",
  retellectInstalled: null,
  period: "14d",
  threshold: 70,
  granularity: 1,
  chartMode: "bars",
};

/** Human labels for chip bar. Order here = chip render order. */
const FILTER_LABELS: Array<{
  key: keyof DashboardFilters;
  label: string;
  format: (v: DashboardFilters[keyof DashboardFilters]) => string;
}> = [
  { key: "store", label: "Store", format: (v) => String(v) },
  { key: "cpuModel", label: "CPU", format: (v) => String(v) },
  { key: "search", label: "Search", format: (v) => `"${String(v)}"` },
  { key: "retellectInstalled", label: "Retellect", format: (v) => v === true ? "installed" : v === false ? "not installed" : "" },
  { key: "period", label: "Period", format: (v) => /^\d+$/.test(String(v)) ? `${v}d` : String(v) },
  { key: "threshold", label: "Threshold", format: (v) => `${v}%` },
  { key: "granularity", label: "Granularity", format: (v) => `${v}min` },
  { key: "chartMode", label: "Chart", format: (v) => String(v) },
];

interface ContextValue {
  filters: DashboardFilters;
  setFilter: <K extends keyof DashboardFilters>(key: K, value: DashboardFilters[K]) => void;
  resetField: (key: keyof DashboardFilters) => void;
  resetAll: () => void;
  activeChips: Array<{ key: keyof DashboardFilters; label: string; value: string }>;
  activeCount: number;
}

const RtFiltersContext = createContext<ContextValue | null>(null);

export function useRtFilters(): ContextValue {
  const ctx = useContext(RtFiltersContext);
  if (!ctx) throw new Error("useRtFilters must be used within RtFiltersProvider");
  return ctx;
}

interface ProviderProps {
  /** Pilot id — used as localStorage namespace. */
  pilotId: string;
  children: ReactNode;
}

export function RtFiltersProvider({ pilotId, children }: ProviderProps) {
  const storageKey = `rtFilters:${pilotId}`;

  // Initialise from localStorage via lazy init. This file is "use client", so
  // the initialiser only runs in the browser — no SSR mismatch concern.
  const [filters, setFilters] = useState<DashboardFilters>(() => {
    if (typeof window === "undefined") return defaultFilters;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return defaultFilters;
      const parsed = JSON.parse(raw) as Partial<DashboardFilters>;
      // Shallow-merge with defaults so missing keys fall back gracefully when
      // the schema gains a field between sessions.
      const merged = { ...defaultFilters, ...parsed };
      // Migration 2026-04-28: drill-down granularity used to expose 1/5/15/60
      // presets. The 5- and 15-minute buckets were dropped, but legacy
      // localStorage payloads still carry those values — if we let them
      // through, the drill-down API silently fetches a 5- or 15-minute
      // resolution that no UI control can change, leaving the user with
      // stale-looking data and no way out. Snap anything outside the new
      // {1, 60} set back to the default (1).
      if (merged.granularity !== 1 && merged.granularity !== 60) {
        merged.granularity = defaultFilters.granularity;
      }
      return merged;
    } catch {
      return defaultFilters;
    }
  });

  // Persist on change.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(filters));
    } catch {
      // Quota / privacy mode — silently ignore.
    }
  }, [filters, storageKey]);

  const setFilter = useCallback(<K extends keyof DashboardFilters>(key: K, value: DashboardFilters[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }, []);

  const resetField = useCallback((key: keyof DashboardFilters) => {
    setFilters((prev) => ({ ...prev, [key]: defaultFilters[key] }));
  }, []);

  const resetAll = useCallback(() => setFilters(defaultFilters), []);

  const activeChips = useMemo(() => {
    const chips: Array<{ key: keyof DashboardFilters; label: string; value: string }> = [];
    for (const meta of FILTER_LABELS) {
      const cur = filters[meta.key];
      const def = defaultFilters[meta.key];
      if (cur === def) continue;
      // String-equal check for primitives.
      if (typeof cur === "string" && typeof def === "string" && cur === def) continue;
      const formatted = meta.format(cur);
      if (!formatted) continue;
      chips.push({ key: meta.key, label: meta.label, value: formatted });
    }
    return chips;
  }, [filters]);

  const value = useMemo<ContextValue>(() => ({
    filters,
    setFilter,
    resetField,
    resetAll,
    activeChips,
    activeCount: activeChips.length,
  }), [filters, setFilter, resetField, resetAll, activeChips]);

  return (
    <RtFiltersContext.Provider value={value}>
      {children}
    </RtFiltersContext.Provider>
  );
}

/**
 * Filter chip bar — renders above the tabs. Each chip removes its filter on
 * click; "Clear all" resets every filter to its default.
 */
export function RtFiltersBar() {
  const { activeChips, resetField, resetAll, activeCount } = useRtFilters();
  if (activeCount === 0) return null;
  return (
    <div className="bg-amber-50 border-b border-amber-200 px-6 py-2">
      <div className="max-w-6xl mx-auto flex items-center gap-2 flex-wrap text-xs">
        <span className="font-semibold text-amber-900 uppercase tracking-wide text-[10px]">
          {activeCount === 1 ? "Active filter" : `Active filters (${activeCount})`}
        </span>
        {activeChips.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => resetField(c.key)}
            className="group inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-amber-300 bg-white text-amber-900 hover:bg-amber-100 transition"
            title={`Clear ${c.label}`}
          >
            <span className="text-[10px] uppercase tracking-wide text-amber-700">{c.label}</span>
            <span className="font-mono">{c.value}</span>
            <span className="text-amber-400 group-hover:text-amber-700 ml-0.5">✕</span>
          </button>
        ))}
        <button
          type="button"
          onClick={resetAll}
          className="ml-auto text-amber-900 hover:text-red-600 transition font-medium"
        >
          Clear all
        </button>
      </div>
    </div>
  );
}
