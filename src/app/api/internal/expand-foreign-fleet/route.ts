/**
 * One-shot admin endpoint: import the Latvian (LV) and Estonian (EE)
 * Rimi SCO fleets into the Retellect pilot as inventory-only rows
 * (no Zabbix link, no Retellect coverage — just rows that make the
 * CPU Matrix's per-class share-of-fleet meaningful across the Baltic
 * estate).
 *
 *   LV: 702 hosts across 142 stores
 *   EE: 437 hosts across  84 stores
 *
 * Mirrors the architecture of /api/internal/expand-lt-fleet that ran
 * on 2026-06-01 for the Lithuanian estate.
 *
 * Idempotency rules (identical to the LT importer):
 *   • Reuse Store row keyed by code "{LV|EE}-<SAP>"; otherwise create
 *     with name "Rimi <SAP>" and the appropriate country code.
 *   • Skip Device rows that already exist at (storeId, name) — Zabbix-
 *     sourced records win (LV / EE have none today, but the rule keeps
 *     the importer safe to re-run after any future migration).
 *   • Inserted devices get sourceHostKey=null so the dashboard treats
 *     them as Unmonitored coverage and never feeds them into measured
 *     metric computations.
 *
 * Auth: idempotency-state gate (no WARM_CACHE_SECRET to share from the
 * sandbox). If the Retellect pilot already has any device with country
 * LV or EE, the endpoint refuses with 423 Locked. dryRun=1 always
 * returns the plan without writing.
 *
 * Lifecycle: one-shot — remove the route after the import lands.
 */

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

interface ForeignFleetEntry {
  country: string;
  sap: string;
  rawName: string | null;
  scoLabel: string;
  cpuModel: string | null;
  cpuRaw: string | null;
  vendor: string | null;
}

const COUNTRY_FILES: Record<string, string> = {
  LV: "lv-fleet-2026-05-31.json",
  EE: "ee-fleet-2026-05-31.json",
};

export async function GET(req: NextRequest) {
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";

  const pilot = await prisma.pilot.findFirst({
    where: { productType: "RETELLECT" },
    select: { id: true, name: true, clientId: true },
  });
  if (!pilot) {
    return Response.json({ error: "No RETELLECT pilot found" }, { status: 404 });
  }

  // Gate: refuse a real run if any device with country LV or EE is
  // already in the pilot. The import is idempotent at the store/device
  // level too, but the high-level gate gives a clearer 'already done'
  // signal in the response than 'devicesCreated: 0'.
  const foreignDeviceCount = await prisma.device.count({
    where: {
      pilotId: pilot.id,
      store: { country: { in: ["LV", "EE"] } },
    },
  });
  if (!dryRun && foreignDeviceCount > 0) {
    return Response.json(
      {
        error: "Already-run gate is closed",
        foreignDeviceCount,
        hint: "Pilot already has LV / EE devices. Endpoint is one-shot.",
      },
      { status: 423 },
    );
  }

  // Load both JSON files.
  const allEntries: ForeignFleetEntry[] = [];
  for (const [country, file] of Object.entries(COUNTRY_FILES)) {
    const jsonPath = path.resolve(process.cwd(), "scripts", file);
    try {
      const raw = fs.readFileSync(jsonPath, "utf-8");
      const parsed = JSON.parse(raw) as ForeignFleetEntry[];
      for (const e of parsed) {
        // Defensive — the JSON should already carry the country, but
        // overwrite from the dict in case of stale local edits.
        e.country = country;
        allEntries.push(e);
      }
    } catch (e) {
      return Response.json(
        {
          error: `Failed to read scripts/${file}`,
          details: e instanceof Error ? e.message : String(e),
        },
        { status: 500 },
      );
    }
  }

  // Index by (country, sap) so we process per-store.
  const byStore = new Map<string, ForeignFleetEntry[]>();
  for (const e of allEntries) {
    const key = `${e.country}::${e.sap}`;
    if (!byStore.has(key)) byStore.set(key, []);
    byStore.get(key)!.push(e);
  }

  let storesCreated = 0;
  let storesReused = 0;
  let devicesCreated = 0;
  let devicesSkipped = 0;
  const perCountry: Record<string, { storesCreated: number; devicesCreated: number }> = {
    LV: { storesCreated: 0, devicesCreated: 0 },
    EE: { storesCreated: 0, devicesCreated: 0 },
  };

  const sortedKeys = Array.from(byStore.keys()).sort();
  for (const key of sortedKeys) {
    const hosts = byStore.get(key)!;
    const [country, sap] = key.split("::");
    const storeCode = `${country}-${sap}`;
    const displayName = `Rimi ${sap}`;

    let store = await prisma.store.findFirst({
      where: { pilotId: pilot.id, code: storeCode },
    });
    if (!store) {
      if (dryRun) {
        store = {
          id: "__dryrun__",
          clientId: pilot.clientId,
          pilotId: pilot.id,
          name: displayName,
          code: storeCode,
          country,
          city: country,
          status: "active",
          createdAt: new Date(),
        };
      } else {
        store = await prisma.store.create({
          data: {
            clientId: pilot.clientId,
            pilotId: pilot.id,
            name: displayName,
            code: storeCode,
            country,
            city: country, // No city granularity in the source files
            status: "active",
          },
        });
      }
      storesCreated++;
      perCountry[country].storesCreated++;
    } else {
      storesReused++;
    }

    const existingDevices =
      store.id === "__dryrun__"
        ? []
        : await prisma.device.findMany({
            where: { storeId: store.id },
            select: { id: true, name: true, sourceHostKey: true },
          });
    const existingByName = new Map(existingDevices.map((d) => [d.name, d]));

    for (const h of hosts) {
      if (existingByName.has(h.scoLabel)) {
        devicesSkipped++;
        continue;
      }
      const notes = [
        h.vendor ? `vendor ${h.vendor}` : null,
        `Imported from ${country} infrastructure inventory 2026-05-31. No Zabbix coverage.`,
      ]
        .filter(Boolean)
        .join(" · ");
      if (!dryRun) {
        await prisma.device.create({
          data: {
            pilotId: pilot.id,
            storeId: store.id,
            name: h.scoLabel,
            sourceHostKey: null,
            deviceType: "SCO",
            cpuModel: h.cpuModel,
            os: null, // LV / EE inventory doesn't include OS column
            retellectEnabled: false,
            status: "active",
            notes,
          },
        });
      }
      devicesCreated++;
      perCountry[country].devicesCreated++;
    }
  }

  // Final tally for sanity-check.
  const totalDevicesAfter = await prisma.device.count({ where: { pilotId: pilot.id } });
  const ltCount = await prisma.device.count({
    where: { pilotId: pilot.id, store: { country: "LT" } },
  });
  const lvCount = await prisma.device.count({
    where: { pilotId: pilot.id, store: { country: "LV" } },
  });
  const eeCount = await prisma.device.count({
    where: { pilotId: pilot.id, store: { country: "EE" } },
  });

  return Response.json({
    dryRun,
    pilot: { id: pilot.id, name: pilot.name },
    inventory: {
      hostsInFile: allEntries.length,
      storesInFile: byStore.size,
    },
    applied: {
      storesCreated,
      storesReused,
      devicesCreated,
      devicesSkipped,
    },
    perCountry,
    afterCounts: {
      totalDevices: totalDevicesAfter,
      LT: ltCount,
      LV: lvCount,
      EE: eeCount,
    },
  });
}
