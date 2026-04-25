/**
 * In-memory cache for Zabbix API responses.
 *
 * Two mechanisms:
 *   1. TTL cache — resolved values live for a bounded time window.
 *   2. In-flight request deduplication — concurrent callers asking for the
 *      same key share a single promise instead of firing duplicate network
 *      requests. This is what collapses the 4–5 `host.get` calls a single
 *      RT page render used to produce down to one.
 *
 * Cache is per-process, so each Next.js worker has its own copy.
 */

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();
const pending = new Map<string, Promise<unknown>>();

const DEFAULT_TTL_MS = 30_000; // 30 seconds

/**
 * Get or compute a cached value.
 *
 * - If a fresh cached value exists, return it synchronously.
 * - If an identical request is already in flight, await that same promise.
 * - Otherwise, fire the request, memoize the promise for concurrent callers,
 *   and store the resolved value on success.
 */
export async function cached<T>(
  key: string,
  fn: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<T> {
  const now = Date.now();
  const existing = cache.get(key);
  if (existing && existing.expiresAt > now) {
    return existing.data as T;
  }

  const inFlight = pending.get(key);
  if (inFlight) {
    return inFlight as Promise<T>;
  }

  const promise = (async () => {
    try {
      const data = await fn();
      cache.set(key, { data, expiresAt: Date.now() + ttlMs });
      return data;
    } finally {
      pending.delete(key);
    }
  })();
  pending.set(key, promise);

  // Lazy cleanup once in a while.
  if (cache.size > 100) {
    for (const [k, v] of cache) {
      if (v.expiresAt <= now) cache.delete(k);
    }
  }

  return promise;
}

/** Invalidate all cache entries (e.g., after manual sync). */
export function invalidateCache(): void {
  cache.clear();
}
