/**
 * One-shot: fill in cpuModel for Zabbix-monitored Retellect devices
 * whose CPU is currently unknown but is listed in the LT inventory
 * spreadsheet.
 *
 * Context: expand-lt-fleet.ts intentionally SKIPS devices that already
 * exist at the (storeId, name) coordinate so Zabbix-sourced rows aren't
 * overwritten. Side effect: if such a device had cpuModel = null in the
 * DB and Zabbix.inventory.type was also null/empty, it'd surface in the
 * 'Unknown' class of the matrix — even though the inventory spreadsheet
 * knows exactly what CPU sits in that machine.
 *
 * This endpoint reads scripts/lt-fleet-2026-05-31.json, indexes entries
 * by (SAP, SCO label), then iterates Devices where cpuModel IS NULL,
 * matches them to inventory entries via their Store's RIMI-* code and
 * the device's name, and stamps the cpuModel.
 *
 * Auth: idempotency-state gate. If there are no devices with
 * cpuModel IS NULL inside the Retellect pilot, the endpoint refuses
 * with 423. dryRun=1 always allowed, never writes.
 *
 * Lifecycle: this route is a one-shot, same as expand-lt-fleet was.
 * Removed in the commit after the import is verified.
 */

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

interface LtFleetEntry {
  sap: string;
  rawName: string;
  scoLabel: string;
  ip: string | null;
  spssVersion: string | null;
  os: string | null;
  cpuModel: string | null;
  cpuRaw: string | null;
  vendor: string | null;
}

export async function GET(req: NextRequest) {
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";

  const pilot = await prisma.pilot.findFirst({
    where: { productType: "RETELLECT" },
    select: { id: true, name: true, clientId: true },
  });
  if (!pilot) {
    return Response.json({ error: "No RETELLECT pilot found" }, { status: 404 });
  }

  // Pre-check: are there ANY devices left with null cpuModel? If not,
  // the gate is closed (real run only — dryRun stays open for auditing).
  const nullCpuCount = await prisma.device.count({
    where: { pilotId: pilot.id, cpuModel: null },
  });
  if (!dryRun && nullCpuCount === 0) {
    return Response.json(
      {
        error: "Already-run gate is closed",
        nullCpuCount,
        hint: "No devices left with cpuModel = null. Nothing to backfill.",
      },
      { status: 423 },
    );
  }

  // Load inventory snapshot and index by (sap, scoLabel).
  const jsonPath = path.resolve(process.cwd(), "scripts", "lt-fleet-2026-05-31.json");
  let fleet: LtFleetEntry[];
  try {
    fleet = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as LtFleetEntry[];
  } catch (e) {
    return Response.json(
      {
        error: "Failed to read scripts/lt-fleet-2026-05-31.json",
        details: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    );
  }
  const byKey = new Map<string, LtFleetEntry>();
  for (const h of fleet) {
    byKey.set(`${h.sap}::${h.scoLabel}`, h);
  }

  // All Retellect-pilot devices with no CPU info yet, along with their
  // store code so we can derive the SAP token.
  const targets = await prisma.device.findMany({
    where: { pilotId: pilot.id, cpuModel: null },
    select: {
      id: true,
      name: true,
      sourceHostKey: true,
      store: { select: { code: true, name: true } },
    },
  });

  const matches: {
    deviceId: string;
    deviceName: string;
    storeCode: string | null;
    sap: string | null;
    monitored: boolean;
    newCpuModel: string | null;
    matched: boolean;
  }[] = [];
  let updated = 0;
  for (const d of targets) {
    const storeCode = d.store?.code ?? null;
    // Store codes look like 'RIMI-T813'; strip the prefix to get T813.
    const sap = storeCode?.startsWith("RIMI-") ? storeCode.slice(5) : null;
    const entry = sap ? byKey.get(`${sap}::${d.name}`) : null;
    const matched = !!entry && !!entry.cpuModel;
    const newCpuModel = entry?.cpuModel ?? null;

    matches.push({
      deviceId: d.id,
      deviceName: d.name,
      storeCode,
      sap,
      monitored: !!d.sourceHostKey,
      newCpuModel,
      matched,
    });

    if (matched && newCpuModel && !dryRun) {
      await prisma.device.update({
        where: { id: d.id },
        data: { cpuModel: newCpuModel },
      });
      updated++;
    } else if (matched && newCpuModel && dryRun) {
      updated++; // count what we WOULD have done
    }
  }

  // Final-state summary so the operator can verify the gate closed.
  const remainingNull = await prisma.device.count({
    where: { pilotId: pilot.id, cpuModel: null },
  });

  return Response.json({
    dryRun,
    pilot: { id: pilot.id, name: pilot.name },
    inventory: { hostsInFile: fleet.length },
    targets: {
      withNullCpu: targets.length,
      matchedInInventory: updated,
      notMatched: targets.length - updated,
    },
    afterCounts: {
      remainingNullCpu: dryRun ? targets.length : remainingNull,
    },
    sampleMatches: matches.filter((m) => m.matched).slice(0, 10),
    sampleNonMatches: matches.filter((m) => !m.matched).slice(0, 10),
  });
}
