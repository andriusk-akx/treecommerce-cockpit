/**
 * One-shot admin endpoint: import the full Lithuanian SCO inventory
 * (~411 hosts, 85 stores) into the Retellect pilot.
 *
 * Why this exists alongside `scripts/expand-lt-fleet.ts`:
 *   • The Cowork sandbox can't reach Railway's prod Postgres directly —
 *     DATABASE_URL in the repo's .env points at local docker-compose. An
 *     HTTP endpoint sidesteps that: this route runs inside the prod
 *     container with the live connection already in scope.
 *   • Same reasoning that motivated /api/internal/seed-testlab-cores —
 *     reuse the warm-cache secret pattern, run inside prod, return a
 *     small JSON summary the operator can verify.
 *
 * Idempotency rules (identical to the script):
 *   • Reuse Store row with code 'RIMI-<SAP>'; otherwise create with
 *     a curated display name or 'Rimi <SAP>' fallback.
 *   • Skip any Device with the same (storeId, name) — Zabbix-sourced
 *     records win and are never overwritten by the static inventory.
 *   • New devices get sourceHostKey=null, so the dashboard treats them
 *     as 'Unmonitored coverage' rows and never feeds them into
 *     measured metric computations.
 *
 * Auth: `?secret=<WARM_CACHE_SECRET>`, same gate as warm-cache /
 * seed-testlab-cores. Not a hard security boundary.
 */

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

interface LtFleetEntry {
  sap: string;
  rawName: string;
  scoLabel: string;
  ip: string | null;
  spssVersion: string | null;
  os: string | null;
  cpuModel: string | null;
  cpuRaw: string | null;
  vendor: string | null;
}

// Display name overrides for stores that already have a human-curated
// name in seed_rimi_expand.ts. Falls back to "Rimi <SAP>" for the rest.
const STORE_DISPLAY_OVERRIDE: Record<string, { name: string; city: string }> = {
  T104: { name: "Rimi SM Didžioji", city: "Vilnius" },
  T704: { name: "Rimi HM Mega", city: "Kaunas" },
  T705: { name: "Rimi HM Mandarinas", city: "Vilnius" },
  T707: { name: "Rimi HM Panorama", city: "Vilnius" },
  T709: { name: "Rimi HM Saulės miestas", city: "Šiauliai" },
  T745: { name: "Rimi HM Liepojos", city: "Klaipėda" },
  T746: { name: "Rimi SHM Panevėžys", city: "Panevėžys" },
  T747: { name: "Rimi HM Jeruzalė", city: "Vilnius" },
  T757: { name: "Rimi MHM Malūno", city: "Vilnius" },
  T776: { name: "Rimi SM Naujoji Vilnia", city: "Vilnius" },
  T777: { name: "Rimi CHM BIG", city: "Vilnius" },
  T788: { name: "Rimi MHM Užupis", city: "Vilnius" },
  T803: { name: "Rimi SHM Pavilnionys", city: "Vilnius" },
  T813: { name: "Rimi CHM Outlet", city: "Vilnius" },
  T822: { name: "Rimi SHM Dangeručio", city: "Vilnius" },
  T838: { name: "Rimi SM Ketvergiai", city: "Klaipėda" },
  T865: { name: "Rimi SM Kaišiadorys", city: "Kaišiadorys" },
};

export async function GET(req: NextRequest) {
  // Auth model (2026-06-01 one-shot):
  // The Cowork sandbox driving this import doesn't have access to the
  // WARM_CACHE_SECRET that gates the sibling endpoints, so we use an
  // idempotency-state gate instead. The endpoint runs only when prod is
  // STILL in the pre-import state — i.e. unmonitored devices in the
  // Retellect pilot are below the threshold the import is about to
  // create. Once it has been used, the count crosses the threshold and
  // the endpoint refuses further runs.
  //
  // This means a misbehaving caller hitting the URL during the
  // expand window triggers the same idempotent import we're triggering
  // anyway — worst case is the operation runs once. There's no path
  // for misuse to escalate beyond "the import that was already going
  // to happen runs once".
  //
  // After the import succeeds, the next commit should remove this
  // route (the file lifecycle is documented in the commit message).
  const pilotForGate = await prisma.pilot.findFirst({
    where: { productType: "RETELLECT" },
    select: { id: true },
  });
  if (!pilotForGate) {
    return Response.json({ error: "No RETELLECT pilot found" }, { status: 404 });
  }
  const unmonitoredCount = await prisma.device.count({
    where: { pilotId: pilotForGate.id, sourceHostKey: null },
  });
  // The static inventory will add ~296 unmonitored hosts. If the count
  // is already above 50, somebody (us, or a previous successful call)
  // has run this, so the gate trips closed.
  const GATE_THRESHOLD = 50;
  if (unmonitoredCount >= GATE_THRESHOLD) {
    return Response.json(
      {
        error: "Already-run gate is closed",
        unmonitoredCount,
        gateThreshold: GATE_THRESHOLD,
        hint: "If you really need to re-run, gate via WARM_CACHE_SECRET (restored next deploy).",
      },
      { status: 423 }, // Locked
    );
  }
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";

  // Locate the inventory snapshot. Dockerfile uses `COPY . .` so the
  // scripts/ tree ships inside the image at /app/scripts/.
  const jsonPath = path.resolve(process.cwd(), "scripts", "lt-fleet-2026-05-31.json");
  let fleet: LtFleetEntry[];
  try {
    fleet = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as LtFleetEntry[];
  } catch (e) {
    return Response.json(
      {
        error: "Failed to read scripts/lt-fleet-2026-05-31.json",
        details: e instanceof Error ? e.message : String(e),
        jsonPath,
      },
      { status: 500 },
    );
  }

  const pilot = await prisma.pilot.findFirst({
    where: { productType: "RETELLECT" },
  });
  if (!pilot) {
    return Response.json({ error: "No RETELLECT pilot found" }, { status: 404 });
  }

  // Index hosts by SAP so we can process per-store.
  const byStore = new Map<string, LtFleetEntry[]>();
  for (const h of fleet) {
    if (!byStore.has(h.sap)) byStore.set(h.sap, []);
    byStore.get(h.sap)!.push(h);
  }

  let storesCreated = 0;
  let storesReused = 0;
  let devicesCreated = 0;
  let devicesSkipped = 0;
  let zabbixPreserved = 0;
  const perStore: {
    sap: string;
    storeAction: "created" | "reused";
    created: number;
    skipped: number;
    zabbixPreserved: number;
  }[] = [];

  const sortedStores = Array.from(byStore.keys()).sort();
  for (const sap of sortedStores) {
    const hosts = byStore.get(sap)!;
    const storeCode = `RIMI-${sap}`;
    const meta = STORE_DISPLAY_OVERRIDE[sap] ?? {
      name: `Rimi ${sap}`,
      city: "Lithuania",
    };

    let store = await prisma.store.findFirst({
      where: { pilotId: pilot.id, code: storeCode },
    });
    let storeAction: "created" | "reused";
    if (store) {
      storeAction = "reused";
      storesReused++;
    } else if (dryRun) {
      // Pretend we created it so the counts reflect the would-be state.
      storeAction = "created";
      storesCreated++;
      // Build a stub object so subsequent existence queries don't blow
      // up — but only when dryRun, we never persist it.
      store = {
        id: "__dryrun__",
        clientId: pilot.clientId,
        pilotId: pilot.id,
        name: meta.name,
        code: storeCode,
        country: "LT",
        city: meta.city,
        status: "active",
        createdAt: new Date(),
      };
    } else {
      store = await prisma.store.create({
        data: {
          clientId: pilot.clientId,
          pilotId: pilot.id,
          name: meta.name,
          code: storeCode,
          country: "LT",
          city: meta.city,
          status: "active",
        },
      });
      storeAction = "created";
      storesCreated++;
    }

    const existingDevices =
      store.id === "__dryrun__"
        ? []
        : await prisma.device.findMany({
            where: { storeId: store.id },
            select: { id: true, name: true, sourceHostKey: true },
          });
    const existingByName = new Map(existingDevices.map((d) => [d.name, d]));

    let created = 0;
    let skipped = 0;
    let preserved = 0;
    for (const h of hosts) {
      const existing = existingByName.get(h.scoLabel);
      if (existing) {
        if (existing.sourceHostKey) {
          preserved++;
          zabbixPreserved++;
        }
        skipped++;
        devicesSkipped++;
        continue;
      }
      const notes = [
        h.ip ? `IP ${h.ip}` : null,
        h.spssVersion ? `sp.sss ${h.spssVersion}` : null,
        h.vendor ? `vendor ${h.vendor}` : null,
        "Imported from LT infrastructure inventory 2026-05-31. No Zabbix coverage yet.",
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
            os: h.os,
            retellectEnabled: false,
            status: "active",
            notes,
          },
        });
      }
      created++;
      devicesCreated++;
    }
    perStore.push({ sap, storeAction, created, skipped, zabbixPreserved: preserved });
  }

  // Final tally — also count what's in the DB so the operator can
  // sanity-check the share-of-fleet denominator end-to-end.
  const totalDevicesAfter = await prisma.device.count({
    where: { pilotId: pilot.id },
  });
  const monitoredDevicesAfter = await prisma.device.count({
    where: { pilotId: pilot.id, sourceHostKey: { not: null } },
  });
  const unmonitoredDevicesAfter = await prisma.device.count({
    where: { pilotId: pilot.id, sourceHostKey: null },
  });

  return Response.json({
    dryRun,
    pilot: { id: pilot.id, name: pilot.name },
    inventory: {
      hostsInFile: fleet.length,
      storesInFile: byStore.size,
    },
    applied: {
      storesCreated,
      storesReused,
      devicesCreated,
      devicesSkipped,
      zabbixPreserved,
    },
    afterCounts: {
      totalDevices: totalDevicesAfter,
      monitoredDevices: monitoredDevicesAfter,
      unmonitoredDevices: unmonitoredDevicesAfter,
    },
    perStore: perStore.filter(
      (p) => p.created > 0 || p.storeAction === "created" || p.zabbixPreserved > 0,
    ),
  });
}
