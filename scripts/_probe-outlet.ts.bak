/**
 * Backfill Device.cpuModel from Zabbix host.inventory.hardware.
 *
 * Caveat: as of 2026-04-17, only 2/109 Rimi SCO WIN hosts have inventory.hardware
 * populated in Zabbix. UI falls back to "—" when cpuModel empty / ramGb is 0.
 *
 * Run: ZABBIX_TOKEN=... npx tsx scripts/backfill-device-hw.ts
 */
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const URL_ZBX = "https://monitoring.strongpoint.com/api_jsonrpc.php";
const TOKEN = process.env.ZABBIX_TOKEN;
if (!TOKEN) { console.error("Set ZABBIX_TOKEN"); process.exit(1); }

async function call(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(URL_ZBX, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: Math.random() }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`${method}: ${data.error.message} — ${data.error.data}`);
  return data.result;
}

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const prisma = new PrismaClient({ adapter });
  try {
    const zbxHosts = await call("host.get", {
      output: ["hostid", "host", "name"],
      selectInventory: ["hardware"],
      groupids: ["198"],
    });
    console.log(`Fetched ${zbxHosts.length} Zabbix hosts`);

    const byKey = new Map<string, string>();
    for (const h of zbxHosts) {
      const hw = h.inventory?.hardware?.trim();
      if (!hw) continue;
      byKey.set(h.name, hw);
      byKey.set(h.host, hw);
    }
    const distinct = new Set(byKey.values());
    console.log(`${byKey.size / 2 | 0} Zabbix hosts have hardware inventory (${[...distinct].join(", ") || "none"})`);

    const devices = await prisma.device.findMany();
    console.log(`\nBackfilling ${devices.length} DB devices...`);

    let updated = 0, skipped = 0;
    for (const d of devices) {
      const key = d.sourceHostKey || d.name;
      const hw = byKey.get(key);
      if (!hw) { skipped++; continue; }
      if (d.cpuModel === hw) { skipped++; continue; }
      await prisma.device.update({ where: { id: d.id }, data: { cpuModel: hw } });
      console.log(`  ${d.name}: cpuModel -> "${hw}"`);
      updated++;
    }
    console.log(`\nDone: ${updated} updated, ${skipped} skipped`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
