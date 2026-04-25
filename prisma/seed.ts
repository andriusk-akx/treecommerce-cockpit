import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function main() {
  // Clean existing data (order matters for foreign keys)
  await prisma.view.deleteMany();
  await prisma.device.deleteMany();
  await prisma.note.deleteMany();
  await prisma.incident.deleteMany();
  await prisma.dataSource.deleteMany();
  await prisma.store.deleteMany();
  await prisma.pilot.deleteMany();
  await prisma.client.deleteMany();

  // ─── Clients ─────────────────────────────────────────────────────

  const strongpoint = await prisma.client.create({
    data: {
      name: "StrongPoint",
      code: "STRONGPOINT",
      type: "EXTERNAL",
      status: "ACTIVE",
      ownerName: "Andrius",
      notes: "Pagrindinis klientas — TreeCommerce ir Retellect pilotai.",
    },
  });

  const rimi = await prisma.client.create({
    data: {
      name: "Rimi Baltic",
      code: "RIMI",
      type: "EXTERNAL",
      status: "ACTIVE",
      ownerName: "Andrius",
      notes: "Rimi — TreeCommerce pilotas su 12eat integracija.",
    },
  });

  const internal = await prisma.client.create({
    data: {
      name: "AK Internal",
      code: "AK-INTERNAL",
      type: "INTERNAL",
      status: "ACTIVE",
      ownerName: "Andrius",
      notes: "Vidinis klientas testavimui ir demo tikslams.",
    },
  });

  // ─── Pilots ──────────────────────────────────────────────────────

  const tcPilot = await prisma.pilot.create({
    data: {
      clientId: rimi.id,
      name: "Rimi TreeCommerce Pilotas",
      shortCode: "RIMI-TC",
      productType: "TREECOMMERCE",
      status: "ACTIVE",
      visibility: "INTERNAL",
      startDate: new Date("2024-09-01"),
      goalSummary: "12eat POS pardavimų ir Zabbix monitoringo integracija Rimi parduotuvėms.",
      internalOwner: "Andrius",
      notes: "Pirmasis AKpilot pilotas. Migruota iš treecommerce-cockpit.",
    },
  });

  const retellectPilot = await prisma.pilot.create({
    data: {
      clientId: strongpoint.id,
      name: "Retellect SCO CPU Analysis",
      shortCode: "SP-RETELLECT",
      productType: "RETELLECT",
      status: "ACTIVE",
      visibility: "INTERNAL",
      startDate: new Date("2025-03-15"),
      goalSummary: "Rimi SCO CPU load monitoring. Live Zabbix data.",
      internalOwner: "Andrius",
      notes: "Uses Zabbix resource metrics. Goal — identify SCO hosts with sufficient CPU headroom for Retellect.",
    },
  });

  const demoPilot = await prisma.pilot.create({
    data: {
      clientId: internal.id,
      name: "AK Demo Pilotas",
      shortCode: "AK-DEMO",
      productType: "OTHER",
      status: "PLANNED",
      visibility: "INTERNAL",
      goalSummary: "Demonstracinis pilotas AKpilot platformos galimybėms pademonstruoti.",
      internalOwner: "Andrius",
    },
  });

  // ─── Stores ──────────────────────────────────────────────────────

  const store12eat = await prisma.store.create({
    data: {
      clientId: rimi.id,
      pilotId: tcPilot.id,
      name: "12eat",
      code: "12EAT",
      city: "Vilnius",
      country: "LT",
    },
  });

  const storeWiden = await prisma.store.create({
    data: {
      clientId: rimi.id,
      pilotId: tcPilot.id,
      name: "Widen Arena",
      code: "WIDEN-ARENA",
      city: "Vilnius",
      country: "LT",
    },
  });

  const storeTreecom = await prisma.store.create({
    data: {
      clientId: rimi.id,
      pilotId: tcPilot.id,
      name: "TreeCom",
      code: "TREECOM",
      city: "Vilnius",
      country: "LT",
    },
  });

  const storeRimiSco = await prisma.store.create({
    data: {
      clientId: strongpoint.id,
      pilotId: retellectPilot.id,
      name: "Rimi Žirmūnai SCO",
      code: "RIMI-ZIR-SCO",
      city: "Vilnius",
      country: "LT",
    },
  });

  // ─── Data Sources ────────────────────────────────────────────────

  await prisma.dataSource.create({
    data: {
      clientId: rimi.id,
      pilotId: tcPilot.id,
      type: "ZABBIX",
      name: "Production Zabbix",
      baseUrl: "https://monitoring.strongpoint.com/api_jsonrpc.php",
      authType: "TOKEN",
      syncMode: "LIVE",
      isActive: true,
    },
  });

  await prisma.dataSource.create({
    data: {
      clientId: rimi.id,
      pilotId: tcPilot.id,
      type: "TREECOMMERCE_SALES_API",
      name: "12eat Sales API",
      baseUrl: "http://10.100.39.16:9051",
      authType: "NONE",
      syncMode: "LIVE",
      isActive: true,
      notes: "Reikalauja VPN. TEST: 10.36.161.75:9051, PROD: 10.100.39.16:9051",
    },
  });

  await prisma.dataSource.create({
    data: {
      clientId: strongpoint.id,
      pilotId: retellectPilot.id,
      type: "ZABBIX",
      name: "StrongPoint Zabbix",
      baseUrl: "https://monitoring.strongpoint.com/api_jsonrpc.php",
      authType: "TOKEN",
      syncMode: "LIVE",
      isActive: true,
    },
  });

  // ─── Devices (Retellect pilot — sample SCO devices) ──────────────

  const scoDevices = [
    { name: "rimi-zir-sco-01", cpuModel: "Intel Celeron J4125", ramGb: 4, os: "Windows 10 IoT", retellectEnabled: false },
    { name: "rimi-zir-sco-02", cpuModel: "Intel Celeron J4125", ramGb: 4, os: "Windows 10 IoT", retellectEnabled: false },
    { name: "rimi-zir-sco-03", cpuModel: "Intel Core i3-8100T", ramGb: 8, os: "Windows 10 IoT", retellectEnabled: true },
    { name: "rimi-zir-sco-04", cpuModel: "Intel Core i3-8100T", ramGb: 8, os: "Windows 10 IoT", retellectEnabled: true },
    { name: "rimi-zir-sco-05", cpuModel: "Intel Celeron J4125", ramGb: 4, os: "Windows 10 IoT", retellectEnabled: false },
    { name: "rimi-zir-sco-06", cpuModel: "Intel Core i5-8500T", ramGb: 16, os: "Windows 10 IoT", retellectEnabled: true },
    { name: "rimi-zir-pos-01", cpuModel: "Intel Core i3-8100T", ramGb: 8, os: "Windows 10", retellectEnabled: false },
    { name: "rimi-zir-server-01", cpuModel: "Intel Xeon E-2236", ramGb: 32, os: "Windows Server 2019", retellectEnabled: false },
  ];

  for (const dev of scoDevices) {
    await prisma.device.create({
      data: {
        pilotId: retellectPilot.id,
        storeId: storeRimiSco.id,
        name: dev.name,
        deviceType: dev.name.includes("sco") ? "SCO" : dev.name.includes("pos") ? "POS" : "SERVER",
        cpuModel: dev.cpuModel,
        ramGb: dev.ramGb,
        os: dev.os,
        retellectEnabled: dev.retellectEnabled,
        status: "active",
      },
    });
  }

  // ─── Done ────────────────────────────────────────────────────────

  console.log("✅ AKpilot seed data created successfully.");
  console.log("");
  console.log("  Clients:");
  console.log(`    - ${strongpoint.name} (${strongpoint.code})`);
  console.log(`    - ${rimi.name} (${rimi.code})`);
  console.log(`    - ${internal.name} (${internal.code})`);
  console.log("");
  console.log("  Pilots:");
  console.log(`    - ${tcPilot.name} (${tcPilot.shortCode}) — TREECOMMERCE`);
  console.log(`    - ${retellectPilot.name} (${retellectPilot.shortCode}) — RETELLECT`);
  console.log(`    - ${demoPilot.name} (${demoPilot.shortCode}) — OTHER/PLANNED`);
  console.log("");
  console.log(`  Stores: ${store12eat.name}, ${storeWiden.name}, ${storeTreecom.name}, ${storeRimiSco.name}`);
  console.log(`  Devices: ${scoDevices.length} (Retellect pilot)`);
  console.log("");
  console.log("  No demo incidents — use Sync Zabbix to import real data.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
