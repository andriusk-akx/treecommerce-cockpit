/**
 * Unit tests for cpu_num resolution.
 *
 * Covers the two pure helpers (parseZabbixCores, inferCoresFromCpuModel)
 * with comprehensive cases, plus resolveCoresForHost against an in-memory
 * mock of the Prisma client.
 *
 * Spec: AKpilot-CPU-Normalization-Spec.md §4.1, §6.2
 */
import { describe, it, expect } from "vitest";
import {
  parseZabbixCores,
  inferCoresFromCpuModel,
  resolveCoresForHost,
} from "./cores";

// ─── parseZabbixCores ───────────────────────────────────────────────

describe("parseZabbixCores", () => {
  it("accepts a healthy integer lastvalue", () => {
    expect(parseZabbixCores({ lastvalue: "4" })).toBe(4);
    expect(parseZabbixCores({ lastvalue: "8" })).toBe(8);
    expect(parseZabbixCores({ lastvalue: "1" })).toBe(1);
  });

  it("ignores ZBX_NOTSUPPORTED items (state='1')", () => {
    // Even with a non-zero lastvalue, a state=1 item's value is stale and
    // must not drive normalisation. memory: project_zabbix_agent_broken_pattern.
    expect(parseZabbixCores({ lastvalue: "4", state: "1" })).toBeNull();
    expect(parseZabbixCores({ lastvalue: "8", state: 1 })).toBeNull();
  });

  it("accepts state=0 (supported) explicitly", () => {
    expect(parseZabbixCores({ lastvalue: "4", state: "0" })).toBe(4);
    expect(parseZabbixCores({ lastvalue: "4", state: 0 })).toBe(4);
  });

  it("returns null for missing item entirely", () => {
    expect(parseZabbixCores(undefined)).toBeNull();
  });

  it("returns null for empty / null / undefined lastvalue", () => {
    expect(parseZabbixCores({ lastvalue: "" })).toBeNull();
    expect(parseZabbixCores({ lastvalue: null })).toBeNull();
    expect(parseZabbixCores({})).toBeNull();
  });

  it("returns null for zero or negative core counts", () => {
    // cores=0 is a known bug shape from broken templates. cores<0 should
    // never appear but we guard for completeness.
    expect(parseZabbixCores({ lastvalue: "0" })).toBeNull();
    expect(parseZabbixCores({ lastvalue: "-2" })).toBeNull();
  });

  it("returns null for non-numeric lastvalue", () => {
    expect(parseZabbixCores({ lastvalue: "abc" })).toBeNull();
    expect(parseZabbixCores({ lastvalue: "NaN" })).toBeNull();
  });

  it("rejects absurdly large values (>1024) — likely misconfigured item", () => {
    // Some Zabbix templates accidentally point system.cpu.num at a memory
    // metric, producing nonsense like 8589934592. Reject defensively.
    expect(parseZabbixCores({ lastvalue: "2048" })).toBeNull();
    expect(parseZabbixCores({ lastvalue: "8589934592" })).toBeNull();
  });
});

// ─── inferCoresFromCpuModel ─────────────────────────────────────────

describe("inferCoresFromCpuModel", () => {
  it("recognises Intel Core i3 SCO models", () => {
    expect(inferCoresFromCpuModel("Intel(R) Core(TM) i3-6100 CPU @ 3.70GHz")).toBe(4);
    expect(inferCoresFromCpuModel("Intel(R) Core(TM) i3-9100 CPU @ 3.60GHz")).toBe(4);
    expect(inferCoresFromCpuModel("Intel Core i3-10100")).toBe(8);
  });

  it("recognises Intel Pentium variants", () => {
    expect(inferCoresFromCpuModel("Intel(R) Pentium(R) CPU G4400 @ 3.30GHz")).toBe(2);
    expect(inferCoresFromCpuModel("Intel(R) Pentium(R) CPU G4560 @ 3.50GHz")).toBe(4);
  });

  it("recognises Celeron embedded models", () => {
    expect(inferCoresFromCpuModel("Intel(R) Celeron(R) CPU J3455 @ 1.50GHz")).toBe(4);
    expect(inferCoresFromCpuModel("Celeron J4125")).toBe(4);
  });

  it("is case-insensitive and whitespace-tolerant", () => {
    expect(inferCoresFromCpuModel("INTEL CORE I3-6100")).toBe(4);
    expect(inferCoresFromCpuModel("intel    core    i3-6100")).toBe(4);
  });

  it("returns null for unknown models", () => {
    expect(inferCoresFromCpuModel("AMD Ryzen 7 5800X")).toBeNull();
    expect(inferCoresFromCpuModel("Some Weird CPU 9000")).toBeNull();
  });

  it("returns null for null / empty input", () => {
    expect(inferCoresFromCpuModel(null)).toBeNull();
    expect(inferCoresFromCpuModel("")).toBeNull();
  });
});

// ─── resolveCoresForHost ────────────────────────────────────────────
//
// We mock just the Prisma surface the helper touches (device.findUnique,
// device.findFirst, device.update). Each test builds the device state it
// needs and verifies the resolution priority order specified in §4.1.

type MockDevice = {
  id: string;
  cpuCores: number | null;
  cpuCoresSource: string | null;
  cpuCoresProbedAt: Date | null;
  cpuModel: string | null;
  sourceHostKey: string | null;
};

function makePrisma(devices: MockDevice[]) {
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  // Cast to never via unknown because the real PrismaClient is enormous
  // and we only stub the slice we use. resolveCoresForHost only ever
  // touches device.findUnique / findFirst / update.
  const stub = {
    device: {
      findUnique: async ({ where: { id } }: { where: { id: string }; select: unknown }) =>
        devices.find((d) => d.id === id) ?? null,
      findFirst: async ({ where: { sourceHostKey } }: { where: { sourceHostKey: string }; select: unknown }) =>
        devices.find((d) => d.sourceHostKey === sourceHostKey) ?? null,
      update: async ({ where: { id }, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push({ id, data });
        const d = devices.find((dev) => dev.id === id);
        if (d) Object.assign(d, data);
        return d;
      },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { prisma: stub as unknown as any, updates };
}

describe("resolveCoresForHost", () => {
  it("priority 1: live Zabbix lastvalue wins over a zabbix-sourced cache", async () => {
    // Cache was originally populated by a prior Zabbix probe (source='zabbix')
    // and is now stale (probedAt epoch) with a different value. A fresh probe
    // should overwrite. Manual overrides are tested separately below — those
    // are NOT overwritten by Zabbix regardless of staleness.
    const { prisma, updates } = makePrisma([
      {
        id: "d1", sourceHostKey: "hostA",
        cpuCores: 8, cpuCoresSource: "zabbix", cpuCoresProbedAt: new Date(0),
        cpuModel: "Intel i3-6100",
      },
    ]);
    const r = await resolveCoresForHost({
      hostId: "hostA",
      zabbixItem: { lastvalue: "4", state: "0" },
      prisma,
    });
    expect(r.value).toBe(4);
    expect(r.source).toBe("zabbix");
    expect(r.coresKnown).toBe(true);
    // Old probe was epoch (very stale) and value differs → must update.
    expect(updates).toHaveLength(1);
    expect(updates[0].data.cpuCores).toBe(4);
    expect(updates[0].data.cpuCoresSource).toBe("zabbix");
  });

  it("priority 0: manual override beats live Zabbix even when they disagree", async () => {
    // The whole point of cpuCoresSource='manual' is that an operator decided
    // Zabbix is wrong about this host. Without sticky manual, the next Zabbix
    // read would silently overwrite the override (and stamp source='zabbix')
    // every minute — exactly the bug the StrongPoint Testlab SCO hit, where
    // the testlab system.cpu.num returns 1 but the box is actually 4-core.
    const { prisma, updates } = makePrisma([
      {
        id: "d1", sourceHostKey: "hostA",
        cpuCores: 4, cpuCoresSource: "manual", cpuCoresProbedAt: null,
        cpuModel: null,
      },
    ]);
    const r = await resolveCoresForHost({
      hostId: "hostA",
      zabbixItem: { lastvalue: "1", state: "0" }, // Zabbix says 1 — wrong
      prisma,
    });
    expect(r.value).toBe(4);
    expect(r.source).toBe("manual");
    expect(r.coresKnown).toBe(true);
    expect(updates).toHaveLength(0); // never overwrite manual
  });

  it("priority 2: falls back to cached Device.cpuCores when Zabbix unsupported", async () => {
    const { prisma, updates } = makePrisma([
      {
        id: "d1", sourceHostKey: "hostA",
        cpuCores: 4, cpuCoresSource: "zabbix", cpuCoresProbedAt: new Date(),
        cpuModel: null,
      },
    ]);
    const r = await resolveCoresForHost({
      hostId: "hostA",
      zabbixItem: { lastvalue: "4", state: "1" },  // ZBX_NOTSUPPORTED
      prisma,
    });
    expect(r.value).toBe(4);
    expect(r.source).toBe("zabbix");  // source preserved from cached row
    expect(r.coresKnown).toBe(true);
    expect(updates).toHaveLength(0);  // no write — Zabbix didn't provide a fresh reading
  });

  it("priority 3: infers from cpuModel when neither Zabbix nor cache available", async () => {
    const { prisma, updates } = makePrisma([
      {
        id: "d1", sourceHostKey: "hostA",
        cpuCores: null, cpuCoresSource: null, cpuCoresProbedAt: null,
        cpuModel: "Intel(R) Core(TM) i3-6100 CPU @ 3.70GHz",
      },
    ]);
    const r = await resolveCoresForHost({
      hostId: "hostA",
      zabbixItem: undefined,  // host doesn't publish system.cpu.num at all
      prisma,
    });
    expect(r.value).toBe(4);
    expect(r.source).toBe("inferred_from_model");
    expect(r.coresKnown).toBe(true);
    // Inference is NOT cached back to the DB by the hot-path helper —
    // backfill script handles persistent inference writes.
    expect(updates).toHaveLength(0);
  });

  it("priority 4: returns coresKnown=false when no source can answer", async () => {
    const { prisma } = makePrisma([
      {
        id: "d1", sourceHostKey: "hostA",
        cpuCores: null, cpuCoresSource: null, cpuCoresProbedAt: null,
        cpuModel: "Some Unknown CPU XYZ",
      },
    ]);
    const r = await resolveCoresForHost({
      hostId: "hostA",
      zabbixItem: undefined,
      prisma,
    });
    expect(r.value).toBe(1);          // safe placeholder
    expect(r.source).toBeNull();
    expect(r.coresKnown).toBe(false); // caller must NOT use value for normalisation
  });

  it("returns coresKnown=false when no Device matches the hostId either", async () => {
    const { prisma } = makePrisma([]);  // empty DB
    const r = await resolveCoresForHost({
      hostId: "stranger",
      zabbixItem: undefined,
      prisma,
    });
    expect(r.coresKnown).toBe(false);
  });

  it("manual override is preserved even when Zabbix matches", async () => {
    // Operator set cpuCores=4 manually. Zabbix also returns 4. We must NOT
    // upgrade the source from 'manual' → 'zabbix' on a matching read: that
    // would silently demote the override and leave the host vulnerable to
    // a future Zabbix glitch overwriting the value.
    const now = new Date();
    const { prisma, updates } = makePrisma([
      {
        id: "d1", sourceHostKey: "hostA",
        cpuCores: 4, cpuCoresSource: "manual", cpuCoresProbedAt: now,
        cpuModel: null,
      },
    ]);
    const r = await resolveCoresForHost({
      hostId: "hostA",
      zabbixItem: { lastvalue: "4", state: "0" },
      prisma,
    });
    expect(r.value).toBe(4);
    expect(r.source).toBe("manual");
    expect(updates).toHaveLength(0);
  });
});
