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

// Zabbix display name (the `name` field returned by host.get), NOT the
// technical `host` identifier. seed_rimi_expand.ts and the retellect page
// match `Device.sourceHostKey` against `host.name`, so storing the
// technical name here would leave the device silently unmatched in the
// dashboard ("device exists, but never any data").
//
// Verified via Zabbix API (2026-05-13):
//   host="testlab_SPUB-P-SCO150"  name="Strongpoint testlab SCO"
const TESTLAB_HOST_KEY = "Strongpoint testlab SCO";
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
      // Andrius confirmed 2026-05-26: the testlab SCO is a 4-core box.
      // Seeding `cpuCores: 4` with `cpuCoresSource: "manual"` gives
      // `resolveCoresForHost` (src/lib/zabbix/cores.ts) a trustworthy
      // step-2 fallback for the days when Zabbix `system.cpu.num` is
      // missing or ZBX_NOTSUPPORTED — without it the drill-down would
      // silently fall to step 4 (coresKnown=false, value=1), and the
      // per-process stack would overshoot 100% because perf_counter
      // values are "% of one core" and we'd skip the /cores divide.
      //
      // `cpuCoresProbedAt` is left null on purpose: a live Zabbix probe
      // is still allowed to write through and refresh the source to
      // "zabbix" once a real reading shows up, but until then we have
      // an honest manual baseline.
      cpuCores: 4,
      cpuCoresSource: "manual",
      notes:
        "Experimental host. 2026-05-12: SP admin enabled per-process monitoring " +
        "(BESClient / Elastic / system.cpu.util[,system]) here — the dashboard " +
        "uses it to validate the detailed 'Other' breakdown before fleet rollout. " +
        "Hardware: 4-core SCO (Andrius 2026-05-26).",
    },
  });

  console.log(`✅ Seeded ${TESTLAB_STORE_NAME} → ${TESTLAB_DEVICE_NAME} (${TESTLAB_HOST_KEY})`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
