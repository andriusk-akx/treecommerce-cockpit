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
import type { HostMeta } from "./compute";

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
  const devices = pilot.devices
    .filter((d) => !allowed || allowed.has(d.id))
    // CPU model filter: exact match against Device.cpuModel. When cpuModel
    // is null we keep all rows. Note: Device.cpuModel may itself be null
    // for devices where Zabbix inventory hasn't been resolved yet — those
    // are excluded when a specific model is requested.
    .filter((d) => !cpuModelFilter || d.cpuModel === cpuModelFilter);
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
  const zHosts = (await client.getHosts()) as Array<{ hostid: string; name: string }>;
  const matchedZ: Array<{ zHostId: string; device: typeof devices[number] }> = [];
  for (const z of zHosts) {
    const device = keyToDevice.get(z.name);
    if (device) matchedZ.push({ zHostId: z.hostid, device });
  }
  if (matchedZ.length === 0) {
    return {
      hosts: [],
      itemIds: [],
      itemHostMap: new Map(),
      unmatchedDeviceIds: devices.map((d) => d.id),
    };
  }

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
      cpuModel: m.device.cpuModel ?? null,
      cpuCores: m.device.cpuCores ?? null,
    }));

  const matchedSet = new Set(hosts.map((h) => h.deviceId));
  const unmatchedDeviceIds = devices.filter((d) => !matchedSet.has(d.id)).map((d) => d.id);

  return { hosts, itemIds, itemHostMap, unmatchedDeviceIds };
}
