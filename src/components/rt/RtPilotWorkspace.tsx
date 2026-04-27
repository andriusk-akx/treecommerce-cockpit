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
}

// ─── Constants ──────────────────────────────────────────────────────

const tabs = [
  { id: "overview", label: "Overview" },
  { id: "timeline", label: "CPU Timeline" },
  { id: "inventory", label: "Host Inventory" },
  { id: "health", label: "Data Health" },
  { id: "cpu", label: "CPU Comparison" },
  { id: "reference", label: "Resource Overview" },
  { id: "risk", label: "Capacity Risk" },
  { id: "hypotheses", label: "Hypotheses & Recs" },
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
}: {
  pilot: RtPilotData;
  zabbix: ZabbixData;
  initialTab: string;
}) {
  const [activeTab, setActiveTab] = useState(initialTab);
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

      {/* Tabs */}
      <div className="bg-white border-b border-gray-200 px-6">
        <div className="max-w-6xl mx-auto flex gap-0 overflow-x-auto">
          {tabs.map((t) => (
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

      {/* Content */}
      <div className="max-w-6xl mx-auto px-6 py-6">
        {activeTab === "overview" && <RtOverview pilot={pilot} zabbix={zabbix} />}
        {activeTab === "inventory" && <RtInventory pilot={pilot} zabbix={zabbix} />}
        {activeTab === "health" && <RtDataHealth pilot={pilot} zabbix={zabbix} />}
        {activeTab === "timeline" && <RtTimeline pilot={pilot} zabbix={zabbix} />}
        {activeTab === "cpu" && <RtCpuComparison pilot={pilot} zabbix={zabbix} />}
        {activeTab === "reference" && <RtReference pilot={pilot} zabbix={zabbix} />}
        {activeTab === "risk" && <RtCapacityRisk pilot={pilot} zabbix={zabbix} />}
        {activeTab === "hypotheses" && <RtHypotheses pilot={pilot} zabbix={zabbix} />}
      </div>
    </div>
    </RtFiltersProvider>
  );
}
