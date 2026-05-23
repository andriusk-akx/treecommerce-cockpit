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
  /**
   * Retellect filter pill state.
   *   "today"     → show only hosts with meaningful Retellect (python.cpu)
   *                 activity in the last 24 h. Strict subset of "installed".
   *   "installed" → show only hosts where Retellect items are configured
   *                 in the Zabbix template (regardless of current activity).
   *   null        → no filter.
   *
   * Was `boolean | null` until 2026-05-07 when the negative-filter pill
   * ("Retellect Off") was replaced with a positive-filter pill
   * ("Retellect Installed"). The localStorage migration in the provider
   * below collapses any pre-migration boolean value to `null` rather than
   * trying to guess intent.
   */
  retellectInstalled: "today" | "installed" | null;
  /** Timeline period — preset id ("14d", "30d", "90d") or numeric custom days as string. */
  period: string;
  /** Timeline threshold (used by heatmap colour and exceed count). */
  threshold: number;
  /**
   * Rollout Insights "active" threshold in **percentage points** above
   * each host's spss.cpu baseline. A minute counts as active when
   * `spss.cpu > baseline + activeThresholdPp`. Conceptually different
   * from `threshold` (which is an absolute heatmap %); kept as a
   * separate field so the two filter UIs don't collide. Bounded 0..10.
   */
  activeThresholdPp: number;
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
  activeThresholdPp: 2.0,
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
  { key: "retellectInstalled", label: "Retellect", format: (v) => v === "today" ? "active today" : v === "installed" ? "installed" : "" },
  { key: "period", label: "Period", format: (v) => /^\d+$/.test(String(v)) ? `${v}d` : String(v) },
  { key: "threshold", label: "Threshold", format: (v) => `${v}%` },
  { key: "activeThresholdPp", label: "Active", format: (v) => `${v} pp` },
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
  /**
   * Period value seeded from the page-level `?period=` URL search param.
   *
   * Why this exists: `period` has two sources of truth — the URL (used by the
   * server component to fetch the right-sized CPU history payload) and the
   * filters context (used by the client UI to compute the heatmap axis
   * length). Before this prop, the provider's SSR pass returned
   * `defaultFilters.period = "14d"` regardless of URL because `localStorage`
   * is unavailable server-side. That caused a "14-day axis with 30-day data"
   * flash on hard reload of `?period=30d`: the server-rendered HTML had the
   * wrong axis width until the client's URL→context sync useEffect in
   * RtTimeline fired and re-rendered. Users perceived this as "data stuck on
   * 14d, then somehow recovers".
   *
   * Passing `initialPeriod` from the page lets the very first SSR pass — and
   * client first render — both use the URL value, so the heatmap renders the
   * correct axis from paint zero. localStorage still wins for return visits
   * with no `?period=` in URL (deep-link from elsewhere).
   *
   * Pass the raw URL param value: preset id ("14d") or bare digits ("60").
   * Empty/undefined means no URL override; localStorage (then defaults) wins.
   */
  initialPeriod?: string;
  /**
   * Same pattern as initialPeriod — seeded from page `?at=` URL param so
   * SSR + client first render use the URL value rather than localStorage
   * / defaults. Drives the Rollout Insights minute classification.
   */
  initialActiveThresholdPp?: number;
  children: ReactNode;
}

export function RtFiltersProvider({ pilotId, initialPeriod, initialActiveThresholdPp, children }: ProviderProps) {
  const storageKey = `rtFilters:${pilotId}`;

  // Initialise from localStorage via lazy init. This file is "use client", so
  // the initialiser only runs in the browser — no SSR mismatch concern…
  // …except for `period`, where the server's SSR pass also runs this code
  // and would otherwise return `defaultFilters.period`. We seed `period` from
  // the URL-derived `initialPeriod` first so server and client agree on the
  // axis width from the very first render (see ProviderProps doc above).
  const [filters, setFilters] = useState<DashboardFilters>(() => {
    const seed: DashboardFilters = {
      ...defaultFilters,
      ...(initialPeriod ? { period: initialPeriod } : {}),
      ...(initialActiveThresholdPp !== undefined ? { activeThresholdPp: initialActiveThresholdPp } : {}),
    };
    if (typeof window === "undefined") return seed;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return seed;
      const parsed = JSON.parse(raw) as Partial<DashboardFilters>;
      // Shallow-merge with defaults so missing keys fall back gracefully when
      // the schema gains a field between sessions. URL `period` (if present)
      // overrides localStorage to match server-side data fetch.
      const merged = {
        ...defaultFilters,
        ...parsed,
        ...(initialPeriod ? { period: initialPeriod } : {}),
        ...(initialActiveThresholdPp !== undefined ? { activeThresholdPp: initialActiveThresholdPp } : {}),
      };
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
      // Migration 2026-05-07: retellectInstalled was `boolean | null`; the
      // pill bar replaced the negative "Off" filter with a positive
      // "Installed" filter, and the type widened to "today" | "installed"
      // | null. Pre-migration localStorage payloads still carry booleans —
      // collapse them all to null rather than trying to guess intent
      // (`true` "On" semantically maps to "today", but the user may
      // genuinely want the wider "installed" filter post-migration; safer
      // to start clean than silently keep a different filter state).
      if (
        merged.retellectInstalled !== null &&
        merged.retellectInstalled !== "today" &&
        merged.retellectInstalled !== "installed"
      ) {
        merged.retellectInstalled = null;
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
