"use client";

import { useEffect, useMemo, useState } from "react";
import type { RtPilotData, ZabbixData } from "../RtPilotWorkspace";
import {
  RT_FRESHNESS_THRESHOLD_SEC,
  RT_STALE_THRESHOLD_SEC,
  formatAgeShort,
} from "./rt-inventory-helpers";

// ─── Types ───────────────────────────────────────────────────────────────

interface HostHealthRow {
  /** DB device id (stable React key) */
  id: string;
  deviceName: string;
  storeName: string;
  /** Resolved Zabbix host name, if matched */
  zabbixHostName: string | null;
  zabbixMatched: boolean;
  /** ms since epoch of the most recent `system.cpu.util*` sample, or null */
  lastClockMs: number | null;
  /** Age in seconds vs. nowMs, or null when lastClock is missing */
  ageSec: number | null;
  /** Coarse bucket label used for grouping */
  bucket: AgeBucket;
}

type AgeBucket =
  | "live" //          < 5 min
  | "recent" //        5–30 min
  | "stale-1h" //      30–60 min
  | "stale-6h" //      1–6 h
  | "stale-24h" //     6–24 h
  | "stale-older" //   ≥ 24 h
  | "silent" //        zabbix-matched but never reported
  | "unmatched"; //    DB device not found in Zabbix at all

interface HealthStats {
  total: number;
  matched: number;
  unmatched: number;
  live: number;
  recent: number;
  staleTotal: number;
  silent: number;
  /** Histogram bucket counts for the age distribution chart */
  histogram: Record<AgeBucket, number>;
}

// ─── Component ───────────────────────────────────────────────────────────

export function RtDataHealth({
  pilot,
  zabbix,
}: {
  pilot: RtPilotData;
  zabbix: ZabbixData;
}) {
  // Client-only clock to keep SSR output deterministic; refresh every 30s so
  // the view ages in place while the user reads it. The initial tick is
  // scheduled via setTimeout(0) so the setState happens inside a callback
  // rather than synchronously in the effect body — satisfies the React 19
  // `react-hooks/set-state-in-effect` rule while preserving the same UX.
  const [nowMs, setNowMs] = useState<number>(0);
  useEffect(() => {
    const firstTick = setTimeout(() => setNowMs(Date.now()), 0);
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => {
      clearTimeout(firstTick);
      clearInterval(id);
    };
  }, []);

  // Build one row per DB device, join to Zabbix, pick the freshest CPU sample.
  const rows = useMemo<HostHealthRow[]>(() => {
    const zabbixByName = new Map(zabbix.hosts.map((h) => [h.hostName, h]));

    // Per-host: newest lastClock across any system.cpu.util* or cpu.load item
    const newestClockByHostId = new Map<string, number>();
    for (const item of zabbix.cpuDetail) {
      if (!item.lastClock) continue;
      // Only consider items we actually care about for freshness. The cpuDetail
      // payload already only contains system.cpu.* keys, but we keep the check
      // explicit so a future schema tweak does not silently expand the set.
      if (
        !item.key.startsWith("system.cpu.util") &&
        item.key !== "system.cpu.load[,avg1]"
      ) {
        continue;
      }
      const ts = Date.parse(item.lastClock);
      if (!Number.isFinite(ts) || ts <= 0) continue;
      const prev = newestClockByHostId.get(item.hostId);
      if (prev === undefined || ts > prev) {
        newestClockByHostId.set(item.hostId, ts);
      }
    }

    const out: HostHealthRow[] = [];
    for (const device of pilot.devices) {
      const zHost =
        zabbixByName.get(device.sourceHostKey || "") ||
        zabbixByName.get(device.name);
      const lastClockMs = zHost
        ? newestClockByHostId.get(zHost.hostId) ?? null
        : null;
      const ageSec =
        nowMs > 0 && lastClockMs !== null
          ? Math.max(0, Math.floor((nowMs - lastClockMs) / 1000))
          : null;
      out.push({
        id: device.id,
        deviceName: device.name,
        storeName: device.storeName,
        zabbixHostName: zHost ? zHost.hostName : null,
        zabbixMatched: !!zHost,
        lastClockMs,
        ageSec,
        bucket: classifyBucket(!!zHost, lastClockMs, ageSec),
      });
    }
    return out;
  }, [pilot, zabbix, nowMs]);

  const stats = useMemo<HealthStats>(() => {
    const histogram: Record<AgeBucket, number> = {
      live: 0,
      recent: 0,
      "stale-1h": 0,
      "stale-6h": 0,
      "stale-24h": 0,
      "stale-older": 0,
      silent: 0,
      unmatched: 0,
    };
    let matched = 0;
    for (const r of rows) {
      histogram[r.bucket] += 1;
      if (r.zabbixMatched) matched += 1;
    }
    const staleTotal =
      histogram["stale-1h"] +
      histogram["stale-6h"] +
      histogram["stale-24h"] +
      histogram["stale-older"];
    return {
      total: rows.length,
      matched,
      unmatched: histogram.unmatched,
      live: histogram.live,
      recent: histogram.recent,
      staleTotal,
      silent: histogram.silent,
      histogram,
    };
  }, [rows]);

  // Derived: sorted lists for the "Silent hosts" and "Stale hosts" panels.
  // Sort stale hosts oldest-first (most urgent at the top); silent hosts are
  // alphabetized by device name since they have no freshness to compare.
  const silentHosts = useMemo(
    () =>
      rows
        .filter((r) => r.bucket === "silent")
        .sort((a, b) =>
          a.deviceName.localeCompare(b.deviceName, undefined, { numeric: true })
        ),
    [rows]
  );
  const staleHosts = useMemo(
    () =>
      rows
        .filter(
          (r) =>
            r.bucket === "stale-1h" ||
            r.bucket === "stale-6h" ||
            r.bucket === "stale-24h" ||
            r.bucket === "stale-older"
        )
        .sort((a, b) => (b.ageSec ?? 0) - (a.ageSec ?? 0)),
    [rows]
  );
  const unmatchedHosts = useMemo(
    () =>
      rows
        .filter((r) => r.bucket === "unmatched")
        .sort((a, b) =>
          a.deviceName.localeCompare(b.deviceName, undefined, { numeric: true })
        ),
    [rows]
  );

  const maxHistCount = Math.max(
    1,
    stats.histogram.live,
    stats.histogram.recent,
    stats.histogram["stale-1h"],
    stats.histogram["stale-6h"],
    stats.histogram["stale-24h"],
    stats.histogram["stale-older"]
  );

  // ─── Render ──────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Summary tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <HealthTile label="DB devices" value={stats.total} tone="neutral" />
        <HealthTile
          label="Zabbix matched"
          value={`${stats.matched} / ${stats.total}`}
          tone={stats.matched === stats.total ? "ok" : "warn"}
          hint="DB host key resolved to a monitored Zabbix host"
        />
        <HealthTile
          label="Live (<5 min)"
          value={stats.live}
          tone={stats.live > 0 ? "ok" : "warn"}
          hint={`system.cpu.util sample < ${Math.round(
            RT_FRESHNESS_THRESHOLD_SEC / 60
          )} min old`}
        />
        <HealthTile
          label="Recent (5–30 min)"
          value={stats.recent}
          tone={stats.recent > 0 ? "warn" : "neutral"}
          hint="Reporting but outside live window"
        />
        <HealthTile
          label="Stale (>30 min)"
          value={stats.staleTotal}
          tone={stats.staleTotal > 0 ? "warn" : "neutral"}
          hint={`Last sample ≥ ${Math.round(
            RT_STALE_THRESHOLD_SEC / 60
          )} min old`}
        />
        <HealthTile
          label="Silent (never)"
          value={stats.silent}
          tone={stats.silent > 0 ? "alert" : "neutral"}
          hint="Zabbix-matched but lastClock is 0 — item configured, never reported"
        />
      </div>

      {/* Methodology note */}
      <div className="rounded border border-gray-200 bg-white px-4 py-3 text-xs text-gray-600">
        <div className="font-medium text-gray-800 mb-1">How we compute this</div>
        <ul className="list-disc list-inside space-y-0.5">
          <li>
            Freshness = age of the latest <code className="font-mono">system.cpu.util*</code>{" "}
            or <code className="font-mono">system.cpu.load[,avg1]</code>{" "}
            sample vs. wall clock.
          </li>
          <li>
            Item delay is 1m / 5m — anything &gt;
            {Math.round(RT_STALE_THRESHOLD_SEC / 60)} min is treated as
            &ldquo;stale&rdquo; (most likely agent / proxy lag).
          </li>
          <li>
            &ldquo;Silent&rdquo; = Zabbix host found, but the CPU item&apos;s
            lastClock = 0 → the configuration is there, the telemetry isn&apos;t.
          </li>
        </ul>
      </div>

      {/* Age distribution histogram */}
      <section className="rounded border border-gray-200 bg-white p-4">
        <header className="mb-3">
          <h3 className="text-sm font-semibold text-gray-900">
            Age distribution
          </h3>
          <p className="text-xs text-gray-500">
            How many hosts fall into each time bucket — bar height is
            proportional to host count in that bucket.
          </p>
        </header>
        <div className="grid grid-cols-6 gap-3">
          <HistogramBar
            label="<5m"
            sublabel="live"
            count={stats.histogram.live}
            max={maxHistCount}
            tone="ok"
          />
          <HistogramBar
            label="5–30m"
            sublabel="recent"
            count={stats.histogram.recent}
            max={maxHistCount}
            tone="warn-soft"
          />
          <HistogramBar
            label="30–60m"
            sublabel="stale"
            count={stats.histogram["stale-1h"]}
            max={maxHistCount}
            tone="warn"
          />
          <HistogramBar
            label="1–6h"
            sublabel="stale"
            count={stats.histogram["stale-6h"]}
            max={maxHistCount}
            tone="warn"
          />
          <HistogramBar
            label="6–24h"
            sublabel="very stale"
            count={stats.histogram["stale-24h"]}
            max={maxHistCount}
            tone="alert-soft"
          />
          <HistogramBar
            label="≥24h"
            sublabel="very stale"
            count={stats.histogram["stale-older"]}
            max={maxHistCount}
            tone="alert"
          />
        </div>
      </section>

      {/* Silent hosts */}
      <HostListSection
        title={`Silent (${silentHosts.length})`}
        subtitle="Zabbix host exists, but the CPU item's lastClock = 0 — never sent a value."
        emptyMessage="None — every matched host has sent a CPU sample at least once."
        rows={silentHosts}
        showAge={false}
      />

      {/* Stale hosts */}
      <HostListSection
        title={`Stale (${staleHosts.length})`}
        subtitle={`Latest sample is > ${Math.round(
          RT_STALE_THRESHOLD_SEC / 60
        )} min old — sorted oldest first.`}
        emptyMessage="None — every matched host has reported within the last 30 min."
        rows={staleHosts}
        showAge
      />

      {/* Unmatched (DB-only) hosts */}
      {unmatchedHosts.length > 0 && (
        <HostListSection
          title={`Unmatched (${unmatchedHosts.length})`}
          subtitle="DB device cannot be matched to a Zabbix host — check the sourceHostKey / hostname mapping."
          emptyMessage=""
          rows={unmatchedHosts}
          showAge={false}
        />
      )}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function classifyBucket(
  matched: boolean,
  lastClockMs: number | null,
  ageSec: number | null
): AgeBucket {
  if (!matched) return "unmatched";
  if (lastClockMs === null) return "silent";
  if (ageSec === null) return "silent";
  if (ageSec < RT_FRESHNESS_THRESHOLD_SEC) return "live";
  if (ageSec < RT_STALE_THRESHOLD_SEC) return "recent";
  if (ageSec < 60 * 60) return "stale-1h";
  if (ageSec < 6 * 60 * 60) return "stale-6h";
  if (ageSec < 24 * 60 * 60) return "stale-24h";
  return "stale-older";
}

// ─── Sub-components ──────────────────────────────────────────────────────

type HealthTone = "ok" | "warn" | "alert" | "neutral";

function HealthTile({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: number | string;
  tone: HealthTone;
  hint?: string;
}) {
  const toneClass =
    tone === "ok"
      ? "text-emerald-700 border-emerald-200 bg-emerald-50"
      : tone === "warn"
        ? "text-amber-700 border-amber-200 bg-amber-50"
        : tone === "alert"
          ? "text-red-700 border-red-200 bg-red-50"
          : "text-gray-700 border-gray-200 bg-white";
  return (
    <div className={`rounded border ${toneClass} px-3 py-2`} title={hint}>
      <div className="text-[10px] uppercase tracking-wide text-gray-500">
        {label}
      </div>
      <div className="text-lg font-semibold">{value}</div>
      {hint && (
        <div className="text-[10px] text-gray-500 leading-tight mt-0.5">
          {hint}
        </div>
      )}
    </div>
  );
}

type HistogramTone =
  | "ok"
  | "warn-soft"
  | "warn"
  | "alert-soft"
  | "alert";

function HistogramBar({
  label,
  sublabel,
  count,
  max,
  tone,
}: {
  label: string;
  sublabel: string;
  count: number;
  max: number;
  tone: HistogramTone;
}) {
  // Percentage of the tallest bar; min 2% so a single-host bucket is still visible.
  const pct = count === 0 ? 0 : Math.max(2, Math.round((count / max) * 100));
  const barClass =
    tone === "ok"
      ? "bg-emerald-500"
      : tone === "warn-soft"
        ? "bg-amber-300"
        : tone === "warn"
          ? "bg-amber-500"
          : tone === "alert-soft"
            ? "bg-red-400"
            : "bg-red-600";
  return (
    <div className="flex flex-col items-center">
      <div className="h-20 w-full flex items-end">
        <div
          className={`w-full rounded-t ${barClass}`}
          style={{ height: `${pct}%` }}
          aria-label={`${label}: ${count} hosts`}
        />
      </div>
      <div className="mt-1 text-xs font-semibold text-gray-900">{count}</div>
      <div className="text-[10px] text-gray-500 leading-tight">{label}</div>
      <div className="text-[10px] text-gray-400 leading-tight">{sublabel}</div>
    </div>
  );
}

function HostListSection({
  title,
  subtitle,
  emptyMessage,
  rows,
  showAge,
}: {
  title: string;
  subtitle: string;
  emptyMessage: string;
  rows: HostHealthRow[];
  showAge: boolean;
}) {
  return (
    <section className="rounded border border-gray-200 bg-white">
      <header className="px-4 py-3 border-b border-gray-100">
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>
      </header>
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-xs text-gray-400">{emptyMessage}</div>
      ) : (
        <div className="max-h-72 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-500 uppercase text-[10px] tracking-wide">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Device</th>
                <th className="text-left px-4 py-2 font-medium">Store</th>
                <th className="text-left px-4 py-2 font-medium">
                  Zabbix host
                </th>
                {showAge && (
                  <th className="text-right px-4 py-2 font-medium">
                    Last sample
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-gray-100">
                  <td className="px-4 py-2 font-medium text-gray-900">
                    {r.deviceName}
                  </td>
                  <td className="px-4 py-2 text-gray-600">{r.storeName}</td>
                  <td className="px-4 py-2 text-gray-500 font-mono">
                    {r.zabbixHostName ?? "—"}
                  </td>
                  {showAge && (
                    <td className="px-4 py-2 text-right text-gray-700">
                      {formatAgeShort(r.ageSec)}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
