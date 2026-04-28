import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { classifyProcessKey, mapHostInventory, ZabbixClient } from "./client";
import { invalidateCache } from "./cache";

describe("classifyProcessKey", () => {
  it("classifies python and python1..N as retellect", () => {
    expect(classifyProcessKey("python.cpu").category).toBe("retellect");
    expect(classifyProcessKey("python1.cpu").category).toBe("retellect");
    expect(classifyProcessKey("python2.cpu").category).toBe("retellect");
    expect(classifyProcessKey("python3.cpu").category).toBe("retellect");
    expect(classifyProcessKey("python10.cpu").category).toBe("retellect");
  });

  it("preserves the python worker suffix in procName", () => {
    expect(classifyProcessKey("python.cpu").procName).toBe("python");
    expect(classifyProcessKey("python1.cpu").procName).toBe("python1");
    expect(classifyProcessKey("python3.cpu").procName).toBe("python3");
  });

  it("classifies spss / sp.sss / sp as StrongPoint SCO", () => {
    expect(classifyProcessKey("spss.cpu").category).toBe("sco");
    expect(classifyProcessKey("sp.sss.cpu").category).toBe("sco");
    expect(classifyProcessKey("sp.cpu").category).toBe("sco");
  });

  it("normalizes the SCO process name to 'spss'", () => {
    expect(classifyProcessKey("spss.cpu").procName).toBe("spss");
    expect(classifyProcessKey("sp.sss.cpu").procName).toBe("spss");
    expect(classifyProcessKey("sp.cpu").procName).toBe("spss");
  });

  it("classifies sql / sqlservr as db", () => {
    expect(classifyProcessKey("sql.cpu").category).toBe("db");
    expect(classifyProcessKey("sqlservr.cpu").category).toBe("db");
  });

  it("classifies peripheral drivers as hw", () => {
    expect(classifyProcessKey("cs300sd.cpu").category).toBe("hw");
    expect(classifyProcessKey("NHSTW32.cpu").category).toBe("hw");
    expect(classifyProcessKey("udm.cpu").category).toBe("hw");
    expect(classifyProcessKey("UDMServer.cpu").category).toBe("hw");
  });

  it("classifies vm / vmware-vmx as sys", () => {
    expect(classifyProcessKey("vm.cpu").category).toBe("sys");
    expect(classifyProcessKey("vmware-vmx.cpu").category).toBe("sys");
  });

  it("falls back to 'other' for unknown processes", () => {
    expect(classifyProcessKey("explorer.cpu").category).toBe("other");
    expect(classifyProcessKey("notepad.cpu").category).toBe("other");
  });

  it("handles keys that do not end with .cpu", () => {
    // procName is the whole key when the suffix is missing
    const r = classifyProcessKey("python");
    expect(r.category).toBe("retellect");
    expect(r.procName).toBe("python");
  });

  it("is case-insensitive for classification", () => {
    expect(classifyProcessKey("Python1.cpu").category).toBe("retellect");
    expect(classifyProcessKey("SPSS.cpu").category).toBe("sco");
    expect(classifyProcessKey("Sqlservr.cpu").category).toBe("db");
  });
});

// ─── mapHostInventory (RT-CPUMODEL phase 1) ───────────────────

describe("mapHostInventory", () => {
  it("returns null for an empty array (Zabbix's representation of inventory_mode=-1)", () => {
    expect(mapHostInventory([])).toBeNull();
  });

  it("returns null for null/undefined/non-objects", () => {
    expect(mapHostInventory(null)).toBeNull();
    expect(mapHostInventory(undefined)).toBeNull();
    expect(mapHostInventory("string")).toBeNull();
    expect(mapHostInventory(42)).toBeNull();
  });

  it("returns null when every requested field is empty/blank/'0'", () => {
    expect(mapHostInventory({ hardware: "", hardware_full: "", os: "", os_full: "" })).toBeNull();
    expect(mapHostInventory({ hardware: "0", os: "0" })).toBeNull();
    expect(mapHostInventory({})).toBeNull();
  });

  it("picks `hardware` when only the short field is populated", () => {
    const r = mapHostInventory({ hardware: "Intel Atom", os: "" });
    expect(r).toEqual({ cpuModel: "Intel Atom", ramBytes: null, os: null });
  });

  it("prefers `hardware_full` when it is populated and at least as long as `hardware`", () => {
    const r = mapHostInventory({ hardware: "Intel", hardware_full: "Intel(R) Pentium(R) CPU G4400 @ 3.30GHz" });
    expect(r?.cpuModel).toBe("Intel(R) Pentium(R) CPU G4400 @ 3.30GHz");
  });

  it("falls back to `hardware` when `hardware_full` is shorter (rare but seen)", () => {
    const r = mapHostInventory({ hardware: "Intel(R) Pentium(R) Long string", hardware_full: "Short" });
    expect(r?.cpuModel).toBe("Intel(R) Pentium(R) Long string");
  });

  it("prefers `os_full` over `os` when both are populated", () => {
    const r = mapHostInventory({ hardware: "Intel", os: "Win10", os_full: "Microsoft Windows 10 Pro 22H2" });
    expect(r?.os).toBe("Microsoft Windows 10 Pro 22H2");
  });

  it("returns the inventory shape with ramBytes always null (no inventory ram field)", () => {
    const r = mapHostInventory({ hardware: "Intel", os: "Win10" });
    expect(r?.ramBytes).toBeNull();
  });

  it("trims whitespace on string fields", () => {
    const r = mapHostInventory({ hardware: "  Intel Xeon  ", os: "  Linux  " });
    expect(r?.cpuModel).toBe("Intel Xeon");
    expect(r?.os).toBe("Linux");
  });

  it("survives unexpected non-string field values without throwing", () => {
    const r = mapHostInventory({ hardware: 42 as unknown as string, os: null as unknown as string, os_full: "Linux" });
    expect(r?.cpuModel).toBeNull();
    expect(r?.os).toBe("Linux");
  });
});

// ─── getProcessCpuItems — filtering + parsing ──────────────────

interface MockZabbixItem {
  itemid?: string;
  hostid?: string;
  name?: string;
  key_: string;
  lastvalue?: string | number;
  lastclock?: string | number;
  units?: string;
}

/** Stub `fetch` to return a JSON-RPC response wrapping `items` as the result. */
function mockFetchReturning(items: MockZabbixItem[]): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ jsonrpc: "2.0", result: items, id: 1 }),
  });
}

describe("ZabbixClient.getProcessCpuItems", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Reset to a clean stub + drop any cached results between tests.
    // The client now memoizes item.get responses per (hostIds, search) key
    // so identical calls across tests would otherwise get stale data.
    invalidateCache();
    globalThis.fetch = mockFetchReturning([]) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("short-circuits without a network call when hostIds is empty", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const client = new ZabbixClient("https://zbx.example/api", "tok");
    const result = await client.getProcessCpuItems([]);
    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("filters out system.cpu.* keys", async () => {
    globalThis.fetch = mockFetchReturning([
      { itemid: "1", hostid: "h1", name: "CPU total", key_: "system.cpu.util[,,avg1]", lastvalue: "5.5", lastclock: "1700000000", units: "%" },
      { itemid: "2", hostid: "h1", name: "CPU user", key_: "system.cpu.util[,user]", lastvalue: "3.0", lastclock: "1700000000", units: "%" },
      { itemid: "3", hostid: "h1", name: "Python", key_: "python.cpu", lastvalue: "1.2", lastclock: "1700000000", units: "%" },
    ]) as unknown as typeof fetch;
    const client = new ZabbixClient("https://zbx.example/api", "tok");
    const items = await client.getProcessCpuItems(["h1"]);
    expect(items).toHaveLength(1);
    expect(items[0].key).toBe("python.cpu");
    expect(items[0].category).toBe("retellect");
  });

  it("filters out perf_counter[...] variants (slower-refreshing Windows counters)", async () => {
    globalThis.fetch = mockFetchReturning([
      { itemid: "1", hostid: "h1", key_: "perf_counter[\\Process(python)\\% Processor Time]", lastvalue: "2.1", lastclock: "1700000000" },
      { itemid: "2", hostid: "h1", key_: "perf_counter_en[\\Process]", lastvalue: "0", lastclock: "1700000000" },
      { itemid: "3", hostid: "h1", key_: "python1.cpu", lastvalue: "1.0", lastclock: "1700000000" },
    ]) as unknown as typeof fetch;
    const client = new ZabbixClient("https://zbx.example/api", "tok");
    const items = await client.getProcessCpuItems(["h1"]);
    expect(items.map((i) => i.key)).toEqual(["python1.cpu"]);
  });

  it("drops keys that do not end with .cpu", async () => {
    globalThis.fetch = mockFetchReturning([
      { itemid: "1", hostid: "h1", key_: "python.memory", lastvalue: "5", lastclock: "1700000000" },
      { itemid: "2", hostid: "h1", key_: "python.cpu", lastvalue: "1.5", lastclock: "1700000000" },
      { itemid: "3", hostid: "h1", key_: "agent.version", lastvalue: "6.0", lastclock: "1700000000" },
    ]) as unknown as typeof fetch;
    const client = new ZabbixClient("https://zbx.example/api", "tok");
    const items = await client.getProcessCpuItems(["h1"]);
    expect(items).toHaveLength(1);
    expect(items[0].key).toBe("python.cpu");
  });

  it("parses lastvalue and lastclock from strings to numbers", async () => {
    globalThis.fetch = mockFetchReturning([
      { itemid: "42", hostid: "h1", name: "Python1", key_: "python1.cpu", lastvalue: "3.45", lastclock: "1700000123", units: "%" },
    ]) as unknown as typeof fetch;
    const client = new ZabbixClient("https://zbx.example/api", "tok");
    const items = await client.getProcessCpuItems(["h1"]);
    expect(items).toHaveLength(1);
    expect(items[0].cpuValue).toBeCloseTo(3.45, 5);
    expect(items[0].lastClock).toBe(1700000123);
    expect(items[0].itemId).toBe("42");
    expect(items[0].hostId).toBe("h1");
    expect(items[0].units).toBe("%");
  });

  it("defaults missing lastvalue / lastclock to 0 instead of NaN", async () => {
    globalThis.fetch = mockFetchReturning([
      { itemid: "1", hostid: "h1", key_: "python.cpu" /* no lastvalue, no lastclock */ },
    ]) as unknown as typeof fetch;
    const client = new ZabbixClient("https://zbx.example/api", "tok");
    const items = await client.getProcessCpuItems(["h1"]);
    expect(items).toHaveLength(1);
    expect(items[0].cpuValue).toBe(0);
    expect(items[0].lastClock).toBe(0);
    expect(Number.isNaN(items[0].cpuValue)).toBe(false);
    expect(Number.isNaN(items[0].lastClock)).toBe(false);
  });

  it("classifies each kept item (retellect / sco / db / hw / sys / other)", async () => {
    globalThis.fetch = mockFetchReturning([
      { itemid: "1", hostid: "h1", key_: "python.cpu", lastvalue: "1", lastclock: "1700000000" },
      { itemid: "2", hostid: "h1", key_: "python2.cpu", lastvalue: "2", lastclock: "1700000000" },
      { itemid: "3", hostid: "h1", key_: "spss.cpu", lastvalue: "5", lastclock: "1700000000" },
      { itemid: "4", hostid: "h1", key_: "sqlservr.cpu", lastvalue: "3", lastclock: "1700000000" },
      { itemid: "5", hostid: "h1", key_: "cs300sd.cpu", lastvalue: "0.5", lastclock: "1700000000" },
      { itemid: "6", hostid: "h1", key_: "vmware-vmx.cpu", lastvalue: "1", lastclock: "1700000000" },
      { itemid: "7", hostid: "h1", key_: "explorer.cpu", lastvalue: "0.1", lastclock: "1700000000" },
    ]) as unknown as typeof fetch;
    const client = new ZabbixClient("https://zbx.example/api", "tok");
    const items = await client.getProcessCpuItems(["h1"]);
    const byKey = Object.fromEntries(items.map((i) => [i.key, i.category]));
    expect(byKey).toEqual({
      "python.cpu": "retellect",
      "python2.cpu": "retellect",
      "spss.cpu": "sco",
      "sqlservr.cpu": "db",
      "cs300sd.cpu": "hw",
      "vmware-vmx.cpu": "sys",
      "explorer.cpu": "other",
    });
  });

  it("passes the correct JSON-RPC payload to Zabbix", async () => {
    const fetchSpy = mockFetchReturning([]);
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const client = new ZabbixClient("https://zbx.example/api", "my-token");
    await client.getProcessCpuItems(["h1", "h2"]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.method).toBe("item.get");
    expect(body.params.hostids).toEqual(["h1", "h2"]);
    expect(body.params.search).toEqual({ key_: ".cpu" });
    // Only active, enabled items
    expect(body.params.filter).toEqual({ status: 0, state: 0 });
    // Authorization header uses bearer token
    expect(init.headers.Authorization).toBe("Bearer my-token");
  });

  it("propagates Zabbix API errors instead of silently returning empty", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: "2.0", error: { code: -32602, message: "Invalid params", data: "bad hostid" }, id: 1 }),
    }) as unknown as typeof fetch;
    const client = new ZabbixClient("https://zbx.example/api", "tok");
    await expect(client.getProcessCpuItems(["h1"])).rejects.toThrow(/Invalid params/);
  });
});

// ─── getCpuHistoryDaily — trend.get + history.get aggregation ─────

describe("ZabbixClient.getCpuHistoryDaily", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    invalidateCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /**
   * Stub fetch to dispatch by JSON-RPC method. Each subsequent call hits a
   * different mock so tests can vary trend.get vs history.get responses.
   */
  function mockByMethod(handlers: { trend?: () => any[]; history?: (itemId: string) => any[] }) {
    return vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (body.method === "trend.get") {
        return { ok: true, json: async () => ({ jsonrpc: "2.0", result: handlers.trend ? handlers.trend() : [], id: body.id }) };
      }
      if (body.method === "history.get") {
        const itemId = body.params.itemids[0];
        return { ok: true, json: async () => ({ jsonrpc: "2.0", result: handlers.history ? handlers.history(itemId) : [], id: body.id }) };
      }
      return { ok: true, json: async () => ({ jsonrpc: "2.0", result: [], id: body.id }) };
    });
  }

  it("returns empty array when no item ids", async () => {
    const client = new ZabbixClient("https://zbx.example/api", "tok");
    const r = await client.getCpuHistoryDaily([], new Map(), 14);
    expect(r).toEqual([]);
  });

  it("aggregates per (host, date) with max/avg/min from raw 1-min samples", async () => {
    // Three samples on the same Vilnius local day for one host.
    const day0 = Math.floor(new Date("2026-04-20T10:00:00+03:00").getTime() / 1000);
    globalThis.fetch = mockByMethod({
      trend: () => [],
      history: () => [
        { itemid: "i1", clock: String(day0), value: "30" },
        { itemid: "i1", clock: String(day0 + 60), value: "60" },
        { itemid: "i1", clock: String(day0 + 120), value: "90" },
      ],
    }) as unknown as typeof fetch;
    const client = new ZabbixClient("https://zbx.example/api", "tok");
    const r = await client.getCpuHistoryDaily(["i1"], new Map([["i1", "h1"]]), 14);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      hostId: "h1",
      max: 90,
      min: 30,
      avg: 60, // (30+60+90)/3 = 60.0
    });
    // Per-threshold counters reflect the three samples.
    expect(r[0].minutesAbove[50]).toBe(2); // 60, 90
    expect(r[0].minutesAbove[60]).toBe(2); // 60, 90 (>=60)
    expect(r[0].minutesAbove[70]).toBe(1); // 90
    expect(r[0].minutesAbove[80]).toBe(1); // 90
    expect(r[0].minutesAbove[90]).toBe(1); // 90
    expect(r[0].totalSamples).toBe(3);
  });

  it("trend.get aggregates feed max/avg/min but NOT minutesAbove counters", async () => {
    // Trend.get exposes min/avg/max per HOUR — trying to count "minutes above
    // threshold" from these would over- or under-count by an order of magnitude.
    // The aggregator must skip the per-threshold counters for trend rows.
    const dayClock = Math.floor(new Date("2026-04-20T10:00:00+03:00").getTime() / 1000);
    globalThis.fetch = mockByMethod({
      trend: () => [
        { itemid: "i1", clock: String(dayClock), value_min: "20", value_avg: "50", value_max: "80" },
      ],
      history: () => [], // no raw samples
    }) as unknown as typeof fetch;
    const client = new ZabbixClient("https://zbx.example/api", "tok");
    const r = await client.getCpuHistoryDaily(["i1"], new Map([["i1", "h1"]]), 14);
    expect(r).toHaveLength(1);
    expect(r[0].max).toBe(80);
    expect(r[0].min).toBe(20);
    expect(r[0].avg).toBe(50);
    // No raw samples → counters all zero.
    expect(r[0].totalSamples).toBe(0);
    expect(r[0].minutesAbove[50]).toBe(0);
    expect(r[0].minutesAbove[70]).toBe(0);
    expect(r[0].minutesAbove[90]).toBe(0);
  });

  it("unions trend + history: max takes the higher of the two", async () => {
    // Real-world case: history.get returns 25k recent samples but the OLDER
    // edge of the 14-day window is only covered by trend.get. The function
    // must keep both contributions on the same per-(host,date) bucket.
    const day = Math.floor(new Date("2026-04-15T12:00:00+03:00").getTime() / 1000);
    globalThis.fetch = mockByMethod({
      trend: () => [
        { itemid: "i1", clock: String(day), value_min: "10", value_avg: "30", value_max: "55" },
      ],
      history: () => [
        // Same calendar day, but a higher 1-min spike not represented by trend.
        { itemid: "i1", clock: String(day + 600), value: "85" },
      ],
    }) as unknown as typeof fetch;
    const client = new ZabbixClient("https://zbx.example/api", "tok");
    const r = await client.getCpuHistoryDaily(["i1"], new Map([["i1", "h1"]]), 14);
    expect(r[0].max).toBe(85); // history max wins over trend max
    expect(r[0].min).toBe(10); // trend min wins (smaller)
    expect(r[0].minutesAbove[80]).toBe(1); // raw sample above 80
    expect(r[0].totalSamples).toBe(1);
  });

  it("produces one entry per (host, date) — multi-host, multi-day", async () => {
    const day1 = Math.floor(new Date("2026-04-19T08:00:00+03:00").getTime() / 1000);
    const day2 = Math.floor(new Date("2026-04-20T08:00:00+03:00").getTime() / 1000);
    globalThis.fetch = mockByMethod({
      trend: () => [],
      history: (itemId: string) => itemId === "i1"
        ? [{ itemid: "i1", clock: String(day1), value: "50" }, { itemid: "i1", clock: String(day2), value: "60" }]
        : [{ itemid: "i2", clock: String(day1), value: "10" }],
    }) as unknown as typeof fetch;
    const client = new ZabbixClient("https://zbx.example/api", "tok");
    const r = await client.getCpuHistoryDaily(
      ["i1", "i2"],
      new Map([["i1", "h1"], ["i2", "h2"]]),
      14,
    );
    expect(r).toHaveLength(3); // h1×2 dates + h2×1 date
    const keys = r.map((x) => `${x.hostId}|${x.date}`).sort();
    expect(keys[0].startsWith("h1|")).toBe(true);
    expect(keys[1].startsWith("h1|")).toBe(true);
    expect(keys[2].startsWith("h2|")).toBe(true);
  });

  it("skips items not in itemHostMap (defensive)", async () => {
    // If the client somehow gets an itemid back without a known host (Zabbix
    // hot-deleted an item between calls, or a typo in the map), it should
    // silently drop those samples rather than throwing or attributing them
    // to the wrong host.
    globalThis.fetch = mockByMethod({
      trend: () => [{ itemid: "stranger", clock: "1700000000", value_min: "1", value_avg: "1", value_max: "1" }],
      history: () => [{ itemid: "stranger", clock: "1700000000", value: "50" }],
    }) as unknown as typeof fetch;
    const client = new ZabbixClient("https://zbx.example/api", "tok");
    const r = await client.getCpuHistoryDaily(["stranger"], new Map(), 14);
    expect(r).toEqual([]);
  });

  it("rounds returned max/avg/min to 1 decimal", async () => {
    const day = Math.floor(new Date("2026-04-20T08:00:00+03:00").getTime() / 1000);
    globalThis.fetch = mockByMethod({
      trend: () => [],
      history: () => [
        { itemid: "i1", clock: String(day), value: "12.345" },
        { itemid: "i1", clock: String(day + 60), value: "23.456" },
        { itemid: "i1", clock: String(day + 120), value: "34.567" },
      ],
    }) as unknown as typeof fetch;
    const client = new ZabbixClient("https://zbx.example/api", "tok");
    const r = await client.getCpuHistoryDaily(["i1"], new Map([["i1", "h1"]]), 14);
    // (12.345+23.456+34.567)/3 = 23.456 → rounded to 23.5
    expect(r[0].avg).toBeCloseTo(23.5, 5);
    expect(r[0].max).toBeCloseTo(34.6, 5);
    expect(r[0].min).toBeCloseTo(12.3, 5);
  });
});
