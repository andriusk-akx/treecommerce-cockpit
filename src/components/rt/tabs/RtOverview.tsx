"use client";
import { useEffect, useState } from "react";
import type { RtPilotData, ZabbixData } from "../RtPilotWorkspace";
import { computeCpuTotal, formatAgeShort } from "./rt-inventory-helpers";
import { isRetellectRunning } from "./rt-overview-helpers";

export function RtOverview({ pilot, zabbix }: { pilot: RtPilotData; zabbix: ZabbixData }) {
  const [cpuSummarySort, setCpuSummarySort] = useState<"store" | "cpu">("store");
  const [withinGroupSort, setWithinGroupSort] = useState<"default" | "host-asc" | "retellect-on" | "cpu-desc" | "age-asc">("host-asc");
  const [rtFilter, setRtFilter] = useState<boolean>(true);
  const [nowMs, setNowMs] = useState<number>(0);
  useEffect(() => {
    // Set initial client time, then tick every 30s.
    // We deliberately don't set Date.now() during render (impure) — SSR and
    // first client paint use 0, which downstream code interprets as "unknown"
    // (hides age badges, skips freshness filters).
    const id = setTimeout(() => setNowMs(Date.now()), 0);
    const iv = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => { clearTimeout(id); clearInterval(iv); };
  }, []);
  // Build CPU model groups from DB devices + Zabbix live metrics
  // Hardware class grouping: by CPU core count (from Zabbix system.cpu.num).
  // Different SCO hardware generations have different core counts (e.g. 4 vs 12),
  // making this a meaningful differentiator for capacity analysis.
  const cpuModelMap = new Map<string, { hosts: number; cpuValues: number[]; cores: number }>();
  const zabbixByName = new Map(zabbix.hosts.map((h) => [h.hostName, h]));

  // Build CPU detail map per host — tracks user/system/total + freshest lastClock
  const cpuDetailByHostId = new Map<string, { user: number; system: number; total: number; numCpus: number; lastClock: string | null }>();
  for (const item of zabbix.cpuDetail) {
    if (!cpuDetailByHostId.has(item.hostId)) {
      cpuDetailByHostId.set(item.hostId, { user: 0, system: 0, total: 0, numCpus: 0, lastClock: null });
    }
    const entry = cpuDetailByHostId.get(item.hostId)!;
    if (item.key === "system.cpu.util[,user]") entry.user = item.value;
    if (item.key === "system.cpu.util[,system]") entry.system = item.value;
    if (item.key === "system.cpu.util[,,avg1]" || item.key === "system.cpu.util") entry.total = item.value;
    if (item.key === "system.cpu.num") entry.numCpus = item.value;
    // Track most-recent lastClock across all cpu items for this host
    if (item.lastClock) {
      if (!entry.lastClock || new Date(item.lastClock) > new Date(entry.lastClock)) {
        entry.lastClock = item.lastClock;
      }
    }
  }

  // refMs = nowMs once the component has mounted (useEffect set it). Until
  // then it's 0, which downstream code treats as "freshness unknown" — no age
  // labels rendered, no time-window filtering. Critically we do NOT fall back
  // to Date.now() here: that would diverge between SSR and the first client
  // paint and trigger a hydration mismatch (e.g. server "36s" vs client "37s").
  const refMs = nowMs;

  // Group by DB cpuModel (sourced from Excel hardware registry).
  // Falls back to core count when cpuModel is missing.
  for (const device of pilot.devices) {
    if (device.status !== "active") continue;
    const zHost = zabbixByName.get(device.sourceHostKey || "") || zabbixByName.get(device.name);
    const detail = zHost ? cpuDetailByHostId.get(zHost.hostId) : null;
    const cores = detail?.numCpus || 0;
    const groupKey = device.cpuModel
      ? device.cpuModel
      : cores > 0 ? `${cores}-core (model unknown)` : "Unknown";
    if (!cpuModelMap.has(groupKey)) cpuModelMap.set(groupKey, { hosts: 0, cpuValues: [], cores });
    const group = cpuModelMap.get(groupKey)!;
    group.hosts++;
    // Use the same CPU total computation as elsewhere — fresh samples only
    if (detail && detail.lastClock) {
      // Pre-mount (refMs=0) we can't compute a real age — accept the sample
      // anyway so SSR renders consistent numbers with the first client paint.
      // After mount the 2h freshness filter kicks in normally.
      const ageSec = refMs > 0 ? (refMs - new Date(detail.lastClock).getTime()) / 1000 : 0;
      if (ageSec < 7200) { // 2h window — matches REPORTING_WINDOW_SEC; Rimi Zabbix poll cycle for system.cpu.util can be 1h+
        const totalCpu = computeCpuTotal(detail.user, detail.system, detail.total);
        if (totalCpu > 0) group.cpuValues.push(totalCpu);
      }
    }
  }

  const cpuByClass = Array.from(cpuModelMap.entries()).map(([name, data]) => {
    const avg = data.cpuValues.length > 0 ? Math.round(data.cpuValues.reduce((s, v) => s + v, 0) / data.cpuValues.length * 10) / 10 : 0;
    const peak = data.cpuValues.length > 0 ? Math.round(Math.max(...data.cpuValues) * 10) / 10 : 0;
    const sampleCount = data.cpuValues.length;
    let risk: "critical" | "warn" | "ok" | "unknown" = "unknown";
    if (sampleCount > 0) {
      if (avg > 70) risk = "critical";
      else if (avg > 40) risk = "warn";
      else risk = "ok";
    }
    return { name, hosts: data.hosts, avgCpu: avg, peakCpu: peak, sampleCount, risk };
  }).sort((a, b) => {
    // Highest CPU usage first (= least free headroom — most urgent for capacity decisions).
    // Groups without fresh samples sink to the bottom.
    if (a.sampleCount === 0 && b.sampleCount > 0) return 1;
    if (b.sampleCount === 0 && a.sampleCount > 0) return -1;
    return b.avgCpu - a.avgCpu;
  });

  // Calculate totals from DB devices only (only those with Zabbix matches)
  const matchedZabbixNames = new Set(
    pilot.devices.map((d) => d.sourceHostKey || d.name).filter(Boolean)
  );
  const matchedHosts = zabbix.hosts.filter((h) => matchedZabbixNames.has(h.hostName) && h.status === "up");
  const highCpuHosts = matchedHosts.filter((h) => {
    const detail = cpuDetailByHostId.get(h.hostId);
    const totalCpu = detail ? computeCpuTotal(detail.user, detail.system, detail.total) : (h.cpu?.utilization || 0);
    return totalCpu > 70;
  });

  // Host-level counts: active = DB devices flagged active; disabled = flagged inactive (Zabbix status=1)
  const activeHostCount = pilot.devices.filter((d) => d.status === "active").length;
  const disabledHostCount = pilot.devices.filter((d) => d.status === "inactive").length;

  // Retellect Active Stores: count distinct stores where at least one host
  // publishes a fresh python.cpu reading > 0% (i.e. the Retellect worker is
  // actually running right now, per Zabbix per-process telemetry).
  const FRESH_SEC = 300;         // 5 min — for per-process live liveness
  // RETELLECT_CPU_THRESHOLD now lives in rt-overview-helpers.ts and is shared
  // with `isRetellectRunning()` so the big-tile count and the filter button
  // can never disagree again. Calibrated 2026-04-28 from real Rimi prod
  // data — see helper file for the history.

  // Per-host Retellect 3-state aggregation:
  //   • > 0%  → Retellect doing work
  //   •   0%  → installed but currently idle (or stopped — Zabbix python.cpu reads 0%)
  //   •  null → no python.cpu items at all (template not deployed) — show as "—"
  const retellectCpuByHostId = new Map<string, number>();
  const retellectFreshestMsByHostId = new Map<string, number>();
  const retellectHasItemByHostId = new Set<string>();
  for (const proc of zabbix.procCpu || []) {
    if (proc.category !== "retellect") continue;
    retellectHasItemByHostId.add(proc.hostId);
    const lastMs = proc.lastClock ? new Date(proc.lastClock).getTime() : 0;
    if (lastMs > 0) {
      const prev = retellectFreshestMsByHostId.get(proc.hostId) || 0;
      if (lastMs > prev) retellectFreshestMsByHostId.set(proc.hostId, lastMs);
      const cur = retellectCpuByHostId.get(proc.hostId) || 0;
      retellectCpuByHostId.set(proc.hostId, cur + Math.max(0, proc.cpuValue));
    }
  }

  // Live host ids — single source of truth shared with the "Retellect running"
  // filter button below via isRetellectRunning(). Eliminating the parallel
  // implementations is what makes the tile count and the filter agree.
  const retellectLiveHostIds = new Set<string>();
  for (const [hid, totalCpu] of retellectCpuByHostId) {
    const freshestMs = retellectFreshestMsByHostId.get(hid) || 0;
    if (isRetellectRunning({ freshestMs, refMs, totalCpu, freshSec: FRESH_SEC })) {
      retellectLiveHostIds.add(hid);
    }
  }

  // Map each live host id back to its store via Zabbix host → DB device → store
  const hostIdToStore = new Map<string, string>();
  for (const device of pilot.devices) {
    const zHost = zabbixByName.get(device.sourceHostKey || "") || zabbixByName.get(device.name);
    if (zHost) hostIdToStore.set(zHost.hostId, device.storeName);
  }
  const retellectActiveStoreSet = new Set<string>();
  for (const hid of retellectLiveHostIds) {
    const storeName = hostIdToStore.get(hid);
    if (storeName) retellectActiveStoreSet.add(storeName);
  }
  const retellectActiveStores = retellectActiveStoreSet.size;
  const retellectActiveHosts = retellectLiveHostIds.size;

  // Stores we're receiving data from: count distinct stores where at least one
  // active host has a Zabbix match with status="up" (host-level availability,
  // independent of cpu.util poll-cycle quirks).
  const reportingStoreNames = new Set<string>();
  for (const device of pilot.devices) {
    if (device.status !== "active") continue;
    const zHost = zabbixByName.get(device.sourceHostKey || "") || zabbixByName.get(device.name);
    if (zHost && zHost.status === "up") reportingStoreNames.add(device.storeName);
  }
  const reportingStoreCount = reportingStoreNames.size;

  // Hardware registry coverage — count devices with cpuModel filled
  const hwModeledCount = pilot.devices.filter((d) => d.cpuModel && d.cpuModel.trim() !== "").length;

  // ─── Anomaly detection for Key Observations ───────────────────────
  // "Most hosts in this store have Retellect, but one or two don't —
  // and that one IS reporting CPU data (agent is alive)." Likely
  // installation gap or template misconfig.
  type StoreCoverage = { storeName: string; rtCount: number; gapCount: number; gapHosts: string[] };
  const storeCoverage = new Map<string, { total: number; rt: number; gapHosts: string[] }>();
  for (const device of pilot.devices) {
    if (device.status !== "active") continue; // Skip Zabbix-disabled hosts
    const zHost = zabbixByName.get(device.sourceHostKey || "") || zabbixByName.get(device.name);
    if (!zHost || zHost.status !== "up") continue; // Only Zabbix-monitored
    const cur = storeCoverage.get(device.storeName) || { total: 0, rt: 0, gapHosts: [] };
    cur.total++;
    if (device.retellectEnabled) {
      cur.rt++;
    } else {
      // Check if host IS reporting any CPU telemetry (agent alive — broader signal:
      // even system.cpu.num (rare poll) means the agent is checking in, just maybe
      // missing util/load items in its template).
      const hasAnyCpuTelemetry = zabbix.cpuDetail.some((it) => {
        if (it.hostId !== zHost.hostId || !it.lastClock) return false;
        if (!it.key.startsWith("system.cpu")) return false;
        // Pre-mount (refMs=0) accept the sample so SSR/client first-paint render
        // identically; the freshness window kicks in once the clock is set.
        const ageSec = refMs > 0 ? (refMs - new Date(it.lastClock).getTime()) / 1000 : 0;
        return ageSec < 2 * 60 * 60; // 2h
      });
      if (hasAnyCpuTelemetry) cur.gapHosts.push(device.name);
    }
    storeCoverage.set(device.storeName, cur);
  }
  const coverageGaps: StoreCoverage[] = [];
  for (const [storeName, sig] of storeCoverage) {
    if (sig.rt >= 2 && sig.gapHosts.length >= 1) {
      coverageGaps.push({ storeName, rtCount: sig.rt, gapCount: sig.gapHosts.length, gapHosts: sig.gapHosts });
    }
  }
  coverageGaps.sort((a, b) => b.rtCount - a.rtCount);

  return (
    <>
      {/* Project Card */}
      <div className="bg-white rounded-lg border border-gray-200 border-l-4 border-l-blue-400 p-5 mb-6">
        <div className="flex items-center gap-2 mb-2">
          <h3 className="font-semibold text-gray-900">Project: {pilot.name}</h3>
          <span className="px-2 py-0.5 rounded bg-blue-50 text-blue-700 text-xs font-medium">{pilot.clientName}</span>
        </div>
        <p className="text-sm text-gray-600">
          {pilot.goalSummary || "Determine whether existing SCO hardware can sustain the Retellect workload. Identify which hosts need replacement, which configurations are viable, and what the deployment recommendation should be."}
        </p>
      </div>

      {/* KPIs — pilot scope at a glance */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <KpiCard
          label="SCO's"
          value={String(activeHostCount)}
          subtitle={disabledHostCount > 0 ? `of ${pilot.deviceCount} total · ${disabledHostCount} disabled` : `of ${pilot.deviceCount} total`}
        />
        <KpiCard
          label="Stores"
          value={String(reportingStoreCount)}
          subtitle="reporting live data"
        />
        <KpiCard
          label="Retellect Active"
          value={String(retellectActiveHosts)}
          subtitle={`hosts running Retellect (across ${retellectActiveStores} of ${reportingStoreCount} stores)`}
          className={retellectActiveHosts > 0 ? "text-emerald-600" : "text-gray-500"}
        />
      </div>

      {/* Two-column: Investigation + Risks */}
      <div className="grid grid-cols-2 gap-6 mb-6">
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="font-semibold text-gray-900 mb-2">Live CPU Summary (Zabbix)</h3>
          <div className="flex items-center gap-2 mb-3 pb-2 border-b border-gray-100 flex-wrap">
            <span className="text-[10px] uppercase tracking-wider text-gray-400">Group by</span>
            <div className="inline-flex rounded border border-gray-200 overflow-hidden text-[11px]">
              <button
                type="button"
                onClick={() => setCpuSummarySort("store")}
                className={`px-2 py-0.5 transition ${cpuSummarySort === "store" ? "bg-blue-500 text-white font-medium" : "bg-white text-gray-500 hover:bg-gray-50"}`}
              >Store</button>
              <button
                type="button"
                onClick={() => setCpuSummarySort("cpu")}
                className={`px-2 py-0.5 border-l border-gray-200 transition ${cpuSummarySort === "cpu" ? "bg-blue-500 text-white font-medium" : "bg-white text-gray-500 hover:bg-gray-50"}`}
              >CPU (high → low)</button>
            </div>
            <button
              type="button"
              onClick={() => setRtFilter((v) => !v)}
              className={`ml-2 inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-[11px] transition ${rtFilter ? "bg-emerald-50 border-emerald-300 text-emerald-700 font-medium" : "bg-white border-gray-200 text-gray-500 hover:bg-gray-50"}`}
              title="Show only hosts where Retellect is currently running per Zabbix telemetry (python.cpu items reporting). DB Device.retellectEnabled is currently unreliable on Rimi prod — see roadmap RT-BACKFILL."
            >
              <span className={`w-1.5 h-1.5 rounded-full ${rtFilter ? "bg-emerald-500" : "bg-gray-300"}`} />
              Retellect running
            </button>
          </div>
          <div className="flex items-center gap-3 pr-6 mb-1 text-[9px] uppercase tracking-wider text-gray-400 font-semibold">
            <button
              type="button"
              onClick={() => setWithinGroupSort((v) => v === "host-asc" ? "default" : "host-asc")}
              className={`flex-1 min-w-0 truncate text-left cursor-pointer hover:text-blue-600 transition ${withinGroupSort === "host-asc" ? "text-blue-600" : ""}`}
              title="Click to sort within group by host name (A → Z)"
            >Host{withinGroupSort === "host-asc" ? " ↑" : ""}</button>
            <button
              type="button"
              onClick={() => setWithinGroupSort((v) => v === "retellect-on" ? "default" : "retellect-on")}
              className={`w-24 flex justify-start items-center flex-shrink-0 cursor-pointer hover:text-blue-600 transition ${withinGroupSort === "retellect-on" ? "text-blue-600" : ""}`}
              title="Latest 1-min sample of python.cpu sum (Retellect-only). Age label appears next to the value if the sample is older than 5 min. Click to sort: Retellect-on hosts first."
            >Retellect CPU (latest){withinGroupSort === "retellect-on" ? " ↓" : ""}</button>
            <button
              type="button"
              onClick={() => setWithinGroupSort((v) => v === "cpu-desc" ? "default" : "cpu-desc")}
              className={`w-20 flex justify-start items-center flex-shrink-0 cursor-pointer hover:text-blue-600 transition ${withinGroupSort === "cpu-desc" ? "text-blue-600" : ""}`}
              title="Latest 1-min sample of system.cpu.util — instantaneous host CPU, NOT a 1-hour average. The age label (e.g. '1h') means the sample is that old. Click to sort by CPU desc."
            >Host CPU (latest){withinGroupSort === "cpu-desc" ? " ↓" : ""}</button>
          </div>
          <div className="space-y-1.5 text-sm max-h-80 overflow-y-auto pr-6">
            {(() => {
              // Build rows: one per matched, reporting host
              const rows = matchedHosts.map((host) => {
                const detail = cpuDetailByHostId.get(host.hostId);
                const cpuTotal = detail ? computeCpuTotal(detail.user, detail.system, detail.total) : (host.cpu?.utilization || 0);
                // Match back to DB device to get store name + SCO number
                const dev = pilot.devices.find((d) => (d.sourceHostKey || d.name) === host.hostName);
                const storeName = dev?.storeName || "(unknown store)";
                const scoMatch = /SCO(\d+)/i.exec(host.hostName) || /SCOW_(\d+)/i.exec(host.hostName) || (dev ? /SCO(\d+)/i.exec(dev.name) : null);
                const scoNum = scoMatch ? parseInt(scoMatch[1], 10) : 0;
                const lastClockMs = detail?.lastClock ? new Date(detail.lastClock).getTime() : 0;
                // ageSec stays null until the client-side clock is set (nowMs > 0).
                // Pre-mount the age label is hidden, which keeps SSR and client
                // first-paint markup identical (avoids React hydration warning).
                const ageSec = lastClockMs && nowMs > 0 ? Math.max(0, Math.floor((nowMs - lastClockMs) / 1000)) : null;
                const rtHasItem = retellectHasItemByHostId.has(host.hostId);
                const rtCpuTotal = retellectCpuByHostId.get(host.hostId) ?? 0;
                const rtFreshestMs = retellectFreshestMsByHostId.get(host.hostId) || 0;
                const rtPythonAgeSec = rtFreshestMs > 0 && refMs > 0 ? Math.max(0, Math.floor((refMs - rtFreshestMs) / 1000)) : null;
                const rtFresh = rtPythonAgeSec !== null && rtPythonAgeSec < FRESH_SEC;
                // Single shared rule with the big-tile retellectLiveHostIds set.
                const rtActive = isRetellectRunning({ freshestMs: rtFreshestMs, refMs, totalCpu: rtCpuTotal, freshSec: FRESH_SEC });
                const dbDev = pilot.devices.find((d) => (d.sourceHostKey || d.name) === host.hostName);
                const rtPlanned = dbDev?.retellectEnabled || false;
                const rtConfidence = (dbDev?.retellectConfidence || null) as "high" | "low" | null;
                return { hostId: host.hostId, hostName: host.hostName, storeName, scoNum, cpuTotal, ageSec, rtActive, rtPlanned, rtConfidence, rtHasItem, rtCpuTotal, rtPythonAgeSec, rtFresh };
              }).filter((r) => {
                if (!rtFilter) return true;
                // Hot-fix 2026-04-28: filter on live telemetry, not DB flag.
                // `Device.retellectEnabled` is hardcoded false in seed_rimi_expand.ts
                // for the live Rimi fleet, so DB-based filter returned empty.
                // `rtActive` = python.cpu items fresh (<5 min) AND CPU > threshold.
                // TODO(RT-BACKFILL): once retellectEnabled is backfilled from
                // telemetry, switch back to `r.rtPlanned === true` so this also
                // surfaces hosts that SHOULD run Retellect but currently don't.
                return r.rtActive === true;
              });

              // Helper: secondary tiebreaker after primary group key
              const ageRank = (r: typeof rows[number]) =>
                r.ageSec === null ? Number.POSITIVE_INFINITY : r.ageSec;
              const secondary = (a: typeof rows[number], b: typeof rows[number]): number => {
                if (withinGroupSort === "cpu-desc") return b.cpuTotal - a.cpuTotal;
                if (withinGroupSort === "host-asc") return a.hostName.localeCompare(b.hostName, "lt");
                if (withinGroupSort === "age-asc") return ageRank(a) - ageRank(b);
                if (withinGroupSort === "retellect-on") {
                  if (a.rtActive !== b.rtActive) return a.rtActive ? -1 : 1;
                  return 0;
                }
                return 0;
              };
              const defaultStoreSco = (a: typeof rows[number], b: typeof rows[number]): number => {
                const cmp = a.storeName.localeCompare(b.storeName, "lt");
                if (cmp !== 0) return cmp;
                return a.scoNum - b.scoNum;
              };

              if (cpuSummarySort === "cpu") {
                // Top-level by CPU desc; secondary still applies as tiebreaker
                rows.sort((a, b) => {
                  if (b.cpuTotal !== a.cpuTotal) return b.cpuTotal - a.cpuTotal;
                  return secondary(a, b) || defaultStoreSco(a, b);
                });
              } else {
                // Group by store: alpha by store, then within-group secondary
                rows.sort((a, b) => {
                  const cmp = a.storeName.localeCompare(b.storeName, "lt");
                  if (cmp !== 0) return cmp;
                  return secondary(a, b) || (a.scoNum - b.scoNum);
                });
              }

              // When grouped by store, render store headers between groups
              const out: React.ReactElement[] = [];
              let lastStore = "";
              for (const r of rows) {
                if (cpuSummarySort === "store" && r.storeName !== lastStore) {
                  out.push(
                    <div key={`hdr-${r.storeName}`} className="text-[10px] uppercase tracking-wider text-gray-400 pt-2 pb-0.5 border-t border-gray-100 first:pt-0 first:border-t-0">
                      {r.storeName}
                    </div>
                  );
                  lastStore = r.storeName;
                }
                // CPU value is grayed out when its underlying sample is stale (>30min) —
                // the number is from the past, not "now", so visually demote it.
                // Color gradient by CPU value — staleness signaled by the age subtitle (gray "39m"),
                // not by dimming the value itself, so risk colors stay legible.
                const cpuColor =
                    r.cpuTotal > 70 ? "text-red-600"
                  : r.cpuTotal > 40 ? "text-amber-600"
                  : r.cpuTotal > 0 ? "text-emerald-600"
                  : "text-gray-400";
                const staleLabel = r.ageSec === null ? "no data" : r.ageSec < 300 ? "live" : formatAgeShort(r.ageSec);
                out.push(
                  <div key={r.hostId} className="flex items-center gap-3">
                    <span className="flex-1 min-w-0 truncate text-gray-700 text-xs">{r.hostName}</span>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      {/* Retellect column — sum of all python*.cpu values (% of CPU used by Retellect) */}
                      <span className="w-24 flex items-center gap-2">
                        {!r.rtHasItem ? (
                          <span className="inline-block w-7 text-xs text-gray-300" title="No python.cpu Zabbix item deployed — Retellect template not present">—</span>
                        ) : (
                          <>
                            <span
                              className={`text-xs tabular-nums ${
                                !r.rtFresh ? "text-amber-600"
                                : r.rtCpuTotal > 5 ? "text-emerald-700"
                                : r.rtCpuTotal > 0 ? "text-emerald-600"
                                : "text-gray-500"
                              }`}
                              title={r.rtCpuTotal > 0 ? "Sum of python*.cpu — total CPU consumed by Retellect right now" : "Retellect template installed, but python.cpu reads 0% — process is idle or not running"}
                            >{r.rtCpuTotal > 0 ? `${Math.max(0.1, parseFloat(r.rtCpuTotal.toFixed(1))).toFixed(1)}%` : "0%"}</span>
                            {r.rtPythonAgeSec !== null && (
                              <span className="text-[10px] text-gray-400 tabular-nums text-left">{formatAgeShort(r.rtPythonAgeSec)}</span>
                            )}
                          </>
                        )}
                      </span>
                      {/* CPU column — fixed-width value block + age (matches Retellect structure) */}
                      <span className="w-20 flex items-center gap-2">
                        {r.cpuTotal > 0
                          ? <span className={`text-xs tabular-nums ${cpuColor}`}>{Math.round(r.cpuTotal)}%</span>
                          : <span className="inline-block w-6 text-xs text-gray-300">—</span>
                        }
                        {r.ageSec !== null && r.ageSec >= 300 && (
                          <span className="text-[10px] tabular-nums text-left text-gray-400">{staleLabel}</span>
                        )}
                      </span>
                    </div>
                  </div>
                );
              }
              if (rows.length === 0) {
                out.push(<p key="empty" className="text-gray-400">No Zabbix match for DB devices</p>);
              }
              return out;
            })()}
          </div>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="font-semibold text-gray-900 mb-3">Key Observations</h3>
          <div className="space-y-2 text-sm">
            {coverageGaps.length > 0 && coverageGaps.map((g) => (
              <div key={g.storeName} className="flex items-start gap-2">
                <span className="w-2 h-2 rounded-full bg-amber-500 flex-shrink-0 mt-1.5" />
                <span className="leading-snug">
                  <span className="font-medium">{g.storeName}</span>: {g.rtCount} cash registers run Retellect, but {g.gapCount === 1 ? `one (${g.gapHosts[0]})` : `${g.gapCount} (${g.gapHosts.join(", ")})`} {g.gapCount === 1 ? "doesn't" : "don't"} — host{g.gapCount > 1 ? "s are" : " is"} alive (sending CPU data) so likely a Retellect install gap, not a dead agent.
                </span>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${highCpuHosts.length > 0 ? "bg-red-500" : "bg-emerald-500"} flex-shrink-0`} />
              <span>{highCpuHosts.length} hosts with CPU  {">"} 70% right now</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0" />
              <span>{pilot.deviceCount} devices configured in pilot DB</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0" />
              <span>{pilot.devices.filter((d) => d.retellectEnabled).length} devices with Retellect enabled</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-gray-400 flex-shrink-0" />
              <span>History API unavailable — showing current snapshots only</span>
            </div>
          </div>
        </div>
      </div>

      {/* CPU by Hardware Class (grouped by Zabbix core count) */}
      {cpuByClass.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-5 mb-6">
          <h3 className="font-semibold text-gray-900 mb-1">CPU by Hardware Class</h3>
          <p className="text-xs text-gray-500 mb-3">Grouped by hardware model (from registry). Active hosts only; CPU averages use fresh samples (&lt; 2 h).</p>
          <div className="space-y-3">
            {cpuByClass.map((c) => {
              const barColor = c.risk === "critical" ? "bg-red-500" : c.risk === "warn" ? "bg-amber-500" : c.risk === "ok" ? "bg-emerald-500" : "bg-gray-300";
              const textColor = c.risk === "critical" ? "text-red-600" : c.risk === "warn" ? "text-amber-600" : c.risk === "ok" ? "text-emerald-600" : "text-gray-400";
              return (
                <div key={c.name}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-gray-700"><span className="font-medium">{c.name}</span> · {c.hosts} hosts {c.sampleCount > 0 && <span className="text-xs text-gray-400">({c.sampleCount} fresh · last 2h)</span>}</span>
                    {c.sampleCount > 0 ? (
                      <span className="font-medium tabular-nums">
                        <span className="text-gray-500">avg </span>
                        <span className={c.avgCpu > 70 ? "text-red-600" : c.avgCpu > 40 ? "text-amber-600" : "text-emerald-600"}>{c.avgCpu}%</span>
                        <span className="text-gray-300"> · </span>
                        <span className="text-gray-500">peak </span>
                        <span className={c.peakCpu > 70 ? "text-red-600" : c.peakCpu > 40 ? "text-amber-600" : "text-emerald-600"}>{c.peakCpu}%</span>
                      </span>
                    ) : (
                      <span className="text-gray-400">no fresh samples</span>
                    )}
                  </div>
                  <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${barColor}`}
                      style={{ width: `${Math.max(c.avgCpu, c.sampleCount > 0 ? 2 : 0)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Data Sources */}
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <h3 className="font-semibold text-gray-900 mb-3">Data Sources</h3>
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs">
            <span className={`w-2 h-2 rounded-full ${zabbix.status === "live" ? "bg-emerald-500" : zabbix.status === "cached" ? "bg-amber-500" : "bg-red-500"}`} />
            <span className="text-gray-700 font-medium">Zabbix Monitoring</span>
            <span className={`font-semibold ${zabbix.status === "live" ? "text-emerald-600" : "text-amber-600"}`}>
              {zabbix.status.toUpperCase()}
            </span>
            <span className="text-gray-400">{zabbix.fetchMs}ms</span>
            <span className="text-gray-400">— {zabbix.hosts.length} hosts total, {matchedHosts.length} matched to DB devices</span>
          </div>
          {zabbix.error && (
            <div className="text-xs text-red-500 ml-4">{zabbix.error}</div>
          )}
          <div className="flex items-center gap-2 text-xs">
            <span className="w-2 h-2 rounded-full bg-blue-500" />
            <span className="text-gray-700 font-medium">Pilot DB</span>
            <span className="text-blue-600 font-semibold">OK</span>
            <span className="text-gray-400">— {pilot.deviceCount} devices, {pilot.storeCount} stores</span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className={`w-2 h-2 rounded-full ${hwModeledCount > 0 ? "bg-emerald-500" : "bg-gray-400"}`} />
            <span className="text-gray-700 font-medium">Hardware Registry (Excel)</span>
            <span className={`font-semibold ${hwModeledCount > 0 ? "text-emerald-600" : "text-gray-500"}`}>
              {hwModeledCount > 0 ? "LOADED" : "EMPTY"}
            </span>
            <span className="text-gray-400">— {hwModeledCount}/{pilot.deviceCount} devices mapped to CPU model · WN Beetle SCO terminal registry, sourced from Intility/Wincor-Nixdorf installation list</span>
          </div>
          <div className="flex items-center gap-2 text-xs mt-2">
            <span className="w-2 h-2 rounded-full bg-gray-400" />
            <span className="text-gray-500">Zabbix history.get / trend.get — restricted by API token permissions</span>
          </div>
        </div>
      </div>

      {/* Methodology footnotes */}
      <div className="mt-4 space-y-3 text-[11px] text-gray-500 leading-relaxed">
        <div>
          <span className="font-semibold text-gray-600">Retellect CPU calculation:</span>{" "}
          sum of these Zabbix items per host —{" "}
          <code className="px-1 py-0.5 rounded bg-gray-100 text-gray-700">python.cpu</code>{" "}
          +{" "}
          <code className="px-1 py-0.5 rounded bg-gray-100 text-gray-700">python1.cpu</code>{" "}
          +{" "}
          <code className="px-1 py-0.5 rounded bg-gray-100 text-gray-700">python2.cpu</code>{" "}
          +{" "}
          <code className="px-1 py-0.5 rounded bg-gray-100 text-gray-700">python3.cpu</code>.
          Each is a 1-minute average of the matching <code className="px-1 py-0.5 rounded bg-gray-100 text-gray-700">python.exe</code>{" "}
          process CPU share. Values reset to 0% when a process is idle or stopped — Zabbix cannot
          distinguish between the two. The <em>Retellect installed</em> filter shows hosts where
          these items have published any non-zero value within the last 7 days; high-confidence flag
          applies when 7-day max exceeds 1%.
        </div>
        <div>
          <span className="font-semibold text-gray-600">Hardware Class avg / peak calculation:</span>{" "}
          for each model group, we collect the current{" "}
          <code className="px-1 py-0.5 rounded bg-gray-100 text-gray-700">system.cpu.util</code>{" "}
          value from every active host (Zabbix sample younger than 2 h, value &gt; 0%).
          {" "}<strong>avg</strong> = arithmetic mean across the sample —{" "}
          <em>&ldquo;how loaded is a typical host of this model right now&rdquo;</em>.{" "}
          <strong>peak</strong> = maximum value in the sample —{" "}
          <em>&ldquo;the worst-loaded host of this model right now&rdquo;</em>. Both are current snapshots
          (not historical max). Each is colored independently by its own risk threshold:
          <span className="text-emerald-600"> green ≤ 40%</span>,
          <span className="text-amber-600"> amber &gt; 40%</span>,
          <span className="text-red-600"> red &gt; 70%</span>.
          Sort order: highest avg first (= least free headroom).
        </div>
      </div>
    </>
  );
}

function KpiCard({ label, value, className, subtitle }: { label: string; value: string; className?: string; subtitle?: string }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className={`text-2xl font-bold ${className || "text-gray-900"}`}>{value}</div>
      <div className="text-xs text-gray-500 mt-0.5">{label}</div>
      {subtitle && <div className="text-[10px] text-gray-400">{subtitle}</div>}
    </div>
  );
}
