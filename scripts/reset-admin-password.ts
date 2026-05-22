/**
 * CLI: reset the password for an admin user.
 *
 *   # Default — resets user "Admin" to the password you supply
 *   npx tsx scripts/reset-admin-password.ts MyNewPassword123
 *
 *   # Reset any other user (e.g. if you renamed Admin)
 *   npx tsx scripts/reset-admin-password.ts MyNewPassword123 --user Andrius
 *
 * Also clears any lockout state (failedLoginAttempts, lockedUntil) so the
 * new credentials are immediately usable.
 *
 * Targets whichever database `DATABASE_URL` points at, so to update Railway:
 *
 *   # Option A — via Railway CLI (recommended; no secrets leave your shell)
 *   railway run npx tsx scripts/reset-admin-password.ts MyNewPassword123
 *
 *   # Option B — paste the Railway DATABASE_URL manually
 *   DATABASE_URL='postgresql://...' npx tsx scripts/reset-admin-password.ts MyNewPassword123
 *
 * Safety: refuses passwords shorter than 8 characters; never logs the
 * plaintext password; idempotent (re-running with the same password just
 * re-hashes and re-writes).
 */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword } from "../src/lib/auth/passwords";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

function parseArgs(): { password: string; username: string } {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error(
      "Usage: npx tsx scripts/reset-admin-password.ts <new-password> [--user <name>]",
    );
    process.exit(1);
  }
  const password = args[0];
  let username = "Admin";
  const userFlag = args.indexOf("--user");
  if (userFlag !== -1 && args[userFlag + 1]) {
    username = args[userFlag + 1];
  }
  if (password.length < 8) {
    console.error("Password must be at least 8 characters. Aborting.");
    process.exit(1);
  }
  return { password, username };
}

async function main() {
  const { password, username } = parseArgs();

  const user = await prisma.user.findFirst({
    where: { username: { equals: username, mode: "insensitive" } },
    select: { id: true, username: true, isAdmin: true, isActive: true },
  });
  if (!user) {
    console.error(`No user named "${username}" found in this database.`);
    process.exit(1);
  }
  if (!user.isAdmin) {
    console.warn(
      `Warning: "${user.username}" is not an admin (isAdmin = false). Proceeding anyway.`,
    );
  }

  const hash = await hashPassword(password);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: hash,
      failedLoginAttempts: 0,
      lockedUntil: null,
      // Re-activate the account if it was disabled — common reason to reset
      // is "I locked myself out and disabled the account".
      isActive: true,
    },
  });

  console.log(
    `Password reset for "${user.username}". Lockout cleared. Account active.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
