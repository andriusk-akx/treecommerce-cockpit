/**
 * One-shot: merge duplicate SCO device rows created by the
 * expand-lt-fleet import for stores where the Zabbix template names
 * SCO lanes 1..N while the LT inventory spreadsheet names them
 * POS 31..N+30. The expand script saw 'SCO5' (existing Zabbix-sourced)
 * and 'SCO35' (newly imported unmonitored) as different devices and
 * left both records side-by-side.
 *
 * This route walks each Retellect-pilot store and, when it finds the
 * +30 offset pattern, treats the pair as the same physical machine:
 *   • keep the Zabbix-monitored record (telemetry, IDs, references),
 *   • copy cpuModel / os / notes from the unmonitored sibling onto it
 *     whenever the monitored record was missing those fields,
 *   • delete the unmonitored duplicate.
 *
 * Auth: idempotency-state gate. Gate is "any duplicate pair still
 * exists in the pilot?". Real run refuses when none remain. dryRun=1
 * always allowed.
 *
 * Lifecycle: one-shot, removed after the import is verified.
 */

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const NAMING_OFFSET = 30;

interface DeviceLite {
  id: string;
  name: string;
  storeId: string | null;
  sourceHostKey: string | null;
  cpuModel: string | null;
  os: string | null;
  notes: string | null;
}

/** Parse SCO label into the numeric tail. Returns null when the name
 *  doesn't look like an SCO label so we don't accidentally merge
 *  weirdly-named rows. */
function scoNum(name: string): number | null {
  const m = /^SCO(\d+)$/i.exec(name.trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

export async function GET(req: NextRequest) {
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";

  const pilot = await prisma.pilot.findFirst({
    where: { productType: "RETELLECT" },
    select: { id: true, name: true },
  });
  if (!pilot) {
    return Response.json({ error: "No RETELLECT pilot found" }, { status: 404 });
  }

  // Pull every device in the pilot once, then group by store in
  // memory — cheaper than N+1 store queries for a 500-device pilot.
  const all = (await prisma.device.findMany({
    where: { pilotId: pilot.id },
    select: {
      id: true,
      name: true,
      storeId: true,
      sourceHostKey: true,
      cpuModel: true,
      os: true,
      notes: true,
    },
  })) as DeviceLite[];

  const byStore = new Map<string | null, DeviceLite[]>();
  for (const d of all) {
    if (!byStore.has(d.storeId)) byStore.set(d.storeId, []);
    byStore.get(d.storeId)!.push(d);
  }

  type MergeAction = {
    storeId: string | null;
    monitoredId: string;
    monitoredName: string;
    unmonitoredId: string;
    unmonitoredName: string;
    cpuModelTaken: string | null;
    osTaken: string | null;
    notesTaken: string | null;
  };
  const planned: MergeAction[] = [];

  for (const [storeId, devices] of byStore.entries()) {
    if (storeId === null) continue;
    // Build name → device map for O(1) lookup of the +30 sibling.
    const byName = new Map<string, DeviceLite>(devices.map((d) => [d.name, d]));
    for (const d of devices) {
      if (!d.sourceHostKey) continue; // only consider monitored as the keeper
      const n = scoNum(d.name);
      if (n === null || n >= NAMING_OFFSET) continue;
      const sibling = byName.get(`SCO${n + NAMING_OFFSET}`);
      if (!sibling) continue;
      if (sibling.sourceHostKey) continue; // both monitored — shouldn't merge
      // Only copy fields where the keeper currently has nothing — never
      // overwrite a real CPU model with a sibling's CPU model.
      planned.push({
        storeId,
        monitoredId: d.id,
        monitoredName: d.name,
        unmonitoredId: sibling.id,
        unmonitoredName: sibling.name,
        cpuModelTaken: d.cpuModel === null ? sibling.cpuModel : null,
        osTaken: d.os === null ? sibling.os : null,
        notesTaken: d.notes === null ? sibling.notes : null,
      });
    }
  }

  // Idempotency: if no merge pairs remain, gate the real run.
  if (!dryRun && planned.length === 0) {
    return Response.json(
      {
        error: "Already-run gate is closed",
        plannedPairs: 0,
        hint: "No +30-offset duplicate pairs left to merge.",
      },
      { status: 423 },
    );
  }

  let merged = 0;
  if (!dryRun) {
    // Apply each planned merge in its own short transaction — the
    // operation set is small, and a single-pilot fleet is well below
    // any reasonable transaction-size concern.
    for (const p of planned) {
      await prisma.$transaction([
        prisma.device.update({
          where: { id: p.monitoredId },
          data: {
            ...(p.cpuModelTaken !== null && { cpuModel: p.cpuModelTaken }),
            ...(p.osTaken !== null && { os: p.osTaken }),
            ...(p.notesTaken !== null && { notes: p.notesTaken }),
          },
        }),
        prisma.device.delete({ where: { id: p.unmonitoredId } }),
      ]);
      merged++;
    }
  }

  // Post-state summary.
  const totalAfter = await prisma.device.count({ where: { pilotId: pilot.id } });
  const monitoredAfter = await prisma.device.count({
    where: { pilotId: pilot.id, sourceHostKey: { not: null } },
  });
  const unmonitoredAfter = await prisma.device.count({
    where: { pilotId: pilot.id, sourceHostKey: null },
  });
  const nullCpuAfter = await prisma.device.count({
    where: { pilotId: pilot.id, cpuModel: null },
  });

  return Response.json({
    dryRun,
    pilot: { id: pilot.id, name: pilot.name },
    summary: {
      plannedPairs: planned.length,
      merged,
    },
    afterCounts: {
      totalDevices: dryRun ? totalAfter : totalAfter,
      monitoredDevices: monitoredAfter,
      unmonitoredDevices: unmonitoredAfter,
      remainingNullCpu: nullCpuAfter,
    },
    samplePlanned: planned.slice(0, 12),
  });
}
