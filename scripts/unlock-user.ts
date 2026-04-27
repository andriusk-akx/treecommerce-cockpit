/**
 * CLI: clear lockout state for a user (or all users).
 *
 *   npx tsx scripts/unlock-user.ts            # unlock everyone
 *   npx tsx scripts/unlock-user.ts Admin      # unlock just Admin
 *
 * Useful after verify-vulnerabilities.mjs / brute-force testing — those
 * suites hammer the login endpoint with wrong passwords and trip the
 * lockout policy. We don't want to disable lockout to make tests easier
 * (that's the actual feature being tested), so we provide an explicit
 * cleanup tool instead.
 */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function main() {
  const target = process.argv[2];
  if (target) {
    const r = await prisma.user.updateMany({
      where: { username: { equals: target, mode: "insensitive" } },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });
    console.log(`Unlocked: ${r.count} user(s) named "${target}"`);
  } else {
    const r = await prisma.user.updateMany({
      where: { OR: [{ failedLoginAttempts: { gt: 0 } }, { lockedUntil: { not: null } }] },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });
    console.log(`Unlocked: ${r.count} user(s)`);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
