import { describe, it, expect } from "vitest";
import { buildConfigTracking, computeKpis, compareHostConfig, type ConfigDeviceInput } from "./build";
import type { RawHostConfig } from "@/lib/zabbix/config";

const NOW = Date.UTC(2026, 5, 8, 12, 0, 0); // 2026-06-08
const DAY = 86400;
const nowSec = Math.floor(NOW / 1000);

function ini(width: number, height: number, model = "20251122_30") {
  return (
    `2026 INFO config.ini: {'server': {'store': 's', 'name': 'sco_1'}, ` +
    `'model': {'version': '${model}', 'inference_backend': 'onnx', 'onnx_providers': 'CPUExecutionProvider', 'enable_prediction': 'True', 'number_of_results': '3'}, ` +
    `'video1': {'usb_camera_index': '0', 'capture_width': '${width}', 'capture_height': '${height}'}}`
  );
}

function dev(id: string, name: string, over: Partial<ConfigDeviceInput> = {}): ConfigDeviceInput {
  return { id, name, sourceHostKey: name, storeName: "Rimi X", cpuModel: "Intel i3-4330", country: "LT", retellectEnabled: true, ...over };
}

describe("buildConfigTracking", () => {
  it("parses current values from the latest config.ini + version items", () => {
    const raw = new Map<string, RawHostConfig>([
      ["H1", {
        hostId: "z1", hostName: "H1",
        configIni: { value: ini(960, 540), clock: nowSec - 3600 },
        configIniHistory: [{ value: ini(960, 540), clock: nowSec - 3600 }],
        rtVersion: { value: "1.68", clock: nowSec - 3600 }, rtVersionHistory: [{ value: "1.68", clock: nowSec - 3600 }],
        scoVersion: { value: "26.05.00", clock: nowSec - 3600 }, scoVersionHistory: [{ value: "26.05.00", clock: nowSec - 3600 }],
      }],
    ]);
    const data = buildConfigTracking([dev("d1", "H1")], raw, 30, "live", NOW);
    const h = data.hosts[0];
    expect(h.params.resolution).toBe("960×540");
    expect(h.params.retellectVersion).toBe("1.68");
    expect(h.params.scoVersion).toBe("26.05.00");
    expect(h.params.modelVersion).toBe("20251122_30");
    expect(h.snapshotFresh).toBe(true);
    expect(data.dataMode).toBe("live");
  });

  it("detects a resolution change from config.ini history", () => {
    const raw = new Map<string, RawHostConfig>([
      ["H1", {
        hostId: "z1", hostName: "H1",
        configIni: { value: ini(960, 540), clock: nowSec - 2 * DAY },
        configIniHistory: [
          { value: ini(1280, 720), clock: nowSec - 20 * DAY },
          { value: ini(1280, 720), clock: nowSec - 15 * DAY }, // re-log, no change
          { value: ini(960, 540), clock: nowSec - 5 * DAY },   // CHANGE here
        ],
        rtVersion: null, rtVersionHistory: [],
        scoVersion: null, scoVersionHistory: [],
      }],
    ]);
    const h = buildConfigTracking([dev("d1", "H1")], raw, 30, "live", NOW).hosts[0];
    const resChanges = h.changes.filter((c) => c.param === "resolution");
    expect(resChanges).toHaveLength(1);
    expect(resChanges[0].before).toBe("1280×720");
    expect(resChanges[0].after).toBe("960×540");
    expect(h.resolutionChanged).toBe(true);
    expect(h.highPriorityChange).toBe(true);
    expect(h.changedParamCount).toBe(1);
  });

  it("detects version changes and respects the window", () => {
    const raw = new Map<string, RawHostConfig>([
      ["H1", {
        hostId: "z1", hostName: "H1",
        configIni: { value: ini(960, 540), clock: nowSec - DAY }, configIniHistory: [{ value: ini(960, 540), clock: nowSec - DAY }],
        rtVersion: { value: "1.68", clock: nowSec - DAY },
        rtVersionHistory: [
          { value: "1.67", clock: nowSec - 60 * DAY },
          { value: "1.68", clock: nowSec - 50 * DAY }, // change 50 days ago
        ],
        scoVersion: null, scoVersionHistory: [],
      }],
    ]);
    const dev1 = dev("d1", "H1");
    const w30 = buildConfigTracking([dev1], raw, 30, "live", NOW).hosts[0];
    const w90 = buildConfigTracking([dev1], raw, 90, "live", NOW).hosts[0];
    // The change is 50 days old: in history regardless, but only counts for 90d window.
    expect(w90.changes.some((c) => c.param === "retellectVersion")).toBe(true);
    expect(w90.versionChanged).toBe(true);
    expect(w30.versionChanged).toBe(false);
    expect(w30.changedParamCount).toBe(0);
  });

  it("marks hosts with no config item as missing snapshot", () => {
    const data = buildConfigTracking([dev("d1", "H1")], new Map(), 30, "live", NOW);
    const h = data.hosts[0];
    expect(h.snapshotFresh).toBe(false);
    expect(h.params.resolution).toBe("unknown");
    expect(h.params.retellectVersion).toBe("unknown");
    expect(data.kpis.missingSnapshot).toBe(1);
    expect(data.hostsWithSnapshot).toBe(0);
  });

  it("treats a config.ini older than the stale threshold as missing", () => {
    const raw = new Map<string, RawHostConfig>([
      ["H1", {
        hostId: "z1", hostName: "H1",
        configIni: { value: ini(960, 540), clock: nowSec - 20 * DAY }, // 20d old > 7d stale
        configIniHistory: [{ value: ini(960, 540), clock: nowSec - 20 * DAY }],
        rtVersion: null, rtVersionHistory: [], scoVersion: null, scoVersionHistory: [],
      }],
    ]);
    const h = buildConfigTracking([dev("d1", "H1")], raw, 30, "live", NOW).hosts[0];
    expect(h.snapshotFresh).toBe(false);
    expect(h.snapshotAgeDays).toBeGreaterThanOrEqual(19);
  });

  it("KPIs and sort: fresh+high-priority first, missing last", () => {
    const fresh = ini(960, 540);
    const raw = new Map<string, RawHostConfig>([
      ["A", { hostId: "a", hostName: "A", configIni: { value: fresh, clock: nowSec - DAY }, configIniHistory: [
        { value: ini(1280, 720), clock: nowSec - 4 * DAY }, { value: fresh, clock: nowSec - DAY }], rtVersion: null, rtVersionHistory: [], scoVersion: null, scoVersionHistory: [] }],
      ["B", { hostId: "b", hostName: "B", configIni: { value: fresh, clock: nowSec - DAY }, configIniHistory: [{ value: fresh, clock: nowSec - DAY }], rtVersion: null, rtVersionHistory: [], scoVersion: null, scoVersionHistory: [] }],
    ]);
    const devices = [dev("a", "A"), dev("b", "B"), dev("c", "C")]; // C has no config
    const data = buildConfigTracking(devices, raw, 30, "live", NOW);
    expect(data.kpis.trackedHosts).toBe(3);
    expect(data.kpis.missingSnapshot).toBe(1);
    expect(data.kpis.highPriorityChanges).toBe(1); // only A changed resolution
    // Sorted with no inversions; missing-snapshot host (C) last.
    for (let i = 1; i < data.hosts.length; i++) {
      expect(compareHostConfig(data.hosts[i - 1], data.hosts[i])).toBeLessThanOrEqual(0);
    }
    expect(data.hosts[data.hosts.length - 1].snapshotFresh).toBe(false);
  });

  it("computeKpis pct is bounded 0..100", () => {
    const k = computeKpis([]);
    expect(k.trackedHosts).toBe(0);
    expect(k.pctHighPriority).toBe(0);
  });
});
