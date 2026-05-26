/**
 * Edge middleware — first line of defense.
 *
 * We can't run Prisma here (Edge runtime), so this is a coarse check:
 *   • If the user has NO session cookie → redirect to /login (except for
 *     public routes: /login, /api/auth/*, _next, etc.).
 *   • The actual session validation (DB lookup, expiry, isActive check) and
 *     fine-grained permission checks happen in pages/route handlers via
 *     getCurrentUser() — they always re-validate.
 *
 * This means:
 *   • An attacker can't probe protected URLs without at least a cookie.
 *   • Forged cookies pass middleware but fail at the page (DB check).
 *   • Logout invalidates immediately on the next request (DB lookup misses).
 */
import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE_NAME = "akpilot_session";

// Public paths — accessible without a session.
const PUBLIC_PREFIXES = [
  "/login",
  "/api/auth/login",
  "/api/auth/logout",
  // Build identity — used by ops/monitoring; safe to expose.
  "/api/version",
  // Cache pre-warm orchestrator. The route itself validates `?secret=`
  // against `WARM_CACHE_SECRET`, so it's safe to expose at the middleware
  // layer — the secret is the actual auth boundary, not a session cookie.
  "/api/internal/warm-cache",
  // Testlab cpuCores prod patch — same WARM_CACHE_SECRET gate inside the
  // route, same rationale as warm-cache: the secret IS the auth boundary,
  // session cookies don't apply because operators hit this from curl.
  "/api/internal/seed-testlab-cores",
  "/_next",
  "/favicon.ico",
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();
  // Cache-warm bypass — when the warm orchestrator fans out to
  // /retellect/{id}?period=… it forwards the secret as a request header.
  // Middleware lets the request through so the page can detect the same
  // header and skip auth on its end. WARM_CACHE_SECRET stays the auth
  // boundary; an attacker without it falls through to the cookie check.
  const warmHeader = req.headers.get("x-warm-cache-secret");
  if (warmHeader && warmHeader === process.env.WARM_CACHE_SECRET) {
    return NextResponse.next();
  }
  const cookie = req.cookies.get(SESSION_COOKIE_NAME);
  if (!cookie) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    // Run on everything except static assets and Next.js internals.
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
