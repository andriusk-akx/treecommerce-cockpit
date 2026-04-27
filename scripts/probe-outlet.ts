import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import "dotenv/config";

const URL_ZBX = "https://monitoring.strongpoint.com/api_jsonrpc.php";
const TOKEN = process.env.ZABBIX_TOKEN!;

async function zbx(method: string, params: Record<string, unknown> = {}) {
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
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });

  // 1) All stores in DB
  const stores = await prisma.store.findMany({
    include: { _count: { select: { devices: true } } },
    orderBy: { name: "asc" },
  });
  console.log("=== DB stores:", stores.length, "===");
  for (const s of stores) console.log(`  ${s.name}  (code=${s.code ?? "-"})  devices=${s._count.devices}`);

  // 2) Outlet devices — filter by store name
  const outletStores = stores.filter((s) => s.name.toLowerCase().includes("outlet"));
  console.log("\n=== Outlet stores in DB:", outletStores.length, "===");
  for (const s of outletStores) {
    const devices = await prisma.device.findMany({
      where: { storeId: s.id },
      select: { id: true, name: true, sourceHostKey: true, retellectEnabled: true, cpuModel: true, ramGb: true, deviceType: true },
      orderBy: { name: "asc" },
    });
    console.log(`\n  Store: ${s.name}  (${devices.length} devices)`);
    for (const d of devices) console.log(`    ${d.name}  type=${d.deviceType}  srcKey=${d.sourceHostKey}  rtEnabled=${d.retellectEnabled}  cpu="${d.cpuModel ?? ""}"  ram=${d.ramGb}`);
  }

  // 3) All devices with retellectEnabled
  const rtDevices = await prisma.device.findMany({
    where: { retellectEnabled: true },
    include: { store: true },
    orderBy: { name: "asc" },
  });
  console.log(`\n=== retellectEnabled devices: ${rtDevices.length} ===`);
  for (const d of rtDevices) console.log(`  ${d.name}  store=${d.store?.name}  srcKey=${d.sourceHostKey}`);

  // 4) Zabbix: search for Outlet hosts
  console.log("\n=== Zabbix hosts containing 'Outlet' ===");
  const zHosts = await zbx("host.get", {
    output: ["hostid", "host", "name", "status"],
    search: { name: "Outlet" },
    searchWildcardsEnabled: true,
    selectInterfaces: ["ip"],
    selectInventory: ["type", "hardware", "os"],
  });
  console.log(`  Found ${zHosts.length}`);
  for (const h of zHosts) {
    const inv = h.inventory && typeof h.inventory === "object" && !Array.isArray(h.inventory) ? h.inventory : {};
    console.log(`  host="${h.host}"  name="${h.name}"  status=${h.status}  hw="${(inv as any).hardware ?? ""}"`);
  }

  // 5) Zabbix: proc.num items total (across all Rimi hosts)
  console.log("\n=== Zabbix proc.num items across Rimi group ===");
  const procItems = await zbx("item.get", {
    output: ["itemid", "hostid", "key_", "lastvalue"],
    search: { key_: "proc.num" },
    searchWildcardsEnabled: true,
  });
  console.log(`  Found ${procItems.length} proc.num items total`);
  const byHost = new Map<string, any[]>();
  for (const it of procItems) {
    const arr = byHost.get(it.hostid) ?? [];
    arr.push(it);
    byHost.set(it.hostid, arr);
  }
  console.log(`  Across ${byHost.size} hosts`);
  const sampleHosts = [...byHost.entries()].slice(0, 5);
  for (const [hostid, items] of sampleHosts) {
    console.log(`  hostid=${hostid}: ${items.length} items — e.g. ${items.slice(0, 3).map((i: any) => `${i.key_}=${i.lastvalue}`).join(" | ")}`);
  }

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
