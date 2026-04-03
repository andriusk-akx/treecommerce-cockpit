import { NextResponse } from "next/server";
import { getZabbixClient } from "@/lib/zabbix/client";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const client = getZabbixClient();
    const resources = await client.getResourceMetrics();
    return NextResponse.json({ ok: true, data: resources, timestamp: new Date().toISOString() });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
