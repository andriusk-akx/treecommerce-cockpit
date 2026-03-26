import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { syncZabbixProblems } from "@/lib/zabbix/sync";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const client = await prisma.client.findFirst();

    if (!client) {
      return NextResponse.json({ error: "No client found" }, { status: 404 });
    }

    const result = await syncZabbixProblems(client.id);
    return NextResponse.json(result);
  } catch (error) {
    console.error("Sync error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
