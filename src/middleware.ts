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
  "/_next",
  "/favicon.ico",
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();
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
