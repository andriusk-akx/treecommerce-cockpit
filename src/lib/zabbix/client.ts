import type { HostInventory, ProcessCategory, ProcessCpuItem } from "./types";
import { cached } from "./cache";

/**
 * Map raw Zabbix `host.inventory` payload to our normalised `HostInventory`.
 *
 * Zabbix returns `inventory` as either:
 *   - an empty array `[]` when `inventory_mode = -1` (disabled), or
 *   - an object whose keys are the inventory field names we asked for in
 *     `selectInventory`.
 *
 * Empty strings, `"0"` and `null` are all treated as "no value" — Zabbix never
 * returns a literal null but admins routinely save empty placeholders. When
 * every requested field is empty the function returns `null` so the UI can
 * cheaply distinguish "no inventory at all" from "inventory present, just
 * missing one field".
 *
 * RT-CPUMODEL phase 1: read-only fallback so the dashboard can render a CPU
 * model column even before phase 2 backfills `Device.cpuModel` from this same
 * source.
 */
export function mapHostInventory(raw: unknown): HostInventory | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const pick = (key: string): string | null => {
    const v = r[key];
    if (typeof v !== "string") return null;
    const trimmed = v.trim();
    if (trimmed === "" || trimmed === "0") return null;
    return trimmed;
  };
  // Prefer the longer "_full" variant for human readability — Zabbix
  // populates `hardware` with a short label (e.g. "Intel(R) Pentium(R)") and
  // `hardware_full` with the full CPUID string when both are configured.
  const hardware = pick("hardware");
  const hardwareFull = pick("hardware_full");
  const cpuModel = hardwareFull && (!hardware || hardwareFull.length >= hardware.length)
    ? hardwareFull
    : (hardware ?? hardwareFull);
  const os = pick("os_full") || pick("os");
  if (!cpuModel && !os) return null;
  return { cpuModel, ramBytes: null, os };
}

/**
 * Classify a process CPU Zabbix key (e.g. "python1.cpu", "spss.cpu") into the
 * Retellect pilot domain taxonomy. Exported for tests and reuse.
 */
export function classifyProcessKey(key: string): { procName: string; category: ProcessCategory } {
  // Strip any trailing ".cpu" (the custom metric convention on SCO hosts)
  const base = key.endsWith(".cpu") ? key.slice(0, -4) : key;
  const lower = base.toLowerCase();
  // Retellect — all python workers (python, python1, python2, python3, ...)
  if (/^python\d*$/.test(lower)) return { procName: base, category: "retellect" };
  // StrongPoint SCO — spss process, sometimes reported as "sp.sss"
  if (lower === "spss" || lower === "sp.sss" || lower === "sp") return { procName: "spss", category: "sco" };
  // Database
  if (lower === "sql" || lower === "sqlservr") return { procName: base, category: "db" };
  // Peripherals / drivers
  if (lower === "cs300sd" || lower === "nhstw32" || lower === "udm" || lower === "udmserver") {
    return { procName: base, category: "hw" };
  }
  // Virtualization
  if (lower === "vm" || lower === "vmware-vmx") return { procName: base, category: "sys" };
  return { procName: base, category: "other" };
}

/** Sanitise the days-back window into a stable, bounded cache-key segment.
 *
 *  Lower bound 1 day guards against negative / NaN input (zero-day window
 *  has no meaningful aggregate).
 *
 *  Upper bound 365 days — Zabbix's trend.get retention is ~365 d on a
 *  typical install. Pre-2026-05-12 this clamped at 14 d to match the
 *  raw-history window only, but the heatmap timeline now needs to honour
 *  custom periods up to a year (RtFiltersContext period selector). The
 *  internal fetch path (_getCpuHistoryDailyUncached) merges trend + history
 *  data, so >14 d windows fall back to hourly trend aggregates for the
 *  older days — same hybrid pattern process-trend route uses. */
function effectiveDaysKey(days: number): string {
  return String(Math.min(Math.max(1, days), 365));
}

export class ZabbixClient {
  private baseUrl: string;
  private token: string;
  private requestId = 0;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  async request(method: string, params: Record<string, unknown> = {}, skipAuth = false) {
    this.requestId++;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (!skipAuth) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }
    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id: this.requestId }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await response.json();
    if (data.error) {
      throw new ZabbixApiError(data.error.message, data.error.data, data.error.code);
    }
    return data.result;
  }

  async getVersion(): Promise<string> {
    return this.request("apiinfo.version", {}, true);
  }

  async getHosts(): Promise<any[]> {
    // In-process dedup + 30s TTL: collapses the 4–5 host.get calls a single
    // RT page render used to fire into one Zabbix round-trip.
    //
    // `selectInventory` (RT-CPUMODEL phase 1): pull the hardware/OS strings so
    // the dashboard has a runtime fallback when `Device.cpuModel` is null in
    // the DB. Empty arrays come back for hosts whose `inventory_mode = -1`,
    // which we handle gracefully via `mapHostInventory`.
    // 5-minute TTL: host topology + inventory only changes on Zabbix
    // template updates or new agent installs — both rare events. The 6
    // parallel page fetchers all hit `getHosts` first; without a long TTL,
    // every page navigation older than 30 s pays the host.get round-trip
    // again. Was the default 30 s before perf pass 2026-05-07.
    return cached(
      "zabbix:host.get",
      async () => {
        const hosts = (await this.request("host.get", {
          output: ["hostid", "host", "name", "status", "maintenance_status", "inventory_mode"],
          selectInterfaces: ["ip", "type", "available"],
          selectGroups: ["groupid", "name"],
          selectInventory: ["hardware", "hardware_full", "os", "os_full"],
        })) as Array<Record<string, unknown>>;
        // Normalise inventory in-place. Keep the original `inventory` key
        // pointing at our derived shape so downstream code can read either
        // `host.inventory.cpuModel` or fall through to null cleanly.
        for (const h of hosts) {
          h.inventory = mapHostInventory(h.inventory);
        }
        return hosts;
      },
      5 * 60_000,
    );
  }

  async getHostGroups(): Promise<any[]> {
    return this.request("hostgroup.get", { output: ["groupid", "name"] });
  }

  async getProblems(): Promise<any[]> {
    return this.request("problem.get", {
      output: "extend",
      selectTags: "extend",
      recent: true,
      sortfield: ["eventid"],
      sortorder: "DESC",
      limit: 200,
    });
  }

  async getActiveTriggers(): Promise<any[]> {
    return this.request("trigger.get", {
      output: ["triggerid", "description", "priority", "lastchange", "value", "status"],
      selectHosts: ["hostid", "host", "name"],
      expandDescription: true,
      filter: { value: 1 },
    });
  }

  /**
   * Get events for a time period. Events contain problem start/end times
   * for downtime calculation.
   */
  async getEventsForPeriod(daysBack: number = 30, limit: number = 500): Promise<any[]> {
    const timeFrom = Math.floor(Date.now() / 1000) - daysBack * 24 * 3600;
    return this.request("event.get", {
      output: "extend",
      time_from: String(timeFrom),
      sortfield: ["clock"],
      sortorder: "DESC",
      limit,
    });
  }

  /**
   * Get all triggers (both active and resolved) with their hosts.
   * Used to understand what monitoring exists per host.
   */
  async getAllTriggers(limit: number = 200): Promise<any[]> {
    return this.request("trigger.get", {
      output: ["triggerid", "description", "priority", "lastchange", "value", "status"],
      selectHosts: ["hostid", "host", "name"],
      expandDescription: true,
      limit,
    });
  }

  /** Get items (metrics) for specific hosts */
  async getItems(hostIds: string[], search?: string): Promise<any[]> {
    if (hostIds.length === 0) return [];
    // Cache key encodes the input parameters so different searches don't collide.
    const key = `zabbix:item.get:${search || "*"}:${hostIds.slice().sort().join(",")}`;
    // 5-min TTL — item registry only changes when SP redeploys the Zabbix
    // template (new metric keys, new processes added). 4 separate searches
    // (system.cpu, proc, .cpu, system.cpu.util) fire on every page load —
    // each is now reused across navigations within 5 min.
    return cached(key, () =>
      this.request("item.get", {
        output: ["itemid", "hostid", "name", "key_", "lastvalue", "units", "lastclock", "value_type", "state", "status"],
        hostids: hostIds,
        ...(search ? { search: { key_: search } } : {}),
        filter: { status: 0, state: 0 },
        sortfield: "name",
      }),
      5 * 60_000,
    );
  }

  /**
   * Per-host item health summary — counts enabled items in each Zabbix `state`
   * value plus a sample of `error` strings for unsupported items. Unlike
   * `getItems`, this method does NOT filter `state: 0`, so it can SEE items
   * the agent has marked as ZBX_NOTSUPPORTED.
   *
   * Used by the Data Health tab to surface hosts where the local Zabbix agent
   * is in degraded shape (e.g. broken Windows perfcounters, lacking privileges
   * to read `\Process(*)\% Processor Time`). Without this, a host whose 22 of
   * 24 items report `state=1` would silently show all-zero CPU on the
   * dashboard — a misleading "Retellect not running" reading when the truth is
   * "we have no data to make any claim".
   *
   * The sample errors are useful for diagnostics: the agent returns the
   * specific failure reason ("ZBX_NOTSUPPORTED", "Cannot evaluate function",
   * etc.) which points at whether it's a permissions issue, PDH corruption, or
   * a missing process.
   */
  async getAgentHealthSummary(
    hostIds: string[],
  ): Promise<{ hostId: string; totalEnabled: number; supported: number; unsupported: number; sampleErrors: string[] }[]> {
    if (hostIds.length === 0) return [];
    const cacheKey = `zabbix:agentHealth:${hostIds.slice().sort().join(",")}`;
    // 60s TTL — agent state DOES change minute-by-minute (agents come and
    // go), but the dashboard's Data Health tab tolerates ~1 min staleness.
    // Was the default 30s; longer would mean a recently-recovered agent
    // takes too long to switch from "broken" to "healthy" in the UI.
    return cached(cacheKey, async () => {
      const items = (await this.request("item.get", {
        output: ["itemid", "hostid", "key_", "state", "error"],
        hostids: hostIds,
        // status: 0 only — exclude DISABLED items (admin-disabled, not the
        // agent's fault). Crucially: NO state filter, so unsupported items
        // come through.
        filter: { status: 0 },
      })) as Array<{ itemid: string; hostid: string; key_: string; state: string; error: string }>;
      // Aggregate by host. A Map keyed by hostId, accumulating counts and
      // capturing up to 5 sample error strings for diagnostics in the UI.
      const byHost = new Map<string, { totalEnabled: number; supported: number; unsupported: number; sampleErrors: string[] }>();
      for (const it of items) {
        let entry = byHost.get(it.hostid);
        if (!entry) {
          entry = { totalEnabled: 0, supported: 0, unsupported: 0, sampleErrors: [] };
          byHost.set(it.hostid, entry);
        }
        entry.totalEnabled += 1;
        if (it.state === "1") {
          entry.unsupported += 1;
          if (entry.sampleErrors.length < 5 && it.error) entry.sampleErrors.push(it.error);
        } else {
          entry.supported += 1;
        }
      }
      // Ensure every requested host appears in the result, even with 0 items
      // (would happen if the host has no enabled items at all — rare but
      // worth flagging in the UI as "no monitoring configured").
      const result = hostIds.map((hostId) => {
        const e = byHost.get(hostId);
        return {
          hostId,
          totalEnabled: e?.totalEnabled ?? 0,
          supported: e?.supported ?? 0,
          unsupported: e?.unsupported ?? 0,
          sampleErrors: e?.sampleErrors ?? [],
        };
      });
      return result;
    });
  }

  /** Get history data for items */
  async getHistory(itemIds: string[], valueType: number = 0, limit: number = 100, timeFrom?: number): Promise<any[]> {
    return this.request("history.get", {
      output: "extend",
      itemids: itemIds,
      history: valueType,
      sortfield: "clock",
      sortorder: "DESC",
      limit,
      ...(timeFrom ? { time_from: String(timeFrom) } : {}),
    });
  }

  /** Get trend (hourly aggregated) data for items */
  async getTrends(itemIds: string[], timeFrom: number, timeTill?: number): Promise<any[]> {
    if (itemIds.length === 0) return [];
    return this.request("trend.get", {
      output: ["itemid", "clock", "num", "value_min", "value_avg", "value_max"],
      itemids: itemIds,
      time_from: String(timeFrom),
      ...(timeTill ? { time_till: String(timeTill) } : {}),
    });
  }

  /**
   * Get CPU history for multiple items, aggregated into daily max/avg/min.
   *
   * Strategy: combine `trend.get` (Zabbix's pre-aggregated hourly data, fast,
   * cheap, but only retained ~5–7 days on this deployment) with `history.get`
   * (raw 1-min samples, full retention but slower). The two sources are
   * unioned: a per-(host,date) bucket takes the max across both, so we never
   * lose recent days due to limit truncation.
   *
   * Why per-item history.get instead of batched: items emit at different
   * delays (5min vs 1min). When a 1-min item shares a batch with 5-min items
   * and `limit: 50000` clips the response, the recent days for some items
   * disappear silently. Per-item fetch with 25000-record limit is enough for
   * 14 days × 1440 1-min samples and avoids cross-item contention.
   *
   * Daily grouping uses Europe/Vilnius local date — the cockpit's working
   * timezone — so that timeline cell labels match the day boundaries the
   * drill-down API uses.
   */
  async getCpuHistoryDaily(
    itemIds: string[],
    itemHostMap: Map<string, string>,
    daysBack: number = 14
  ): Promise<{ hostId: string; date: string; max: number; avg: number; min: number; minutesAbove: { 50: number; 60: number; 70: number; 80: number; 90: number }; totalSamples: number }[]> {
    if (itemIds.length === 0) return [];
    // Cache the daily aggregate for 2 minutes. This data covers 14 days, the
    // newest day changes minute-by-minute, but the rest is frozen. A 2-minute
    // cache keeps the dashboard "live enough" without paying the 1-2s (prod)
    // / ~10s (dev mode, with fewer concurrent connections) cost on every
    // page load. In-flight dedup ALSO collapses concurrent renders to one
    // upstream call — important when the user clicks rapidly between pilots.
    const cacheKey = `zabbix:cpuHistDaily:${effectiveDaysKey(daysBack)}:${itemIds.slice().sort().join(",")}`;
    return cached(cacheKey, () => this._getCpuHistoryDailyUncached(itemIds, itemHostMap, daysBack), 120_000);
  }

  private async _getCpuHistoryDailyUncached(
    itemIds: string[],
    itemHostMap: Map<string, string>,
    daysBack: number = 14
  ): Promise<{ hostId: string; date: string; max: number; avg: number; min: number; minutesAbove: { 50: number; 60: number; 70: number; 80: number; 90: number }; totalSamples: number }[]> {
    // Bound at 1..365 days. The internal merge handles >14 d windows via
    // trend.get hourly aggregates: history.get covers the recent ~14 d with
    // sample-level accuracy, trend.get fills in the rest of the window.
    // The old hard clamp to 14 made the heatmap mis-display custom periods
    // (30 d / 60 d): the page rendered the wider date axis but the data
    // payload was silently capped to 14 d, so older cells showed "—".
    const effectiveDays = Math.min(Math.max(1, daysBack), 365);
    const timeFrom = Math.floor(Date.now() / 1000) - effectiveDays * 24 * 3600;

    // `samplesAbove` and `totalSamples` are populated only from history.get
    // (raw 1-min samples). trend.get aggregates contribute to max/avg/min but
    // not to the sample-level counters — they don't expose individual samples.
    type Bucket = {
      max: number; sum: number; min: number; count: number;
      samples: { 50: number; 60: number; 70: number; 80: number; 90: number };
      totalSamples: number;
    };
    const dailyMap = new Map<string, Bucket>();
    const localDate = (clockSec: number) =>
      new Date(clockSec * 1000).toLocaleDateString("en-CA", { timeZone: "Europe/Vilnius" });
    const newBucket = (value: number): Bucket => ({
      max: value, sum: value, min: value, count: 1,
      samples: { 50: 0, 60: 0, 70: 0, 80: 0, 90: 0 },
      totalSamples: 0,
    });
    const merge = (hostId: string, date: string, value: number, isRawSample: boolean) => {
      const key = `${hostId}|${date}`;
      let b = dailyMap.get(key);
      if (!b) { b = newBucket(value); dailyMap.set(key, b); }
      else {
        b.max = Math.max(b.max, value);
        b.min = Math.min(b.min, value);
        b.sum += value;
        b.count += 1;
      }
      // Per-threshold counters apply only to true 1-min samples. Trend
      // aggregates would distort the count (each represents an hour, not a
      // minute) so we exclude them.
      if (isRawSample) {
        b.totalSamples += 1;
        if (value >= 50) b.samples[50]++;
        if (value >= 60) b.samples[60]++;
        if (value >= 70) b.samples[70]++;
        if (value >= 80) b.samples[80]++;
        if (value >= 90) b.samples[90]++;
      }
    };

    // 1) trend.get — single call for all items, cheap (~hour-level aggregates).
    //    Retention is short on this Zabbix (~5–8 days) but covers exactly the
    //    recent days that history.get tends to truncate.
    //
    // 2) history.get — per item, with sortorder DESC + ample limit. Even at
    //    1-min sampling, 25000 covers 17 days; combined with the 14-day window
    //    no item gets truncated.
    //
    // We run trend.get and history.get IN PARALLEL: they merge into the same
    // dailyMap (raw samples vs aggregates flagged separately) so there's no
    // ordering dependency. Saves ~400ms on cold load. CONCURRENCY=24 was the
    // sweet spot in benchmarks (above this, Zabbix server-side queueing kicks
    // in and total time gets worse, not better).
    const PER_ITEM_LIMIT = 25000;
    const CONCURRENCY = 24;
    const trendPromise = (async () => {
      try {
        return (await this.request("trend.get", {
          output: ["itemid", "clock", "value_min", "value_avg", "value_max"],
          itemids: itemIds,
          time_from: String(timeFrom),
          limit: 100000,
        })) as Array<{ itemid: string; clock: string; value_min: string; value_avg: string; value_max: string }>;
      } catch (e) {
        console.warn("[Zabbix] trend.get failed, will rely on history.get:", e);
        return [] as Array<{ itemid: string; clock: string; value_min: string; value_avg: string; value_max: string }>;
      }
    })();
    const fetchOne = async (itemId: string): Promise<Array<{ itemid: string; clock: string; value: string }>> => {
      try {
        return (await this.request("history.get", {
          output: ["itemid", "clock", "value"],
          itemids: [itemId],
          history: 0,
          time_from: String(timeFrom),
          sortfield: "clock",
          sortorder: "DESC",
          limit: PER_ITEM_LIMIT,
        })) as Array<{ itemid: string; clock: string; value: string }>;
      } catch (e) {
        console.warn(`[Zabbix] history.get item ${itemId} failed:`, e);
        return [];
      }
    };
    const historyPromise = (async () => {
      const allRecords: Array<{ itemid: string; clock: string; value: string }> = [];
      for (let i = 0; i < itemIds.length; i += CONCURRENCY) {
        const slice = itemIds.slice(i, i + CONCURRENCY);
        const results = await Promise.all(slice.map(fetchOne));
        for (const records of results) {
          for (const r of records) allRecords.push(r);
        }
      }
      return allRecords;
    })();

    const [trends, historyRecords] = await Promise.all([trendPromise, historyPromise]);
    // Apply trend aggregates first (coarse), then layer 1-min samples on top.
    for (const t of trends) {
      const hostId = itemHostMap.get(t.itemid);
      if (!hostId) continue;
      const clockSec = parseInt(t.clock);
      const date = localDate(clockSec);
      const vmax = parseFloat(t.value_max) || 0;
      const vavg = parseFloat(t.value_avg) || 0;
      const vmin = parseFloat(t.value_min) || 0;
      const key = `${hostId}|${date}`;
      let b = dailyMap.get(key);
      if (!b) { b = newBucket(vmax); b.sum = vavg; b.min = vmin; dailyMap.set(key, b); }
      else {
        b.max = Math.max(b.max, vmax);
        b.min = Math.min(b.min, vmin);
        b.sum += vavg;
        b.count += 1;
      }
    }
    for (const r of historyRecords) {
      const hostId = itemHostMap.get(r.itemid);
      if (!hostId) continue;
      const date = localDate(parseInt(r.clock));
      merge(hostId, date, parseFloat(r.value) || 0, true);
    }

    const result: { hostId: string; date: string; max: number; avg: number; min: number; minutesAbove: { 50: number; 60: number; 70: number; 80: number; 90: number }; totalSamples: number }[] = [];
    for (const [key, data] of dailyMap) {
      const [hostId, date] = key.split("|");
      result.push({
        hostId,
        date,
        max: Math.round(data.max * 10) / 10,
        avg: Math.round((data.sum / data.count) * 10) / 10,
        min: Math.round(data.min * 10) / 10,
        minutesAbove: data.samples,
        totalSamples: data.totalSamples,
      });
    }
    return result;
  }

  /**
   * Get per-process CPU % items for the given hosts.
   *
   * On SCO hosts monitoring is configured with custom Zabbix keys of the form
   * `<proc>.cpu` (e.g. `python.cpu`, `python1.cpu`, `spss.cpu`, `sqlservr.cpu`).
   * These are 1-minute averages — refreshed far more often than the
   * Windows `perf_counter[\\Process(...)]` variants, and are what the Retellect
   * dashboard should read.
   *
   * We fetch with `search: { key_: ".cpu" }` and filter client-side so we get
   * every custom process metric in one round-trip regardless of which
   * processes a given host reports.
   */
  async getProcessCpuItems(hostIds: string[]): Promise<ProcessCpuItem[]> {
    if (hostIds.length === 0) return [];
    const cacheKey = `zabbix:procCpuItems:${hostIds.slice().sort().join(",")}`;
    // 60s TTL — careful balance: this response carries `lastvalue` and
    // `lastClock` that the Overview tab's "is Retellect running" check
    // reads as the live signal. Bumping much past 60 s would stall the
    // freshness reading (Zabbix native sample rate is 60 s, so 60 s cache
    // matches the underlying cadence). Was the default 30 s; bumping to
    // 60 s saves ~150–300 ms on every navigation within the same minute.
    const raw = (await cached(
      cacheKey,
      () =>
        this.request("item.get", {
          output: ["itemid", "hostid", "name", "key_", "lastvalue", "units", "lastclock", "value_type"],
          hostids: hostIds,
          search: { key_: ".cpu" },
          filter: { status: 0, state: 0 },
          sortfield: "key_",
        }),
      60_000,
    )) as Array<Record<string, unknown>>;
    const result: ProcessCpuItem[] = [];
    for (const it of raw) {
      const key = String(it.key_ || "");
      // Exclude native Zabbix CPU metrics (system.cpu.util, system.cpu.load, etc.)
      if (key.startsWith("system.cpu")) continue;
      // Exclude Windows perf_counter variants — slower refresh, duplicate data
      if (key.startsWith("perf_counter")) continue;
      // Only the `<proc>.cpu` convention
      if (!key.endsWith(".cpu")) continue;
      const { procName, category } = classifyProcessKey(key);
      result.push({
        itemId: String(it.itemid),
        hostId: String(it.hostid),
        name: String(it.name || procName),
        key,
        procName,
        category,
        cpuValue: parseFloat(String(it.lastvalue ?? "")) || 0,
        lastClock: parseInt(String(it.lastclock ?? "")) || 0,
        units: String(it.units || "%"),
      });
    }
    return result;
  }

  /**
   * Find which hosts have Retellect *actually deployed* — i.e. python.cpu
   * items configured AND at least one of them has produced trend history
   * in the last 14 days.
   *
   * Why trend history rather than `lastclock > 0`: when a Zabbix item
   * transitions to ZBX_NOTSUPPORTED, the agent resets `item.lastclock` to
   * 0 (verified live 2026-05-08). So a host whose Retellect ran healthily
   * for weeks and then the perfcounter broke ends up with lastclock=0 on
   * every item — indistinguishable, by lastclock alone, from a host that
   * never ran Retellect at all. trend.get's 14-day history survives that
   * transition: as long as the items emitted ANY records (zero or non-
   * zero) before they broke, the trend table still has those rows.
   *
   * Pavilnonys SCO2 (canonical 2026-05-08 case): 8 python items, all
   * state=1, all lastclock=0, BUT 1284 trend records from 2026-04-24 to
   * 2026-05-01 with 577 non-zero values. Clearly deployed; clearly
   * stopped working a week ago. The trend-history check correctly says
   * "deployed"; the prior lastclock check incorrectly said "never".
   *
   * Excludes: hosts where the template registers python items but NO
   * trend record ever existed for them — i.e. the items have always been
   * ZBX_NOTSUPPORTED with no historical samples. That's the "never
   * deployed" template-scaffolding case the user reported earlier.
   *
   * Cost: two item.get calls (registry, returning itemid+hostid) + one
   * batched trend.get over the last 14 d for those itemids. Cached 5 min.
   */
  async getRetellectDeployedHostIds(hostIds: string[]): Promise<Set<string>> {
    if (hostIds.length === 0) return new Set();
    const cacheKey = `zabbix:retellectDeployedHostIds:${hostIds.slice().sort().join(",")}`;
    return (await cached(
      cacheKey,
      async () => {
        // Step 1: item registry — all python.cpu / perf_counter[Process(python*)]
        // items on the matched hosts (status=0, NO state filter).
        const [byCpuKey, byPerfKey] = await Promise.all([
          this.request("item.get", {
            output: ["itemid", "hostid"],
            hostids: hostIds,
            search: { key_: "python" },
            filter: { status: 0 },
          }) as Promise<Array<{ itemid: string; hostid: string }>>,
          this.request("item.get", {
            output: ["itemid", "hostid"],
            hostids: hostIds,
            search: { key_: "Process(python" },
            filter: { status: 0 },
          }) as Promise<Array<{ itemid: string; hostid: string }>>,
        ]);
        const itemHostMap = new Map<string, string>();
        for (const it of byCpuKey) itemHostMap.set(String(it.itemid), String(it.hostid));
        for (const it of byPerfKey) itemHostMap.set(String(it.itemid), String(it.hostid));
        if (itemHostMap.size === 0) return new Set<string>();

        // Step 2: trend.get over the last 14 days for those items. Any
        // record at all (even zero-valued) is evidence the host ran
        // Retellect telemetry at some point in the window.
        const itemIds = Array.from(itemHostMap.keys());
        const timeFrom = Math.floor(Date.now() / 1000) - 14 * 24 * 3600;
        const trends = (await this.request("trend.get", {
          output: ["itemid"],
          itemids: itemIds,
          time_from: String(timeFrom),
          // 100k caps at ~12k itemids × 24 h × 14 d / max items per pilot —
          // Rimi pilot has ~115 hosts × 8 items = ~920 items, well under
          // the ceiling.
          limit: 100000,
        })) as Array<{ itemid: string }>;

        const out = new Set<string>();
        for (const t of trends) {
          const hostId = itemHostMap.get(String(t.itemid));
          if (hostId) out.add(hostId);
        }
        return out;
      },
      // 5-min TTL — item registry + 14-day trend window only changes on
      // Zabbix template redeploy or as data ages out at the day boundary.
      5 * 60_000,
    ));
  }

  /** Get resource metrics (CPU, RAM, Disk, Network) for all monitored hosts */
  async getResourceMetrics(): Promise<any[]> {
    // 60s TTL — same reasoning as getProcessCpuItems: the response carries
    // live `lastvalue`/`lastclock` for CPU util, memory, disk. Native Zabbix
    // sample cadence is 60 s on this template, so 60 s cache matches the
    // underlying refresh rate without staleness penalty.
    return cached("zabbix:resourceMetrics", () => this._getResourceMetricsUncached(), 60_000);
  }

  private async _getResourceMetricsUncached(): Promise<any[]> {
    const hosts = await this.getHosts();
    const hostIds = hosts.map((h: any) => h.hostid);
    if (hostIds.length === 0) return [];

    // Fetch all relevant items — Zabbix search doesn't support comma-separated terms
    // so we run parallel queries for each category
    const itemParams = {
      output: ["itemid", "hostid", "name", "key_", "lastvalue", "units", "lastclock", "value_type"],
      hostids: hostIds,
      filter: { status: 0, state: 0 },
      sortfield: "name",
    };
    const [cpuItems, memItems, diskItems, netItems] = await Promise.all([
      this.request("item.get", { ...itemParams, search: { key_: "system.cpu" } }),
      this.request("item.get", { ...itemParams, search: { key_: "vm.memory" } }),
      this.request("item.get", { ...itemParams, search: { key_: "vfs.fs" } }),
      this.request("item.get", { ...itemParams, search: { key_: "net.if" } }),
    ]);
    const items = [...cpuItems, ...memItems, ...diskItems, ...netItems];

    // Group by host
    const hostMap = new Map<string, any>();
    for (const host of hosts) {
      hostMap.set(host.hostid, {
        hostId: host.hostid,
        hostName: host.name,
        status: host.status === "0" ? "up" : "down",
        cpu: null,
        memory: null,
        disk: null,
        network: null,
        // RT-CPUMODEL phase 1: carry inventory through from getHosts() so the
        // dashboard can fall back to live Zabbix CPU/OS strings when the DB
        // device row has them as null. mapHostInventory() already normalises
        // the raw Zabbix payload to { cpuModel, ramBytes, os } | null.
        inventory: (host.inventory ?? null) as HostInventory | null,
        items: [],
      });
    }

    for (const item of items) {
      const host = hostMap.get(item.hostid);
      if (!host) continue;
      host.items.push(item);

      const key = item.key_ as string;
      const val = parseFloat(item.lastvalue);

      // CPU — track user/system separately, compute total
      if (key.includes("system.cpu.util") || key.includes("system.cpu.load")) {
        if (!host.cpu) host.cpu = { utilization: 0, userPct: 0, systemPct: 0, load: 0, itemId: item.itemid, valueType: item.value_type };
        if (key === "system.cpu.util[,user]") host.cpu.userPct = val;
        if (key === "system.cpu.util[,system]") host.cpu.systemPct = val;
        // Handle both system.cpu.util and system.cpu.util[,,avg1] as total utilization
        if ((key === "system.cpu.util" || key === "system.cpu.util[,,avg1]") && val > 0) host.cpu.utilization = val;
        if (key.includes("system.cpu.load")) host.cpu.load = val;
        host.cpu.itemId = item.itemid;
        host.cpu.valueType = item.value_type;
      }

      // Memory
      if (key === "vm.memory.utilization" || key === "vm.memory.size[pavailable]") {
        if (!host.memory) host.memory = { utilization: 0, available: 0, total: 0, itemId: item.itemid, valueType: item.value_type };
        if (key === "vm.memory.utilization") host.memory.utilization = val;
        if (key === "vm.memory.size[pavailable]") host.memory.utilization = 100 - val;
        host.memory.itemId = item.itemid;
        host.memory.valueType = item.value_type;
      }
      if (key === "vm.memory.size[total]") {
        if (!host.memory) host.memory = { utilization: 0, available: 0, total: 0, itemId: "", valueType: "0" };
        host.memory.total = val;
      }
      if (key === "vm.memory.size[available]") {
        if (!host.memory) host.memory = { utilization: 0, available: 0, total: 0, itemId: "", valueType: "0" };
        host.memory.available = val;
      }

      // Disk
      if (key.includes("vfs.fs.size") && key.includes("pused")) {
        if (!host.disk || val > (host.disk.utilization || 0)) {
          host.disk = { utilization: val, path: key.match(/\[(.*?),/)?.[1] || "/", itemId: item.itemid, valueType: item.value_type };
        }
      }

      // Network
      if (key.includes("net.if.in") || key.includes("net.if.out")) {
        if (!host.network) host.network = { inBps: 0, outBps: 0, inItemId: "", outItemId: "", valueType: item.value_type };
        if (key.includes("net.if.in")) { host.network.inBps = val; host.network.inItemId = item.itemid; }
        if (key.includes("net.if.out")) { host.network.outBps = val; host.network.outItemId = item.itemid; }
      }
    }

    // Post-process: compute CPU utilization from user+system if base key was 0
    for (const host of hostMap.values()) {
      if (host.cpu && host.cpu.utilization === 0 && (host.cpu.userPct > 0 || host.cpu.systemPct > 0)) {
        host.cpu.utilization = host.cpu.userPct + host.cpu.systemPct;
      }
    }

    return Array.from(hostMap.values());
  }
}

export class ZabbixApiError extends Error {
  constructor(message: string, public data: string, public code: number) {
    super("Zabbix API Error: " + message + " - " + data);
    this.name = "ZabbixApiError";
  }
}

export function getZabbixClient(): ZabbixClient {
  const url = process.env.ZABBIX_URL;
  const token = process.env.ZABBIX_TOKEN;
  if (!url || !token) {
    throw new Error("ZABBIX_URL and ZABBIX_TOKEN must be set");
  }
  return new ZabbixClient(url, token);
}
