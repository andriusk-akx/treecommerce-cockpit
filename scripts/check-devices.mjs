import pkg from "../src/generated/prisma/index.js";
const { PrismaClient } = pkg;
const db = new PrismaClient();
const rows = await db.device.findMany({
  where: { pilotId: "cmnj8zf3100045zyfamibgz18" },
  select: { name: true, cpuModel: true, ramGb: true, sourceHostKey: true },
});
const total = rows.length;
const hasCpuModel = rows.filter(r => r.cpuModel && r.cpuModel.trim() !== "").length;
const hasRamGb = rows.filter(r => r.ramGb && r.ramGb > 0).length;
console.log(JSON.stringify({ total, hasCpuModel, hasRamGb, sample: rows.slice(0, 3) }, null, 2));
await db.$disconnect();
