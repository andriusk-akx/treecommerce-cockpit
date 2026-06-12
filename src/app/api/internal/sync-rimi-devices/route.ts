/**
 * Admin endpoint: sync Rimi SCO Device rows from live Zabbix.
 *
 * Why this exists (2026-06-12): the Device table was seeded from a static
 * Zabbix snapshot (`rimi_hosts_filtered.json`, scripts/seed_rimi_expand.ts).
 * The Zabbix admin later added hosts — T822 Dangeručio SCO3/4/5 and
 * T803 Pavilnionys SCO1/SCO3 — which therefore never appeared on the
 * dashboard even though Zabbix had full CPU history for them. A static
 * snapshot goes stale every time the fleet changes; this endpoint reads
 * host.get live so the fix is one curl, not a re-probe + re-seed cycle.
 *
 * Same deployment constraints as seed-testlab-cores: the Cowork sandbox
 * can't reach Railway's prod Postgres, so DB writes ship as an HTTP
 * endpoint running inside the prod container, gated by WARM_CACHE_SECRET.
 *
 * What it does (idempotent):
 *   1. host.get all `LT_*_SCOW_*` hosts (no cache — admin just changed them).
 *   2. Parse store code (T822) + SCO label. Same label rules as the seed:
 *      display name `... SCO4` wins; raw `LT_Txxx_SCOW_34` falls back to
 *      `SCO34` — consistent with rows the original seed created.
 *   3. Match against existing monitored devices of the RETELLECT pilot:
 *        a. by sourceHostKey (Zabbix display name), else
 *        b. by store + SCO label (handles hosts renamed in Zabbix —
 *           updates sourceHostKey instead of duplicating the device).
 *      Unmatched Zabbix host → create Device (active/inactive per Zabbix
 *      status, retellectEnabled=false; instrumentation detection stays
 *      with the live item probes, same as seeded rows).
 *   4. Existing device whose Zabbix status flipped → update status.
 *   5. Monitored device on a RIMI-* store whose host vanished from
 *      Zabbix → status='inactive' (never deleted — history stays).
 *      Non-Rimi stores (Testlab) are never touched.
 *   6. Stores not present in DB are reported, not auto-created — store
 *      naming/city metadata is a deliberate human decision.
 *
 * Usage: GET /api/internal/sync-rimi-devices?secret=<WARM_CACHE_SECRET>
 *        optional &dryRun=1 to get the report without writing.
 */

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { getZabbixClient } from "@/lib/zabbix/client";

export const dynamic = "force-dynamic";

interface ZbxHost {
  hostid: string;
  host: string;
  name: string;
  status: string; // "0" = monitored, "1" = disabled
}

function parseHost(h: ZbxHost): { storeCode: string; scoLabel: string } | null {
  const storeM = /^LT_(T\d+)_SCOW_(\d+)$/.exec(h.host);
  if (!storeM) return null; // template dummies like LT_SAPCODE_SCOW_DEVICENUMBER
  const nameM = /SCO(\d+)/i.exec(h.name) || /SCOW_(\d+)/i.exec(h.host);
  return { storeCode: storeM[1], scoLabel: nameM ? `SCO${nameM[1]}` : h.host };
}

export async function GET(req: NextRequest) {
  const expectedSecret = process.env.WARM_CACHE_SECRET;
  if (!expectedSecret) {
    return Response.json({ error: "WARM_CACHE_SECRET not configured" }, { status: 500 });
  }
  if (req.nextUrl.searchParams.get("secret") !== expectedSecret) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";

  const pilot = await prisma.pilot.findFirst({ where: { productType: "RETELLECT" } });
  if (!pilot) {
    return Response.json({ error: "no RETELLECT pilot" }, { status: 500 });
  }

  // Live host list — bypass the 5-min getHosts() cache on purpose; the
  // operator calls this right after the Zabbix admin changed topology.
  const zbx = getZabbixClient();
  const hosts = (await zbx.request("host.get", {
    output: ["hostid", "host", "name", "status"],
    search: { host: "LT_*_SCOW_*" },
    searchWildcardsEnabled: true,
  })) as ZbxHost[];

  const stores = await prisma.store.findMany({
    where: { pilotId: pilot.id, code: { startsWith: "RIMI-" } },
  });
  const storeByCode = new Map(stores.map((s) => [s.code, s]));

  const devices = await prisma.device.findMany({
    where: { pilotId: pilot.id, sourceHostKey: { not: null } },
  });
  const deviceByHostKey = new Map(devices.map((d) => [d.sourceHostKey as string, d]));
  const deviceByStoreLabel = new Map(
    devices.filter((d) => d.storeId).map((d) => [`${d.storeId}:${d.name}`, d]),
  );

  const created: string[] = [];
  const relinked: string[] = [];
  const statusUpdated: string[] = [];
  const deactivated: string[] = [];
  const skippedStores = new Set<string>();
  const matchedDeviceIds = new Set<string>();

  for (const h of hosts) {
    const parsed = parseHost(h);
    if (!parsed) continue;
    const store = storeByCode.get(`RIMI-${parsed.storeCode}`);
    if (!store) {
      skippedStores.add(parsed.storeCode);
      continue;
    }
    const wantStatus = h.status === "0" ? "active" : "inactive";
    const existing =
      deviceByHostKey.get(h.name) ??
      deviceByStoreLabel.get(`${store.id}:${parsed.scoLabel}`);

    if (existing) {
      matchedDeviceIds.add(existing.id);
      const patch: { sourceHostKey?: string; status?: string } = {};
      if (existing.sourceHostKey !== h.name) {
        patch.sourceHostKey = h.name;
        relinked.push(`${h.name} (was ${existing.sourceHostKey})`);
      }
      if (existing.status !== wantStatus) {
        patch.status = wantStatus;
        statusUpdated.push(`${h.name}: ${existing.status} → ${wantStatus}`);
      }
      if (Object.keys(patch).length > 0 && !dryRun) {
        await prisma.device.update({ where: { id: existing.id }, data: patch });
      }
    } else {
      created.push(`${store.name} / ${parsed.scoLabel} ← ${h.name} (${wantStatus})`);
      if (!dryRun) {
        await prisma.device.create({
          data: {
            pilotId: pilot.id,
            storeId: store.id,
            name: parsed.scoLabel,
            sourceHostKey: h.name,
            deviceType: "SCO",
            retellectEnabled: false,
            status: wantStatus,
          },
        });
      }
    }
  }

  // Vanished hosts: monitored Rimi devices no longer present in Zabbix.
  const rimiStoreIds = new Set(stores.map((s) => s.id));
  for (const d of devices) {
    if (matchedDeviceIds.has(d.id)) continue;
    if (!d.storeId || !rimiStoreIds.has(d.storeId)) continue; // Testlab etc.
    if (d.status !== "inactive") {
      deactivated.push(`${d.name} (${d.sourceHostKey})`);
      if (!dryRun) {
        await prisma.device.update({ where: { id: d.id }, data: { status: "inactive" } });
      }
    }
  }

  return Response.json({
    dryRun,
    zabbixHosts: hosts.length,
    dbMonitoredDevices: devices.length,
    created,
    relinked,
    statusUpdated,
    deactivated,
    skippedStores: [...skippedStores].sort(),
  });
}
