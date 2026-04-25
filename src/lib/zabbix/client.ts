import type { ProcessCategory, ProcessCpuItem } from "./types";
import { cached } from "./cache";

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
    return cached(
      "zabbix:host.get",
      () =>
        this.request("host.get", {
          output: ["hostid", "host", "name", "status", "maintenance_status"],
          selectInterfaces: ["ip", "type", "available"],
          selectGroups: ["groupid", "name"],
        }),
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
    return cached(key, () =>
      this.request("item.get", {
        output: ["itemid", "hostid", "name", "key_", "lastvalue", "units", "lastclock", "value_type", "state", "status"],
        hostids: hostIds,
        ...(search ? { search: { key_: search } } : {}),
        filter: { status: 0, state: 0 },
        sortfield: "name",
      }),
    );
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
  ): Promise<{ hostId: string; date: string; max: number; avg: number; min: number }[]> {
    if (itemIds.length === 0) return [];
    const effectiveDays = Math.min(daysBack, 14);
    const timeFrom = Math.floor(Date.now() / 1000) - effectiveDays * 24 * 3600;

    type Bucket = { max: number; sum: number; min: number; count: number };
    const dailyMap = new Map<string, Bucket>();
    const localDate = (clockSec: number) =>
      new Date(clockSec * 1000).toLocaleDateString("en-CA", { timeZone: "Europe/Vilnius" });
    const merge = (hostId: string, date: string, value: number) => {
      const key = `${hostId}|${date}`;
      const b = dailyMap.get(key);
      if (b) {
        b.max = Math.max(b.max, value);
        b.min = Math.min(b.min, value);
        b.sum += value;
        b.count += 1;
      } else {
        dailyMap.set(key, { max: value, sum: value, min: value, count: 1 });
      }
    };

    // 1) trend.get — single call for all items, cheap (~hour-level aggregates).
    //    Retention is short on this Zabbix (~5–7 days) but covers exactly the
    //    recent days that history.get tends to truncate.
    try {
      const trends = (await this.request("trend.get", {
        output: ["itemid", "clock", "value_min", "value_avg", "value_max"],
        itemids: itemIds,
        time_from: String(timeFrom),
        limit: 100000,
      })) as Array<{ itemid: string; clock: string; value_min: string; value_avg: string; value_max: string }>;
      for (const t of trends) {
        const hostId = itemHostMap.get(t.itemid);
        if (!hostId) continue;
        const clockSec = parseInt(t.clock);
        const date = localDate(clockSec);
        const vmax = parseFloat(t.value_max) || 0;
        const vavg = parseFloat(t.value_avg) || 0;
        const vmin = parseFloat(t.value_min) || 0;
        // Treat each hourly trend record as ONE observation for avg purposes —
        // it is itself an hourly mean, so summing avgs and dividing by count
        // gives a reasonable day-level mean. Min/max use the trend's min/max.
        const key = `${hostId}|${date}`;
        const b = dailyMap.get(key);
        if (b) {
          b.max = Math.max(b.max, vmax);
          b.min = Math.min(b.min, vmin);
          b.sum += vavg;
          b.count += 1;
        } else {
          dailyMap.set(key, { max: vmax, sum: vavg, min: vmin, count: 1 });
        }
      }
    } catch (e) {
      console.warn("[Zabbix] trend.get failed, will rely on history.get:", e);
    }

    // 2) history.get — per item, with sortorder DESC + ample limit. Even at
    //    1-min sampling, 25000 covers 17 days; combined with the 14-day window
    //    no item gets truncated. Run with bounded concurrency to keep the
    //    Zabbix API happy.
    const PER_ITEM_LIMIT = 25000;
    const CONCURRENCY = 8;
    const fetchOne = async (itemId: string) => {
      try {
        const records = (await this.request("history.get", {
          output: ["itemid", "clock", "value"],
          itemids: [itemId],
          history: 0,
          time_from: String(timeFrom),
          sortfield: "clock",
          sortorder: "DESC",
          limit: PER_ITEM_LIMIT,
        })) as Array<{ itemid: string; clock: string; value: string }>;
        const hostId = itemHostMap.get(itemId);
        if (!hostId) return;
        for (const r of records) {
          const date = localDate(parseInt(r.clock));
          merge(hostId, date, parseFloat(r.value) || 0);
        }
      } catch (e) {
        console.warn(`[Zabbix] history.get item ${itemId} failed:`, e);
      }
    };
    for (let i = 0; i < itemIds.length; i += CONCURRENCY) {
      const slice = itemIds.slice(i, i + CONCURRENCY);
      await Promise.all(slice.map(fetchOne));
    }

    const result: { hostId: string; date: string; max: number; avg: number; min: number }[] = [];
    for (const [key, data] of dailyMap) {
      const [hostId, date] = key.split("|");
      result.push({
        hostId,
        date,
        max: Math.round(data.max * 10) / 10,
        avg: Math.round((data.sum / data.count) * 10) / 10,
        min: Math.round(data.min * 10) / 10,
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

  /** Get resource metrics (CPU, RAM, Disk, Network) for all monitored hosts */
  async getResourceMetrics(): Promise<any[]> {
    return cached("zabbix:resourceMetrics", () => this._getResourceMetricsUncached());
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
