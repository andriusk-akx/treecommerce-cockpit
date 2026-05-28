/**
 * GET /api/rt/cpu-compare?pilotId=...&aFrom=...&aTo=...&bFrom=...&bTo=...
 *                       &threshold=70&aLabel=...&bLabel=...&hostIds=...
 *                       &alignment=time-of-day|absolute-offset
 *                       &mock=1
 *
 * Returns a side-by-side comparison of two equal-length periods (A vs B) for
 * the Retellect CPU Timeline sub-view. The contract is documented in
 *   docs/specs/cpu-timeline-compare-periods-spec.md §5
 *
 * Phase 2 (this commit):
 *   - Real Zabbix path: resolve pilot devices to Zabbix items, run two
 *     parallel `getCpuHistoryForRange` calls, hand the result to
 *     `buildCompareResponse`.
 *   - `?mock=1` flag keeps the deterministic mock payload available for
 *     UI development and screenshot reproducibility.
 *
 * Phase 3+ will add per-host parallelism tuning and result caching.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getZabbixClient } from "@/lib/zabbix/client";
import {
  COMPARE_THRESHOLDS,
  type CompareAlignment,
  type CompareErrorResponse,
  type CompareHostRow,
  type CompareResponse,
  type CompareThreshold,
  type OverlayPoint,
  type DataQuality,
} from "@/components/rt/compare/types";
import { resolvePilotHosts } from "@/lib/rt/compare/resolve";
import { buildCompareResponse, type HostMeta } from "@/lib/rt/compare/compute";

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
  /** Optional: restrict comparison to hosts with this exact CPU model.
   *  null = all CPU models. */
  cpuModel: string | null;
  alignment: CompareAlignment;
  useMock: boolean;
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

/**
 * Convert an ISO date in pilot timezone (Europe/Vilnius) to a Unix seconds
 * range covering midnight..midnight. We approximate via UTC + a fixed 0..-3h
 * offset is wrong for Vilnius (UTC+2/+3 with DST); use Intl to walk the
 * actual local boundary.
 */
function isoToVilniusUnix(iso: string, hour: number): number {
  // Compute the Unix timestamp at which the given ISO date hits `hour`:00
  // local-Vilnius time. Approach: trial-and-error against Intl, since JS has
  // no clean way to construct a "Y-M-D in zone Z" Date.
  const guessUtc = Date.UTC(
    Number(iso.slice(0, 4)),
    Number(iso.slice(5, 7)) - 1,
    Number(iso.slice(8, 10)),
    hour,
    0,
    0,
  );
  // Vilnius is UTC+2 in winter, UTC+3 in summer. Try -3, then -2, snap to whichever lands on the requested local hour.
  for (const offsetHours of [-3, -2]) {
    const candidate = guessUtc + offsetHours * 3600 * 1000;
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Vilnius",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date(candidate));
    let y = "", m = "", d = "", h = "";
    for (const p of parts) {
      if (p.type === "year") y = p.value;
      else if (p.type === "month") m = p.value;
      else if (p.type === "day") d = p.value;
      else if (p.type === "hour") h = p.value;
    }
    const formattedIso = `${y}-${m}-${d}`;
    const formattedHour = parseInt(h === "24" ? "0" : h, 10);
    if (formattedIso === iso && formattedHour === hour) {
      return Math.floor(candidate / 1000);
    }
  }
  // Should be unreachable for Europe/Vilnius midnight: both winter (UTC+2)
  // and summer (UTC+3) offsets are tried above. If we land here, the host's
  // Intl data is corrupted or the date is inside a DST gap (e.g. 03:00 on
  // spring-forward day). Throw loudly instead of silently returning a UTC
  // offset that would be 2-3h wrong.
  throw new Error(
    `isoToVilniusUnix: could not resolve ${iso} ${String(hour).padStart(2, "0")}:00 to Vilnius local time — possible DST gap or Intl misconfiguration`,
  );
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

  const cpuModelRaw = sp.get("cpuModel");
  const cpuModel = cpuModelRaw && cpuModelRaw.trim() && cpuModelRaw !== "all" ? cpuModelRaw.trim() : null;

  const alignmentRaw = sp.get("alignment");
  const alignment: CompareAlignment =
    alignmentRaw === "absolute-offset" ? "absolute-offset" : "time-of-day";

  const useMock = sp.get("mock") === "1";

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
      cpuModel,
      alignment,
      useMock,
    },
  };
}

// ── Mock payload (kept from Phase 1; reachable via ?mock=1) ───────────

interface MockHost {
  id: string;
  name: string;
  storeName: string;
  cpuModel: string | null;
  cpuCores: number | null;
}

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

async function resolveMockHosts(pilotId: string, hostFilter: string[] | null): Promise<MockHost[]> {
  const pilot = await prisma.pilot.findUnique({
    where: { id: pilotId },
    include: { devices: { include: { store: { select: { name: true } } }, orderBy: { name: "asc" } } },
  });
  if (!pilot) return [];
  const all = pilot.devices.map((d) => ({
    id: d.id, name: d.name,
    storeName: d.store?.name ?? "Unknown store",
    cpuModel: d.cpuModel ?? null,
    cpuCores: d.cpuCores ?? null,
  }));
  if (!hostFilter || hostFilter.length === 0) return all;
  const allowed = new Set(hostFilter);
  return all.filter((h) => allowed.has(h.id));
}

function buildMockPayload(q: ParsedQuery, hosts: MockHost[]): CompareResponse {
  const periodLength = daysBetween(q.aFrom, q.aTo);
  const seed = `${q.pilotId}|${q.aFrom}|${q.bFrom}|${q.threshold}`;
  const rng = seededRng(seed);

  const hostRows: CompareHostRow[] = hosts.map((h, idx) => {
    const baseMin = 80 + Math.floor(rng() * 380);
    const improvement = 0.4 + rng() * 0.5;
    const aMinutes = baseMin;
    const bMinutes = Math.max(8, Math.round(baseMin * (1 - improvement)));
    const aMean = 35 + rng() * 30;
    const bMean = aMean - 8 - rng() * 10;
    const aSpark = Array.from({ length: periodLength }, () => Math.round(rng() * 100));
    const bSpark = Array.from({ length: periodLength }, () => Math.round(rng() * 60));
    const hostScope = idx === hosts.length - 1 && hosts.length >= 4 ? "added-in-b" : "both";
    const aSamples = hostScope === "added-in-b" ? 0 : 9000 + Math.floor(rng() * 1500);
    const bSamples = 9000 + Math.floor(rng() * 1500);
    return {
      hostId: h.id, hostName: h.name, storeName: h.storeName,
      cpuModel: h.cpuModel, cpuCores: h.cpuCores,
      aMinutesAbove: hostScope === "added-in-b" ? 0 : aMinutes,
      bMinutesAbove: bMinutes,
      deltaMinutesAbs: bMinutes - (hostScope === "added-in-b" ? 0 : aMinutes),
      deltaMinutesPct: hostScope === "added-in-b" ? null : Math.round(((bMinutes - aMinutes) / aMinutes) * 1000) / 10,
      aMeanCpu: Math.round(aMean * 10) / 10,
      bMeanCpu: Math.round(bMean * 10) / 10,
      aSamples, bSamples,
      aSparkline: hostScope === "added-in-b" ? [] : aSpark,
      bSparkline: bSpark,
      dataQuality: daysSinceToday(q.aFrom) > HISTORY_GRAIN_DAYS ? "trend-only" : "full",
      hostScope,
    };
  });

  const sumA = hostRows.reduce((s, r) => s + r.aMinutesAbove, 0);
  const sumB = hostRows.reduce((s, r) => s + r.bMinutesAbove, 0);
  const meanA = hostRows.length === 0 ? 0
    : Math.round((hostRows.reduce((s, r) => s + r.aMeanCpu, 0) / hostRows.length) * 10) / 10;
  const meanB = hostRows.length === 0 ? 0
    : Math.round((hostRows.reduce((s, r) => s + r.bMeanCpu, 0) / hostRows.length) * 10) / 10;
  const totalMinutesPerPeriod = periodLength * 24 * 60 * Math.max(hostRows.length, 1);
  const pctA = Math.round((sumA / totalMinutesPerPeriod) * 1000) / 10;
  const pctB = Math.round((sumB / totalMinutesPerPeriod) * 1000) / 10;
  const delta = (a: number, b: number) => ({
    a, b,
    deltaAbs: Math.round((b - a) * 10) / 10,
    deltaPct: a === 0 ? null : Math.round(((b - a) / a) * 1000) / 10,
  });

  const SLOT_MIN = 5;
  const TOTAL_SLOTS = (24 * 60) / SLOT_MIN;
  const points: OverlayPoint[] = [];
  for (let i = 0; i < TOTAL_SLOTS; i++) {
    const tod = i * SLOT_MIN;
    const hour = tod / 60;
    const trafficShape = (hr: number) =>
      Math.exp(-Math.pow((hr - 10.5) / 2.4, 2)) +
      Math.exp(-Math.pow((hr - 17.5) / 2.6, 2));
    const shapeA = trafficShape(hour);
    const shapeB = trafficShape(hour) * 0.55;
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
            ? [`Period A older than ${HISTORY_GRAIN_DAYS}d - minute-level data partial, using hourly trend`]
            : []),
          ...(daysSinceToday(q.bFrom) > HISTORY_GRAIN_DAYS
            ? [`Period B older than ${HISTORY_GRAIN_DAYS}d - minute-level data partial, using hourly trend`]
            : []),
          "MOCK PAYLOAD - ?mock=1 in URL",
        ],
      },
      generatedAt: new Date().toISOString(),
    },
    kpis: {
      minutesAboveThreshold: delta(sumA, sumB),
      meanCpu: delta(meanA, meanB),
      pctTimeAboveThreshold: delta(pctA, pctB),
    },
    overlay: { alignment: "time-of-day", totalSlots: TOTAL_SLOTS, slotMinutes: SLOT_MIN, points },
    hostRows,
  };
}

// ── Real payload (Phase 2) ──────────────────────────────────────────

function dataQualityFor(iso: string): DataQuality {
  return daysSinceToday(iso) > HISTORY_GRAIN_DAYS ? "trend-only" : "full";
}

async function buildRealPayload(q: ParsedQuery, hosts: HostMeta[], itemIds: string[], itemHostMap: Map<string, string>): Promise<CompareResponse> {
  const client = getZabbixClient();

  // Period boundaries in Vilnius local time. aFrom = midnight start;
  // aTo = midnight end of (aTo + 1) day to make `[aFromSec, aToSec)` inclusive.
  const aFromSec = isoToVilniusUnix(q.aFrom, 0);
  const aToSec = isoToVilniusUnix(addDayIso(q.aTo, 1), 0);
  const bFromSec = isoToVilniusUnix(q.bFrom, 0);
  const bToSec = isoToVilniusUnix(addDayIso(q.bTo, 1), 0);

  const [periodA, periodB] = await Promise.all([
    client.getCpuHistoryForRange(itemIds, itemHostMap, aFromSec, aToSec),
    client.getCpuHistoryForRange(itemIds, itemHostMap, bFromSec, bToSec),
  ]);

  const warnings: string[] = [];
  const dqA = dataQualityFor(q.aFrom);
  const dqB = dataQualityFor(q.bFrom);
  if (dqA !== "full") warnings.push(`Period A older than ${HISTORY_GRAIN_DAYS}d - minute-level data partial, using hourly trend`);
  if (dqB !== "full") warnings.push(`Period B older than ${HISTORY_GRAIN_DAYS}d - minute-level data partial, using hourly trend`);

  return buildCompareResponse({
    pilotId: q.pilotId,
    hosts,
    threshold: q.threshold,
    aFromSec, aToSec, bFromSec, bToSec,
    aFromIso: q.aFrom, aToIso: q.aTo, bFromIso: q.bFrom, bToIso: q.bTo,
    aLabel: q.aLabel, bLabel: q.bLabel,
    alignment: q.alignment,
    periodA, periodB,
    dataQualityA: dqA,
    dataQualityB: dqB,
    warnings,
  });
}

function addDayIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const v = validate(req);
  if (!v.ok) return v.resp;

  // ── Mock mode (?mock=1) ──────────────────────────────────────────
  if (v.q.useMock) {
    const allMock = await resolveMockHosts(v.q.pilotId, v.q.hostIds);
    const hosts = v.q.cpuModel ? allMock.filter((h) => h.cpuModel === v.q.cpuModel) : allMock;
    if (hosts.length === 0) {
      return err(404, "VALIDATION", "Pilot not found or has no matching devices", {
        pilotId: v.q.pilotId, cpuModel: v.q.cpuModel,
      });
    }
    return NextResponse.json(buildMockPayload(v.q, hosts));
  }

  // ── Real path ────────────────────────────────────────────────────
  try {
    const resolved = await resolvePilotHosts(v.q.pilotId, v.q.hostIds, v.q.cpuModel);
    if (resolved.hosts.length === 0) {
      return err(404, "VALIDATION", "No matching Zabbix hosts found for the selected pilot/hosts/CPU model", {
        pilotId: v.q.pilotId,
        cpuModel: v.q.cpuModel,
        unmatchedDeviceIds: resolved.unmatchedDeviceIds,
      });
    }
    const payload = await buildRealPayload(v.q, resolved.hosts, resolved.itemIds, resolved.itemHostMap);
    return NextResponse.json(payload);
  } catch (e) {
    console.error("[cpu-compare] real path failed:", e);
    const message = e instanceof Error ? e.message : "Unknown error";
    return err(500, "INTERNAL", `Failed to compute comparison: ${message}`);
  }
}
