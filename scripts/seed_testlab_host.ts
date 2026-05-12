/**
 * Seed the StrongPoint Testlab host into the Retellect pilot.
 *
 * 2026-05-12: SP admin enabled per-process monitoring (BESClient / Elastic /
 * Windows OS kernel) on this host so the dashboard's "Other" bucket can be
 * detailed for the first time. It's the experimental host the SP team uses
 * to validate new Zabbix templates before fleet rollout.
 *
 * Zabbix host name: `testlab_SPUB-P-SCO150`
 * Store grouping:   "StrongPoint Testlab" (separate from Rimi prod stores)
 * Device label:     "SCO150"
 * Status:           active, experimental flag carried in `notes`
 *
 * Idempotent — clears the testlab store on every run before re-creating it,
 * same pattern as scripts/seed_rimi_expand.ts.
 */
import { prisma } from "../src/lib/db";

const TESTLAB_HOST_KEY = "testlab_SPUB-P-SCO150";
const TESTLAB_STORE_CODE = "SP-TESTLAB";
const TESTLAB_STORE_NAME = "StrongPoint Testlab";
const TESTLAB_DEVICE_NAME = "SCO150";

async function main() {
  const pilot = await prisma.pilot.findFirst({ where: { productType: "RETELLECT" } });
  if (!pilot) throw new Error("No RETELLECT pilot found — run main seed first");
  console.log(`Pilot: ${pilot.name} (${pilot.id})`);

  // Idempotent: drop the previous testlab store + its devices.
  const existing = await prisma.store.findFirst({
    where: { pilotId: pilot.id, code: TESTLAB_STORE_CODE },
  });
  if (existing) {
    const d = await prisma.device.deleteMany({ where: { storeId: existing.id } });
    await prisma.store.delete({ where: { id: existing.id } });
    console.log(`Removed previous testlab store (${d.count} devices)`);
  }

  const store = await prisma.store.create({
    data: {
      clientId: pilot.clientId,
      pilotId: pilot.id,
      name: TESTLAB_STORE_NAME,
      code: TESTLAB_STORE_CODE,
      country: "NO",
      city: "StrongPoint HQ",
      status: "active",
      // Store model has no `notes` String field — the human-readable rationale
      // lives in Device.notes instead (carried per-device in the loop below).
    },
  });

  await prisma.device.create({
    data: {
      pilotId: pilot.id,
      storeId: store.id,
      name: TESTLAB_DEVICE_NAME,
      sourceHostKey: TESTLAB_HOST_KEY,
      deviceType: "SCO",
      retellectEnabled: false,
      status: "active",
      notes:
        "Experimental host. 2026-05-12: SP admin enabled per-process monitoring " +
        "(BESClient / Elastic / system.cpu.util[,system]) here — the dashboard " +
        "uses it to validate the detailed 'Other' breakdown before fleet rollout.",
    },
  });

  console.log(`✅ Seeded ${TESTLAB_STORE_NAME} → ${TESTLAB_DEVICE_NAME} (${TESTLAB_HOST_KEY})`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
