import { describe, it, expect } from "vitest";
import {
  classifyDataHealth,
  groupByStore,
  summarize,
  diagnosisFor,
  type DataHealthHostRow,
  type DataHealthBucket,
} from "./rt-data-health-helpers";

/**
 * Builds a row with sensible defaults so tests can assert one field at a time
 * without re-stating the whole shape every call.
 */
function row(partial: Partial<DataHealthHostRow>): DataHealthHostRow {
  return {
    deviceId: partial.deviceId ?? `dev-${Math.random().toString(36).slice(2, 8)}`,
    hostName: partial.hostName ?? "LT_T000_SCOW_01",
    storeName: partial.storeName ?? "Rimi T000",
    zabbixHostName: partial.zabbixHostName ?? "LT_T000_SCOW_01",
    zabbixMatched: partial.zabbixMatched ?? true,
    retellectEnabled: partial.retellectEnabled ?? false,
    rtStatus: partial.rtStatus ?? "unknown",
    supported: partial.supported ?? 24,
    unsupported: partial.unsupported ?? 0,
    totalEnabled: partial.totalEnabled ?? 24,
    bucket: partial.bucket ?? "healthy",
    lastUpdate: partial.lastUpdate ?? null,
  };
}

describe("classifyDataHealth", () => {
  it("returns 'unmatched' when device is not matched to a Zabbix host", () => {
    expect(classifyDataHealth(false, null)).toBe("unmatched");
    // Even if some entry is somehow present, unmatched takes precedence.
    expect(
      classifyDataHealth(false, { supported: 0, unsupported: 0, totalEnabled: 0 }),
    ).toBe("unmatched");
  });

  it("returns 'no-data' when matched but no agent-health entry", () => {
    expect(classifyDataHealth(true, null)).toBe("no-data");
    expect(classifyDataHealth(true, undefined)).toBe("no-data");
  });

  it("delegates to classifyAgentHealth thresholds when entry is present", () => {
    // 22 of 24 unsupported = canonical broken (Dangeručio SCO2).
    expect(
      classifyDataHealth(true, {
        supported: 2,
        unsupported: 22,
        totalEnabled: 24,
      }),
    ).toBe("broken");
    // 8 of 24 = 33 % unsupported → partial.
    expect(
      classifyDataHealth(true, {
        supported: 16,
        unsupported: 8,
        totalEnabled: 24,
      }),
    ).toBe("partial");
    // All supported → healthy.
    expect(
      classifyDataHealth(true, {
        supported: 24,
        unsupported: 0,
        totalEnabled: 24,
      }),
    ).toBe("healthy");
    // 0 enabled → no-data via classifyAgentHealth.
    expect(
      classifyDataHealth(true, {
        supported: 0,
        unsupported: 0,
        totalEnabled: 0,
      }),
    ).toBe("no-data");
  });
});

describe("groupByStore", () => {
  it("returns empty array for empty input", () => {
    expect(groupByStore([])).toEqual([]);
  });

  it("groups all-healthy single store with isMixed=false", () => {
    const groups = groupByStore([
      row({ hostName: "LT_T000_SCOW_01", storeName: "Rimi T000", bucket: "healthy" }),
      row({ hostName: "LT_T000_SCOW_02", storeName: "Rimi T000", bucket: "healthy" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].storeName).toBe("Rimi T000");
    expect(groups[0].hosts).toHaveLength(2);
    expect(groups[0].hasHealthy).toBe(true);
    expect(groups[0].hasIssue).toBe(false);
    expect(groups[0].isMixed).toBe(false);
  });

  it("flags a mixed store (one healthy + one broken sibling) as host-level", () => {
    // T822 motivating example: SCO1 healthy, SCO2 broken, same store.
    const groups = groupByStore([
      row({
        hostName: "LT_T822_SCOW_31",
        storeName: "Rimi T822",
        bucket: "healthy",
      }),
      row({
        hostName: "LT_T822_SCOW_32",
        storeName: "Rimi T822",
        bucket: "broken",
        unsupported: 22,
        supported: 2,
        totalEnabled: 24,
      }),
    ]);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.hasHealthy).toBe(true);
    expect(g.hasIssue).toBe(true);
    expect(g.isMixed).toBe(true);
    // Numeric sort: SCOW_31 before SCOW_32.
    expect(g.hosts[0].hostName).toBe("LT_T822_SCOW_31");
    expect(g.hosts[1].hostName).toBe("LT_T822_SCOW_32");
  });

  it("does not mark all-broken store as 'mixed' (no healthy sibling)", () => {
    const groups = groupByStore([
      row({ hostName: "h1", storeName: "Store A", bucket: "broken" }),
      row({ hostName: "h2", storeName: "Store A", bucket: "broken" }),
    ]);
    expect(groups[0].hasHealthy).toBe(false);
    expect(groups[0].hasIssue).toBe(true);
    expect(groups[0].isMixed).toBe(false);
  });

  it("treats partial-only stores as having an issue but not 'mixed'", () => {
    const groups = groupByStore([
      row({ hostName: "h1", storeName: "Store A", bucket: "partial" }),
    ]);
    expect(groups[0].hasIssue).toBe(true);
    expect(groups[0].hasHealthy).toBe(false);
    expect(groups[0].isMixed).toBe(false);
  });

  it("flags healthy + partial as mixed (any issue counts)", () => {
    const groups = groupByStore([
      row({ hostName: "h1", storeName: "Store A", bucket: "healthy" }),
      row({ hostName: "h2", storeName: "Store A", bucket: "partial" }),
    ]);
    expect(groups[0].isMixed).toBe(true);
  });

  it("handles single-host store edge case", () => {
    const groups = groupByStore([
      row({ hostName: "only-host", storeName: "Lonely Store", bucket: "healthy" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].hosts).toHaveLength(1);
    expect(groups[0].isMixed).toBe(false);
    expect(groups[0].hasHealthy).toBe(true);
    expect(groups[0].hasIssue).toBe(false);
  });

  it("preserves first-seen store order across multiple stores", () => {
    const groups = groupByStore([
      row({ hostName: "a", storeName: "Beta", bucket: "healthy" }),
      row({ hostName: "b", storeName: "Alpha", bucket: "healthy" }),
      row({ hostName: "c", storeName: "Beta", bucket: "broken" }),
    ]);
    expect(groups.map((g) => g.storeName)).toEqual(["Beta", "Alpha"]);
    expect(groups[0].isMixed).toBe(true);
    expect(groups[1].isMixed).toBe(false);
  });

  it("sorts hosts within a store numerically (SCO2 before SCO10)", () => {
    const groups = groupByStore([
      row({ hostName: "LT_T1_SCOW_10", storeName: "S", bucket: "healthy" }),
      row({ hostName: "LT_T1_SCOW_2", storeName: "S", bucket: "healthy" }),
    ]);
    expect(groups[0].hosts.map((h) => h.hostName)).toEqual([
      "LT_T1_SCOW_2",
      "LT_T1_SCOW_10",
    ]);
  });

  it("treats unmatched and no-data as non-issue, non-healthy (won't trigger 'mixed')", () => {
    // A store with one healthy + one unmatched host should NOT be flagged as
    // mixed — unmatched is a different problem (DB-Zabbix mapping), not a
    // host-level agent issue. Same for no-data (template gap).
    const groups = groupByStore([
      row({ hostName: "h1", storeName: "S", bucket: "healthy" }),
      row({ hostName: "h2", storeName: "S", bucket: "unmatched" }),
      row({ hostName: "h3", storeName: "S", bucket: "no-data" }),
    ]);
    expect(groups[0].hasHealthy).toBe(true);
    expect(groups[0].hasIssue).toBe(false);
    expect(groups[0].isMixed).toBe(false);
  });
});

describe("summarize", () => {
  it("returns zero counts for empty input", () => {
    expect(summarize([])).toEqual({
      healthy: 0,
      partial: 0,
      broken: 0,
      unenrolled: 0,
      total: 0,
    });
  });

  it("rolls unmatched and no-data into 'unenrolled'", () => {
    const out = summarize([
      row({ bucket: "healthy" }),
      row({ bucket: "healthy" }),
      row({ bucket: "partial" }),
      row({ bucket: "broken" }),
      row({ bucket: "broken" }),
      row({ bucket: "broken" }),
      row({ bucket: "unmatched" }),
      row({ bucket: "no-data" }),
    ]);
    expect(out).toEqual({
      healthy: 2,
      partial: 1,
      broken: 3,
      unenrolled: 2,
      total: 8,
    });
  });
});

describe("diagnosisFor", () => {
  it("mentions ZBX_NOTSUPPORTED and lodctr in the broken copy", () => {
    const text = diagnosisFor("broken");
    expect(text).toMatch(/ZBX_NOTSUPPORTED/);
    expect(text).toMatch(/lodctr/);
    expect(text).toMatch(/host-level/i);
  });

  it("returns short partial copy", () => {
    expect(diagnosisFor("partial")).toMatch(/subset of items unsupported/i);
  });

  it("returns unmatched copy for unmatched", () => {
    expect(diagnosisFor("unmatched")).toMatch(/not registered in Zabbix/i);
  });

  it("returns short healthy copy", () => {
    expect(diagnosisFor("healthy")).toMatch(/normally/i);
  });

  it("returns no-data copy", () => {
    expect(diagnosisFor("no-data")).toMatch(/template/i);
  });

  it("covers every bucket without falling through", () => {
    const buckets: DataHealthBucket[] = [
      "healthy",
      "partial",
      "broken",
      "no-data",
      "unmatched",
    ];
    for (const b of buckets) {
      expect(diagnosisFor(b)).toBeTruthy();
    }
  });
});
