"use client";

import {
  RT_FRESHNESS_THRESHOLD_SEC,
  RT_STALE_THRESHOLD_SEC,
  formatAgeShort,
} from "./rt-inventory-helpers";

/**
 * Small inline badge showing how old a Zabbix sample is, colored by threshold.
 *
 *   live  (ageSec < RT_FRESHNESS_THRESHOLD_SEC, 5 min) → badge hidden
 *   warn  (5 min ≤ ageSec < RT_STALE_THRESHOLD_SEC, 30 min) → amber
 *   stale (ageSec ≥ RT_STALE_THRESHOLD_SEC)              → gray
 *
 * `nowMs=0` is treated as „clock not yet initialized" — we render nothing so
 * SSR and first client render match (prevents hydration mismatches; parent
 * components that need a live clock set nowMs via useEffect on mount).
 */
export function StaleAgeBadge({
  lastClock,
  nowMs,
  compact = false,
}: {
  lastClock: string | null | undefined;
  nowMs: number;
  /** When true, uses a smaller/tighter variant (for dense tables). */
  compact?: boolean;
}) {
  if (!lastClock) return null;
  const lastClockMs = new Date(lastClock).getTime();
  if (!Number.isFinite(lastClockMs)) return null;
  if (nowMs <= 0) return null;
  const ageSec = Math.max(0, Math.floor((nowMs - lastClockMs) / 1000));
  if (ageSec < RT_FRESHNESS_THRESHOLD_SEC) return null;
  const isStale = ageSec >= RT_STALE_THRESHOLD_SEC;
  const sizeClass = compact ? "text-[10px]" : "text-xs";
  const colorClass = isStale ? "text-gray-400" : "text-amber-500";
  const title = isStale
    ? "Stale: Zabbix data older than 30 min"
    : "Zabbix data older than 5 min";
  return (
    <span className={`font-normal ${sizeClass} ${colorClass}`} title={title}>
      {formatAgeShort(ageSec)}
    </span>
  );
}
