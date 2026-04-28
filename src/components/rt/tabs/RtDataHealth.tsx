"use client";

import { useEffect, useMemo, useState } from "react";
import type { RtPilotData, ZabbixData } from "../RtPilotWorkspace";
import {
  determineRtStatus,
  buildProcByHost,
  buildRetellectProcsByHost,
  type RtProcessStatus,
} from "./rt-inventory-helpers";
import {
  classifyDataHealth,
  groupByStore,
  summarize,
  diagnosisFor,
  type DataHealthBucket,
  type DataHealthHostRow,
} from "./rt-data-health-helpers";

/**
 * MON-1 Data Health tab.
 *
 * Why this view exists:
 *   A host where the local Zabbix agent reports most items as
 *   `ZBX_NOTSUPPORTED` looks identical to a host where Retellect is genuinely
 *   idle — both read as "0 % CPU" on every other tab. This view separates
 *   those two failure modes so a monitoring gap on one host doesn't pollute
 *   capacity findings (false negative: "looks like Retellect is off, actually
 *   we just can't see anything from this host").
 *
 *   Per-store grouping with sibling-contrast detection makes host-level
 *   issues obvious: when a single store has both a healthy host and a
 *   broken host, the problem is almost certainly host-side (perfcounter
 *   privileges, corrupt PDH, stuck WMI provider) — not site-wide.
 */
export function RtDataHealth({
  pilot,
  zabbix,
  onNavigateTab,
}: {
  pilot: RtPilotData;
  zabbix: ZabbixData;
  /** Switch to another tab in the parent workspace (e.g. "inventory"). */
  onNavigateTab?: (tabId: string) => void;
}) {
  // Lightweight toast for the placeholder runbook button. Absolute-positioned
  // so it doesn't shift the layout, and auto-dismisses after 3 s.
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(id);
  }, [toast]);

  // Group filter chips: All / Issues only / Mixed stores.
  const [groupFilter, setGroupFilter] = useState<"all" | "issues" | "mixed">(
    "all",
  );

  // Build host rows: join DB devices to Zabbix hosts and agent-health entries.
  const rows = useMemo<DataHealthHostRow[]>(() => {
    const zabbixByName = new Map(zabbix.hosts.map((h) => [h.hostName, h]));
    const agentHealthByHostId = new Map(
      (zabbix.agentHealth ?? []).map((a) => [a.hostId, a]),
    );

    // Newest CPU sample per host — surfaces in the "Last update" column.
    const newestClockByHostId = new Map<string, number>();
    for (const item of zabbix.cpuDetail) {
      if (!item.lastClock) continue;
      const ts = Date.parse(item.lastClock);
      if (!Number.isFinite(ts) || ts <= 0) continue;
      const prev = newestClockByHostId.get(item.hostId);
      if (prev === undefined || ts > prev) {
        newestClockByHostId.set(item.hostId, ts);
      }
    }

    // RT-status inputs (mirrors RtInventory's logic so the "Retellect" pill
    // here agrees with the Inventory tab).
    const procByHost = buildProcByHost(
      (zabbix.procItems || []).map((p) => ({
        hostId: p.hostId,
        key: p.key,
        name: p.name,
        value: p.value,
      })),
    );
    const retellectProcsByHost = buildRetellectProcsByHost(
      (zabbix.procCpu || []).map((p) => ({
        hostId: p.hostId,
        key: p.key,
        name: p.name,
        procName: p.procName,
        category: p.category,
        cpuValue: p.cpuValue,
        lastClockUnix: p.lastClockUnix,
      })),
    );
    const hasProcCpuFeed = (zabbix.procCpu?.length ?? 0) > 0;

    const out: DataHealthHostRow[] = [];
    for (const device of pilot.devices) {
      const zHost =
        zabbixByName.get(device.sourceHostKey || "") ||
        zabbixByName.get(device.name);
      const matched = !!zHost;
      const entry = zHost ? agentHealthByHostId.get(zHost.hostId) : undefined;
      const bucket: DataHealthBucket = classifyDataHealth(matched, entry);

      const procEntry = zHost ? procByHost.get(zHost.hostId) : undefined;
      const pythonProcs = zHost ? retellectProcsByHost.get(zHost.hostId) : undefined;
      const retellectProcsForStatus = hasProcCpuFeed && zHost
        ? (pythonProcs ?? [])
        : undefined;
      const rt = determineRtStatus({
        retellectEnabled: device.retellectEnabled,
        zabbixHostExists: matched,
        procMatch: procEntry ? { count: procEntry.count } : null,
        retellectProcs: retellectProcsForStatus,
      });
      const rtStatus: RtProcessStatus = rt.status;

      const lastClockMs = zHost
        ? newestClockByHostId.get(zHost.hostId) ?? null
        : null;

      out.push({
        deviceId: device.id,
        hostName: device.name,
        storeName: device.storeName,
        zabbixHostName: zHost ? zHost.hostName : null,
        zabbixMatched: matched,
        retellectEnabled: device.retellectEnabled,
        rtStatus,
        supported: entry?.supported ?? 0,
        unsupported: entry?.unsupported ?? 0,
        totalEnabled: entry?.totalEnabled ?? 0,
        bucket,
        lastUpdate: lastClockMs ? new Date(lastClockMs).toISOString() : null,
      });
    }
    return out;
  }, [pilot, zabbix]);

  const summary = useMemo(() => summarize(rows), [rows]);
  const groups = useMemo(() => groupByStore(rows), [rows]);

  const visibleGroups = useMemo(() => {
    if (groupFilter === "issues") return groups.filter((g) => g.hasIssue);
    if (groupFilter === "mixed") return groups.filter((g) => g.isMixed);
    return groups;
  }, [groups, groupFilter]);

  // ─── Render ────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Why-this-view banner */}
      <div className="rounded border border-amber-200 bg-amber-50 px-5 py-4 border-l-4 border-l-amber-400">
        <h3 className="font-semibold text-sm text-amber-900 mb-1">
          Why this view exists
        </h3>
        <p className="text-sm text-amber-900/90 leading-relaxed">
          A host with no CPU data is <em>not</em> the same as a host where
          Retellect is off. Some Rimi SCOs have local Zabbix agents in a
          degraded state where most <code className="font-mono">perf_counter[*]</code>{" "}
          items report <code className="font-mono">ZBX_NOTSUPPORTED</code> —
          the dashboard would otherwise read those as 0 % Retellect activity,
          a false negative. This view surfaces monitoring gaps separately so
          they don&apos;t pollute capacity findings.
        </p>
      </div>

      {/* 4 KPI cards — healthy / partial / broken / unenrolled */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard
          label="Healthy"
          value={summary.healthy}
          tone="ok"
          hint="Agent reporting normally — < 25 % items unsupported."
        />
        <KpiCard
          label="Partial"
          value={summary.partial}
          tone="warn"
          hint="25–50 % items unsupported — partial visibility into per-process CPU."
        />
        <KpiCard
          label="Broken"
          value={summary.broken}
          tone="alert"
          hint="> 50 % items in ZBX_NOTSUPPORTED — host-side agent / perfcounter problem. Dashboard numbers from these hosts NOT reliable."
        />
        <KpiCard
          label="Unenrolled"
          value={summary.unenrolled}
          tone="neutral"
          hint="DB device not registered in Zabbix monitoring, or template empty."
        />
      </div>

      {/* Per-store breakdown header + filter chips */}
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm text-gray-900">
          Per-store breakdown
        </h3>
        <div className="flex items-center gap-2 text-xs">
          {(
            [
              { id: "all", label: "All" },
              { id: "issues", label: "Issues only" },
              { id: "mixed", label: "Mixed stores" },
            ] as const
          ).map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setGroupFilter(f.id)}
              className={`px-3 py-1 rounded-full font-medium transition ${
                groupFilter === f.id
                  ? "bg-blue-50 text-blue-700"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Per-store groups */}
      {visibleGroups.length === 0 ? (
        <div className="rounded border border-gray-200 bg-white px-5 py-8 text-center text-xs text-gray-400">
          {groupFilter === "mixed"
            ? "No stores currently show mixed (healthy + broken) hosts. Sibling-contrast diagnosis is unavailable until at least one store has both."
            : groupFilter === "issues"
              ? "No stores have any agent issues. Every host is reporting normally or has no monitoring entry."
              : "No hosts in this pilot."}
        </div>
      ) : (
        visibleGroups.map((g) => (
          <section
            key={g.storeName}
            className="rounded border border-gray-200 bg-white overflow-hidden"
          >
            <header className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-200">
              <div className="flex items-center gap-3">
                <span className="font-semibold text-sm text-gray-900">
                  {g.storeName}
                </span>
                <span className="text-xs text-gray-500">
                  {g.hosts.length} host{g.hosts.length === 1 ? "" : "s"}
                </span>
              </div>
              {g.isMixed && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-50 text-amber-700 border border-amber-200">
                  Mixed — host-level issue
                </span>
              )}
            </header>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-white text-gray-500 uppercase text-[10px] tracking-wide">
                  <tr>
                    <th className="text-left py-2 px-3 font-medium">Host</th>
                    <th className="text-center py-2 px-3 font-medium">Agent</th>
                    <th className="text-center py-2 px-3 font-medium">
                      Retellect
                    </th>
                    <th className="text-center py-2 px-3 font-medium">
                      Items OK
                    </th>
                    <th className="text-left py-2 px-3 font-medium">
                      Last update
                    </th>
                    <th className="text-left py-2 px-3 font-medium">
                      Diagnosis
                    </th>
                    <th className="text-right py-2 px-3 font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {g.hosts.map((h) => (
                    <tr
                      key={h.deviceId}
                      className="border-t border-gray-100 align-top"
                    >
                      <td className="py-3 px-3 font-mono text-xs text-gray-900">
                        {h.hostName}
                      </td>
                      <td className="py-3 px-3 text-center">
                        <AgentPill bucket={h.bucket} />
                      </td>
                      <td className="py-3 px-3 text-center">
                        <RtPill status={h.rtStatus} />
                      </td>
                      <td className="py-3 px-3 text-center text-xs">
                        {h.totalEnabled > 0 ? (
                          <span
                            className={`font-medium ${
                              h.supported < h.totalEnabled
                                ? "text-amber-600"
                                : "text-emerald-600"
                            }`}
                          >
                            {h.supported}/{h.totalEnabled}{" "}
                            <span className="text-[10px] font-normal text-gray-400">
                              supported
                            </span>
                          </span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="py-3 px-3 text-xs text-gray-500">
                        {h.lastUpdate
                          ? new Date(h.lastUpdate).toLocaleString("lt-LT")
                          : "—"}
                      </td>
                      <td className="py-3 px-3 text-xs text-gray-700 max-w-md leading-relaxed">
                        {diagnosisFor(h.bucket)}
                      </td>
                      <td className="py-3 px-3 text-right whitespace-nowrap">
                        <ActionCell
                          host={h}
                          onAction={() =>
                            setToast(
                              `Runbook for ${h.hostName} not yet wired`,
                            )
                          }
                          onViewInventory={
                            onNavigateTab
                              ? () => onNavigateTab("inventory")
                              : undefined
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}

      {/* Toast (placeholder runbook target) */}
      {toast && (
        <div
          className="fixed bottom-6 right-6 z-50 rounded-lg shadow-lg bg-gray-900 text-white text-sm px-4 py-3 max-w-sm"
          role="status"
          aria-live="polite"
        >
          {toast}
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: number;
  tone: "ok" | "warn" | "alert" | "neutral";
  hint: string;
}) {
  const valueColor =
    tone === "ok"
      ? "text-emerald-600"
      : tone === "warn"
        ? "text-amber-600"
        : tone === "alert"
          ? "text-red-600"
          : "text-gray-500";
  return (
    <div
      className="rounded-lg border border-gray-200 bg-white p-4"
      title={hint}
    >
      <div className={`text-3xl font-semibold ${valueColor}`}>{value}</div>
      <div className="text-xs uppercase tracking-wide text-gray-500 mt-1">
        {label}
      </div>
      <div className="text-[11px] text-gray-400 mt-1 leading-tight">
        {hint}
      </div>
    </div>
  );
}

function AgentPill({ bucket }: { bucket: DataHealthBucket }) {
  const cfg: Record<
    DataHealthBucket,
    { label: string; classes: string }
  > = {
    healthy: {
      label: "Healthy",
      classes: "bg-emerald-50 text-emerald-700 border-emerald-200",
    },
    partial: {
      label: "Partial",
      classes: "bg-amber-50 text-amber-700 border-amber-200",
    },
    broken: {
      label: "Broken",
      classes: "bg-red-50 text-red-700 border-red-200",
    },
    "no-data": {
      label: "No data",
      classes: "bg-gray-100 text-gray-500 border-gray-200",
    },
    unmatched: {
      label: "Unenrolled",
      classes: "bg-gray-100 text-gray-500 border-gray-200",
    },
  };
  const c = cfg[bucket];
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${c.classes}`}
    >
      {c.label}
    </span>
  );
}

function RtPill({ status }: { status: RtProcessStatus }) {
  if (status === "running") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
        Running
      </span>
    );
  }
  if (status === "stopped") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-red-50 text-red-600">
        <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
        Stopped
      </span>
    );
  }
  if (status === "not-installed") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-gray-50 text-gray-400">
        <span className="w-1.5 h-1.5 rounded-full bg-gray-300" />
        N/A
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-amber-50 text-amber-600">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
      Unknown
    </span>
  );
}

function ActionCell({
  host,
  onAction,
  onViewInventory,
}: {
  host: DataHealthHostRow;
  onAction: () => void;
  onViewInventory?: () => void;
}) {
  // Healthy hosts get no action — they're not actionable.
  if (host.bucket === "healthy") {
    return <span className="text-xs text-gray-400">No action needed</span>;
  }
  // Action label depends on the failure mode.
  const label =
    host.bucket === "broken"
      ? "Open runbook →"
      : host.bucket === "partial"
        ? "Show unsupported items →"
        : host.bucket === "unmatched"
          ? "Enroll host →"
          : "Open runbook →"; // no-data fallback
  return (
    <div className="flex items-center justify-end gap-3">
      {host.bucket === "broken" && onViewInventory && (
        <button
          type="button"
          onClick={onViewInventory}
          className="text-xs text-blue-600 hover:text-blue-800 underline-offset-2 hover:underline"
          title="Jump to this host in the Host Inventory tab"
        >
          View in Inventory →
        </button>
      )}
      <button
        type="button"
        onClick={onAction}
        className="border border-gray-200 bg-white text-gray-700 text-xs font-medium px-2.5 py-1 rounded hover:bg-gray-50 transition"
      >
        {label}
      </button>
    </div>
  );
}
