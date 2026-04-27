/**
 * Seed two initial users — Admin (full access) and Sprimi1 (limited).
 *
 * Re-running this script is safe — uses upsert so it won't duplicate or
 * overwrite passwords once set (passwordHash is only written on first
 * insert, see handling below).
 *
 * Usage:
 *   npx tsx scripts/seed-auth.ts
 */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword } from "../src/lib/auth/passwords";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function main() {
  // ── Built-in roles ───────────────────────────────────────────────
  const allTabs = ["overview", "inventory", "timeline", "comparison", "reference", "capacity", "hypotheses", "datahealth"];
  const fullAccess = await prisma.role.upsert({
    where: { name: "Full access" },
    create: {
      name: "Full access",
      description: "All tabs in any pilot. Template for admins to apply quickly.",
      isBuiltIn: true,
      allowedTabs: allTabs,
    },
    update: {
      description: "All tabs in any pilot. Template for admins to apply quickly.",
      isBuiltIn: true,
      allowedTabs: allTabs,
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
  console.log(`Roles ready: ${fullAccess.name}, ${limitedViewer.name}`);

  // ── Admin user ───────────────────────────────────────────────────
  // We never overwrite a password on re-run — only set on initial create.
  const adminExisting = await prisma.user.findFirst({
    where: { username: { equals: "Admin", mode: "insensitive" } },
  });
  if (!adminExisting) {
    const adminHash = await hashPassword("Nvbcentux1");
    await prisma.user.create({
      data: {
        username: "Admin",
        passwordHash: adminHash,
        isAdmin: true,
        isActive: true,
      },
    });
    console.log("Created Admin user");
  } else {
    console.log("Admin user already exists — password left unchanged");
  }

  // ── Sprimi1 user — limited to Retellect pilot (overview + timeline) ──
  const sprimiExisting = await prisma.user.findFirst({
    where: { username: { equals: "Sprimi1", mode: "insensitive" } },
  });
  let sprimiId: string;
  if (!sprimiExisting) {
    const sprimiHash = await hashPassword("Sprimi1");
    const created = await prisma.user.create({
      data: {
        username: "Sprimi1",
        passwordHash: sprimiHash,
        isAdmin: false,
        roleId: limitedViewer.id,
        isActive: true,
      },
    });
    sprimiId = created.id;
    console.log("Created Sprimi1 user");
  } else {
    sprimiId = sprimiExisting.id;
    console.log("Sprimi1 user already exists — password left unchanged");
  }

  // Find the Retellect pilot.
  const retellectPilot = await prisma.pilot.findFirst({
    where: { productType: "RETELLECT", shortCode: "SP-RETELLECT" },
  });
  if (!retellectPilot) {
    console.warn("Retellect pilot not found — skipping access grant");
    return;
  }

  // Grant Sprimi1 access to that pilot with overview + timeline only.
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
  console.log(`Granted Sprimi1 → ${retellectPilot.name} (overview, timeline)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
