/**
 * DB fix for Retellect pilot:
 *   1. Fix sourceHostKey for Outlet devices to match real Zabbix host names.
 *      Old: "Rimi CHM Outlet (Vilnius) SCO1/SCO4"  →  New: "CHM Outlet [T813] SCO1/SCO4"
 *   2. Clear retellectEnabled on CHM BIG [T777] SCO1-5 — Retellect is currently
 *      only deployed on Outlet; CHM BIG was marked true in seed by mistake.
 *
 * Run:  DATABASE_URL=... npx tsx scripts/fix-outlet-db.ts
 */
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import "dotenv/config";

async function main() {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });

  // ── 1) Fix Outlet sourceHostKey ─────────────────────────────────────
  const outletUpdates: Array<{ dbName: string; newKey: string }> = [
    { dbName: "Rimi CHM Outlet SCO1", newKey: "CHM Outlet [T813] SCO1" },
    { dbName: "Rimi CHM Outlet SCO4", newKey: "CHM Outlet [T813] SCO4" },
  ];
  for (const u of outletUpdates) {
    const res = await prisma.device.updateMany({
      where: { name: u.dbName },
      data: { sourceHostKey: u.newKey },
    });
    console.log(`sourceHostKey ${u.dbName} → "${u.newKey}": ${res.count} row(s) updated`);
  }

  // ── 2) Clear retellectEnabled on CHM BIG [T777] SCO1-5 ──────────────
  const chmBigRes = await prisma.device.updateMany({
    where: {
      name: { startsWith: "CHM BIG [T777]" },
      retellectEnabled: true,
    },
    data: { retellectEnabled: false },
  });
  console.log(`retellectEnabled=false on CHM BIG [T777] devices: ${chmBigRes.count} row(s) updated`);

  // ── Verify final state ──────────────────────────────────────────────
  const rt = await prisma.device.findMany({
    where: { retellectEnabled: true },
    select: { name: true, sourceHostKey: true, store: { select: { name: true } } },
    orderBy: { name: "asc" },
  });
  console.log(`\n=== retellectEnabled devices after fix (expected: 2) ===`);
  for (const d of rt) console.log(`  ${d.name}  store=${d.store?.name}  srcKey=${d.sourceHostKey}`);

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
