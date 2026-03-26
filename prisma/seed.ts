import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function main() {
  // Clean existing data
  await prisma.note.deleteMany();
  await prisma.incident.deleteMany();
  await prisma.dataSource.deleteMany();
  await prisma.store.deleteMany();
  await prisma.client.deleteMany();

  // Create client
  const client = await prisma.client.create({
    data: {
      name: "TreeCommerce",
      code: "TREECOMMERCE",
    },
  });

  // Create stores (based on Zabbix host groups)
  const store1 = await prisma.store.create({
    data: {
      clientId: client.id,
      name: "12eat",
      code: "12EAT",
    },
  });

  const store2 = await prisma.store.create({
    data: {
      clientId: client.id,
      name: "Widen Arena",
      code: "WIDEN-ARENA",
    },
  });

  const store3 = await prisma.store.create({
    data: {
      clientId: client.id,
      name: "TreeCom",
      code: "TREECOM",
    },
  });

  // Create Zabbix data source
  await prisma.dataSource.create({
    data: {
      clientId: client.id,
      type: "ZABBIX",
      name: "Production Zabbix",
      baseUrl: "https://monitoring.strongpoint.com/api_jsonrpc.php",
      isActive: true,
    },
  });

  console.log("Seed data created successfully.");
  console.log(`  Client: ${client.name}`);
  console.log(`  Clients: ${store1.name}, ${store2.name}, ${store3.name}`);
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
