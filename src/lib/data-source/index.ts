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
  /** Max age of cache in ms before it's considered stale (default: no limit) */
  maxCacheAgeMs?: number;
}

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
