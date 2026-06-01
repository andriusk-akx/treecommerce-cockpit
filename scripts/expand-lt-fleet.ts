/**
 * Expand the Retellect pilot with the full Lithuanian SCO fleet.
 *
 * Source: scripts/lt-fleet-2026-05-31.json — converted from the
 * "CPU LT_infrastructure_31-05-2026.xlsx" inventory the StrongPoint
 * Lithuania admin maintains. 411 SCO devices across 85 stores.
 *
 * What this adds vs. `seed_rimi_expand.ts`:
 *
 *   seed_rimi_expand.ts  → 17 Rimi stores that have Zabbix coverage today
 *                          (~115 monitored devices). Source: live Zabbix
 *                          host list. Devices have sourceHostKey set.
 *   expand-lt-fleet.ts   → the remaining ~68 stores and ~296 devices that
 *                          have no Zabbix monitoring. Source: this
 *                          static inventory. Devices have NO sourceHostKey
 *                          so the dashboard treats them as "Unmonitored"
 *                          coverage rows — never feeds them into measured
 *                          metric computations.
 *
 * The purpose is the matrix's per-class "% of fleet" share signal: it has
 * to count physical inventory, not monitoring coverage, so the denominator
 * reflects what Retellect rollout actually touches across the whole
 * Lithuanian estate.
 *
 * Idempotency rules:
 *   • If a Store with code "RIMI-{SAP}" already exists, reuse it.
 *   • If a Device with the same (storeId, name) already exists, SKIP — we
 *     never overwrite a Zabbix-sourced device record.
 *   • Otherwise insert a new Device with sourceHostKey=null and the
 *     cpuModel / os pulled from the inventory file.
 *
 * Usage (against prod):
 *   DATABASE_URL=postgres://... npx tsx scripts/expand-lt-fleet.ts
 * Or via Railway:
 *   railway run npx tsx scripts/expand-lt-fleet.ts
 */
import { prisma } from "../src/lib/db";
import fs from "fs";
import path from "path";

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

/** Pretty-printed display names for stores we don't have human metadata
 *  for. Falls back to "Rimi {SAP}" for everything else, so the matrix
 *  store dropdown stays readable even before someone curates a name. */
const STORE_DISPLAY_OVERRIDE: Record<string, { name: string; city: string }> = {
  // Known Zabbix-covered stores — left here so the expand script picks
  // up the same display name if the seed_rimi_expand row was lost for
  // any reason. (seed_rimi_expand still owns these primarily.)
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

async function main() {
  const jsonPath = path.resolve(__dirname, "lt-fleet-2026-05-31.json");
  const fleet: LtFleetEntry[] = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  console.log(`Loaded ${fleet.length} hosts from LT inventory file`);

  const pilot = await prisma.pilot.findFirst({ where: { productType: "RETELLECT" } });
  if (!pilot) throw new Error("No RETELLECT pilot found");
  console.log(`Pilot: ${pilot.name} (${pilot.id}, client=${pilot.clientId})`);

  // Index hosts by SAP code so we can process per-store.
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

  const sortedStores = Array.from(byStore.keys()).sort();
  for (const sap of sortedStores) {
    const hosts = byStore.get(sap)!;
    const storeCode = `RIMI-${sap}`;
    const meta = STORE_DISPLAY_OVERRIDE[sap] ?? {
      name: `Rimi ${sap}`,
      city: "Lithuania",
    };

    // Reuse or create the store.
    let store = await prisma.store.findFirst({
      where: { pilotId: pilot.id, code: storeCode },
    });
    if (store) {
      storesReused++;
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
      storesCreated++;
    }

    // Index existing devices in this store by name so we can skip
    // duplicates without an extra query per host.
    const existingDevices = await prisma.device.findMany({
      where: { storeId: store.id },
      select: { id: true, name: true, sourceHostKey: true },
    });
    const existingByName = new Map(existingDevices.map((d) => [d.name, d]));

    for (const h of hosts) {
      const existing = existingByName.get(h.scoLabel);
      if (existing) {
        // Zabbix-sourced devices win — we never overwrite them with the
        // static inventory record. (Their telemetry is the truth.)
        if (existing.sourceHostKey) zabbixPreserved++;
        devicesSkipped++;
        continue;
      }
      // New unmonitored coverage row.
      const notes = [
        h.ip ? `IP ${h.ip}` : null,
        h.spssVersion ? `sp.sss ${h.spssVersion}` : null,
        h.vendor ? `vendor ${h.vendor}` : null,
        "Imported from LT infrastructure inventory 2026-05-31. No Zabbix coverage yet.",
      ]
        .filter(Boolean)
        .join(" · ");
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
      devicesCreated++;
    }
  }

  console.log("");
  console.log(`Stores : created ${storesCreated}, reused ${storesReused}`);
  console.log(`Devices: created ${devicesCreated}, skipped ${devicesSkipped} (of which ${zabbixPreserved} were Zabbix-sourced and preserved)`);
  console.log("");
  console.log("Done. Fleet share denominator now reflects the full LT estate.");
  console.log("Zabbix-monitored host count is unchanged.");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
