/**
 * Tests for fetchSource's stale-while-revalidate path (freshFor option).
 *
 * The SWR path is the speedup that turned login → first paint from
 * "1–3 s cold Zabbix wait" into "<50 ms cached return + background
 * revalidate". The risk surface concentrates here:
 *
 *   1. A stale cache must not be served as fresh.
 *   2. Concurrent calls must not stack background revalidations.
 *   3. Revalidation failures must NOT leak into the user's response —
 *      they already got cached data, the next request retries.
 *   4. Without freshFor, behaviour is identical to the original
 *      live-first / cache-on-failure flow.
 *
 * We mock `fs/promises` so each test controls the on-disk cache state
 * deterministically. Real disk I/O is brittle in CI and would require
 * temp-dir setup; the in-memory mock is faster and isolates the unit.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory backing store for the fs mock — keyed by absolute path.
const fakeFiles = new Map<string, string>();

vi.mock("fs/promises", () => ({
  readFile: vi.fn(async (path: string) => {
    const content = fakeFiles.get(path);
    if (content === undefined) {
      const err = new Error("ENOENT");
      (err as { code?: string }).code = "ENOENT";
      throw err;
    }
    return content;
  }),
  writeFile: vi.fn(async (path: string, data: string) => {
    fakeFiles.set(path, data);
  }),
  mkdir: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ size: 0 })),
}));

import { fetchSource } from "./index";
import { join } from "path";

function cachePathFor(key: string): string {
  return join(process.cwd(), ".cache", `${key}.json`);
}

function seedCache(key: string, data: unknown, ageMs: number) {
  const entry = {
    data,
    cachedAt: new Date(Date.now() - ageMs).toISOString(),
    source: "test",
    label: "Test",
    env: "test",
  };
  fakeFiles.set(cachePathFor(key), JSON.stringify(entry));
}

beforeEach(() => {
  fakeFiles.clear();
  vi.clearAllMocks();
});

// ─── No freshFor: behaviour preserved ──────────────────────────────

describe("fetchSource without freshFor (default behaviour)", () => {
  it("always hits live fetcher, only reads cache on failure", async () => {
    const fetcher = vi.fn(async () => ({ v: 1 }));
    seedCache("unused-key", { v: 99 }, 5_000); // fresh-ish cache present

    const result = await fetchSource("unused-key", {
      source: "test",
      label: "Test",
      env: "test",
      fetcher,
    });

    // Live fetcher was invoked even though a fresh-ish cache existed —
    // the no-freshFor contract is "always live first".
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("live");
    expect(result.data).toEqual({ v: 1 });
  });

  it("falls back to cache when live fetcher throws", async () => {
    seedCache("fallback-key", { v: 42 }, 60_000);
    const result = await fetchSource("fallback-key", {
      source: "test",
      label: "Test",
      env: "test",
      fetcher: async () => { throw new Error("Zabbix down"); },
    });
    expect(result.status).toBe("cached");
    expect(result.data).toEqual({ v: 42 });
  });
});

// ─── freshFor: hot path ────────────────────────────────────────────

describe("fetchSource with freshFor — hot path", () => {
  it("returns fresh cache instantly WITHOUT calling the live fetcher", async () => {
    seedCache("hot-key", { v: 7 }, 10_000); // 10s old
    const fetcher = vi.fn(async () => ({ v: 999 }));

    const result = await fetchSource("hot-key", {
      source: "test",
      label: "Test",
      env: "test",
      freshFor: 60_000, // 60s TTL — 10s old cache is well within window
      fetcher,
    });

    expect(result.status).toBe("live");
    expect(result.data).toEqual({ v: 7 });
    expect(result.cachedAt).toBeTruthy(); // populated so UI can show "10s old"
    // The synchronous response did NOT wait for the live fetcher.
    // (Background revalidation may have queued it — we check via a tick.)
    expect(fetcher).toHaveBeenCalledTimes(1); // 1 = background revalidate; 0 would be acceptable if dedupe wins
    // Flush the background revalidate promise so subsequent tests start clean.
    await new Promise((r) => setTimeout(r, 0));
  });

  it("kicks off background revalidation that updates the cache for next request", async () => {
    seedCache("revalidate-key", { v: "old" }, 30_000);
    let callCount = 0;
    const fetcher = vi.fn(async () => {
      callCount++;
      return { v: `new-${callCount}` };
    });

    const first = await fetchSource("revalidate-key", {
      source: "test", label: "Test", env: "test",
      freshFor: 60_000,
      fetcher,
    });
    expect(first.data).toEqual({ v: "old" }); // cached payload returned

    // Wait for the background revalidate to finish.
    await new Promise((r) => setTimeout(r, 10));

    // The disk cache must now hold the refreshed payload — verify by
    // reading the fake file directly.
    const raw = fakeFiles.get(cachePathFor("revalidate-key"))!;
    const parsed = JSON.parse(raw);
    expect(parsed.data).toEqual({ v: "new-1" });
  });

  it("dedupes background revalidations under concurrent load", async () => {
    seedCache("stampede-key", { v: "old" }, 10_000);
    let inFlight = 0;
    let peakInFlight = 0;
    const fetcher = vi.fn(async () => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      // Simulate a slow Zabbix call so concurrent revalidate attempts overlap.
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { v: "new" };
    });

    // Fire 7 concurrent fetches — same shape as a Retellect page's
    // 7-parallel Zabbix call group hitting the same revalidate target.
    await Promise.all(
      Array.from({ length: 7 }, () =>
        fetchSource("stampede-key", {
          source: "test", label: "Test", env: "test",
          freshFor: 60_000,
          fetcher,
        }),
      ),
    );
    // Let any queued revalidate finish.
    await new Promise((r) => setTimeout(r, 40));

    // The 7 callers all received cached data immediately, and the
    // background revalidate fired ONCE (not 7 times). Without dedupe
    // this would be 7 simultaneous Zabbix round-trips for one key.
    expect(peakInFlight).toBe(1);
  });
});

// ─── freshFor: cold path ───────────────────────────────────────────

describe("fetchSource with freshFor — cold path", () => {
  it("falls through to live fetch when cache is older than freshFor", async () => {
    seedCache("stale-key", { v: "ancient" }, 120_000); // 2 min old
    const fetcher = vi.fn(async () => ({ v: "fresh" }));

    const result = await fetchSource("stale-key", {
      source: "test", label: "Test", env: "test",
      freshFor: 60_000, // 1 min TTL — 2 min cache is stale
      fetcher,
    });

    // Stale cache must NOT be served as fresh. Live fetch happens
    // synchronously (the user waits) and the response carries the new data.
    expect(result.data).toEqual({ v: "fresh" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("falls through to live fetch when no cache entry exists", async () => {
    const fetcher = vi.fn(async () => ({ v: "first-time" }));

    const result = await fetchSource("cold-key", {
      source: "test", label: "Test", env: "test",
      freshFor: 60_000,
      fetcher,
    });

    expect(result.status).toBe("live");
    expect(result.data).toEqual({ v: "first-time" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("treats a cache entry with future cachedAt as unusable (clock-skew defence)", async () => {
    // Negative age (cachedAt in the future) shouldn't be honoured — that
    // would be a clock-skew or corruption signal, not "very fresh".
    seedCache("future-key", { v: "spoof" }, -60_000);
    const fetcher = vi.fn(async () => ({ v: "honest" }));

    const result = await fetchSource("future-key", {
      source: "test", label: "Test", env: "test",
      freshFor: 60_000,
      fetcher,
    });

    expect(result.data).toEqual({ v: "honest" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

// ─── Revalidation failure isolation ────────────────────────────────

describe("fetchSource with freshFor — failure isolation", () => {
  it("background revalidation failure does NOT affect the cached response", async () => {
    seedCache("fragile-key", { v: "stable" }, 10_000);
    const fetcher = vi.fn(async () => {
      throw new Error("Zabbix transient 500");
    });

    const result = await fetchSource("fragile-key", {
      source: "test", label: "Test", env: "test",
      freshFor: 60_000,
      fetcher,
    });

    // User got the cached payload regardless of the revalidation error.
    expect(result.status).toBe("live");
    expect(result.data).toEqual({ v: "stable" });
    expect(result.error).toBeNull();

    // Let the background revalidate settle so the next test starts clean.
    await new Promise((r) => setTimeout(r, 10));
  });
});
