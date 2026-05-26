/**
 * One-shot admin endpoint: stamp `cpuCores = 4` (`cpuCoresSource = "manual"`)
 * on the StrongPoint Testlab SCO device.
 *
 * Why a separate endpoint instead of running scripts/seed_testlab_host.ts:
 *   - The full seed deletes + recreates the testlab store. That works fine
 *     in dev but is wider scope than we need on prod, where we only want
 *     to add the two cpuCores columns to the existing row.
 *   - The Cowork sandbox can't reach Railway's prod Postgres directly —
 *     DATABASE_URL is local-only. An HTTP endpoint sidesteps that: the
 *     route runs inside the prod container with the prod connection
 *     already in scope.
 *   - Reusing the same `WARM_CACHE_SECRET` gate keeps the secret-footprint
 *     small and matches the existing warm-cache pattern. Same operator
 *     credential, same firewall expectations.
 *
 * What this does:
 *   - Finds Device rows where `sourceHostKey = "Strongpoint testlab SCO"`
 *     (the Zabbix display-name key seed_testlab_host.ts uses).
 *   - Sets cpuCores=4, cpuCoresSource="manual" if not already that exact
 *     pair. Leaves `cpuCoresProbedAt` alone so a future live Zabbix probe
 *     (resolveCoresForHost step 1) can still overwrite to source="zabbix"
 *     when system.cpu.num becomes supported.
 *   - Returns { matched, updated, before, after } so the operator can
 *     verify the change in one curl.
 *
 * Why idempotent + no-op when already correct: the operator might hit
 * this endpoint twice. The second call should be a no-op, not a stamp
 * with a new probedAt that masks future drift.
 *
 * Auth: same `?secret=<WARM_CACHE_SECRET>` gate as /api/internal/warm-cache.
 * Not a hard security boundary, but enough to keep stray traffic out.
 */

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

// Must match TESTLAB_HOST_KEY in scripts/seed_testlab_host.ts. Hard-coded
// here on purpose — this endpoint is the testlab-specific patcher, not a
// general "set cores on any host" tool.
const TESTLAB_HOST_KEY = "Strongpoint testlab SCO";
const EXPECTED_CORES = 4;
const EXPECTED_SOURCE = "manual";

export async function GET(req: NextRequest) {
  const expectedSecret = process.env.WARM_CACHE_SECRET;
  if (!expectedSecret) {
    return Response.json(
      { error: "WARM_CACHE_SECRET not configured on this deployment" },
      { status: 503 },
    );
  }
  const givenSecret = req.nextUrl.searchParams.get("secret");
  if (givenSecret !== expectedSecret) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Snapshot the BEFORE state so the response shows exactly what changed.
  // Limiting columns to the two we care about + id keeps the payload small
  // and avoids accidentally returning anything sensitive (notes, etc.).
  const before = await prisma.device.findMany({
    where: { sourceHostKey: TESTLAB_HOST_KEY },
    select: {
      id: true,
      name: true,
      cpuCores: true,
      cpuCoresSource: true,
      cpuCoresProbedAt: true,
    },
  });

  if (before.length === 0) {
    return Response.json(
      {
        error: "No Device row with sourceHostKey matching testlab. Run scripts/seed_testlab_host.ts first.",
        sourceHostKey: TESTLAB_HOST_KEY,
      },
      { status: 404 },
    );
  }

  // Skip the UPDATE entirely if every matching row already has the target
  // pair. Avoids a needless write + downstream cache-bust on idempotent
  // re-runs, and the response still shows the operator what's there.
  const allAlreadyCorrect = before.every(
    (d) => d.cpuCores === EXPECTED_CORES && d.cpuCoresSource === EXPECTED_SOURCE,
  );
  if (allAlreadyCorrect) {
    return Response.json({
      matched: before.length,
      updated: 0,
      noop: true,
      before,
      after: before,
    });
  }

  const result = await prisma.device.updateMany({
    where: { sourceHostKey: TESTLAB_HOST_KEY },
    data: {
      cpuCores: EXPECTED_CORES,
      cpuCoresSource: EXPECTED_SOURCE,
      // Intentionally NOT touching cpuCoresProbedAt — leaving it null/old
      // means the resolver still treats this as "not yet probed by Zabbix"
      // and will write-through to source="zabbix" on the next successful
      // system.cpu.num read. The manual value is just a safe fallback.
    },
  });

  const after = await prisma.device.findMany({
    where: { sourceHostKey: TESTLAB_HOST_KEY },
    select: {
      id: true,
      name: true,
      cpuCores: true,
      cpuCoresSource: true,
      cpuCoresProbedAt: true,
    },
  });

  return Response.json({
    matched: before.length,
    updated: result.count,
    noop: false,
    before,
    after,
  });
}
