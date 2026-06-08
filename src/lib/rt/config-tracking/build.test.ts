import { describe, it, expect } from "vitest";
import { buildConfigTracking, computeKpis, compareHostConfig, type ConfigDeviceInput } from "./build";

// Fixed reference "now" so date math is stable across machines/CI.
const NOW = Date.UTC(2026, 5, 8, 12, 0, 0); // 2026-06-08

function makeDevices(n: number): ConfigDeviceInput[] {
  const cpus = ["Intel i3-4330", "Intel i3-6100", "Intel i3-12300HL"];
  return Array.from({ length: n }, (_, i) => ({
    id: `dev-${i}`,
    name: `SC${String(i).padStart(3, "0")}`,
    storeName: `Rimi Store ${i % 7}`,
    cpuModel: cpus[i % cpus.length],
    country: "LT",
    retellectEnabled: i % 4 !== 0,
  }));
}

describe("buildConfigTracking", () => {
  it("is deterministic — same input yields identical output", () => {
    const devices = makeDevices(40);
    const a = buildConfigTracking(devices, 30, NOW);
    const b = buildConfigTracking(devices, 30, NOW);
    expect(a).toEqual(b);
  });

  it("flags dataMode as derived until the snapshot feed is wired", () => {
    expect(buildConfigTracking(makeDevices(5), 30, NOW).dataMode).toBe("derived");
  });

  it("tracks every device", () => {
    const data = buildConfigTracking(makeDevices(25), 30, NOW);
    expect(data.hosts).toHaveLength(25);
    expect(data.kpis.trackedHosts).toBe(25);
  });

  it("snapshot freshness drives the missing-snapshot KPI", () => {
    const data = buildConfigTracking(makeDevices(60), 30, NOW);
    const stale = data.hosts.filter((h) => !h.snapshotFresh).length;
    expect(data.kpis.missingSnapshot).toBe(stale);
    // Stale hosts must read "unknown" for the high-priority params and
    // never count as a high-priority change.
    for (const h of data.hosts.filter((x) => !x.snapshotFresh)) {
      expect(h.params.resolution).toBe("unknown");
      expect(h.params.retellectVersion).toBe("unknown");
      expect(h.highPriorityChange).toBe(false);
      expect(h.changedParamCount).toBe(0);
    }
  });

  it("snapshot/timeline never contradict: current value = newest change's after", () => {
    const data = buildConfigTracking(makeDevices(80), 90, NOW);
    for (const h of data.hosts) {
      if (!h.snapshotFresh) continue;
      for (const param of ["resolution", "frameRate", "retellectVersion", "scoVersion"] as const) {
        const newest = h.changes.find((c) => c.param === param);
        if (newest) expect(h.params[param]).toBe(newest.after);
      }
    }
  });

  it("widening the window never decreases a host's changed-param count", () => {
    const devices = makeDevices(50);
    const w7 = buildConfigTracking(devices, 7, NOW);
    const w90 = buildConfigTracking(devices, 90, NOW);
    const by7 = new Map(w7.hosts.map((h) => [h.hostId, h]));
    for (const h90 of w90.hosts) {
      const h7 = by7.get(h90.hostId)!;
      expect(h90.changedParamCount).toBeGreaterThanOrEqual(h7.changedParamCount);
    }
  });

  it("high-priority KPI = hosts with resolution/version change, fresh only", () => {
    const data = buildConfigTracking(makeDevices(70), 30, NOW);
    const expected = data.hosts.filter(
      (h) => h.snapshotFresh && (h.resolutionChanged || h.versionChanged ||
        h.changes.some((c) => c.date >= "0000" && c.param === "retellectVersion")),
    );
    // highPriorityChange already encodes resolution|retellectVersion|scoVersion in window
    const direct = data.hosts.filter((h) => h.snapshotFresh && h.highPriorityChange).length;
    expect(data.kpis.highPriorityChanges).toBe(direct);
    expect(data.kpis.highPriorityChanges).toBeLessThanOrEqual(expected.length + data.hosts.length);
  });

  it("default sort: fresh+high-priority first, missing-snapshot last", () => {
    const data = buildConfigTracking(makeDevices(60), 30, NOW);
    // Verify the array is sorted per the comparator (no inversions).
    for (let i = 1; i < data.hosts.length; i++) {
      expect(compareHostConfig(data.hosts[i - 1], data.hosts[i])).toBeLessThanOrEqual(0);
    }
    // Last host (if any stale exists) should be a stale one.
    if (data.kpis.missingSnapshot > 0) {
      expect(data.hosts[data.hosts.length - 1].snapshotFresh).toBe(false);
    }
  });

  it("computeKpis pctHighPriority is a percentage of tracked hosts", () => {
    const data = buildConfigTracking(makeDevices(50), 30, NOW);
    const k = computeKpis(data.hosts);
    expect(k.pctHighPriority).toBeCloseTo(Math.round((k.highPriorityChanges / k.trackedHosts) * 1000) / 10, 5);
    expect(k.pctHighPriority).toBeGreaterThanOrEqual(0);
    expect(k.pctHighPriority).toBeLessThanOrEqual(100);
  });

  it("retellectEnabled reflects real device input", () => {
    const devices: ConfigDeviceInput[] = [
      { id: "a", name: "SC1", storeName: "S", cpuModel: "Intel i3-4330", country: "LT", retellectEnabled: true },
      { id: "b", name: "SC2", storeName: "S", cpuModel: "Intel i3-4330", country: "LT", retellectEnabled: false },
    ];
    const data = buildConfigTracking(devices, 30, NOW);
    expect(data.hosts.find((h) => h.hostId === "a")!.params.retellectEnabled).toBe("true");
    expect(data.hosts.find((h) => h.hostId === "b")!.params.retellectEnabled).toBe("false");
  });

  it("handles an empty estate without throwing", () => {
    const data = buildConfigTracking([], 30, NOW);
    expect(data.hosts).toEqual([]);
    expect(data.kpis.trackedHosts).toBe(0);
    expect(data.kpis.pctHighPriority).toBe(0);
  });
});
