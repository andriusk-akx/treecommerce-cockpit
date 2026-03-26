/**
 * In-memory cache for Zabbix API responses.
 *
 * Next.js 16 unstable_cache works with server components, but since all our
 * pages use `force-dynamic`, we use a simple time-based memory cache instead.
 * This avoids hitting Zabbix on every single page load while keeping data
 * reasonably fresh.
 *
 * TTL: 60 seconds — data is at most 1 minute stale.
 * Cache is per-process, so each Next.js worker has its own copy.
 */

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<any>>();

const DEFAULT_TTL_MS = 60_000; // 60 seconds

/**
 * Get or compute a cached value.
 * Key should encode all parameters that affect the result.
 */
export async function cached<T>(
  key: string,
  fn: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS
): Promise<T> {
  const now = Date.now();
  const existing = cache.get(key);

  if (existing && existing.expiresAt > now) {
    return existing.data as T;
  }

  const data = await fn();
  cache.set(key, { data, expiresAt: now + ttlMs });

  // Lazy cleanup: remove expired entries when cache grows large
  if (cache.size > 100) {
    for (const [k, v] of cache) {
      if (v.expiresAt <= now) cache.delete(k);
    }
  }

  return data;
}

/**
 * Invalidate all cache entries (e.g., after manual sync).
 */
export function invalidateCache(): void {
  cache.clear();
}
