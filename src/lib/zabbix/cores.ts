/**
 * Per-host CPU core resolution for Retellect drill-down normalisation.
 *
 * Why this exists
 * ───────────────
 * Windows Zabbix agents publish two flavours of CPU metric:
 *
 *   1. `perf_counter[\Process(X)\% Processor Time]` — "% of one core",
 *      ranges 0–100 × cpu_num. A 4-core host with one process pinning a
 *      single core reports 100; pinning all four reports 400.
 *
 *   2. `system.cpu.util[,,avg1]` and `*.cpu` — "% of host", ranges 0–100
 *      regardless of cpu_num. These are already normalised.
 *
 * To stack the two on one chart we must divide perf_counter values by the
 * host's core count. Before this module, the route inlined:
 *
 *     const cores = Math.max(1, parseInt(numCpuItem?.lastvalue || "1") || 1);
 *
 * which silently fell back to `1` whenever `system.cpu.num` was missing or
 * ZBX_NOTSUPPORTED (a common state on Rimi SCO hosts — see memory
 * `project_zabbix_agent_broken_pattern`). With cores=1 the /cores division
 * is a no-op and per-counter values render as if they were host-scope —
 * producing the >100 % stacks the operator sees in the drill-down.
 *
 * Resolution priority (per spec §4.1 + Andrius decision 2026-05-20):
 *
 *   1. Live Zabbix `system.cpu.num.lastvalue`, if ≥1 and item is supported.
 *      Source: "zabbix". Side effect: cache into Device.cpuCores.
 *   2. Cached `Device.cpuCores`, if non-null. Source: whatever
 *      `Device.cpuCoresSource` says (could be "zabbix" from a previous
 *      backfill, "manual" set in Settings, or "inferred_from_model").
 *   3. Inference from `Device.cpuModel` via a small known-models table.
 *      Source: "inferred_from_model". NOT cached back to the DB by this
 *      hot-path function — the backfill script handles persistent
 *      inference so we don't write to Device on every drill-down.
 *   4. None of the above → coresKnown=false. The route must then skip
 *      perf_counter items and mark the response with
 *      `dataQuality.coresKnown = false`.
 *
 * Cache TTL
 * ─────────
 * When step 1 succeeds, we write through to Device.cpuCores with a
 * `cpuCoresProbedAt = now()` stamp. The probe only re-fires if
 * `cpuCoresProbedAt` is older than CORES_TTL_MS or null — keeps writes
 * cheap (one UPDATE per host per day) but still picks up hardware
 * replacements within a day. This is intentionally not a real-time read:
 * the route's hot path tolerates ~24 h staleness on the cores value
 * because hardware changes are rare and the consequence of a 24 h-old
 * reading is at worst a single day of slightly off normalisation.
 */
import type { PrismaClient } from "@/generated/prisma/client";

/** How long Device.cpuCores stays trusted before we re-probe Zabbix. */
const CORES_TTL_MS = 24 * 60 * 60 * 1000;

export type CoresSource =
  | "zabbix"
  | "manual"
  | "inferred_from_model"
  | null;

export interface ResolvedCores {
  /** Effective core count to use for /cores normalisation. 1 when unknown
   *  (caller MUST check `coresKnown` before using this for perf_counter
   *  items — a unknown-cores host should not normalise at all). */
  value: number;
  /** Where the value came from. `null` when unknown. */
  source: CoresSource;
  /** False when we couldn't establish a cores count by any path. Routes
   *  use this to skip perf_counter normalisation and surface a warning. */
  coresKnown: boolean;
  /** True when this call performed an UPDATE on Device.cpuCores. Caller
   *  can ignore — exposed for tests and diagnostics. */
  cacheWritten: boolean;
}

/**
 * Shape of the Zabbix item entry we accept. Kept structural (not the
 * full Zabbix item shape) so tests can pass plain literals. `lastvalue`
 * is the string Zabbix sends; `state === "1"` means ZBX_NOTSUPPORTED
 * and we MUST ignore lastvalue in that case (it'll be stale or zero).
 */
export interface ZabbixCoresItem {
  lastvalue?: string | null;
  state?: string | number | null;
}

interface ResolveOpts {
  /** Zabbix host id (the same id Device.sourceHostKey-matched record
   *  is keyed on — we look up Device by sourceHostKey OR id depending
   *  on what the caller has handy). Pass the actual Zabbix hostId so
   *  errors can be diagnosed against Zabbix's UI. */
  hostId: string;
  /** The system.cpu.num item from `item.get`, if any. Pass `undefined`
   *  when the host doesn't publish it at all (a different failure mode
   *  from "publishes but ZBX_NOTSUPPORTED"). */
  zabbixItem: ZabbixCoresItem | undefined;
  /** Prisma client for cache read/write. Tests can pass a mock. */
  prisma: PrismaClient;
  /** Optional override for the cache TTL — tests use a small value. */
  ttlMs?: number;
  /** Optional explicit Device id when the caller already has it (saves
   *  a sourceHostKey lookup). When omitted we look up by sourceHostKey
   *  matching the Zabbix hostId. */
  deviceId?: string;
}

/**
 * Resolve `cpuCores` for one host. See module docstring for the rules.
 *
 * This function is read-mostly: it only writes to the DB when a fresh
 * Zabbix probe gives us a better value than what's cached. Callers MAY
 * be invoked many times per page (each drill-down host), so we keep the
 * happy path to "one SELECT + 0 UPDATEs" when the cache is warm.
 */
export async function resolveCoresForHost(
  opts: ResolveOpts,
): Promise<ResolvedCores> {
  const ttl = opts.ttlMs ?? CORES_TTL_MS;
  const now = new Date();

  // ── Step 1: try Zabbix (fresh probe). Only trusted when:
  //    • item exists
  //    • state ≠ 1 (not ZBX_NOTSUPPORTED)
  //    • lastvalue parses to integer ≥1
  // The state guard is important: a previously-supported item that has
  // since gone unsupported will retain its last good value in `lastvalue`,
  // which would be misleading if cores actually changed.
  const zabbixCores = parseZabbixCores(opts.zabbixItem);

  // We need the Device row regardless — both to read the cache (step 2)
  // and to write through (after step 1). One SELECT keeps it cheap.
  const device = await loadDevice(opts.prisma, opts.deviceId, opts.hostId);

  if (zabbixCores !== null) {
    // Write through if the cached value is missing, stale, or differs.
    const shouldRefresh =
      !device ||
      device.cpuCores !== zabbixCores ||
      !device.cpuCoresProbedAt ||
      now.getTime() - device.cpuCoresProbedAt.getTime() > ttl;
    let wrote = false;
    if (device && shouldRefresh) {
      await opts.prisma.device.update({
        where: { id: device.id },
        data: {
          cpuCores: zabbixCores,
          cpuCoresSource: "zabbix",
          cpuCoresProbedAt: now,
        },
      });
      wrote = true;
    }
    return {
      value: zabbixCores,
      source: "zabbix",
      coresKnown: true,
      cacheWritten: wrote,
    };
  }

  // ── Step 2: cached value, if any.
  if (device?.cpuCores && device.cpuCores >= 1) {
    return {
      value: device.cpuCores,
      source: (device.cpuCoresSource as CoresSource) ?? null,
      coresKnown: true,
      cacheWritten: false,
    };
  }

  // ── Step 3: infer from CPU model string.
  const inferred = inferCoresFromCpuModel(device?.cpuModel ?? null);
  if (inferred !== null) {
    return {
      value: inferred,
      source: "inferred_from_model",
      coresKnown: true,
      cacheWritten: false,
    };
  }

  // ── Step 4: give up. Value of 1 is a safe placeholder (it's the
  // identity element for /cores division) but coresKnown=false tells
  // the caller NOT to apply normalisation at all.
  return {
    value: 1,
    source: null,
    coresKnown: false,
    cacheWritten: false,
  };
}

/**
 * Parse the `system.cpu.num` item's lastvalue into a positive integer
 * core count, or null when the value isn't trustworthy. Exported for
 * tests.
 *
 *   • state "1" (ZBX_NOTSUPPORTED) → null
 *   • non-numeric, ≤0, or NaN → null
 *   • absurdly large (>1024) → null (defensive — Zabbix occasionally
 *     reports nonsense like memory-bytes when an item is misconfigured)
 */
export function parseZabbixCores(item: ZabbixCoresItem | undefined): number | null {
  if (!item) return null;
  // Coerce state to string for comparison — Zabbix sometimes returns "1"
  // and other deployments return 1. Either way "1" means unsupported.
  if (String(item.state ?? "") === "1") return null;
  const raw = item.lastvalue;
  if (raw == null || raw === "") return null;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1 || n > 1024) return null;
  return n;
}

/**
 * Best-effort cores inference from a CPU model string.
 *
 * The dictionary is intentionally small and SCO-fleet-targeted. New
 * models should be added via the backfill script when they first show
 * up in Zabbix inventory — not by guessing every possible CPU.
 *
 * Matching is substring-based after lowercasing/whitespace-collapsing,
 * because Zabbix `host.inventory.hardware` strings vary wildly:
 *
 *   "Intel(R) Core(TM) i3-6100 CPU @ 3.70GHz"
 *   "Intel(R) Pentium(R) CPU G4400 @ 3.30GHz"
 *   "Intel(R) Celeron(R) CPU J3455 @ 1.50GHz"
 *
 * Returns null when no entry matches — the route then surfaces a
 * coresKnown=false warning.
 *
 * Exported for tests.
 */
export function inferCoresFromCpuModel(model: string | null): number | null {
  if (!model) return null;
  const norm = model.toLowerCase().replace(/\s+/g, " ").trim();
  for (const entry of KNOWN_CPU_MODELS) {
    if (norm.includes(entry.match)) return entry.cores;
  }
  return null;
}

/**
 * Known SCO/POS CPU models on the Rimi + Maxima fleets (as of 2026-05-20,
 * based on host.inventory.hardware strings observed in Zabbix).
 *
 * Order matters: more-specific matches first. If two entries match the
 * same string, the earlier wins.
 *
 * Adding a model: confirm cores via Intel ARK (or AMD spec sheet),
 * then add `{ match: "<lowercase substring>", cores: <int> }`. Keep
 * the substring short enough to handle the inventory's formatting
 * noise but specific enough to avoid false positives (e.g. "i3-6100"
 * is safer than just "i3").
 */
const KNOWN_CPU_MODELS: readonly { match: string; cores: number }[] = [
  // Match strings are chip identifiers found inside Zabbix `host.inventory.hardware`.
  // Examples observed in production:
  //   "Intel(R) Core(TM) i3-6100 CPU @ 3.70GHz"   -> matches "i3-6100"
  //   "Intel(R) Pentium(R) CPU G4560 @ 3.50GHz"   -> matches "g4560"
  //   "Intel(R) Celeron(R) CPU J3455 @ 1.50GHz"   -> matches "j3455"
  //
  // Substring matches are lowercased before comparison so e.g. "g4560" in the
  // table catches both "G4560" and "g4560" from Zabbix. Order matters: list
  // more-specific identifiers first to avoid a shorter substring eating a
  // longer one (e.g. "i3-1" would otherwise match all 10xxx variants).
  // Intel Core i-series, 6th-10th gen — dominant on Rimi SCOs.
  { match: "i3-10100", cores: 8 },  // Comet Lake, 4C/8T  (must come before i3-1 patterns)
  { match: "i3-6100", cores: 4 },   // Skylake, 2C/4T
  { match: "i3-7100", cores: 4 },   // Kaby Lake, 2C/4T
  { match: "i3-8100", cores: 4 },   // Coffee Lake, 4C/4T
  { match: "i3-9100", cores: 4 },   // Coffee Lake R, 4C/4T
  { match: "i5-6400", cores: 4 },   // Skylake, 4C/4T
  { match: "i5-6500", cores: 4 },   // Skylake, 4C/4T
  { match: "i5-7400", cores: 4 },   // Kaby Lake, 4C/4T
  { match: "i5-8400", cores: 6 },   // Coffee Lake, 6C/6T
  // Pentium / Celeron embedded — older POS / kiosk hardware. Match on the
  // bare chip ID since the "Pentium(R) CPU " prefix in Zabbix breaks the
  // "pentium g4560" substring approach.
  { match: "g4400", cores: 2 },   // Pentium Skylake, 2C/2T
  { match: "g4560", cores: 4 },   // Pentium Kaby Lake, 2C/4T
  { match: "g5400", cores: 4 },   // Pentium Coffee Lake, 2C/4T
  { match: "j3455", cores: 4 },   // Celeron Apollo Lake, 4C/4T
  { match: "j4125", cores: 4 },   // Celeron Gemini Lake R, 4C/4T
  { match: "x5-e8000", cores: 4 }, // Atom Braswell, 4C/4T
];

/** Loads the Device row by id (if known) or by sourceHostKey matching
 *  the Zabbix hostId. Returns just the columns this module needs so we
 *  don't pull large blobs unnecessarily.
 *
 *  The hostId-based lookup uses `findFirst` because sourceHostKey is
 *  not unique in the schema (in theory two pilots could share a key,
 *  though in practice it identifies the Zabbix host uniquely). The
 *  caller can pass deviceId to bypass this. */
async function loadDevice(
  prisma: PrismaClient,
  deviceId: string | undefined,
  hostId: string,
): Promise<{
  id: string;
  cpuCores: number | null;
  cpuCoresSource: string | null;
  cpuCoresProbedAt: Date | null;
  cpuModel: string | null;
} | null> {
  const select = {
    id: true,
    cpuCores: true,
    cpuCoresSource: true,
    cpuCoresProbedAt: true,
    cpuModel: true,
  } as const;
  if (deviceId) {
    return prisma.device.findUnique({ where: { id: deviceId }, select });
  }
  return prisma.device.findFirst({
    where: { sourceHostKey: hostId },
    select,
  });
}
