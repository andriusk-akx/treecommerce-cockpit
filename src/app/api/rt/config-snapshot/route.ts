/**
 * POST /api/rt/config-snapshot
 *
 * Body: { devices: ConfigDeviceInput[], windowDays: 7 | 30 | 90 }
 *
 * Fetches the Retellect configuration log-items from Zabbix (config.ini +
 * Retellect/SCO versions, current + history), parses them, and returns the
 * assembled ConfigTrackingData for the Configuration tab. Lives in a route
 * (not the pilot page server fetch) so the heavier config-history fetch only
 * runs when the operator actually opens this tab — the main dashboard stays
 * fast. Devices are supplied by the client so we reuse the exact pilot
 * device list already loaded server-side.
 */
import { NextRequest, NextResponse } from "next/server";
import { fetchRetellectConfig } from "@/lib/zabbix/config";
import { buildConfigTracking, type ConfigDeviceInput } from "@/lib/rt/config-tracking/build";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { devices?: ConfigDeviceInput[]; windowDays?: number };
  try {
    body = (await req.json()) as { devices?: ConfigDeviceInput[]; windowDays?: number };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const devices = Array.isArray(body.devices) ? body.devices : [];
  const windowDays = [7, 30, 90].includes(Number(body.windowDays)) ? Number(body.windowDays) : 30;

  const { byHostName, status, error } = await fetchRetellectConfig(windowDays);
  const data = buildConfigTracking(
    devices,
    byHostName,
    windowDays,
    status === "live" ? "live" : "unavailable",
  );

  return NextResponse.json({ ...data, sourceError: error });
}
