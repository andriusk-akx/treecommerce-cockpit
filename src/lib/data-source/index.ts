/**
 * Universal Data Source Manager
 *
 * Provides a unified system for fetching data from multiple APIs with
 * automatic cache fallback. Each data source (12eat, Zabbix, DB, etc.)
 * is tracked independently with its own status, cache, and metadata.
 *
 * Usage:
 *
 *   const result = await dataSource.fetch("zabbix-problems", {
 *     source: "zabbix",
 *     label: "Zabbix Problems",
 *     env: "prod",
 *     fetcher: () => zClient.getProblems(),
 *   });
 *
 *   result.status   → "live" | "cached" | "unavailable"
 *   result.data     → the fetched data (or null if unavailable)
 *   result.cachedAt → ISO timestamp of cache (null if live)
 *   result.error    → error message if failed
 */

import { readFile, writeFile, mkdir, readdir, stat } from "fs/promises";
import { join } from "path";

// ─── Types ──────────────────────────────────────────────────────────

export type DataStatus = "live" | "cached" | "unavailable";

/** Result of a single data source fetch */
export interface SourceResult<T = unknown> {
  /** The actual data, or null if unavailable */
  data: T | null;
  /** Current status of this source */
  status: DataStatus;
  /** ISO timestamp when data was cached (null if live) */
  cachedAt: string | null;
  /** Human-readable source name */
  source: string;
  /** Human-readable label */
  label: string;
  /** Environment (test/prod/etc.) */
  env: string;
  /** Error message if fetch failed */
  error: string | null;
  /** How long the fetch took (ms) */
  fetchMs: number;
}

/** Options for a fetch call */
export interface FetchOptions<T> {
  /** Source identifier (e.g. "12eat", "zabbix", "db") */
  source: string;
  /** Human-readable label (e.g. "12eat Pardavimai", "Zabbix Monitoringas") */
  label: string;
  /** Environment identifier */
  env: string;
  /** The live data fetcher function */
  fetcher: () => Promise<T>;
  /** Max age of cache in ms before it's considered stale (default: no limit).
   *  Applies to the failure-fallback path only — a cache entry older than
   *  this is treated as if absent when the live fetcher errors. */
  maxCacheAgeMs?: number;
  /**
   * Stale-while-revalidate TTL.
   *
   * When set, `fetchSource` first checks the disk cache: if an entry is
   * present AND younger than `freshFor` ms, the cached data is returned
   * immediately (status: "live", with `cachedAt` set so the source-status
   * UI can display the freshness), and a background revalidation kicks off
   * to refresh the cache for the next request.
   *
   * When unset (default), every call hits the live fetcher and the cache
   * is only consulted on failure — original behaviour, preserved.
   *
   * Use a TTL that's lower than the upstream poll cadence: monitoring data
   * with 1-min Zabbix poll cycles is honest at 30-60 s; faster than that
   * just wastes round-trips with no UX win. The TTL is meaningful only for
   * paths that benefit from sub-second responses (dashboard first paint,
   * drill-down panels) — single-call admin operations can leave it unset.
   */
  freshFor?: number;
}

/**
 * Per-key in-flight revalidation tracker so background revalidations don't
 * stack on top of each other when many concurrent requests hit the same
 * stale-but-fresh path. The first request kicks off the revalidate; the
 * rest see the flag set and skip — they all already returned the cached
 * payload to their callers, so there's nothing further to do.
 */
const revalidating = new Set<string>();

/** Persisted cache entry */
interface CacheEntry<T> {
  data: T;
  cachedAt: string;
  source: string;
  label: string;
  env: string;
}

/** Summary of all sources for the status bar */
export interface SourceSummary {
  source: string;
  label: string;
  env: string;
  status: DataStatus;
  cachedAt: string | null;
  error: string | null;
  fetchMs: number;
}

// ─── Config ──────────────────────────────────────────────────────────

const CACHE_DIR = join(process.cwd(), ".cache");

// ─── Cache I/O ──────────────────────────────────────────────────────

async function ensureCacheDir() {
  try { await mkdir(CACHE_DIR, { recursive: true }); } catch { /* ok */ }
}

function safeName(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function cachePath(key: string): string {
  return join(CACHE_DIR, `${safeName(key)}.json`);
}

async function writeToCache<T>(key: string, data: T, source: string, label: string, env: string): Promise<void> {
  try {
    await ensureCacheDir();
    const entry: CacheEntry<T> = { data, cachedAt: new Date().toISOString(), source, label, env };
    await writeFile(cachePath(key), JSON.stringify(entry), "utf-8");
  } catch { /* non-critical */ }
}

async function readFromCache<T>(key: string): Promise<CacheEntry<T> | null> {
  try {
    const raw = await readFile(cachePath(key), "utf-8");
    return JSON.parse(raw) as CacheEntry<T>;
  } catch {
    return null;
  }
}

// ─── Core fetch logic ───────────────────────────────────────────────

/**
 * Fetch data from a source with automatic cache fallback.
 *
 * 1. Try live fetcher
 *    → success: save to cache, return { status: "live", data }
 * 2. On failure, try cache
 *    → found & not expired: return { status: "cached", data, cachedAt }
 * 3. Nothing available
 *    → return { status: "unavailable", data: null }
 */
export async function fetchSource<T>(
  cacheKey: string,
  opts: FetchOptions<T>,
): Promise<SourceResult<T>> {
  const t0 = Date.now();

  // 0. Stale-while-revalidate fast path.
  //    If the caller opted in (freshFor > 0) AND we have a cache entry
  //    younger than freshFor ms on disk, return that cached data RIGHT
  //    NOW and kick off a background revalidation. The user gets first
  //    paint in single-digit ms instead of waiting 1–3 s for a live
  //    Zabbix round-trip — typical dashboard refresh window.
  if (opts.freshFor && opts.freshFor > 0) {
    const cached = await readFromCache<T>(cacheKey);
    if (cached) {
      const ageMs = Date.now() - new Date(cached.cachedAt).getTime();
      if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= opts.freshFor) {
        // Background revalidate (no await) — but dedupe so a stampede of
        // 7 parallel page fetchers doesn't fire 7 simultaneous revalidate
        // requests against Zabbix for the same key.
        if (!revalidating.has(cacheKey)) {
          revalidating.add(cacheKey);
          // Detach from the request lifecycle. Errors here are intentionally
          // swallowed: the user already got cached data, so a revalidation
          // failure should not leak into their response. Next request that
          // sees stale-cache will try again.
          void (async () => {
            try {
              const data = await opts.fetcher();
              await writeToCache(cacheKey, data, opts.source, opts.label, opts.env);
            } catch {
              /* revalidation failed — keep the existing cache, next request retries */
            } finally {
              revalidating.delete(cacheKey);
            }
          })();
        }
        const fetchMs = Date.now() - t0;
        // Status is "live" (not "cached") because the data is within the
        // freshness window the caller declared acceptable. The cachedAt
        // field lets the source-status UI still show "X seconds old" if
        // it wants to surface that — purely informational.
        return {
          data: cached.data,
          status: "live",
          cachedAt: cached.cachedAt,
          source: opts.source,
          label: opts.label,
          env: opts.env,
          error: null,
          fetchMs,
        };
      }
    }
    // Cache miss or older than freshFor — fall through to live fetch below.
  }

  // 1. Try live
  try {
    const data = await opts.fetcher();
    const fetchMs = Date.now() - t0;
    // Save to cache in background (don't await)
    writeToCache(cacheKey, data, opts.source, opts.label, opts.env);
    return {
      data,
      status: "live",
      cachedAt: null,
      source: opts.source,
      label: opts.label,
      env: opts.env,
      error: null,
      fetchMs,
    };
  } catch (e: any) {
    // Live failed — continue to cache
    const liveError = e?.message || "Nepavyko prisijungti";

    // 2. Try cache
    const cached = await readFromCache<T>(cacheKey);
    const fetchMs = Date.now() - t0;

    if (cached) {
      // Check max age if specified
      if (opts.maxCacheAgeMs) {
        const age = Date.now() - new Date(cached.cachedAt).getTime();
        if (age > opts.maxCacheAgeMs) {
          return {
            data: null,
            status: "unavailable",
            cachedAt: cached.cachedAt,
            source: opts.source,
            label: opts.label,
            env: opts.env,
            error: `${liveError} (cache per senas: ${formatAge(age)})`,
            fetchMs,
          };
        }
      }
      return {
        data: cached.data,
        status: "cached",
        cachedAt: cached.cachedAt,
        source: opts.source,
        label: opts.label,
        env: opts.env,
        error: null,
        fetchMs,
      };
    }

    // 3. Nothing available
    return {
      data: null,
      status: "unavailable",
      cachedAt: null,
      source: opts.source,
      label: opts.label,
      env: opts.env,
      error: liveError,
      fetchMs,
    };
  }
}

// ─── Multi-source fetch ─────────────────────────────────────────────

/**
 * Fetch multiple sources in parallel. Returns a map of results
 * and a summary array for the status bar.
 *
 *   const { results, summary } = await fetchAll({
 *     sales: { cacheKey: "12eat-sales", ...opts },
 *     zabbix: { cacheKey: "zabbix-problems", ...opts },
 *   });
 *   results.sales.data → sales data or null
 *   summary → [{ source: "12eat", status: "live" }, { source: "zabbix", status: "cached" }]
 */
export async function fetchAll<K extends string>(
  sources: Record<K, { cacheKey: string } & FetchOptions<any>>,
): Promise<{ results: Record<K, SourceResult>; summary: SourceSummary[] }> {
  const keys = Object.keys(sources) as K[];

  const settled = await Promise.all(
    keys.map((k) => {
      const s = sources[k];
      return fetchSource(s.cacheKey, s);
    }),
  );

  const results = {} as Record<K, SourceResult>;
  const summary: SourceSummary[] = [];

  keys.forEach((k, i) => {
    results[k] = settled[i];
    summary.push({
      source: settled[i].source,
      label: settled[i].label,
      env: settled[i].env,
      status: settled[i].status,
      cachedAt: settled[i].cachedAt,
      error: settled[i].error,
      fetchMs: settled[i].fetchMs,
    });
  });

  return { results, summary };
}

// ─── Cache inventory (for debug/status) ─────────────────────────────

export interface CacheInfo {
  key: string;
  source: string;
  label: string;
  env: string;
  cachedAt: string;
  sizeBytes: number;
}

/** List all cached entries with metadata */
export async function listCacheEntries(): Promise<CacheInfo[]> {
  try {
    await ensureCacheDir();
    const files = await readdir(CACHE_DIR);
    const entries: CacheInfo[] = [];
    for (const file of files.filter((f) => f.endsWith(".json"))) {
      try {
        const path = join(CACHE_DIR, file);
        const [raw, st] = await Promise.all([readFile(path, "utf-8"), stat(path)]);
        const parsed = JSON.parse(raw);
        entries.push({
          key: file.replace(".json", ""),
          source: parsed.source || "?",
          label: parsed.label || parsed.source || "?",
          env: parsed.env || "?",
          cachedAt: parsed.cachedAt || "?",
          sizeBytes: st.size,
        });
      } catch { /* skip broken files */ }
    }
    return entries.sort((a, b) => b.cachedAt.localeCompare(a.cachedAt));
  } catch {
    return [];
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function formatAge(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins} min.`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} val.`;
  return `${Math.round(hours / 24)} d.`;
}
