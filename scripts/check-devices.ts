import * as fs from "node:fs";
async function main() {
  const envRaw = fs.readFileSync(".env", "utf8");
  const m = envRaw.match(/^DATABASE_URL="?([^"\n]+)"?/m);
  process.env.DATABASE_URL = m?.[1];
  const { prisma } = await import("../src/lib/db");
  const rows = await prisma.device.findMany({
    where: { pilotId: "cmnj8zf3100045zyfamibgz18" },
    select: { name: true, cpuModel: true, ramGb: true, sourceHostKey: true },
  });
  const total = rows.length;
  const hasCpuModel = rows.filter((r) => r.cpuModel && r.cpuModel.trim() !== "").length;
  const hasRamGb = rows.filter((r) => r.ramGb && r.ramGb > 0).length;
  console.log(JSON.stringify({ total, hasCpuModel, hasRamGb, sample: rows.slice(0, 3) }, null, 2));
  await prisma.$disconnect();
}
main();
