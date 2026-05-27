/**
 * GET /api/rt/cpu-compare?pilotId=...&aFrom=...&aTo=...&bFrom=...&bTo=...
 *                       &threshold=70&aLabel=...&bLabel=...&hostIds=...
 *
 * Returns a side-by-side comparison of two equal-length periods (A vs B) for
 * the Retellect CPU Timeline sub-view. The contract is documented in
 *   docs/specs/cpu-timeline-compare-periods-spec.md §5
 *
 * Phase 1 (this commit):
 *   - Endpoint scaffolded with full input validation and a deterministic
 *     mocked payload so the UI can be wired end-to-end before Zabbix
 *     plumbing lands.
 *   - The mock seeds itself off the pilotId + period dates so reloads stay
 *     stable and screenshots are reproducible.
 *
 * Phase 2 (next commit) wires this to two parallel `getCpuHistoryDaily`
 * calls (one per period) and computes real KPIs / overlay / host deltas
 * via `src/lib/rt/compare/compute.ts`.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  COMPARE_THRESHOLDS,
  type CompareErrorResponse,
  type CompareHostRow,
  type CompareResponse,
  type CompareThreshold,
  type OverlayPoint,
} from "@/components/rt/compare/types";

export const dynamic = "force-dynamic";

/** Hard cap from Zabbix history.get retention on this deployment (~42 d).
 *  Periods that reach further back than this are rejected outright (422). */
const MAX_RETENTION_DAYS = 42;
/** Anything older than this falls back to hourly trend data → lower
 *  resolution. We accept the query but flag dataQuality = "trend-only". */
const HISTORY_GRAIN_DAYS = 14;

interface ParsedQuery {
  pilotId: string;
  aFrom: string;
  aTo: string;
  bFrom: string;
  bTo: string;
  threshold: CompareThreshold;
  aLabel: string | null;
  bLabel: string | null;
  hostIds: string[] | null;
}

function err(
  status: number,
  code: CompareErrorResponse["code"],
  message: string,
  details?: Record<string, unknown>,
): NextResponse<CompareErrorResponse> {
  return NextResponse.json({ error: message, code, details }, { status });
}

function parseDate(s: string | null, field: string): { ok: true; value: string } | { ok: false; field: string } {
  if (!s) return { ok: false, field };
  // ISO YYYY-MM-DD strict
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return { ok: false, field };
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return { ok: false, field };
  return { ok: true, value: s };
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.UTC(
    Number(fromIso.slice(0, 4)),
    Number(fromIso.slice(5, 7)) - 1,
    Number(fromIso.slice(8, 10)),
  );
  const b = Date.UTC(
    Number(toIso.slice(0, 4)),
    Number(toIso.slice(5, 7)) - 1,
    Number(toIso.slice(8, 10)),
  );
  return Math.round((b - a) / 86_400_000) + 1; // inclusive
}

function rangesOverlap(aFrom: string, aTo: string, bFrom: string, bTo: string): boolean {
  return !(aTo < bFrom || bTo < aFrom);
}

function todayUtcIso(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function daysSinceToday(iso: string): number {
  return daysBetween(iso, todayUtcIso()) - 1;
}

/** Deterministic PRNG seeded by a string so mock data stays stable
 *  across reloads. Mulberry32 — sufficient for visual testing. */
function seededRng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function validate(req: NextRequest): { ok: true; q: ParsedQuery } | { ok: false; resp: NextResponse } {
  const sp = req.nextUrl.searchParams;
  const pilotId = sp.get("pilotId");
  if (!pilotId) return { ok: false, resp: err(400, "VALIDATION", "pilotId is required") };

  const aFrom = parseDate(sp.get("aFrom"), "aFrom");
  const aTo = parseDate(sp.get("aTo"), "aTo");
  const bFrom = parseDate(sp.get("bFrom"), "bFrom");
  const bTo = parseDate(sp.get("bTo"), "bTo");
  for (const r of [aFrom, aTo, bFrom, bTo]) {
    if (!r.ok) return { ok: false, resp: err(400, "VALIDATION", `Invalid or missing date: ${r.field}`) };
  }
  // Type narrowing — TS doesn't see the for-loop guard.
  if (!aFrom.ok || !aTo.ok || !bFrom.ok || !bTo.ok) {
    return { ok: false, resp: err(400, "VALIDATION", "date parse error") };
  }
  if (aFrom.value > aTo.value) return { ok: false, resp: err(400, "VALIDATION", "Period A: from > to") };
  if (bFrom.value > bTo.value) return { ok: false, resp: err(400, "VALIDATION", "Period B: from > to") };

  const aLen = daysBetween(aFrom.value, aTo.value);
  const bLen = daysBetween(bFrom.value, bTo.value);
  if (aLen !== bLen) {
    return { ok: false, resp: err(400, "VALIDATION", "Period A and Period B must be the same length", { aLen, bLen }) };
  }
  if (rangesOverlap(aFrom.value, aTo.value, bFrom.value, bTo.value)) {
    return { ok: false, resp: err(400, "VALIDATION", "Period A and Period B overlap") };
  }

  const oldestSeen = aFrom.value < bFrom.value ? aFrom.value : bFrom.value;
  if (daysSinceToday(oldestSeen) > MAX_RETENTION_DAYS) {
    return {
      ok: false,
      resp: err(422, "RETENTION", `Period start is older than ${MAX_RETENTION_DAYS} days (Zabbix history retention limit)`, {
        oldest: oldestSeen,
      }),
    };
  }

  const thrRaw = sp.get("threshold");
  const thrNum = thrRaw ? Number(thrRaw) : 70;
  if (!COMPARE_THRESHOLDS.includes(thrNum as CompareThreshold)) {
    return {
      ok: false,
      resp: err(400, "VALIDATION", `threshold must be one of ${COMPARE_THRESHOLDS.join(", ")}`, { received: thrRaw }),
    };
  }

  const aLabelRaw = sp.get("aLabel");
  const bLabelRaw = sp.get("bLabel");
  const aLabel = aLabelRaw && aLabelRaw.length <= 60 ? aLabelRaw : null;
  const bLabel = bLabelRaw && bLabelRaw.length <= 60 ? bLabelRaw : null;

  const hostIdsRaw = sp.get("hostIds");
  const hostIds = hostIdsRaw ? hostIdsRaw.split(",").map((s) => s.trim()).filter(Boolean) : null;

  return {
    ok: true,
    q: {
      pilotId,
      aFrom: aFrom.value,
      aTo: aTo.value,
      bFrom: bFrom.value,
      bTo: bTo.value,
      threshold: thrNum as CompareThreshold,
      aLabel,
      bLabel,
      hostIds,
    },
  };
}

interface MockHost {
  id: string;
  name: string;
  storeName: string;
  cpuModel: string | null;
  cpuCores: number | null;
}

async function resolveHosts(pilotId: string, hostFilter: string[] | null): Promise<MockHost[]> {
  const pilot = await prisma.pilot.findUnique({
    where: { id: pilotId },
    include: {
      devices: {
        include: { store: { select: { name: true } } },
        orderBy: { name: "asc" },
      },
    },
  });
  if (!pilot) return [];
  const all = pilot.devices.map((d) => ({
    id: d.id,
    name: d.name,
    storeName: d.store?.name ?? "Unknown store",
    cpuModel: d.cpuModel ?? null,
    cpuCores: d.cpuCores ?? null,
  }));
  if (!hostFilter || hostFilter.length === 0) return all;
  const allowed = new Set(hostFilter);
  return all.filter((h) => allowed.has(h.id));
}

/**
 * Builds a synthetic-but-stable payload so the UI can be developed and demo'd
 * before the real data path lands. Numbers fall in a plausible range; B period
 * is biased lower (mock "post-rollout" improvement).
 */
function buildMockPayload(q: ParsedQuery, hosts: MockHost[]): CompareResponse {
  const periodLength = daysBetween(q.aFrom, q.aTo);
  const seed = `${q.pilotId}|${q.aFrom}|${q.bFrom}|${q.threshold}`;
  const rng = seededRng(seed);

  const hostRows: CompareHostRow[] = hosts.map((h, idx) => {
    // Per-host base activity, deterministic.
    const baseMin = 80 + Math.floor(rng() * 380);   // ~80..460 min above threshold in period A
    const improvement = 0.4 + rng() * 0.5;          // 40..90% reduction in mock
    const aMinutes = baseMin;
    const bMinutes = Math.max(8, Math.round(baseMin * (1 - improvement)));
    const aMean = 35 + rng() * 30;
    const bMean = aMean - 8 - rng() * 10;
    const aP95 = Math.min(99, aMean + 15 + rng() * 15);
    const bP95 = Math.min(99, bMean + 10 + rng() * 12);

    const aSpark = Array.from({ length: periodLength }, () => Math.round(rng() * 100));
    const bSpark = Array.from({ length: periodLength }, () => Math.round(rng() * 60));

    // Demonstrate the "added in B" badge for one row when the pilot has >=4 hosts.
    const hostScope = idx === hosts.length - 1 && hosts.length >= 4 ? "added-in-b" : "both";
    const aSamples = hostScope === "added-in-b" ? 0 : 9000 + Math.floor(rng() * 1500);
    const bSamples = 9000 + Math.floor(rng() * 1500);

    return {
      hostId: h.id,
      hostName: h.name,
      storeName: h.storeName,
      cpuModel: h.cpuModel,
      cpuCores: h.cpuCores,
      aMinutesAbove: hostScope === "added-in-b" ? 0 : aMinutes,
      bMinutesAbove: bMinutes,
      deltaMinutesAbs: bMinutes - (hostScope === "added-in-b" ? 0 : aMinutes),
      deltaMinutesPct: hostScope === "added-in-b" ? null : Math.round(((bMinutes - aMinutes) / aMinutes) * 1000) / 10,
      aMeanCpu: Math.round(aMean * 10) / 10,
      bMeanCpu: Math.round(bMean * 10) / 10,
      aP95Cpu: Math.round(aP95 * 10) / 10,
      bP95Cpu: Math.round(bP95 * 10) / 10,
      aSamples,
      bSamples,
      aSparkline: hostScope === "added-in-b" ? [] : aSpark,
      bSparkline: bSpark,
      dataQuality: daysSinceToday(q.aFrom) > HISTORY_GRAIN_DAYS ? "trend-only" : "full",
      hostScope,
    };
  });

  // Aggregate KPIs
  const sumA = hostRows.reduce((s, r) => s + r.aMinutesAbove, 0);
  const sumB = hostRows.reduce((s, r) => s + r.bMinutesAbove, 0);
  const meanA = hostRows.length === 0 ? 0
    : Math.round((hostRows.reduce((s, r) => s + r.aMeanCpu, 0) / hostRows.length) * 10) / 10;
  const meanB = hostRows.length === 0 ? 0
    : Math.round((hostRows.reduce((s, r) => s + r.bMeanCpu, 0) / hostRows.length) * 10) / 10;
  const p95A = hostRows.length === 0 ? 0
    : Math.round((hostRows.reduce((s, r) => s + r.aP95Cpu, 0) / hostRows.length) * 10) / 10;
  const p95B = hostRows.length === 0 ? 0
    : Math.round((hostRows.reduce((s, r) => s + r.bP95Cpu, 0) / hostRows.length) * 10) / 10;
  const totalMinutesPerPeriod = periodLength * 24 * 60 * Math.max(hostRows.length, 1);
  const pctA = Math.round((sumA / totalMinutesPerPeriod) * 1000) / 10;
  const pctB = Math.round((sumB / totalMinutesPerPeriod) * 1000) / 10;

  const delta = (a: number, b: number) => ({
    a, b,
    deltaAbs: Math.round((b - a) * 10) / 10,
    deltaPct: a === 0 ? null : Math.round(((b - a) / a) * 1000) / 10,
  });

  // Overlay: time-of-day alignment at 5-minute granularity (288 slots) so
  // the chart stays cheap to render even in mock mode. Real path may use
  // 1-min or downsample.
  const SLOT_MIN = 5;
  const TOTAL_SLOTS = (24 * 60) / SLOT_MIN; // 288
  const points: OverlayPoint[] = [];
  for (let i = 0; i < TOTAL_SLOTS; i++) {
    const tod = i * SLOT_MIN;          // minutes since midnight
    const hour = tod / 60;
    // Two daily peaks at ~10:30 and ~17:30, like Rimi traffic.
    const trafficShape = (hr: number) =>
      Math.exp(-Math.pow((hr - 10.5) / 2.4, 2)) +
      Math.exp(-Math.pow((hr - 17.5) / 2.6, 2));
    const shapeA = trafficShape(hour);
    const shapeB = trafficShape(hour) * 0.55;     // mock improvement
    const noiseA = (rng() - 0.5) * 6;
    const noiseB = (rng() - 0.5) * 4;
    const aCpu = Math.min(95, Math.max(3, 18 + shapeA * 60 + noiseA));
    const bCpu = Math.min(95, Math.max(3, 16 + shapeB * 55 + noiseB));
    points.push({
      offsetMin: tod,
      aCpu: Math.round(aCpu * 10) / 10,
      bCpu: Math.round(bCpu * 10) / 10,
      aMinutesAbove: aCpu > q.threshold ? hostRows.length * SLOT_MIN : 0,
      bMinutesAbove: bCpu > q.threshold ? Math.round(hostRows.length * SLOT_MIN * 0.3) : 0,
    });
  }

  return {
    meta: {
      pilotId: q.pilotId,
      threshold: q.threshold,
      periodLengthDays: periodLength,
      periodA: { from: q.aFrom, to: q.aTo, label: q.aLabel },
      periodB: { from: q.bFrom, to: q.bTo, label: q.bLabel },
      dataQuality: {
        periodA: daysSinceToday(q.aFrom) > HISTORY_GRAIN_DAYS ? "trend-only" : "full",
        periodB: daysSinceToday(q.bFrom) > HISTORY_GRAIN_DAYS ? "trend-only" : "full",
        warnings: [
          ...(daysSinceToday(q.aFrom) > HISTORY_GRAIN_DAYS
            ? [`Period A older than ${HISTORY_GRAIN_DAYS}d — minute-level data partial, using hourly trend`]
            : []),
          ...(daysSinceToday(q.bFrom) > HISTORY_GRAIN_DAYS
            ? [`Period B older than ${HISTORY_GRAIN_DAYS}d — minute-level data partial, using hourly trend`]
            : []),
          "MOCK PAYLOAD — real Zabbix path lands in next commit",
        ],
      },
      generatedAt: new Date().toISOString(),
    },
    kpis: {
      minutesAboveThreshold: delta(sumA, sumB),
      meanCpu: delta(meanA, meanB),
      p95Cpu: delta(p95A, p95B),
      pctTimeAboveThreshold: delta(pctA, pctB),
    },
    overlay: {
      alignment: "time-of-day",
      totalSlots: TOTAL_SLOTS,
      slotMinutes: SLOT_MIN,
      points,
    },
    hostRows,
  };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const v = validate(req);
  if (!v.ok) return v.resp;
  const hosts = await resolveHosts(v.q.pilotId, v.q.hostIds);
  if (hosts.length === 0) {
    return err(404, "VALIDATION", "Pilot not found or has no devices", { pilotId: v.q.pilotId });
  }
  const payload = buildMockPayload(v.q, hosts);
  return NextResponse.json(payload);
}
