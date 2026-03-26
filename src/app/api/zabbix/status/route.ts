import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getZabbixClient } from "@/lib/zabbix/client";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const client = getZabbixClient();
    const version = await client.getVersion();
    const problems = await client.getProblems();
    const incidents = await prisma.incident.findMany({
      where: { status: { in: ["OPEN", "ACKNOWLEDGED"] } },
      include: { store: true },
      orderBy: { startedAt: "desc" },
      take: 10,
    });

    return NextResponse.json({ version, problems, incidents });
  } catch (error) {
    console.error("Status error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
