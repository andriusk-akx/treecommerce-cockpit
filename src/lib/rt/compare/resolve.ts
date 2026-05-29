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
 * Server-side heuristic for "is this string a real CPU model?". Kept here
 * (not just on the client) so the API responds with `cpuModel: null` for
 * bogus values that leaked into Zabbix inventory hardware fields. This
 * means even a client running stale JS — or a future client built against
 * a different aggregation strategy — gets clean grouping by default.
 *
 * Real CPU model strings:
 *   - start with a recognised vendor / family prefix (case-insensitive)
 *   - contain at least one digit (rules out bare "Intel")
 *   - are reasonably short (≤ 80 chars; longer = pasted multi-line junk)
 *   - have no newlines in the body
 *
 * Examples that pass: "Intel i3-4330", "AMD Ryzen 5 5600X",
 *   "Intel(R) Core(TM) i5-9500E CPU @ 3.00GHz".
 * Examples that fail: "SCO35", "SCO35 Rimi MHM Maluno",
 *   "Intel i3-4330\nRimi HM Panorama", any hostname-style string.
 */
const VENDOR_PREFIXES = [
  "intel", "amd", "apple", "arm", "qualcomm", "snapdragon",
  "ryzen", "epyc", "threadripper", "xeon", "core", "pentium",
  "celeron", "atom",
];
/**
 * Retail-domain markers that should NEVER appear inside a CPU model
 * string. When Zabbix inventory's `hardware` field gets polluted with
 * hostnames or store names (we've seen "Intel Celeron J3060 SCO35 Rimi
 * MHM Maluno"), the vendor prefix alone passes the heuristic — so we
 * also reject anything that mentions these. Domain-specific but the
 * cleanest way to keep bad inventory out of the comparison grouping.
 */
const BOGUS_VALUE_MARKERS = /\b(SCO\d+|Rimi|Maxima|IKI|MHM|SHM|HM\d|Panorama|Mal[uū]no|Vilnius|Kaunas|Klaip[eė]da|Šiauliai|Panev[eė]žys|Pavilnionys|Pilait[eė]|Saul[eė]s)\b/i;

/**
 * Reject upfront. Used by the extractor below — keeps the regex in one
 * place even when we accept post-extraction values.
 */
function hasBogusMarker(s: string): boolean {
  return BOGUS_VALUE_MARKERS.test(s);
}

function passesBasicShape(s: string): boolean {
  if (s === "" || s === "—" || s === "-") return false;
  if (s.length > 50) return false;
  if (/[\r\n]/.test(s)) return false;
  if (!/\d/.test(s)) return false;
  const lower = s.toLowerCase();
  return VENDOR_PREFIXES.some((p) => lower.startsWith(p));
}

/**
 * Return a clean CPU model string, or null if the input looks bogus.
 *
 * Strategy:
 *   1. If the trimmed value has no bogus markers and passes the basic
 *      shape check (vendor prefix, has digit, sane length, no newlines),
 *      return it unchanged.
 *   2. Otherwise, look for the first occurrence of a bogus marker. If
 *      there's anything before it, treat that prefix as the candidate
 *      CPU model — strip the rest and re-test. This rescues polluted
 *      values like "Intel Celeron J3060 SCO35 Rimi MHM Maluno" by
 *      extracting "Intel Celeron J3060".
 *   3. If extraction still fails, return null.
 */
function extractCleanCpuModel(s: string | null | undefined): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (trimmed === "") return null;
  if (!hasBogusMarker(trimmed) && passesBasicShape(trimmed)) {
    return trimmed;
  }
  const match = trimmed.match(BOGUS_VALUE_MARKERS);
  if (match && match.index != null && match.index > 0) {
    const prefix = trimmed.substring(0, match.index).trim();
    if (prefix && !hasBogusMarker(prefix) && passesBasicShape(prefix)) {
      return prefix;
    }
  }
  return null;
}

/**
 * Boolean wrapper used by the client mirror. Server code uses the
 * extractor directly because it both validates AND cleans.
 */
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
