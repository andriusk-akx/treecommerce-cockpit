/**
 * GET /api/internal/rollup-cpu?pilotId=<id>&from=<iso>&to=<iso>
 * GET /api/internal/rollup-cpu?from=<iso>&to=<iso>     (all Retellect pilots)
 *
 * Pulls Zabbix CPU history for the given range and upserts daily +
 * hourly rollup rows for either one pilot or every Retellect pilot.
 * Gated by WARM_CACHE_SECRET (Bearer token) so the daily cron and the
 * manual backfill button can hit it but random callers can't.
 *
 * Default range when `from` / `to` are omitted: yesterday only. The
 * daily cron uses the default; manual backfill passes a wider window.
 *
 * Phase 4 of AKpilot spec v2.1.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { rollupPilotRange, rollupAllRetellectPilots } from "@/lib/cpu-rollup/writer";

export const dynamic = "force-dynamic";

/** Number of days to keep in the rollup tables. Anything older than this
 *  gets pruned by the daily cron (along with the ingestion run). 365 days
 *  matches Andrius's 6-month-minimum requirement with a generous buffer. */
const RETENTION_DAYS = 365;

function todayIsoVilnius(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Vilnius",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  let y = "", m = "", d = "";
  for (const p of parts) {
    if (p.type === "year") y = p.value;
    else if (p.type === "month") m = p.value;
    else if (p.type === "day") d = p.value;
  }
  return `${y}-${m}-${d}`;
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function parseIsoDate(s: string | null): string | null {
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get("authorization") ?? "";
  const expected = process.env.WARM_CACHE_SECRET;
  if (!expected || auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;
  const today = todayIsoVilnius();
  const yesterday = addDaysIso(today, -1);
  // Default: yesterday only (cron use). Manual backfill passes from/to.
  const fromIso = parseIsoDate(sp.get("from")) ?? yesterday;
  const toIso = parseIsoDate(sp.get("to")) ?? yesterday;
  if (fromIso > toIso) {
    return NextResponse.json({ error: "from > to" }, { status: 400 });
  }
  // Sanity cap — backfill more than 60 days at once is asking for
  // Zabbix timeouts (retention is ~29-42 d anyway).
  const daysInWindow = Math.round(
    (new Date(`${toIso}T00:00:00Z`).getTime() - new Date(`${fromIso}T00:00:00Z`).getTime()) / 86_400_000,
  ) + 1;
  // Fix #16: lower cap to 45 — Zabbix retention is ~29–42 d, so even
  // 45 is more than the backfill can possibly cover. Stops requests
  // that can't return useful data.
  if (daysInWindow > 45) {
    return NextResponse.json({ error: "range too large (max 45 days per call)" }, { status: 400 });
  }

  const pilotId = sp.get("pilotId");
  // Fix #19: validate pilotId shape (cuid: ~25 chars, starts with `c`,
  // lowercase alphanumeric). Catches typos before they hit Prisma.
  if (pilotId !== null && !/^c[a-z0-9]{20,30}$/.test(pilotId)) {
    return NextResponse.json({ error: "invalid pilotId format" }, { status: 400 });
  }
  const startedAt = new Date().toISOString();

  try {
    const results = pilotId
      ? [await rollupPilotRange(pilotId, fromIso, toIso)]
      : await rollupAllRetellectPilots(fromIso, toIso);

    // Retention cleanup — same call so the cron has a single thing to
    // hit. Caller can skip with `?retention=skip` if they're just
    // backfilling and don't want side effects.
    // Fix #2: include CpuProcessMetricHourly in the cleanup so the
    // per-process table doesn't grow unbounded.
    // Fix #3: include the per-process delete count in the response.
    let retentionDeleted:
      | { daily: number; hourly: number; processHourly: number }
      | null = null;
    if (sp.get("retention") !== "skip") {
      const cutoffDate = new Date(Date.now() - RETENTION_DAYS * 86_400 * 1000);
      const [d1, d2, d3] = await Promise.all([
        prisma.cpuMetricDaily.deleteMany({ where: { date: { lt: cutoffDate } } }),
        prisma.cpuMetricHourly.deleteMany({ where: { hourStart: { lt: cutoffDate } } }),
        prisma.cpuProcessMetricHourly.deleteMany({ where: { hourStart: { lt: cutoffDate } } }),
      ]);
      retentionDeleted = { daily: d1.count, hourly: d2.count, processHourly: d3.count };
    }

    return NextResponse.json({
      startedAt, finishedAt: new Date().toISOString(),
      window: { fromIso, toIso, days: daysInWindow },
      pilotCount: results.length,
      retentionDeleted,
      results,
    });
  } catch (e) {
    console.error("[rollup-cpu] failed:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 },
    );
  }
}
