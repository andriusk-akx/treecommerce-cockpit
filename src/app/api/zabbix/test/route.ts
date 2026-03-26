import { NextResponse } from "next/server";
import { getZabbixClient } from "@/lib/zabbix/client";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const client = getZabbixClient();
    const version = await client.getVersion();
    const hosts = await client.getHosts();
    const groups = await client.getHostGroups();
    const problems = await client.getProblems();

    return NextResponse.json({ version, hosts, groups, problems });
  } catch (error) {
    console.error("Zabbix test error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
