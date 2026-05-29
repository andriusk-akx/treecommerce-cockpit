/**
 * Host + Zabbix item resolution for the Compare-periods API.
 *
 * Replicates the same matching logic the Retellect page uses to map between
 * Prisma `Device`s and Zabbix host ids (see /retellect/[pilotId]/page.tsx
 * `zabbix-rt-cpu-history-${pilotId}` fetcher). Factored out here so:
 *   - the compare API doesn't repeat ~40 lines of resolution glue
 *   - the test surface is smaller (mock the Zabbix client, inspect the map)
 *
 * Returns the same data the heatmap path needs: itemIds[], itemHostMap, plus
 * a HostMeta list keyed by Zabbix host id so downstream compute can join
 * minutesAbove counters to UI-friendly device metadata.
 */
import { prisma } from "@/lib/db";
import { getZabbixClient } from "@/lib/zabbix/client";
import { resolveCpuModel } from "@/components/rt/tabs/rt-inventory-helpers";
import type { HostMeta } from "./compute";

interface ZHostWithInventory {
  hostid: string;
  name: string;
  inventory: { cpuModel: string | null } | null;
}

/**
 * Strict CPU model allowlist patterns. We've burned too many cycles on
 * heuristics that "almost" caught polluted Zabbix inventory values.
 * Switch to a positive whitelist: a value is a real CPU model ONLY if
 * it matches one of these patterns exactly (after a vendor prefix and
 * an arbitrary character run is allowed in the middle of the string for
 * things like "Intel(R) Core(TM) i5-9500E CPU @ 3.00GHz").
 *
 * Each entry maps the full string back to a canonical CPU model name
 * that's used as the aggregation key — so different surface forms
 * ("Intel i3-4330" vs "Intel(R) Core(TM) i3-4330 CPU @ 3.40GHz") still
 * group under the same row.
 */
const CPU_MODEL_PATTERNS: Array<{ re: RegExp; canonical: (m: RegExpMatchArray) => string }> = [
  // Intel Core iN-XXXX (covers i3-4330, i5-9500E, i3-12300HL, i3-9100E, etc.)
  { re: /\bi([3579])[- ]?(\d{3,6}[A-Z]*)\b/i, canonical: (m) => `Intel i${m[1]}-${m[2].toUpperCase()}` },
  // Intel Celeron (any model code after)
  { re: /\bCeleron[\s-]+([A-Z]?\d{3,6}[A-Z]*)\b/i, canonical: (m) => `Intel Celeron ${m[1].toUpperCase()}` },
  // Intel Pentium
  { re: /\bPentium[\s-]+([A-Z]?\d{3,6}[A-Z]*)\b/i, canonical: (m) => `Intel Pentium ${m[1].toUpperCase()}` },
  // Intel Atom
  { re: /\bAtom[\s-]+([A-Z]?\d{3,6}[A-Z]*)\b/i, canonical: (m) => `Intel Atom ${m[1].toUpperCase()}` },
  // Intel Xeon
  { re: /\bXeon[\s-]+(E[35]?-?\d{3,6}[A-Z]*|\w?\d{3,6}[A-Z]*)\b/i, canonical: (m) => `Intel Xeon ${m[1].toUpperCase()}` },
  // AMD Ryzen
  { re: /\bRyzen[\s-]+(\d+[\s-]+\d{3,5}[A-Z]*)\b/i, canonical: (m) => `AMD Ryzen ${m[1].replace(/\s+/g, " ")}` },
  // AMD EPYC
  { re: /\bEPYC[\s-]+(\d{3,5}[A-Z]*)\b/i, canonical: (m) => `AMD EPYC ${m[1].toUpperCase()}` },
  // AMD Threadripper
  { re: /\bThreadripper[\s-]+(\d{3,5}[A-Z]*)\b/i, canonical: (m) => `AMD Threadripper ${m[1].toUpperCase()}` },
];

/**
 * Return the canonical CPU model name for an input string, or null when
 * the string doesn't contain a recognised CPU model. Pattern matching is
 * done against the WHOLE string (so polluted values like "Intel Celeron
 * J3060 SCO35 Rimi MHM Maluno" still produce "Intel Celeron J3060" and
 * "Rimi Vilnius SC035" returns null because none of the patterns match).
 */
function extractCleanCpuModel(s: string | null | undefined): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (trimmed === "") return null;
  // Length cap is a sanity check — strings longer than this are almost
  // certainly multi-line junk and we don't want to pay regex time on them.
  if (trimmed.length > 200) return null;
  for (const { re, canonical } of CPU_MODEL_PATTERNS) {
    const match = trimmed.match(re);
    if (match) {
      return canonical(match);
    }
  }
  return null;
}

function isLikelyRealCpuModel(s: string | null | undefined): boolean {
  return extractCleanCpuModel(s) !== null;
}

export interface ResolveResult {
  hosts: HostMeta[];
  itemIds: string[];
  itemHostMap: Map<string, string>;
  /** Devices whose sourceHostKey couldn't be matched to a Zabbix host. */
  unmatchedDeviceIds: string[];
}

export async function resolvePilotHosts(
  pilotId: string,
  hostFilter: string[] | null,
  cpuModelFilter: string | null = null,
): Promise<ResolveResult> {
  const pilot = await prisma.pilot.findUnique({
    where: { id: pilotId },
    include: {
      devices: {
        include: { store: { select: { name: true } } },
        orderBy: { name: "asc" },
      },
    },
  });
  if (!pilot) {
    return { hosts: [], itemIds: [], itemHostMap: new Map(), unmatchedDeviceIds: [] };
  }

  const allowed = hostFilter && hostFilter.length > 0 ? new Set(hostFilter) : null;
  const devices = pilot.devices.filter((d) => !allowed || allowed.has(d.id));
  // CPU model filter is applied later, after inventory enrichment — see
  // matchedZ filter below. Doing it here against Device.cpuModel alone
  // would lose hosts whose Device row is null but whose Zabbix inventory
  // does report a model.
  if (devices.length === 0) {
    return { hosts: [], itemIds: [], itemHostMap: new Map(), unmatchedDeviceIds: [] };
  }

  // Mirror the page.tsx pattern: build the set of expected host keys, fetch
  // Zabbix hosts, intersect, fetch items, filter to system.cpu.util[,,avg1].
  const expectedHostKeys = new Set<string>();
  const keyToDevice = new Map<string, typeof devices[number]>();
  for (const d of devices) {
    const key = d.sourceHostKey || d.name;
    if (!key) continue;
    if (keyToDevice.has(key)) {
      // Two pilot devices share the same sourceHostKey/name. Earlier device
      // wins (keep the first match); log loudly so the data-entry mistake
      // surfaces. The later device's metrics would be silently attributed
      // to the earlier device otherwise.
      console.warn(
        `[cpu-compare resolve] duplicate host key "${key}": devices ${keyToDevice.get(key)?.id} and ${d.id} — keeping first, ignoring second`,
      );
      continue;
    }
    expectedHostKeys.add(key);
    keyToDevice.set(key, d);
  }

  const client = getZabbixClient();
  const zHosts = (await client.getHosts()) as ZHostWithInventory[];
  // Build the matched-zabbix list AND resolve the effective CPU model per
  // host. `resolveCpuModel(dbValue, inventoryValue)` is the same fallback
  // chain CPU Timeline uses (Device.cpuModel wins, Zabbix inventory fills
  // in the gap). Without this, devices whose DB cpuModel hasn't been
  // backfilled all collapse into a single "Unknown CPU" group even when
  // Zabbix has the model right there in hardware/hardware_full.
  let matchedZAll: Array<{
    zHostId: string;
    device: typeof devices[number];
    resolvedCpuModel: string | null;
  }> = [];
  for (const z of zHosts) {
    const device = keyToDevice.get(z.name);
    if (device) {
      const resolved = resolveCpuModel(device.cpuModel, z.inventory?.cpuModel ?? null, "");
      const cleaned = resolved && resolved !== "" ? resolved : null;
      // Use the extractor — it both validates AND strips polluted parts.
      // A value like "Intel Celeron J3060 SCO35 Rimi MHM Maluno" comes
      // back as "Intel Celeron J3060"; "SCO35" alone comes back as null;
      // "Intel i3-4330" passes through unchanged.
      const extracted = extractCleanCpuModel(cleaned);
      matchedZAll.push({
        zHostId: z.hostid,
        device,
        resolvedCpuModel: extracted,
      });
    }
  }
  // CPU model filter — apply against the RESOLVED model so the dropdown
  // picks up inventory-only models too.
  if (cpuModelFilter) {
    matchedZAll = matchedZAll.filter((m) => m.resolvedCpuModel === cpuModelFilter);
  }
  if (matchedZAll.length === 0) {
    return {
      hosts: [],
      itemIds: [],
      itemHostMap: new Map(),
      unmatchedDeviceIds: devices.map((d) => d.id),
    };
  }
  const matchedZ = matchedZAll;

  const matchedZHostIds = matchedZ.map((m) => m.zHostId);
  const items = (await client.getItems(matchedZHostIds, "system.cpu.util")) as Array<{
    itemid: string;
    hostid: string;
    key_: string;
  }>;
  const cpuUtilItems = items.filter(
    (i) => i.key_ === "system.cpu.util[,,avg1]" || i.key_ === "system.cpu.util",
  );
  const itemIds = cpuUtilItems.map((i) => i.itemid);
  const itemHostMap = new Map(cpuUtilItems.map((i) => [i.itemid, i.hostid]));

  // Build HostMeta keyed by Zabbix host id, filtered to hosts that actually
  // have a CPU item (no item = no data to compare = skip).
  const hostsWithItems = new Set(cpuUtilItems.map((i) => i.hostid));
  const hosts: HostMeta[] = matchedZ
    .filter((m) => hostsWithItems.has(m.zHostId))
    .map((m) => ({
      deviceId: m.device.id,
      zHostId: m.zHostId,
      hostName: m.device.name,
      storeName: m.device.store?.name ?? "Unknown store",
      cpuModel: m.resolvedCpuModel,
      cpuCores: m.device.cpuCores ?? null,
    }));

  const matchedSet = new Set(hosts.map((h) => h.deviceId));
  const unmatchedDeviceIds = devices.filter((d) => !matchedSet.has(d.id)).map((d) => d.id);

  return { hosts, itemIds, itemHostMap, unmatchedDeviceIds };
}
