import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { getZabbixClient, ZabbixApiError } from "@/lib/zabbix/client";
import { getApiInfo as get12eatInfo } from "@/lib/12eat/client";
import { DataSourceType } from "@/generated/prisma/enums";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type SourceStatus = "ok" | "degraded" | "down" | "not_configured";

interface SourceHealth {
  status: SourceStatus;
  latencyMs: number | null;
  error: string | null;
  lastSyncAt: string | null;
  ageMs: number | null;
  ageLabel: string | null;
  /** true if data is older than STALE_THRESHOLD_MS (1h per spec v2.1) */
  stale: boolean;
  details?: Record<string, unknown>;
}

const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1h — Architecture Spec v2.1 (Saoirse Flynn)
const CACHE_DIR = path.join(process.cwd(), ".cache");

function errMsg(e: unknown, fallback: string): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return fallback;
}

function formatAge(ms: number | null): string | null {
  if (ms === null || ms < 0) return null;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `prieš ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `prieš ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `prieš ${h} val`;
  const d = Math.floor(h / 24);
  return `prieš ${d} d`;
}

async function newestCacheMtime(prefix: string): Promise<Date | null> {
  try {
    const files = await fs.readdir(CACHE_DIR);
    const matches = files.filter((f) => f.startsWith(prefix) && f.endsWith(".json"));
    if (matches.length === 0) return null;
    let newest: Date | null = null;
    for (const f of matches) {
      const st = await fs.stat(path.join(CACHE_DIR, f));
      if (!newest || st.mtime > newest) newest = st.mtime;
    }
    return newest;
  } catch {
    return null;
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label}: timeout po ${ms}ms`)), ms)
    ),
  ]);
}

// ─── Database ────────────────────────────────────────────────────────
async function checkDatabase(): Promise<SourceHealth> {
  const t0 = Date.now();
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, 3000, "DB");
    const latencyMs = Date.now() - t0;
    const [pilotCount, deviceCount] = await Promise.all([
      prisma.pilot.count(),
      prisma.device.count(),
    ]);
    return {
      status: "ok",
      latencyMs,
      error: null,
      lastSyncAt: null,
      ageMs: null,
      ageLabel: null,
      stale: false,
      details: { pilotCount, deviceCount },
    };
  } catch (e: unknown) {
    return {
      status: "down",
      latencyMs: Date.now() - t0,
      error: errMsg(e, "DB prisijungimas nepavyko"),
      lastSyncAt: null,
      ageMs: null,
      ageLabel: null,
      stale: true,
    };
  }
}

// ─── Zabbix ──────────────────────────────────────────────────────────
async function checkZabbix(): Promise<SourceHealth> {
  const url = process.env.ZABBIX_URL;
  const token = process.env.ZABBIX_TOKEN;
  if (!url || !token) {
    return {
      status: "not_configured",
      latencyMs: null,
      error: "ZABBIX_URL ir ZABBIX_TOKEN nenustatyti",
      lastSyncAt: null,
      ageMs: null,
      ageLabel: null,
      stale: false,
    };
  }

  // Freshness sources: cache file mtime and DataSource.lastSyncAt (whichever is newer)
  const cacheMtime = await newestCacheMtime("zabbix-");
  let dbLastSync: Date | null = null;
  try {
    const ds = await prisma.dataSource.findFirst({
      where: { type: DataSourceType.ZABBIX, isActive: true, lastSyncAt: { not: null } },
      orderBy: { lastSyncAt: "desc" },
      select: { lastSyncAt: true },
    });
    dbLastSync = ds?.lastSyncAt ?? null;
  } catch {
    // ignore — DataSource table may not have ZABBIX records yet
  }

  const effectiveLastSync =
    [dbLastSync, cacheMtime]
      .filter((d): d is Date => d !== null)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const effectiveAgeMs = effectiveLastSync ? Date.now() - effectiveLastSync.getTime() : null;
  const urlDisplay = url.replace(/\/api_jsonrpc\.php$/, "");

  const t0 = Date.now();
  try {
    const client = getZabbixClient();
    const [version, hosts] = await withTimeout(
      Promise.all([client.getVersion(), client.getHosts()]),
      5000,
      "Zabbix"
    );
    const latencyMs = Date.now() - t0;
    const stale = effectiveAgeMs !== null && effectiveAgeMs > STALE_THRESHOLD_MS;
    return {
      status: stale ? "degraded" : "ok",
      latencyMs,
      error: null,
      lastSyncAt: effectiveLastSync?.toISOString() ?? null,
      ageMs: effectiveAgeMs,
      ageLabel: formatAge(effectiveAgeMs),
      stale,
      details: {
        version,
        hostsCount: hosts.length,
        url: urlDisplay,
      },
    };
  } catch (e: unknown) {
    const isAuthError =
      e instanceof ZabbixApiError && (e.code === -32602 || e.data?.includes("auth"));
    return {
      status: "down",
      latencyMs: Date.now() - t0,
      error: isAuthError
        ? "Autentifikacijos klaida — patikrinkite ZABBIX_TOKEN"
        : errMsg(e, "Nepavyko prisijungti"),
      lastSyncAt: effectiveLastSync?.toISOString() ?? null,
      ageMs: effectiveAgeMs,
      ageLabel: formatAge(effectiveAgeMs),
      stale: true,
      details: { url: urlDisplay },
    };
  }
}

// ─── 12eat ───────────────────────────────────────────────────────────
async function check12eat(): Promise<SourceHealth> {
  const info = get12eatInfo();
  const t0 = Date.now();
  try {
    const res = await withTimeout(
      fetch(`${info.baseUrl}/api/v1/export/transactions/latest-cursor`, {
        signal: AbortSignal.timeout(4000),
      }),
      5000,
      "12eat"
    );
    const latencyMs = Date.now() - t0;
    if (!res.ok) {
      return {
        status: "down",
        latencyMs,
        error: `HTTP ${res.status}`,
        lastSyncAt: null,
        ageMs: null,
        ageLabel: null,
        stale: true,
        details: { env: info.env, baseUrl: info.baseUrl },
      };
    }
    const body = (await res.json().catch(() => null)) as { cursor?: number } | null;
    return {
      status: "ok",
      latencyMs,
      error: null,
      lastSyncAt: null,
      ageMs: null,
      ageLabel: null,
      stale: false,
      details: { env: info.env, baseUrl: info.baseUrl, latestCursor: body?.cursor ?? null },
    };
  } catch (e: unknown) {
    return {
      status: "down",
      latencyMs: Date.now() - t0,
      error: errMsg(e, "Nepavyko prisijungti"),
      lastSyncAt: null,
      ageMs: null,
      ageLabel: null,
      stale: true,
      details: {
        env: info.env,
        baseUrl: info.baseUrl,
        note: "VPN gali būti reikalingas prod env",
      },
    };
  }
}

// ─── Handler ─────────────────────────────────────────────────────────
export async function GET() {
  const t0 = Date.now();
  const [database, zabbix, twelveEat] = await Promise.all([
    checkDatabase(),
    checkZabbix(),
    check12eat(),
  ]);

  const sources = { database, zabbix, twelveEat };
  const statuses: SourceStatus[] = [database.status, zabbix.status, twelveEat.status];

  // Overall: DB down → down; anything degraded or down → degraded; else healthy
  let overall: "healthy" | "degraded" | "down" = "healthy";
  if (database.status === "down") overall = "down";
  else if (statuses.some((s) => s === "down" || s === "degraded")) overall = "degraded";

  return NextResponse.json(
    {
      ok: overall === "healthy",
      status: overall,
      checkedAt: new Date().toISOString(),
      totalLatencyMs: Date.now() - t0,
      staleThresholdMs: STALE_THRESHOLD_MS,
      sources,
    },
    { status: overall === "down" ? 503 : 200 }
  );
}
