/**
 * GET /api/internal/cpu-compare-debug?pilotId=...
 *
 * Internal-only diagnostic. Returns the raw Device.cpuModel + Zabbix
 * inventory cpuModel + resolveCpuModel output + final extracted value
 * for every device in the pilot. Lets us trace exactly which strings
 * are flowing through the heuristic when bogus rows appear in the
 * Compare-periods table.
 *
 * Gated by WARM_CACHE_SECRET (Bearer token) — same pattern as the rest
 * of /api/internal/*. Returns 401 without it so the endpoint can't be
 * abused even though the data is fairly innocuous.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getZabbixClient } from "@/lib/zabbix/client";
import { resolveCpuModel } from "@/components/rt/tabs/rt-inventory-helpers";

export const dynamic = "force-dynamic";

interface ZHostWithInventory {
  hostid: string;
  name: string;
  inventory: { cpuModel: string | null } | null;
}

const VENDOR_PREFIXES = [
  "intel", "amd", "apple", "arm", "qualcomm", "snapdragon",
  "ryzen", "epyc", "threadripper", "xeon", "core", "pentium",
  "celeron", "atom",
];
const BOGUS_VALUE_MARKERS = /\b(SCO\d+|Rimi|Maxima|IKI|MHM|SHM|HM\d|Panorama|Mal[uū]no|Vilnius|Kaunas|Klaip[eė]da|Šiauliai|Panev[eė]žys|Pavilnionys|Pilait[eė]|Saul[eė]s)\b/i;

function passesBasicShape(s: string): boolean {
  if (s === "" || s === "—" || s === "-") return false;
  if (s.length > 50) return false;
  if (/[\r\n]/.test(s)) return false;
  if (!/\d/.test(s)) return false;
  const lower = s.toLowerCase();
  return VENDOR_PREFIXES.some((p) => lower.startsWith(p));
}

function extractCleanCpuModel(s: string | null | undefined): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (trimmed === "") return null;
  if (!BOGUS_VALUE_MARKERS.test(trimmed) && passesBasicShape(trimmed)) return trimmed;
  const match = trimmed.match(BOGUS_VALUE_MARKERS);
  if (match && match.index != null && match.index > 0) {
    const prefix = trimmed.substring(0, match.index).trim();
    if (prefix && !BOGUS_VALUE_MARKERS.test(prefix) && passesBasicShape(prefix)) return prefix;
  }
  return null;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get("authorization") ?? "";
  const expected = process.env.WARM_CACHE_SECRET;
  if (!expected || auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const pilotId = req.nextUrl.searchParams.get("pilotId");
  if (!pilotId) return NextResponse.json({ error: "pilotId required" }, { status: 400 });

  const pilot = await prisma.pilot.findUnique({
    where: { id: pilotId },
    include: { devices: { include: { store: { select: { name: true } } } } },
  });
  if (!pilot) return NextResponse.json({ error: "pilot not found" }, { status: 404 });

  const client = getZabbixClient();
  const zHosts = (await client.getHosts()) as ZHostWithInventory[];
  const zByName = new Map(zHosts.map((z) => [z.name, z]));

  const out = pilot.devices.map((d) => {
    const key = d.sourceHostKey || d.name;
    const z = key ? zByName.get(key) : undefined;
    const inventoryCpu = z?.inventory?.cpuModel ?? null;
    const resolved = resolveCpuModel(d.cpuModel, inventoryCpu, "");
    const extracted = extractCleanCpuModel(resolved && resolved !== "" ? resolved : null);
    return {
      deviceId: d.id,
      deviceName: d.name,
      storeName: d.store?.name ?? null,
      dbCpuModel: d.cpuModel,
      zabbixInventoryCpuModel: inventoryCpu,
      resolved: resolved && resolved !== "" ? resolved : null,
      extracted,
    };
  });

  return NextResponse.json({
    pilotId,
    pilotName: pilot.name,
    deviceCount: out.length,
    devices: out,
  });
}
