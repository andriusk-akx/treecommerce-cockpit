import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { classifyProcessKey, ZabbixClient } from "./client";
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
