"use client";

/**
 * Retellect Configuration Tracking tab.
 *
 * A parameter-level configuration & change-monitoring workspace (NOT a
 * settings page, NOT a "config profile" view). Answers: what is installed
 * now on each host, what changed and when, which hosts have high-priority
 * changes, and where configuration visibility is missing.
 *
 * Data is REAL: it fetches `/api/rt/config-snapshot`, which reads the three
 * Retellect Zabbix log items (config.ini + Retellect/SCO versions, current +
 * history) and assembles the typed dataset. Coverage is genuinely partial
 * (only a subset of hosts have a parsed config.ini), surfaced by the
 * "Missing latest snapshot" KPI and the coverage line.
 *
 * Future extension: each change event carries { hostId, param, date }, so a
 * selected change can later deep-link into before/after CPU impact analysis.
 */

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useRtFilters } from "../RtFiltersContext";
import {
  FilterBar,
  FilterRow,
  FilterSelect,
  FilterSegmented,
  FilterDivider,
  FilterMultiSelect,
} from "../filters/RtFilterControls";
import type { MultiOption } from "../filters/RtFilterControls";
import type { RtPilotData, ZabbixData } from "../RtPilotWorkspace";
import { CONFIG_PARAMS, type ConfigParamKey, type ConfigTrackingData, type HostConfig } from "@/lib/rt/config-tracking/types";
import type { ConfigDeviceInput } from "@/lib/rt/config-tracking/build";

// ─── Small presentational helpers ───────────────────────────────────

type Tone = "ok" | "change" | "risk" | "muted" | "neutral";

const TONE_TAG: Record<Tone, string> = {
  ok: "bg-blue-50 text-blue-700 border border-blue-100",
  change: "bg-amber-50 text-amber-700 border border-amber-100",
  risk: "bg-red-50 text-red-700 border border-red-100",
  muted: "bg-gray-100 text-gray-500 border border-gray-200",
  neutral: "bg-gray-50 text-gray-600 border border-gray-200",
};

function Tag({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${TONE_TAG[tone]}`}>
      {children}
    </span>
  );
}

function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[(m - 1) % 12]} ${d}${y !== new Date().getFullYear() ? ` '${String(y).slice(2)}` : ""}`;
}

const valueTone = (v: string): Tone => (v === "unknown" ? "risk" : "neutral");

/** Vilnius-local "YYYY-MM-DD". The server (build.ts) tags every change
 *  `date` in Europe/Vilnius, so the client must use the SAME day boundaries
 *  when filtering / dimming by window — otherwise a non-Vilnius browser
 *  disagrees with the server's KPI counts on boundary-day changes. */
const VILNIUS_DAY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Vilnius",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const vilniusDay = (ms: number): string => VILNIUS_DAY_FMT.format(new Date(ms));

// ─── Component ───────────────────────────────────────────────────────

export function RtConfigTracking({ pilot, zabbix }: { pilot: RtPilotData; zabbix: ZabbixData }) {
  const { filters, setFilter } = useRtFilters();

  const [windowDays, setWindowDays] = useState<number>(30);
  const [retVersion, setRetVersion] = useState<string>("all");
  const [scoVersion, setScoVersion] = useState<string>("all");
  const [changedParam, setChangedParam] = useState<"all" | ConfigParamKey>("all");
  const [showChangedOnly, setShowChangedOnly] = useState<boolean>(false);
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);

  const [data, setData] = useState<ConfigTrackingData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch real config snapshots whenever the change window changes.
  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    const devices: ConfigDeviceInput[] = pilot.devices.map((d) => ({
      id: d.id,
      name: d.name,
      sourceHostKey: d.sourceHostKey,
      storeName: d.storeName,
      cpuModel: d.cpuModel || "—",
      country: d.country,
      retellectEnabled: d.retellectEnabled,
    }));
    fetch("/api/rt/config-snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ devices, windowDays }),
      signal: ctrl.signal,
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: ConfigTrackingData) => setData(d))
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setError((e as Error).message);
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [pilot.devices, windowDays]);

  // Store filter options — Zabbix-first grouping, matching the other tabs.
  const storeOptions = useMemo<MultiOption[]>(() => {
    const hostKeys = new Set<string>();
    for (const h of zabbix.hosts) hostKeys.add(h.hostName);
    const tracked = new Set<string>();
    for (const d of pilot.devices) {
      if (hostKeys.has(d.sourceHostKey || "") || hostKeys.has(d.name)) tracked.add(d.storeName);
    }
    return pilot.stores
      .map((s) => ({ v: s.name, l: s.name, tracked: tracked.has(s.name) }))
      .sort((a, b) => (a.tracked === b.tracked ? a.l.localeCompare(b.l) : a.tracked ? -1 : 1));
  }, [zabbix.hosts, pilot.devices, pilot.stores]);

  const windowCutoff = useMemo(() => {
    // eslint-disable-next-line react-hooks/purity
    return vilniusDay(Date.now() - windowDays * 86400000);
  }, [windowDays]);

  const storeSet = useMemo(() => new Set(filters.store), [filters.store]);

  const allHosts = data?.hosts ?? [];
  const filteredHosts = useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    return allHosts.filter((h) => {
      if (storeSet.size > 0 && !storeSet.has(h.storeName)) return false;
      if (filters.cpuModel !== "all" && h.cpuModel !== filters.cpuModel) return false;
      if (retVersion !== "all" && h.params.retellectVersion !== retVersion) return false;
      if (scoVersion !== "all" && h.params.scoVersion !== scoVersion) return false;
      if (changedParam !== "all" && !h.changes.some((c) => c.param === changedParam && c.date >= windowCutoff)) {
        return false;
      }
      if (showChangedOnly && h.changedParamCount === 0) return false;
      if (q && !(h.hostName.toLowerCase().includes(q) || h.storeName.toLowerCase().includes(q) || h.cpuModel.toLowerCase().includes(q))) {
        return false;
      }
      return true;
    });
  }, [allHosts, storeSet, filters.cpuModel, filters.search, retVersion, scoVersion, changedParam, showChangedOnly, windowCutoff]);

  const selected: HostConfig | null =
    filteredHosts.find((h) => h.hostId === selectedHostId) ?? filteredHosts[0] ?? null;

  const k = data?.kpis;
  const statusLabel = data?.sourceStatus === "live" ? "LIVE" : data?.sourceStatus === "cached" ? "CACHED" : "DOWN";
  const statusColor =
    data?.sourceStatus === "live" ? "text-emerald-600" : data?.sourceStatus === "cached" ? "text-amber-600" : "text-red-600";

  return (
    <div className="max-w-6xl mx-auto px-6 py-5">
      {/* ── Filter bar ── */}
      <FilterBar>
        <FilterRow>
          <FilterMultiSelect
            label="Store"
            selected={filters.store}
            options={storeOptions}
            onChange={(next) => setFilter("store", next)}
            allLabel="All stores"
            title="Pick one or more stores. Stores we receive Zabbix data for are listed first."
          />
          <label className="flex items-center gap-2">
            <span className="text-gray-500 font-medium">Host</span>
            <input
              type="text"
              value={filters.search}
              onChange={(e) => setFilter("search", e.target.value)}
              placeholder="Search host / store…"
              className="border border-gray-200 rounded px-2 py-1 text-xs bg-white text-gray-700 focus:outline-none focus:border-blue-400 w-44"
            />
          </label>
          <FilterSelect
            label="CPU model"
            value={filters.cpuModel}
            options={[{ v: "all", l: "All models" }, ...(data?.cpuModels ?? []).map((m) => ({ v: m, l: m }))]}
            onChange={(v) => setFilter("cpuModel", v)}
          />
          <FilterSelect
            label="Retellect"
            value={retVersion}
            options={[{ v: "all", l: "All versions" }, ...(data?.retellectVersions ?? []).map((v) => ({ v, l: v }))]}
            onChange={setRetVersion}
          />
          <FilterSelect
            label="SCO"
            value={scoVersion}
            options={[{ v: "all", l: "All versions" }, ...(data?.scoVersions ?? []).map((v) => ({ v, l: v }))]}
            onChange={setScoVersion}
          />
          <FilterSelect
            label="Changed param"
            value={changedParam}
            options={[{ v: "all", l: "Any parameter" }, ...CONFIG_PARAMS.map((p) => ({ v: p.key, l: p.label }))]}
            onChange={(v) => setChangedParam(v as "all" | ConfigParamKey)}
          />
          <FilterDivider />
          <FilterSegmented<string>
            label="Change window"
            value={String(windowDays)}
            options={[
              { v: "7", l: "7d" },
              { v: "30", l: "30d" },
              { v: "90", l: "90d" },
            ]}
            onChange={(v) => setWindowDays(Number(v))}
          />
          <button
            type="button"
            onClick={() => setShowChangedOnly((s) => !s)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition ${
              showChangedOnly
                ? "bg-amber-50 border-amber-200 text-amber-800"
                : "bg-white border-gray-200 text-gray-500 hover:text-gray-700"
            }`}
            title="Only show hosts with at least one parameter change in the selected window"
          >
            <span className={`w-2 h-2 rounded-full ${showChangedOnly ? "bg-amber-500" : "bg-gray-300"}`} />
            Show changed only
          </button>
        </FilterRow>
        <div className="text-[11px] text-gray-500 flex items-center gap-2 flex-wrap">
          <span>
            <span className="font-semibold text-gray-700">Zabbix</span>{" "}
            <span className={`font-semibold ${statusColor}`}>{statusLabel}</span> · daily config snapshots from
            Retellect <code>config.ini</code> + version log items.
          </span>
          {k && (
            <span className="text-gray-400">
              {data!.hostsWithSnapshot} of {k.trackedHosts} hosts have a current snapshot.
            </span>
          )}
        </div>
        {error && (
          <div className="text-[11px] text-red-700 bg-red-50 border border-red-100 rounded px-2 py-1">
            Could not load configuration data: {error}
          </div>
        )}
        {data?.sourceStatus === "unavailable" && data.sourceError && (
          <div className="text-[11px] text-red-700 bg-red-50 border border-red-100 rounded px-2 py-1 font-mono">
            Zabbix fetch failed: {data.sourceError}
          </div>
        )}
      </FilterBar>

      {/* ── Inventory + detail ── */}
      <div className="grid grid-cols-1 xl:grid-cols-[1.25fr_0.95fr] gap-4 mt-4">
        <InventoryTable
          hosts={filteredHosts}
          totalCount={allHosts.length}
          loading={loading}
          selectedHostId={selected?.hostId ?? null}
          onSelect={setSelectedHostId}
        />
        <HostDetail host={selected} windowDays={windowDays} loading={loading} />
      </div>
    </div>
  );
}

// ─── Inventory table ─────────────────────────────────────────────────

const COLS = "grid grid-cols-[1.5fr_0.9fr_0.7fr_0.7fr_0.8fr_0.9fr_0.85fr_0.6fr] gap-2 items-center";

function InventoryTable({
  hosts,
  totalCount,
  loading,
  selectedHostId,
  onSelect,
}: {
  hosts: HostConfig[];
  totalCount: number;
  loading: boolean;
  selectedHostId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 min-w-0">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-gray-800">Current host configuration inventory</h3>
        <span className="text-[11px] text-gray-400">{hosts.length} of {totalCount} hosts</span>
      </div>
      <p className="text-[11px] text-gray-500 mt-1 leading-snug">
        Current versions and key settings, with when something last changed. Resolution is surfaced directly. Sorted:
        high-priority changes → newest change → missing snapshot last.
      </p>

      <div className="mt-3 border border-gray-200 rounded-lg overflow-hidden">
        <div className={`${COLS} px-3 py-2 bg-gray-50 text-[10px] font-semibold uppercase tracking-wide text-gray-500`}>
          <div>Store / host</div>
          <div>CPU</div>
          <div>Retellect</div>
          <div>SCO</div>
          <div>Resolution</div>
          <div>Changed params</div>
          <div>Last change</div>
          <div>Snapshot</div>
        </div>
        {loading && hosts.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-gray-400">Loading configuration snapshots…</div>
        )}
        {!loading && hosts.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-gray-400">No hosts match the current filters.</div>
        )}
        {hosts.map((h) => {
          const isSel = h.hostId === selectedHostId;
          const rtChanged = h.changes.some((c) => c.param === "retellectVersion");
          const scoChanged = h.changes.some((c) => c.param === "scoVersion");
          return (
            <button
              key={h.hostId}
              type="button"
              onClick={() => onSelect(h.hostId)}
              className={`${COLS} w-full text-left px-3 py-2.5 border-t border-gray-100 text-xs transition ${
                isSel ? "bg-blue-50/60" : "hover:bg-gray-50"
              }`}
            >
              <div className="min-w-0">
                <div className="font-semibold text-blue-700 truncate">{h.storeName}</div>
                <div className="text-[10px] text-gray-400 truncate">{h.hostName}</div>
              </div>
              <div className="text-gray-600 truncate">{h.cpuModel}</div>
              <div>
                {h.params.retellectVersion === "unknown" ? (
                  <span className="text-red-600">unknown</span>
                ) : rtChanged && h.versionChanged ? (
                  <Tag tone="change">{h.params.retellectVersion}</Tag>
                ) : (
                  <Tag tone="ok">{h.params.retellectVersion}</Tag>
                )}
              </div>
              <div className="text-gray-700 truncate">
                {h.params.scoVersion === "unknown" ? (
                  <span className="text-red-600">unknown</span>
                ) : scoChanged && h.versionChanged ? (
                  <Tag tone="change">{h.params.scoVersion}</Tag>
                ) : (
                  h.params.scoVersion
                )}
              </div>
              <div className={h.params.resolution === "unknown" ? "text-red-600 font-semibold" : h.resolutionChanged ? "text-amber-700 font-semibold" : "text-gray-700"}>
                {h.params.resolution}
              </div>
              <div>
                {!h.snapshotFresh ? (
                  <span className="text-red-600">snapshot missing</span>
                ) : h.changedParamCount === 0 ? (
                  <span className="text-gray-400">no change</span>
                ) : (
                  <span className={h.highPriorityChange ? "text-amber-700 font-semibold" : "text-gray-600"}>
                    {h.changedParamCount} param{h.changedParamCount === 1 ? "" : "s"} changed
                  </span>
                )}
              </div>
              <div className={h.lastConfigChange ? (h.highPriorityChange ? "text-amber-700" : "text-gray-600") : "text-gray-400"}>
                {h.snapshotFresh ? shortDate(h.lastConfigChange) : "—"}
              </div>
              <div>{h.snapshotFresh ? <Tag tone="ok">daily</Tag> : <Tag tone="muted">stale</Tag>}</div>
            </button>
          );
        })}
      </div>
      <p className="text-[10px] text-gray-400 mt-2.5">
        For current-state visibility and change tracking. CPU impact correlation can later be linked from a selected
        change into before/after analysis.
      </p>
    </div>
  );
}

// ─── Selected host detail ────────────────────────────────────────────

function HostDetail({ host, windowDays, loading }: { host: HostConfig | null; windowDays: number; loading: boolean }) {
  if (!host) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-4 flex items-center justify-center text-xs text-gray-400 min-h-[200px]">
        {loading ? "Loading…" : "Select a host to inspect its parameters and change history."}
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 min-w-0">
      <h3 className="text-sm font-semibold text-gray-800">Selected host parameter tracking</h3>
      <div className="flex items-center gap-1.5 flex-wrap text-[11px] text-gray-500 mt-1.5">
        <span className="bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full font-semibold">{host.storeName}</span>
        <span>›</span>
        <span className="bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full font-semibold">{host.hostName}</span>
        <span>›</span>
        <span className="font-semibold text-gray-700">Parameter history</span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
        <Stat k="Retellect" v={host.params.retellectVersion} />
        <Stat k="SCO" v={host.params.scoVersion} />
        <Stat k="Resolution" v={host.params.resolution} tone={valueTone(host.params.resolution)} />
        <Stat k="Last change" v={shortDate(host.lastConfigChange)} />
      </div>

      {!host.snapshotFresh && (
        <div className="mt-3 text-[11px] text-red-700 bg-red-50 border border-red-100 rounded px-2 py-1">
          No recent configuration snapshot for this host
          {host.snapshotAgeDays !== null ? ` (last seen ~${host.snapshotAgeDays}d ago)` : ""}. Config-derived values are
          unavailable until visibility is restored.
        </div>
      )}

      {/* Parameter list with last-changed */}
      <div className="mt-3 border border-gray-200 rounded-lg overflow-hidden">
        <div className="grid grid-cols-[1fr_0.8fr_0.8fr] gap-2 px-3 py-2 bg-gray-50 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
          <div>Parameter</div>
          <div>Current value</div>
          <div>Last changed</div>
        </div>
        {CONFIG_PARAMS.map((p) => (
          <div key={p.key} className="grid grid-cols-[1fr_0.8fr_0.8fr] gap-2 px-3 py-2 border-t border-gray-100 text-xs items-center">
            <div className="font-medium text-gray-700">
              {p.label}
              {p.highPriority && <span className="ml-1 text-[9px] text-amber-600">●</span>}
            </div>
            <div className="text-gray-700 truncate" title={host.params[p.key]}>{host.params[p.key]}</div>
            <div className="text-gray-500">{host.paramLastChanged[p.key] ?? "—"}</div>
          </div>
        ))}
        {host.extras.length > 0 && (
          <div className="px-3 py-2 border-t border-gray-100 flex flex-wrap gap-1.5">
            {host.extras.map((e) => (
              <span key={e.label} className="text-[10px] text-gray-500 bg-gray-50 border border-gray-200 rounded px-2 py-0.5">
                {e.label}: <span className="font-medium text-gray-700">{e.value}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Parameter-level change timeline */}
      <div className="mt-3 border border-gray-200 rounded-lg overflow-hidden">
        <div className="grid grid-cols-[90px_1fr_0.85fr_0.85fr] gap-2 px-3 py-2 bg-gray-50 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
          <div>Date</div>
          <div>Parameter</div>
          <div>Before</div>
          <div>After</div>
        </div>
        {host.changes.length === 0 && (
          <div className="px-3 py-4 text-center text-[11px] text-gray-400">
            No parameter changes recorded in the last {windowDays >= 90 ? "90" : windowDays} days.
          </div>
        )}
        {host.changes.map((c, i) => {
          const inWindow = isWithin(c.date, windowDays);
          return (
            <div
              key={`${c.param}-${c.date}-${i}`}
              className={`grid grid-cols-[90px_1fr_0.85fr_0.85fr] gap-2 px-3 py-2.5 border-t border-gray-100 text-xs items-start ${
                inWindow ? "" : "opacity-55"
              }`}
              title={inWindow ? undefined : `Outside the ${windowDays}d window`}
            >
              <div className="font-semibold text-gray-700">{c.date.slice(5)}</div>
              <div className="text-gray-700 flex items-center gap-1.5">
                {c.paramLabel}
                {c.highPriority && <span className="text-[9px] text-amber-600">●</span>}
              </div>
              <div className="text-gray-400 line-through truncate" title={c.before}>{c.before}</div>
              <div className="font-semibold text-gray-800 truncate" title={c.after}>{c.after}</div>
            </div>
          );
        })}
      </div>

      <p className="text-[10px] text-gray-400 mt-2.5">
        Timeline is parameter-level (diffed from Zabbix config history). A future release will let you open a change into
        before/after CPU impact analysis.
      </p>
    </div>
  );
}

function Stat({ k, v, tone = "neutral" }: { k: string; v: string; tone?: Tone }) {
  const valClass = tone === "risk" ? "text-red-600" : tone === "change" ? "text-amber-700" : "text-gray-900";
  return (
    <div className="bg-gray-50 border border-gray-200 rounded px-2.5 py-2 min-w-0">
      <div className="text-[10px] text-gray-400">{k}</div>
      <div className={`text-base font-bold mt-0.5 truncate ${valClass}`} title={v}>{v}</div>
    </div>
  );
}

function isWithin(iso: string, days: number): boolean {
  return iso >= vilniusDay(Date.now() - days * 86400000);
}
