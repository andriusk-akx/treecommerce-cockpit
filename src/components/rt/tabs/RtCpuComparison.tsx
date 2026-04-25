"use client";

import { useEffect, useMemo, useState } from "react";
import type { RtPilotData, ZabbixData } from "../RtPilotWorkspace";
import {
  RT_STALE_THRESHOLD_SEC,
  computeCpuTotal,
} from "./rt-inventory-helpers";
import { DataCoverageBanner } from "./DataCoverageBanner";
import { StaleAgeBadge } from "./StaleAgeBadge";

interface HostEntry {
  name: string;
  cpuTotal: number;
  memUtil: number;
  retellect: boolean;
  /** ISO string of the freshest CPU sample's lastClock */
  lastClock: string | null;
  /** True when the CPU sample is older than RT_STALE_THRESHOLD_SEC (30 min) */
  isStale: boolean;
}

interface CpuGroup {
  model: string;
  hostCount: number;
  cores: number;
  hosts: HostEntry[];
  avgCpu: number;
  peakCpu: number;
  headroom: number;
  risk: "critical" | "high" | "low";
  /** Hosts with fresh (<30 min) CPU sample, used for honest averages */
  freshHostCount: number;
}

export function RtCpuComparison({
  pilot,
  zabbix,
}: {
  pilot: RtPilotData;
  zabbix: ZabbixData;
}) {
  // Client-side clock for stale calculations; starts at 0 to keep SSR and
  // first-client render identical (no badge), then updates on mount and every
  // 30s so the staleness ages in place.
  const [nowMs, setNowMs] = useState<number>(0);
  useEffect(() => {
    const firstTick = setTimeout(() => setNowMs(Date.now()), 0);
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => {
      clearTimeout(firstTick);
      clearInterval(id);
    };
  }, []);

  const { groups, unknownHostCount, totalMatched } = useMemo(() => {
    const zabbixByName = new Map(zabbix.hosts.map((h) => [h.hostName, h]));

    // Aggregate CPU-detail items per host, keeping the newest lastClock.
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
      // Keep the newest lastClock across the item family so the stale badge
      // reflects the freshest available sample.
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

    const modelMap = new Map<string, CpuGroup>();
    let unknownCount = 0;
    let matchedCount = 0;

    for (const device of pilot.devices) {
      const modelRaw = device.cpuModel?.trim();
      const model = modelRaw && modelRaw !== "—" ? modelRaw : "Unknown";
      if (model === "Unknown") unknownCount++;

      if (!modelMap.has(model)) {
        modelMap.set(model, {
          model,
          hostCount: 0,
          cores: 0,
          hosts: [],
          avgCpu: 0,
          peakCpu: 0,
          headroom: 100,
          risk: "low",
          freshHostCount: 0,
        });
      }
      const group = modelMap.get(model)!;
      group.hostCount++;

      const zHost =
        zabbixByName.get(device.sourceHostKey || "") ||
        zabbixByName.get(device.name);
      const detail = zHost ? cpuDetail.get(zHost.hostId) : null;
      if (zHost) matchedCount++;

      const cpuTotal = detail
        ? computeCpuTotal(detail.user, detail.system, detail.total)
        : 0;
      if (detail?.numCpus) group.cores = detail.numCpus;

      // Decide staleness: the newest lastClock must be within 30 min to trust
      // this host's CPU number for aggregate calculations.
      // During SSR nowMs === 0 and we treat nothing as stale (no client
      // render mismatch). On the client it ticks every 30s so freshness
      // ages in place.
      let isStale = false;
      if (nowMs > 0 && detail?.lastClock) {
        const ts = Date.parse(detail.lastClock);
        if (Number.isFinite(ts)) {
          const ageSec = Math.max(0, Math.floor((nowMs - ts) / 1000));
          isStale = ageSec >= RT_STALE_THRESHOLD_SEC;
        }
      }

      group.hosts.push({
        name: device.name,
        cpuTotal,
        memUtil: zHost?.memory?.utilization
          ? Math.round(zHost.memory.utilization * 10) / 10
          : 0,
        retellect: device.retellectEnabled,
        lastClock: detail?.lastClock ?? null,
        isStale,
      });
      if (cpuTotal > 0 && !isStale) group.freshHostCount++;
    }

    // Aggregate: only FRESH (<30 min) values feed avg/peak/risk. Hosts that
    // never reported or are > 30 min old drag averages toward zero and mislead
    // the comparison, so we exclude them — the "Hosts" column still reflects
    // the full membership, but aggregates are annotated with `freshHostCount`.
    const groupsArr = Array.from(modelMap.values()).map((group) => {
      const freshValues = group.hosts
        .filter((h) => !h.isStale && h.cpuTotal > 0)
        .map((h) => h.cpuTotal);
      if (freshValues.length > 0) {
        group.avgCpu =
          Math.round(
            (freshValues.reduce((s, v) => s + v, 0) / freshValues.length) * 10
          ) / 10;
        group.peakCpu = Math.round(Math.max(...freshValues) * 10) / 10;
        group.headroom = Math.round((100 - group.peakCpu) * 10) / 10;
      }
      group.risk =
        group.peakCpu >= 80
          ? "critical"
          : group.peakCpu >= 60
            ? "high"
            : "low";
      return group;
    });
    groupsArr.sort((a, b) => b.avgCpu - a.avgCpu);
    return {
      groups: groupsArr,
      unknownHostCount: unknownCount,
      totalMatched: matchedCount,
    };
  }, [pilot, zabbix, nowMs]);

  const totalDevices = pilot.devices.length;
  const unknownPct =
    totalDevices > 0 ? Math.round((unknownHostCount / totalDevices) * 100) : 0;

  return (
    <>
      <DataCoverageBanner
        title={`Data coverage: ${unknownHostCount}/${totalDevices} (${unknownPct}%) hostų be CPU Model — grupuojam kaip „Unknown“`}
        defaultOpen={unknownPct >= 50}
        available={
          <>
            Live CPU Total % (iš <code>system.cpu.util[,,avg1]</code> arba user+system
            suma) per <strong>{totalMatched}/{totalDevices}</strong> matched hostų;
            <code> system.cpu.num</code> tiems, kam publikuota.
          </>
        }
        missing={
          <>
            <code>inventory.hardware</code> → CPU Model: dauguma hostų šiandien
            tušti, todėl grupuojam po „Unknown“. <code>vm.memory.size</code>{" "}
            → RAM GB; per-mode CPU (<code>system.cpu.util[,user]</code> /{" "}
            <code>[,system]</code>) → būtų tikslesnis peak/avg skaičiavimas.
          </>
        }
        footer={
          <>
            Aggregate skaičiai (avg/peak/headroom) ignoruoja hostus, kurių
            paskutinis sample &gt; 30 min senumo, kad „silent“ hostai
            neapsimetinėtų nuliu. Stulpelyje „Hosts“ rodomas <em>visas</em>{" "}
            grupės narystės skaičius; aktyviai reportuojantys nurodyti čia pat.
          </>
        }
      />

      <div className="mb-5">
        <h2 className="text-lg font-semibold text-gray-800">
          CPU Comparison by Hardware Class
        </h2>
        <p className="text-xs text-gray-400 mt-0.5">
          Live Zabbix data for DB devices grouped by CPU model. Agregatai
          skaičiuojami iš hostų, kurių sample &lt; 30 min senumo.
        </p>
      </div>

      {/* Summary Table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden mb-6">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50">
              <th className="text-left py-3 px-4 text-xs font-semibold text-gray-500 uppercase">
                Hardware Class
              </th>
              <th className="text-center py-3 px-4 text-xs font-semibold text-gray-500 uppercase">
                Hosts
              </th>
              <th
                className="text-center py-3 px-4 text-xs font-semibold text-gray-500 uppercase"
                title="Hosts with fresh (<30 min) CPU sample — basis for avg/peak below"
              >
                Fresh
              </th>
              <th className="text-center py-3 px-4 text-xs font-semibold text-gray-500 uppercase">
                Cores
              </th>
              <th className="text-right py-3 px-4 text-xs font-semibold text-gray-500 uppercase">
                Avg CPU
              </th>
              <th className="text-right py-3 px-4 text-xs font-semibold text-gray-500 uppercase">
                Peak CPU
              </th>
              <th className="text-right py-3 px-4 text-xs font-semibold text-gray-500 uppercase">
                Headroom
              </th>
              <th className="text-center py-3 px-4 text-xs font-semibold text-gray-500 uppercase">
                Risk
              </th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.model} className="border-t border-gray-100">
                <td className="py-3 px-4 font-medium">
                  {g.model}
                  {g.model === "Unknown" && (
                    <span className="ml-2 text-[10px] text-amber-600 font-normal">
                      no cpuModel in DB
                    </span>
                  )}
                </td>
                <td className="py-3 px-4 text-center">{g.hostCount}</td>
                <td
                  className={`py-3 px-4 text-center text-xs ${
                    g.freshHostCount === 0
                      ? "text-gray-400"
                      : g.freshHostCount < g.hostCount
                        ? "text-amber-600"
                        : "text-emerald-600"
                  }`}
                >
                  {g.freshHostCount}/{g.hostCount}
                </td>
                <td className="py-3 px-4 text-center text-gray-500">
                  {g.cores > 0 ? g.cores : "—"}
                </td>
                <td
                  className={`py-3 px-4 text-right font-medium ${cpuColor(
                    g.avgCpu
                  )}`}
                >
                  {g.freshHostCount > 0 ? `${g.avgCpu}%` : "—"}
                </td>
                <td
                  className={`py-3 px-4 text-right font-medium ${cpuColor(
                    g.peakCpu
                  )}`}
                >
                  {g.freshHostCount > 0 ? `${g.peakCpu}%` : "—"}
                </td>
                <td
                  className={`py-3 px-4 text-right font-medium ${
                    g.headroom < 15
                      ? "text-red-600"
                      : g.headroom < 30
                        ? "text-amber-600"
                        : "text-emerald-600"
                  }`}
                >
                  {g.freshHostCount > 0 ? `${g.headroom}%` : "—"}
                </td>
                <td className="py-3 px-4 text-center">
                  {g.freshHostCount > 0 ? (
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium ${
                        g.risk === "critical"
                          ? "bg-red-50 text-red-700"
                          : g.risk === "high"
                            ? "bg-amber-50 text-amber-700"
                            : "bg-emerald-50 text-emerald-700"
                      }`}
                    >
                      {g.risk}
                    </span>
                  ) : (
                    <span className="inline-block px-2 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-500">
                      no data
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Per-group detail cards */}
      <div className="space-y-4">
        {groups.map((g) => (
          <div
            key={g.model}
            className="bg-white rounded-lg border border-gray-200 p-5"
          >
            <div className="flex items-center justify-between mb-3">
              <div>
                <h4 className="font-semibold text-gray-900">{g.model}</h4>
                <p className="text-xs text-gray-400">
                  {g.hostCount} hosts (
                  <span
                    className={
                      g.freshHostCount < g.hostCount ? "text-amber-600" : ""
                    }
                  >
                    {g.freshHostCount} fresh
                  </span>
                  ), {g.cores > 0 ? `${g.cores} cores` : "cores unknown"}
                </p>
              </div>
              <div className="flex gap-4 text-right">
                <div>
                  <div className="text-[10px] text-gray-400 uppercase">Avg</div>
                  <div className={`text-lg font-bold ${cpuColor(g.avgCpu)}`}>
                    {g.freshHostCount > 0 ? `${g.avgCpu}%` : "—"}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-gray-400 uppercase">
                    Peak
                  </div>
                  <div className={`text-lg font-bold ${cpuColor(g.peakCpu)}`}>
                    {g.freshHostCount > 0 ? `${g.peakCpu}%` : "—"}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-gray-400 uppercase">
                    Headroom
                  </div>
                  <div
                    className={`text-lg font-bold ${
                      g.headroom < 15
                        ? "text-red-600"
                        : g.headroom < 30
                          ? "text-amber-600"
                          : "text-emerald-600"
                    }`}
                  >
                    {g.freshHostCount > 0 ? `${g.headroom}%` : "—"}
                  </div>
                </div>
              </div>
            </div>
            <div className="border-t border-gray-100 pt-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {g.hosts.map((host, hostIdx) => (
                  <div
                    key={`${g.model}-${hostIdx}-${host.name}`}
                    className="flex items-center gap-2 text-xs"
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                        host.retellect ? "bg-blue-500" : "bg-gray-300"
                      }`}
                    />
                    <span className="text-gray-700 truncate flex-1 font-mono">
                      {host.name}
                    </span>
                    <div className="flex items-center gap-1">
                      <div className="w-12 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            host.isStale
                              ? "bg-gray-200"
                              : host.cpuTotal >= 10
                                ? "bg-red-500"
                                : host.cpuTotal >= 5
                                  ? "bg-amber-500"
                                  : host.cpuTotal > 0
                                    ? "bg-emerald-500"
                                    : "bg-gray-200"
                          }`}
                          style={{
                            width: `${Math.min(100, Math.max(host.cpuTotal, 1))}%`,
                          }}
                        />
                      </div>
                      <span
                        className={`w-10 text-right font-medium ${
                          host.isStale
                            ? "text-gray-400"
                            : cpuColor(host.cpuTotal)
                        }`}
                      >
                        {host.cpuTotal > 0 ? `${host.cpuTotal}%` : "—"}
                      </span>
                      <StaleAgeBadge
                        lastClock={host.lastClock}
                        nowMs={nowMs}
                        compact
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>

      {groups.length === 0 && (
        <div className="bg-white rounded-lg border border-gray-200 px-5 py-12 text-center">
          <p className="text-gray-400">
            No CPU data available. Check Zabbix connection.
          </p>
        </div>
      )}
    </>
  );
}

function cpuColor(value: number): string {
  if (value >= 80) return "text-red-600";
  if (value >= 60) return "text-amber-600";
  if (value >= 40) return "text-yellow-600";
  if (value > 0) return "text-emerald-600";
  return "text-gray-400";
}
