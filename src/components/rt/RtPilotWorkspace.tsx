"use client";

import { useState } from "react";
import Link from "next/link";
import { RtOverview } from "./tabs/RtOverview";
import { RtInventory } from "./tabs/RtInventory";
import { RtTimeline } from "./tabs/RtTimeline";
import { RtCpuComparison } from "./tabs/RtCpuComparison";
import { RtReference } from "./tabs/RtReference";
import { RtCapacityRisk } from "./tabs/RtCapacityRisk";
import { RtHypotheses } from "./tabs/RtHypotheses";
import { RtDataHealth } from "./tabs/RtDataHealth";
// `RtFiltersBar` (chip bar with active-filter chips and "Clear all") is
// implemented in RtFiltersContext but intentionally not mounted here yet —
// the surface felt too noisy for the current dashboard. Filters still persist
// across tabs via the provider; the bar can be turned back on by importing
// it alongside RtFiltersProvider and rendering above the tabs.
import { RtFiltersProvider } from "./RtFiltersContext";

// ─── Types ──────────────────────────────────────────────────────────

export interface RtPilotData {
  id: string;
  name: string;
  shortCode: string;
  status: string;
  clientName: string;
  goalSummary: string | null;
  notes: string | null;
  deviceCount: number;
  incidentCount: number;
  storeCount: number;
  stores: { id: string; name: string; code: string }[];
  devices: {
    id: string;
    name: string;
    sourceHostKey: string | null;
    storeName: string;
    cpuModel: string;
    ramGb: number;
    retellectEnabled: boolean;
    retellectConfidence: string | null;
    status: string;
    deviceType: string;
    os: string | null;
  }[];
}

export interface ZabbixHostData {
  hostId: string;
  hostName: string;
  status: string;
  groups: string[];
  ip: string | null;
  cpu: { utilization: number; load: number } | null;
  memory: { utilization: number; totalBytes: number; availableBytes: number } | null;
  disk: { utilization: number; path: string } | null;
  /**
   * Hardware inventory pulled from Zabbix `host.inventory` (RT-CPUMODEL phase 1).
   * `null` when the host has `inventory_mode = -1` or every requested field is
   * empty. The Inventory and Timeline tabs read this as a fallback when the DB
   * `Device.cpuModel` is null — phase 2 will backfill the DB and this fallback
   * becomes redundant but harmless.
   */
  inventory: { cpuModel: string | null; ramBytes: number | null; os: string | null } | null;
}

export interface ZabbixCpuDetailItem {
  hostId: string;
  key: string;
  name: string;
  value: number;
  lastClock: string | null;
  units: string;
}

export interface ZabbixProcItem {
  hostId: string;
  key: string;
  name: string;
  value: number;
  lastClock: string | null;
}

/** Per-process CPU % sample from custom `<proc>.cpu` Zabbix items (1-min average). */
export interface ZabbixProcCpuItem {
  hostId: string;
  key: string;
  name: string;
  procName: string;
  category: "retellect" | "sco" | "db" | "hw" | "sys" | "other";
  cpuValue: number;
  lastClock: string | null;
  lastClockUnix: number;
  units: string;
}

export interface ZabbixProcCpuMeta {
  status: "live" | "cached" | "unavailable";
  fetchMs: number;
  error: string | null;
}

export interface ZabbixCpuTrend {
  hostId: string;
  date: string; // ISO date "YYYY-MM-DD"
  max: number;
  avg: number;
  min: number;
  /**
   * Number of raw 1-min samples that day where CPU was at-or-above the
   * named threshold. Computed only from `history.get` samples, so days
   * covered exclusively by `trend.get` aggregates have these as 0.
   */
  minutesAbove?: { 50: number; 60: number; 70: number; 80: number; 90: number };
  /**
   * Total number of raw samples (i.e. minutes with data) ingested for
   * this (host, date). Denominator for "X minutes above / Y total" UI.
   */
  totalSamples?: number;
}

/**
 * Per-host Zabbix item-state summary. Lets the dashboard distinguish
 * "agent broken" (most items in `state=1` / ZBX_NOTSUPPORTED) from
 * "process idle" (items reporting 0 normally). Populated by
 * `ZabbixClient.getAgentHealthSummary()`.
 */
export interface ZabbixAgentHealth {
  hostId: string;
  totalEnabled: number;
  supported: number;
  unsupported: number;
  /** Up to 5 sample error strings from unsupported items, for diagnostics. */
  sampleErrors: string[];
}

export interface ZabbixData {
  status: "live" | "cached" | "unavailable";
  fetchMs: number;
  cachedAt: string | null;
  error: string | null;
  hosts: ZabbixHostData[];
  cpuDetail: ZabbixCpuDetailItem[];
  procItems?: ZabbixProcItem[];
  /** Per-process CPU % (python, spss, sqlservr, ...) — authoritative RT liveness signal */
  procCpu?: ZabbixProcCpuItem[];
  procCpuMeta?: ZabbixProcCpuMeta;
  cpuTrends?: ZabbixCpuTrend[];
  /** Status + error for the trend fetcher specifically. Surfaced to the
   *  cross-tab error banner so a silent history.get failure (long fetch
   *  timed out, item permissions, etc.) is visible even when the hosts
   *  fetch succeeded — i.e. exactly the scenario where the Timeline shows
   *  empty cells but the header still says "Zabbix LIVE". */
  cpuTrendsMeta?: { status: "live" | "cached" | "unavailable"; fetchMs: number; error: string | null };
  /** Per-host item state summary — flags hosts with broken Zabbix agents */
  agentHealth?: ZabbixAgentHealth[];
}

// ─── Constants ──────────────────────────────────────────────────────

// `permKey` maps each tab to the permission key in Role.allowedTabs /
// UserPilotAccess.allowedTabs. Keep in sync with src/lib/auth/permissions.ts.
const tabs = [
  { id: "overview",    label: "Overview",                  permKey: "overview" },
  { id: "timeline",    label: "CPU Timeline",              permKey: "timeline" },
  { id: "inventory",   label: "Host Inventory",            permKey: "inventory" },
  { id: "health",      label: "Data Health",               permKey: "datahealth" },
  { id: "cpu",         label: "CPU Comparison",            permKey: "comparison" },
  { id: "reference",   label: "Resource Overview",         permKey: "reference" },
  { id: "risk",        label: "Capacity Risk",             permKey: "capacity" },
  { id: "hypotheses",  label: "Hypotheses & Recs",         permKey: "hypotheses" },
];

const statusStyles: Record<string, string> = {
  ACTIVE: "bg-emerald-50 text-emerald-700 border-emerald-200",
  PLANNED: "bg-blue-50 text-blue-700 border-blue-200",
  PAUSED: "bg-amber-50 text-amber-700 border-amber-200",
  COMPLETED: "bg-gray-100 text-gray-500 border-gray-200",
};

// ─── Component ──────────────────────────────────────────────────────

export function RtPilotWorkspace({
  pilot,
  zabbix,
  initialTab,
  allowedTabs,
}: {
  pilot: RtPilotData;
  zabbix: ZabbixData;
  initialTab: string;
  /** Permission keys the current user is allowed to see in this pilot. */
  allowedTabs: string[];
}) {
  // Filter the tab list to what the user can see. Admin gets the full list
  // (page passes ALL_TABS). Non-admin sees only their granted tabs.
  // If the user landed on a forbidden tab via URL, fall back to the first
  // allowed tab so the UI doesn't render an empty workspace.
  const allowedSet = new Set(allowedTabs);
  const visibleTabs = tabs.filter((t) => allowedSet.has(t.permKey));
  const safeInitial = visibleTabs.find((t) => t.id === initialTab)
    ? initialTab
    : visibleTabs[0]?.id ?? "overview";
  const [activeTab, setActiveTab] = useState(safeInitial);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);

  function handleSync() {
    setSyncStatus("Syncing...");
    // Reload page to re-fetch from Zabbix
    setTimeout(() => {
      window.location.reload();
    }, 400);
  }

  const zabbixStatusColor =
    zabbix.status === "live" ? "bg-emerald-500" :
    zabbix.status === "cached" ? "bg-amber-500" : "bg-red-500";
  const zabbixStatusLabel =
    zabbix.status === "live" ? "LIVE" :
    zabbix.status === "cached" ? "CACHED" : "DOWN";
  const zabbixFreshness =
    zabbix.status === "live" ? `${zabbix.fetchMs}ms` :
    zabbix.cachedAt ? new Date(zabbix.cachedAt).toLocaleString("lt-LT") : "—";

  // Count matched devices (where sourceHostKey or name matches a Zabbix host)
  const zabbixByName = new Map(zabbix.hosts.map((h) => [h.hostName, h]));
  const matchedDevicesCount = pilot.devices.filter((d) => 
    zabbixByName.has(d.sourceHostKey || "") || zabbixByName.has(d.name)
  ).length;

  return (
    <RtFiltersProvider pilotId={pilot.id}>
    <div>
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-6xl mx-auto">
          <div className="text-xs text-gray-400 mb-2">
            <Link href="/" className="hover:text-gray-600">Home</Link>
            <span className="mx-1">/</span>
            <Link href="/retellect" className="hover:text-gray-600">Retellect</Link>
            <span className="mx-1">/</span>
            <span className="text-gray-700 font-medium">{pilot.name}</span>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold text-gray-900">{pilot.name}</h1>
              <span className={`inline-block px-2 py-0.5 rounded border text-[10px] font-medium ${statusStyles[pilot.status] || statusStyles.PLANNED}`}>
                {pilot.status.toLowerCase()}
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <span className="flex items-center gap-1.5 px-2 py-1 rounded bg-gray-50">
                <span className={`w-1.5 h-1.5 rounded-full ${zabbixStatusColor}`} />
                <span className="text-xs font-medium text-gray-700">Zabbix</span>
                <span className={`text-xs font-semibold ${
                  zabbix.status === "live" ? "text-emerald-600" :
                  zabbix.status === "cached" ? "text-amber-600" : "text-red-600"
                }`}>
                  {zabbixStatusLabel}
                </span>
                <span className="text-xs text-gray-400">{zabbixFreshness}</span>
              </span>
              <span className="text-xs text-gray-400">{matchedDevicesCount}/{pilot.deviceCount} matched</span>
              <button
                className="border border-gray-200 bg-white text-gray-600 text-xs font-medium px-3 py-1 rounded hover:bg-gray-50 transition"
                onClick={handleSync}
              >
                {syncStatus || "Sync"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Cross-tab Zabbix error banner. Surfaces failures from any of the
          per-source fetchers, not just the hosts call — a silent history.get
          failure (long fetch timed out, item permissions) shows the Timeline
          empty even when the header says "Zabbix LIVE", so we collect every
          fetcher's error here and render whichever fired. */}
      {(() => {
        type ErrSource = { label: string; error: string };
        const errors: ErrSource[] = [];
        if (zabbix.error) errors.push({ label: "hosts", error: zabbix.error });
        if (zabbix.cpuTrendsMeta?.error) errors.push({ label: "CPU history", error: zabbix.cpuTrendsMeta.error });
        if (zabbix.procCpuMeta?.error) errors.push({ label: "process CPU", error: zabbix.procCpuMeta.error });
        // No errors AND we still have an empty trends array? That's the silent
        // case the auditor flagged — fetchSource returned status="live" with
        // zero records. Surface it as a soft warning so the user can act.
        const trendsEmpty = (zabbix.cpuTrends?.length || 0) === 0
          && !zabbix.cpuTrendsMeta?.error
          && (zabbix.cpuTrendsMeta?.status === "live" || zabbix.cpuTrendsMeta?.status === "cached");
        if (errors.length === 0 && !trendsEmpty) return null;
        return (
          <div className={`${errors.length > 0 ? "bg-red-50 border-red-200" : "bg-amber-50 border-amber-200"} border-b px-6 py-2`}>
            <div className="max-w-6xl mx-auto flex items-start gap-3 text-xs">
              <span
                className={`inline-block px-1.5 py-0.5 rounded font-semibold tracking-wide ${
                  errors.length > 0 ? "bg-red-200 text-red-800" : "bg-amber-200 text-amber-800"
                }`}
                style={{ fontSize: 9 }}
              >
                ZABBIX
              </span>
              <div className={`flex-1 leading-relaxed ${errors.length > 0 ? "text-red-700" : "text-amber-700"}`}>
                {errors.length > 0 ? (
                  <>
                    <strong>Live data unavailable.</strong>{" "}
                    {errors.map((e, i) => (
                      <span key={e.label}>
                        {i > 0 && <span className="opacity-50"> · </span>}
                        <span className="opacity-70">[{e.label}]</span> {e.error}
                      </span>
                    ))}
                    {zabbix.cachedAt && (
                      <span className="opacity-70">
                        {" "}— showing cached snapshot from {new Date(zabbix.cachedAt).toLocaleString("lt-LT")}.
                      </span>
                    )}
                  </>
                ) : (
                  <>
                    <strong>CPU history empty.</strong> The trend fetch returned
                    {" "}{zabbix.cpuTrendsMeta?.status === "cached" ? "a cached " : "a "}response
                    with 0 records — the Timeline heatmap will look blank. Likely causes:
                    history.get permissions on the API token, or the matched
                    hosts have no <code>system.cpu.util[,,avg1]</code> items.
                  </>
                )}
              </div>
              <button
                type="button"
                className={`underline underline-offset-2 ${
                  errors.length > 0 ? "text-red-700 hover:text-red-900" : "text-amber-700 hover:text-amber-900"
                }`}
                onClick={handleSync}
              >
                Retry
              </button>
            </div>
          </div>
        );
      })()}

      {/* Tabs */}
      <div className="bg-white border-b border-gray-200 px-6">
        <div className="max-w-6xl mx-auto flex gap-0 overflow-x-auto">
          {visibleTabs.map((t) => (
            <button
              key={t.id}
              className={`py-3 px-4 text-sm whitespace-nowrap border-b-2 transition ${
                t.id === activeTab
                  ? "text-blue-600 border-blue-600 font-medium"
                  : "text-gray-500 border-transparent hover:text-gray-700 hover:border-gray-300"
              }`}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content — defence in depth: only render the panel if its permKey
          is in allowedTabs. The page-level check + visibleTabs filter above
          should already make this redundant, but a forbidden activeTab
          (e.g. via stale localStorage) would still render an empty panel. */}
      <div className="max-w-6xl mx-auto px-6 py-6">
        {activeTab === "overview"   && allowedSet.has("overview")   && <RtOverview pilot={pilot} zabbix={zabbix} />}
        {activeTab === "inventory"  && allowedSet.has("inventory")  && <RtInventory pilot={pilot} zabbix={zabbix} />}
        {activeTab === "health"     && allowedSet.has("datahealth") && (
          <RtDataHealth
            pilot={pilot}
            zabbix={zabbix}
            onNavigateTab={(id) => {
              // Only switch if the requested tab is permitted for this user;
              // otherwise leave the active tab alone (silent no-op).
              const tab = tabs.find((t) => t.id === id);
              if (tab && allowedSet.has(tab.permKey)) setActiveTab(id);
            }}
          />
        )}
        {activeTab === "timeline"   && allowedSet.has("timeline")   && <RtTimeline pilot={pilot} zabbix={zabbix} />}
        {activeTab === "cpu"        && allowedSet.has("comparison") && <RtCpuComparison pilot={pilot} zabbix={zabbix} />}
        {activeTab === "reference"  && allowedSet.has("reference")  && <RtReference pilot={pilot} zabbix={zabbix} />}
        {activeTab === "risk"       && allowedSet.has("capacity")   && <RtCapacityRisk pilot={pilot} zabbix={zabbix} />}
        {activeTab === "hypotheses" && allowedSet.has("hypotheses") && <RtHypotheses pilot={pilot} zabbix={zabbix} />}
      </div>
    </div>
    </RtFiltersProvider>
  );
}
