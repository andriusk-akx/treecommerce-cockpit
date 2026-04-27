// dotenv is loaded only when present — in production (Railway/Docker) env
// vars are set natively and dotenv may not be in the standalone bundle.
// Wrapped in try/catch so a missing dotenv module doesn't crash boot.
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("dotenv/config");
} catch {
  // production: env vars come from the platform
}
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    seed: "npx tsx prisma/seed.ts",
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
