/**
 * Idempotent production seed.
 *
 * Safe to run on every deploy:
 *   - Uses upsert for Client, Pilot, Role, Role-built-ins
 *   - Skips User passwordHash on re-run (admin must rotate via UI)
 *   - Doesn't touch Devices / Stores — those are populated by
 *     scripts/seed_rimi_expand.ts which is run manually post-first-deploy
 *
 * Usage:
 *   npx tsx scripts/seed-prod.ts
 *
 * Initial admin password is read from SEED_ADMIN_PASSWORD env var. If unset,
 * we throw rather than committing a default — refuses to seed an admin with
 * a weak/unset password in production.
 */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword } from "../src/lib/auth/passwords";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const ALL_TABS = [
  "overview", "inventory", "timeline", "comparison",
  "reference", "capacity", "hypotheses", "datahealth",
];

async function main() {
  // ── Roles (built-in templates) ─────────────────────────────────────
  const fullAccess = await prisma.role.upsert({
    where: { name: "Full access" },
    create: {
      name: "Full access",
      description: "All tabs in any pilot. Template for admins to apply quickly.",
      isBuiltIn: true,
      allowedTabs: ALL_TABS,
    },
    update: {
      description: "All tabs in any pilot. Template for admins to apply quickly.",
      isBuiltIn: true,
      allowedTabs: ALL_TABS,
    },
  });
  const limitedViewer = await prisma.role.upsert({
    where: { name: "Pilot viewer (Overview + Timeline)" },
    create: {
      name: "Pilot viewer (Overview + Timeline)",
      description: "Read-only access to Overview and CPU Timeline tabs.",
      isBuiltIn: true,
      allowedTabs: ["overview", "timeline"],
    },
    update: {
      description: "Read-only access to Overview and CPU Timeline tabs.",
      isBuiltIn: true,
      allowedTabs: ["overview", "timeline"],
    },
  });
  console.log(`✓ Roles: ${fullAccess.name}, ${limitedViewer.name}`);

  // ── Client + Pilot ─────────────────────────────────────────────────
  const strongpoint = await prisma.client.upsert({
    where: { code: "STRONGPOINT" },
    create: {
      name: "StrongPoint",
      code: "STRONGPOINT",
      type: "EXTERNAL",
      status: "ACTIVE",
      ownerName: "Andrius",
      notes: "Pagrindinis klientas — TreeCommerce ir Retellect pilotai.",
    },
    update: {},
  });
  console.log(`✓ Client: ${strongpoint.name}`);

  const retellectPilot = await prisma.pilot.upsert({
    where: { shortCode: "SP-RETELLECT" },
    create: {
      clientId: strongpoint.id,
      name: "Retellect SCO CPU Analysis",
      shortCode: "SP-RETELLECT",
      productType: "RETELLECT",
      status: "ACTIVE",
      visibility: "INTERNAL",
      goalSummary: "Investigate CPU bottlenecks on legacy Rimi SCO hardware under Retellect Promotion Engine load.",
      internalOwner: "Andrius",
    },
    update: {},
  });
  console.log(`✓ Pilot: ${retellectPilot.name}`);

  // ── Users (Admin + Sprimi1) ───────────────────────────────────────
  // passwordHash is set ONLY on first create. Subsequent runs skip it so an
  // admin who has rotated their password isn't reset to the seed value.
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  const sprimiPassword = process.env.SEED_SPRIMI_PASSWORD;
  if (!adminPassword || adminPassword.length < 8) {
    throw new Error("SEED_ADMIN_PASSWORD must be set (≥8 chars) for first-time prod seed");
  }
  if (!sprimiPassword || sprimiPassword.length < 6) {
    throw new Error("SEED_SPRIMI_PASSWORD must be set (≥6 chars) for first-time prod seed");
  }

  const adminExisting = await prisma.user.findFirst({
    where: { username: { equals: "Admin", mode: "insensitive" } },
  });
  if (!adminExisting) {
    await prisma.user.create({
      data: {
        username: "Admin",
        passwordHash: await hashPassword(adminPassword),
        isAdmin: true,
        isActive: true,
      },
    });
    console.log("✓ Admin created");
  } else {
    console.log("◦ Admin exists — password unchanged");
  }

  let sprimiId: string;
  const sprimiExisting = await prisma.user.findFirst({
    where: { username: { equals: "Sprimi1", mode: "insensitive" } },
  });
  if (!sprimiExisting) {
    const created = await prisma.user.create({
      data: {
        username: "Sprimi1",
        passwordHash: await hashPassword(sprimiPassword),
        isAdmin: false,
        roleId: limitedViewer.id,
        isActive: true,
      },
    });
    sprimiId = created.id;
    console.log("✓ Sprimi1 created");
  } else {
    sprimiId = sprimiExisting.id;
    console.log("◦ Sprimi1 exists — password unchanged");
  }

  // ── Sprimi1 → Retellect pilot grant ──────────────────────────────
  await prisma.userPilotAccess.upsert({
    where: { userId_pilotId: { userId: sprimiId, pilotId: retellectPilot.id } },
    create: {
      userId: sprimiId,
      pilotId: retellectPilot.id,
      allowedTabs: ["overview", "timeline"],
    },
    update: {
      allowedTabs: ["overview", "timeline"],
    },
  });
  console.log(`✓ Sprimi1 → ${retellectPilot.name} (overview, timeline)`);

  console.log("\nProduction seed complete.");
  console.log("Next: run seed_rimi_expand.ts to populate Rimi store/device data.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
