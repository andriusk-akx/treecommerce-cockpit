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
      signal: AbortSignal.timeout(15_000),
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
    return this.request("host.get", {
      output: ["hostid", "host", "name", "status", "maintenance_status"],
      selectInterfaces: ["ip", "type", "available"],
      selectGroups: ["groupid", "name"],
    });
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
    return this.request("item.get", {
      output: ["itemid", "hostid", "name", "key_", "lastvalue", "units", "lastclock", "value_type", "state", "status"],
      hostids: hostIds,
      ...(search ? { search: { key_: search }, searchWildcardsEnabled: true } : {}),
      filter: { status: 0, state: 0 },
      sortfield: "name",
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

  /** Get resource metrics (CPU, RAM, Disk, Network) for all monitored hosts */
  async getResourceMetrics(): Promise<any[]> {
    const hosts = await this.getHosts();
    const hostIds = hosts.map((h: any) => h.hostid);
    if (hostIds.length === 0) return [];

    // Fetch all relevant items for these hosts
    const items = await this.request("item.get", {
      output: ["itemid", "hostid", "name", "key_", "lastvalue", "units", "lastclock", "value_type"],
      hostids: hostIds,
      filter: { status: 0, state: 0 },
      search: { key_: "system.cpu,vm.memory,vfs.fs,net.if" },
      searchByAny: true,
      searchWildcardsEnabled: true,
      sortfield: "name",
    });

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

      // CPU
      if (key.includes("system.cpu.util") || key === "system.cpu.load[all,avg1]" || key === "system.cpu.load[percpu,avg1]") {
        if (!host.cpu) host.cpu = { utilization: 0, load: 0, itemId: item.itemid, valueType: item.value_type };
        if (key.includes("system.cpu.util")) host.cpu.utilization = val;
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
