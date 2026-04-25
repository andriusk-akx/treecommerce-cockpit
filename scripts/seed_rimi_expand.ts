/**
 * Seed the Retellect pilot with the full Rimi SCO fleet from Zabbix.
 *
 * Mirrors every LT_T*_SCOW_* host in Zabbix as a Device row, regardless of
 * monitoring status. Active hosts (Zabbix status=0) get Device.status='active';
 * disabled hosts (Zabbix status=1) get Device.status='inactive' so the UI
 * can visually mark them.
 *
 * Device.sourceHostKey is the Zabbix display name → zabbixByName lookup
 * resolves live CPU/RAM automatically on dashboard load.
 *
 * Idempotent — clears and re-creates expanded stores on every run.
 */
import { prisma } from "../src/lib/db";
import fs from "fs";
import path from "path";

interface RawHost {
  hostid: string;
  host: string;
  name: string;
  store_code: string;
  sco_num: number;
  is_active: boolean;
}

// 17 Rimi stores discovered in Zabbix
const STORE_META: Record<string, { displayName: string; code: string; city: string }> = {
  T104: { displayName: "Rimi SM Didžioji",        code: "RIMI-T104", city: "Vilnius"   },
  T704: { displayName: "Rimi HM Mega",            code: "RIMI-T704", city: "Kaunas"    },
  T705: { displayName: "Rimi HM Mandarinas",      code: "RIMI-T705", city: "Vilnius"   },
  T707: { displayName: "Rimi HM Panorama",        code: "RIMI-T707", city: "Vilnius"   },
  T709: { displayName: "Rimi HM Saulės miestas",  code: "RIMI-T709", city: "Šiauliai"  },
  T745: { displayName: "Rimi HM Liepojos",        code: "RIMI-T745", city: "Klaipėda"  },
  T746: { displayName: "Rimi SHM Panevėžys",      code: "RIMI-T746", city: "Panevėžys" },
  T747: { displayName: "Rimi HM Jeruzalė",        code: "RIMI-T747", city: "Vilnius"   },
  T757: { displayName: "Rimi MHM Malūno",         code: "RIMI-T757", city: "Vilnius"   },
  T776: { displayName: "Rimi SM Naujoji Vilnia",  code: "RIMI-T776", city: "Vilnius"   },
  T777: { displayName: "Rimi CHM BIG",            code: "RIMI-T777", city: "Vilnius"   },
  T788: { displayName: "Rimi MHM Užupis",         code: "RIMI-T788", city: "Vilnius"   },
  T803: { displayName: "Rimi SHM Pavilnionys",    code: "RIMI-T803", city: "Vilnius"   },
  T813: { displayName: "Rimi CHM Outlet",         code: "RIMI-T813", city: "Vilnius"   },
  T822: { displayName: "Rimi SHM Dangeručio",     code: "RIMI-T822", city: "Vilnius"   },
  T838: { displayName: "Rimi SM Ketvergiai",      code: "RIMI-T838", city: "Klaipėda"  },
  T865: { displayName: "Rimi SM Kaišiadorys",     code: "RIMI-T865", city: "Kaišiadorys" },
};

async function main() {
  const jsonPath = path.resolve(__dirname, "..", "rimi_hosts_filtered.json");
  const hosts: RawHost[] = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  const activeN = hosts.filter((h) => h.is_active).length;
  console.log(`Loaded ${hosts.length} hosts from Zabbix probe (${activeN} active, ${hosts.length - activeN} inactive)`);

  const pilot = await prisma.pilot.findFirst({ where: { productType: "RETELLECT" } });
  if (!pilot) throw new Error("No RETELLECT pilot found");
  console.log(`Pilot: ${pilot.name} (${pilot.id})`);

  // Remove legacy placeholder Žirmūnai if still present
  const placeholderStore = await prisma.store.findFirst({
    where: { pilotId: pilot.id, code: "RIMI-ZIR-SCO" },
  });
  if (placeholderStore) {
    const d = await prisma.device.deleteMany({ where: { storeId: placeholderStore.id } });
    await prisma.store.delete({ where: { id: placeholderStore.id } });
    console.log(`Removed placeholder: ${d.count} devices + "${placeholderStore.name}"`);
  }

  // Idempotent: clear all previously-seeded Rimi stores
  for (const code of Object.keys(STORE_META)) {
    const storeCode = STORE_META[code].code;
    const existing = await prisma.store.findFirst({
      where: { pilotId: pilot.id, code: storeCode },
    });
    if (existing) {
      await prisma.device.deleteMany({ where: { storeId: existing.id } });
      await prisma.store.delete({ where: { id: existing.id } });
    }
  }

  const byStore = new Map<string, RawHost[]>();
  for (const h of hosts) {
    if (!byStore.has(h.store_code)) byStore.set(h.store_code, []);
    byStore.get(h.store_code)!.push(h);
  }

  let totalDevices = 0;
  let totalActive = 0;
  const sortedStores = Array.from(byStore.keys()).sort();
  for (const storeCode of sortedStores) {
    const meta = STORE_META[storeCode];
    if (!meta) { console.log(`  skipping unknown store ${storeCode}`); continue; }
    const storeHosts = byStore.get(storeCode)!;
    const store = await prisma.store.create({
      data: {
        clientId: pilot.clientId,
        pilotId: pilot.id,
        name: meta.displayName,
        code: meta.code,
        country: "LT",
        city: meta.city,
        status: "active",
      },
    });
    let active = 0;
    for (const h of storeHosts) {
      const m = /SCO(\d+)/i.exec(h.name) || /SCOW_(\d+)/i.exec(h.host) || /_(\d+)$/.exec(h.host);
      const scoLabel = m ? `SCO${m[1]}` : h.host;
      await prisma.device.create({
        data: {
          pilotId: pilot.id,
          storeId: store.id,
          name: scoLabel,
          sourceHostKey: h.name,
          deviceType: "SCO",
          retellectEnabled: false,
          status: h.is_active ? "active" : "inactive",
        },
      });
      if (h.is_active) active++;
      totalDevices++;
    }
    totalActive += active;
    console.log(`  ${meta.displayName.padEnd(32)}  ${active} active + ${storeHosts.length - active} inactive`);
  }

  console.log(`\nDone. ${totalDevices} devices (${totalActive} active, ${totalDevices - totalActive} inactive) across ${byStore.size} stores.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
