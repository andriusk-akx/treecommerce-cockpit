"use client";

import { useState } from "react";

export interface SourceStatusInfo {
  source: string;
  label: string;
  env: string;
  status: "live" | "cached" | "unavailable";
  cachedAt: string | null;
  error: string | null;
  fetchMs: number;
}

/**
 * Universal data source status bar.
 * Shows all active data sources with their live/cached/unavailable status.
 * Clicking expands to show details per source.
 */
export default function DataSourceStatus({ sources }: { sources: SourceStatusInfo[] }) {
  const [expanded, setExpanded] = useState(false);

  if (sources.length === 0) return null;

  const liveCount = sources.filter((s) => s.status === "live").length;
  const cachedCount = sources.filter((s) => s.status === "cached").length;
  const downCount = sources.filter((s) => s.status === "unavailable").length;

  // Overall status color
  const allLive = liveCount === sources.length;
  const hasDown = downCount > 0;
  const borderColor = hasDown ? "border-red-300" : allLive ? "border-emerald-300" : "border-amber-300";
  const bgColor = hasDown ? "bg-red-50" : allLive ? "bg-emerald-50" : "bg-amber-50";

  return (
    <div className={`rounded-lg border ${borderColor} ${bgColor} mb-6 overflow-hidden transition-all`}>
      {/* Compact bar */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:opacity-80 transition-opacity"
      >
        <div className="flex items-center gap-3">
          {/* Status dots */}
          <div className="flex items-center gap-1.5">
            {sources.map((s, i) => (
              <span
                key={i}
                className={`w-2 h-2 rounded-full ${
                  s.status === "live"
                    ? "bg-emerald-500"
                    : s.status === "cached"
                    ? "bg-amber-500"
                    : "bg-red-500"
                }`}
                title={`${s.label}: ${s.status}`}
              />
            ))}
          </div>
          {/* Summary text */}
          <span className="text-[11px] font-medium text-gray-600">
            {allLive ? (
              <>Visi duomenys gyvi ({liveCount})</>
            ) : (
              <>
                {liveCount > 0 && (
                  <span className="text-emerald-700">{liveCount} live</span>
                )}
                {cachedCount > 0 && (
                  <>
                    {liveCount > 0 && <span className="text-gray-400 mx-1">/</span>}
                    <span className="text-amber-700">{cachedCount} cached</span>
                  </>
                )}
                {downCount > 0 && (
                  <>
                    {(liveCount > 0 || cachedCount > 0) && <span className="text-gray-400 mx-1">/</span>}
                    <span className="text-red-700">{downCount} nepasiekiami</span>
                  </>
                )}
              </>
            )}
          </span>
        </div>
        <span className="text-[10px] text-gray-400">{expanded ? "▲" : "▼"}</span>
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="border-t border-gray-200/50 px-4 py-3 space-y-2">
          {sources.map((s, i) => (
            <div key={i} className="flex items-center gap-3 text-[11px]">
              {/* Status badge */}
              <span
                className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider ${
                  s.status === "live"
                    ? "bg-emerald-100 text-emerald-700 border border-emerald-300"
                    : s.status === "cached"
                    ? "bg-amber-100 text-amber-700 border border-amber-300"
                    : "bg-red-100 text-red-700 border border-red-300"
                }`}
              >
                {s.status === "live" ? "LIVE" : s.status === "cached" ? "CACHED" : "DOWN"}
              </span>
              {/* Source label */}
              <span className="font-medium text-gray-700 min-w-[120px]">{s.label}</span>
              {/* Env badge */}
              <span
                className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${
                  s.env === "prod"
                    ? "bg-green-100 text-green-700"
                    : "bg-yellow-100 text-yellow-700"
                }`}
              >
                {s.env}
              </span>
              {/* Cache timestamp */}
              {s.cachedAt && (
                <span className="text-gray-400">
                  cache:{" "}
                  {new Date(s.cachedAt).toLocaleString("lt-LT", {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              )}
              {/* Error */}
              {s.error && <span className="text-red-500 truncate max-w-[200px]">{s.error}</span>}
              {/* Fetch time */}
              <span className="text-gray-300 ml-auto">{s.fetchMs}ms</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
