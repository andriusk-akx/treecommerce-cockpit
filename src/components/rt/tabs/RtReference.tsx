"use client";

import { useEffect, useMemo, useState } from "react";
import type { RtPilotData, ZabbixData } from "../RtPilotWorkspace";
import {
  RT_STALE_THRESHOLD_SEC,
  bytesToGb,
  computeCpuTotal,
} from "./rt-inventory-helpers";
import { DataCoverageBanner } from "./DataCoverageBanner";
import { StaleAgeBadge } from "./StaleAgeBadge";

interface HostResource {
  name: string;
  cores: number;
  ramGb: number;
  cpuUser: number;
  cpuSystem: number;
  /** Fallback total when per-mode not published (system.cpu.util[,,avg1]). */
  cpuTotal: number;
  memUsed: number;
  memFree: number;
  diskUsed: number;
  hasMatch: boolean;
  /** ISO lastClock of the freshest CPU/mem sample for this host. */
  lastClock: string | null;
  /** True if the newest sample is ≥ 30 min old — excluded from averages. */
  isStale: boolean;
  /** True if any per-mode or total CPU value has been reported (>0). */
  hasCpuValue: boolean;
}

export function RtReference({
  pilot,
  zabbix,
}: {
  pilot: RtPilotData;
  zabbix: ZabbixData;
}) {
  // Shared nowMs clock: 0 on SSR / first render (so no badge flickers in),
  // then set via useEffect on mount and refreshed every 30s.
  const [nowMs, setNowMs] = useState<number>(0);
  useEffect(() => {
    const firstTick = setTimeout(() => setNowMs(Date.now()), 0);
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => {
      clearTimeout(firstTick);
      clearInterval(id);
    };
  }, []);

  const hostResources = useMemo<HostResource[]>(() => {
    // Per-host CPU aggregate with newest lastClock wins.
    const cpuDetail = new Map<
      string,
      {
        user: number;
        system: number;
        total: number;
        numCpus: number;
        lastClock: string | null;
      }
    >();
    for (const item of zabbix.cpuDetail) {
      if (!cpuDetail.has(item.hostId)) {
        cpuDetail.set(item.hostId, {
          user: 0,
          system: 0,
          total: 0,
          numCpus: 0,
          lastClock: null,
        });
      }
      const entry = cpuDetail.get(item.hostId)!;
      if (item.key === "system.cpu.util[,user]") entry.user = item.value;
      if (item.key === "system.cpu.util[,system]") entry.system = item.value;
      if (
        item.key === "system.cpu.util[,,avg1]" ||
        item.key === "system.cpu.util"
      ) {
        entry.total = item.value;
      }
      if (item.key === "system.cpu.num") entry.numCpus = item.value;
      if (item.lastClock) {
        const prevMs = entry.lastClock
          ? Date.parse(entry.lastClock)
          : -Infinity;
        const curMs = Date.parse(item.lastClock);
        if (Number.isFinite(curMs) && curMs > prevMs) {
          entry.lastClock = item.lastClock;
        }
      }
    }

    const zabbixByName = new Map(zabbix.hosts.map((h) => [h.hostName, h]));

    return pilot.devices.map((device) => {
      const zHost =
        zabbixByName.get(device.sourceHostKey || "") ||
        zabbixByName.get(device.name);
      const detail = zHost ? cpuDetail.get(zHost.hostId) : null;
      const cpuUser = detail?.user || 0;
      const cpuSystem = detail?.system || 0;
      const cpuTotal = computeCpuTotal(cpuUser, cpuSystem, detail?.total || 0);
      const memUsed = zHost?.memory?.utilization || 0;
      const memFree = 100 - memUsed;
      const ramGb = zHost?.memory
        ? bytesToGb(zHost.memory.totalBytes)
        : device.ramGb;
      const diskUsed = zHost?.disk?.utilization || 0;

      // Staleness: the newest lastClock, vs. wall clock, vs. the 30-min threshold.
      // When nowMs=0 (pre-mount) we conservatively treat everything as "fresh"
      // so the page doesn't render with everything greyed-out before the clock
      // kicks in on mount.
      let isStale = false;
      if (detail?.lastClock && nowMs > 0) {
        const ts = Date.parse(detail.lastClock);
        if (Number.isFinite(ts)) {
          const ageSec = Math.max(0, Math.floor((nowMs - ts) / 1000));
          isStale = ageSec >= RT_STALE_THRESHOLD_SEC;
        }
      }

      return {
        name: device.name,
        cores: detail?.numCpus || 0,
        ramGb: Math.round(ramGb * 10) / 10,
        cpuUser: Math.round(cpuUser * 10) / 10,
        cpuSystem: Math.round(cpuSystem * 10) / 10,
        cpuTotal,
        memUsed: Math.round(memUsed * 10) / 10,
        memFree: Math.round(memFree * 10) / 10,
        diskUsed: Math.round(diskUsed * 10) / 10,
        hasMatch: !!zHost,
        lastClock: detail?.lastClock ?? null,
        isStale,
        hasCpuValue: cpuUser + cpuSystem > 0 || cpuTotal > 0,
      };
    });
  }, [pilot, zabbix, nowMs]);

  // Summary stats use only fresh, matched hosts — otherwise "silent" hosts
  // (never reported) would drag the averages toward zero and hide real load.
  const summary = useMemo(() => {
    const fresh = hostResources.filter(
      (h) => h.hasMatch && !h.isStale && h.hasCpuValue
    );
    if (fresh.length === 0) {
      return { avgCpu: 0, maxCpu: 0, avgMem: 0, freshCount: 0 };
    }
    const avgCpu =
      fresh.reduce((s, h) => s + h.cpuTotal, 0) / fresh.length;
    const maxCpu = Math.max(...fresh.map((h) => h.cpuTotal));
    const avgMem = fresh.reduce((s, h) => s + h.memUsed, 0) / fresh.length;
    return { avgCpu, maxCpu, avgMem, freshCount: fresh.length };
  }, [hostResources]);

  const matchedCount = hostResources.filter((h) => h.hasMatch).length;

  return (
    <>
      <DataCoverageBanner
        title={`Data coverage: ${summary.freshCount}/${matchedCount} hosts have fresh (<30 min) CPU/mem samples`}
        defaultOpen={summary.freshCount < matchedCount / 2}
        available={
          <>
            Matched hosts: <strong>{matchedCount}</strong>/
            {hostResources.length}. Actively reporting (&lt; 30 min):{" "}
            <strong>{summary.freshCount}</strong>. We show live CPU user/system
            split (if Zabbix publishes them separately), memory utilization,
            disk utilization, RAM total.
          </>
        }
        missing={
          <>
            On most Rimi hosts <code>system.cpu.util[,user]</code> and{" "}
            <code>[,system]</code> are not yet published — the column then
            shows only the aggregate total from <code>[,,avg1]</code>.
            <code>vm.memory.size</code> → RAM GB is empty wherever
            inventory hasn&apos;t been filled. Hourly history (24h pattern,
            weekday/weekend split) requires <code>history.get</code>.
          </>
        }
        footer={
          <>
            The summary (Avg / Peak / Avg Mem) ignores hosts whose latest
            sample is &gt; 30 min old or that never reported, so they
            don&apos;t fold into the calculation as a zero.
          </>
        }
      />

      <div className="mb-5">
        <h2 className="text-lg font-semibold text-gray-800">
          Resource Overview — Matched Hosts
        </h2>
        <p className="text-xs text-gray-400 mt-0.5">
          Live CPU, memory and disk snapshot per DB device with a Zabbix match.
          For a true reference-store comparison (24h patterns, weekday/weekend
          split) we need hourly history, which requires additional Zabbix access.
        </p>
      </div>

      {/* Stacked resource bars per host */}
      <div className="bg-white rounded-lg border border-gray-200 p-5 mb-6">
        <h3 className="font-semibold text-gray-900 mb-4">
          CPU Resource Distribution (live)
        </h3>
        <div className="space-y-4">
          {hostResources.map((h, idx) => (
            <div key={`${idx}-${h.name}`}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-gray-700 font-mono flex items-center gap-2">
                  {h.name}
                  {h.hasMatch && (
                    <StaleAgeBadge
                      lastClock={h.lastClock}
                      nowMs={nowMs}
                      compact
                    />
                  )}
                </span>
                {h.hasMatch ? (
                  <span className="text-xs text-gray-400">
                    {h.cores > 0 ? `${h.cores} cores` : "? cores"},{" "}
                    {h.ramGb > 0 ? `${h.ramGb} GB RAM` : "? GB RAM"}
                  </span>
                ) : (
                  <span className="text-xs text-gray-400">no Zabbix match</span>
                )}
              </div>
              {h.hasMatch ? (
                h.isStale || !h.hasCpuValue ? (
                  <div className="h-6 bg-gray-50 border border-dashed border-gray-200 rounded flex items-center justify-center">
                    <span className="text-[10px] text-gray-400">
                      {!h.hasCpuValue
                        ? "silent — never reported CPU"
                        : "stale — last sample > 30 min"}
                    </span>
                  </div>
                ) : (
                  <>
                    {/* CPU bar: stacked when [,user]/[,system] available; single total when only [,,avg1] */}
                    <div className="h-6 bg-gray-100 rounded flex overflow-hidden mb-1">
                      {h.cpuUser + h.cpuSystem > 0 ? (
                        <>
                          <div
                            className="bg-blue-500 h-full flex items-center justify-center"
                            style={{ width: `${h.cpuUser}%` }}
                          >
                            {h.cpuUser > 5 && (
                              <span className="text-[9px] text-white font-medium">
                                {h.cpuUser}%
                              </span>
                            )}
                          </div>
                          <div
                            className="bg-amber-500 h-full flex items-center justify-center"
                            style={{ width: `${h.cpuSystem}%` }}
                          >
                            {h.cpuSystem > 5 && (
                              <span className="text-[9px] text-white font-medium">
                                {h.cpuSystem}%
                              </span>
                            )}
                          </div>
                        </>
                      ) : (
                        <div
                          className="bg-indigo-500 h-full flex items-center justify-center"
                          style={{ width: `${Math.min(h.cpuTotal, 100)}%` }}
                          title="system.cpu.util[,,avg1] (per-mode breakdown not published)"
                        >
                          {h.cpuTotal > 5 && (
                            <span className="text-[9px] text-white font-medium">
                              {h.cpuTotal}%
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    {/* Memory bar */}
                    <div className="h-3 bg-gray-100 rounded flex overflow-hidden">
                      <div
                        className={`h-full ${
                          h.memUsed > 80
                            ? "bg-red-400"
                            : h.memUsed > 60
                              ? "bg-amber-400"
                              : "bg-emerald-400"
                        }`}
                        style={{ width: `${h.memUsed}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-[10px] text-gray-400 mt-0.5">
                      <span>
                        {h.cpuUser + h.cpuSystem > 0
                          ? `CPU: user ${h.cpuUser}% + sys ${h.cpuSystem}% = ${Math.round((h.cpuUser + h.cpuSystem) * 10) / 10}%`
                          : `CPU total: ${h.cpuTotal}% (avg1)`}
                      </span>
                      <span>
                        RAM: {h.memUsed}% used, disk: {h.diskUsed}%
                      </span>
                    </div>
                  </>
                )
              ) : (
                <div className="h-6 bg-gray-100 rounded flex items-center justify-center">
                  <span className="text-[9px] text-gray-500">no data</span>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Legend */}
        <div className="flex gap-4 mt-4 pt-3 border-t border-gray-100 text-xs text-gray-500">
          <span className="flex items-center gap-1">
            <span className="w-3 h-2 bg-blue-500 rounded" /> CPU User
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-2 bg-amber-500 rounded" /> CPU System
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-2 bg-emerald-400 rounded" /> Memory
          </span>
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {summary.freshCount > 0 ? (
          <>
            <div className="bg-white rounded-lg border border-gray-200 p-4 text-center">
              <div
                className={`text-2xl font-bold ${
                  summary.avgCpu > 50 ? "text-amber-600" : "text-emerald-600"
                }`}
              >
                {summary.avgCpu.toFixed(1)}%
              </div>
              <div className="text-xs text-gray-500">
                Avg CPU across {summary.freshCount} fresh hosts
              </div>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-4 text-center">
              <div
                className={`text-2xl font-bold ${
                  summary.maxCpu > 80 ? "text-red-600" : "text-gray-900"
                }`}
              >
                {summary.maxCpu.toFixed(1)}%
              </div>
              <div className="text-xs text-gray-500">
                Peak CPU (any fresh host)
              </div>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-4 text-center">
              <div
                className={`text-2xl font-bold ${
                  summary.avgMem > 70 ? "text-amber-600" : "text-emerald-600"
                }`}
              >
                {summary.avgMem.toFixed(1)}%
              </div>
              <div className="text-xs text-gray-500">
                Avg Memory utilization
              </div>
            </div>
          </>
        ) : (
          <div className="col-span-3 bg-gray-50 border border-dashed border-gray-200 rounded-lg p-6 text-center text-sm text-gray-500">
            No fresh hosts to compute aggregates from. Check the{" "}
            <strong>Data Health</strong> tab — most hosts are likely silent
            or stale.
          </div>
        )}
      </div>

      {/* Note */}
      <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
        <p className="text-xs text-amber-700">
          <strong>Note:</strong> This is a live resource snapshot, not a
          reference-store comparison. A real reference-store view requires
          hourly CPU/memory history per host over 1–2 weeks to compare a chosen
          store against the fleet. Daily trends are already available (see CPU
          Timeline); hourly granularity is the missing piece.
        </p>
      </div>
    </>
  );
}
