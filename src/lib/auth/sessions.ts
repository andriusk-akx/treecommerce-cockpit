/**
 * Cookie-based session management.
 *
 * Why not next-auth/Auth.js? For an MVP with a single credentials provider
 * and a single-tenant deployment, the value of a 100k-line auth framework
 * is dominated by its constraints. A 200-line custom implementation we
 * understand fully — and can audit in one sitting — is the safer choice.
 *
 * Design:
 *   • A login generates a cryptographically random 32-byte token.
 *   • The cookie value is the token; the DB row stores SHA-256(token).
 *     This means even DB read access doesn't grant session theft — an
 *     attacker would still need the original cookie value.
 *   • Cookie is HttpOnly, Secure (in prod), SameSite=Lax, path="/".
 *   • Server-side session row is the source of truth — logout deletes the
 *     row and the cookie becomes useless.
 *   • Sessions expire after 24h of inactivity (lastSeenAt + 24h). Renewed
 *     on each authenticated request.
 *
 * Threat model covered:
 *   • Cookie theft via XSS — HttpOnly defeats document.cookie access.
 *   • Cookie theft via DB dump — token is hashed at rest.
 *   • Session fixation — token is generated server-side, never accepted from input.
 *   • CSRF — SameSite=Lax handles same-site requests; mutations go through
 *     server actions which Next.js protects with origin validation.
 *   • Replay after logout — server-side row deletion invalidates immediately.
 */
import { cookies, headers } from "next/headers";
import { randomBytes, createHash } from "crypto";
import { prisma } from "@/lib/db";
import type { UserAuthState, TabKey } from "./permissions";
import { ALL_TABS } from "./permissions";

const SESSION_COOKIE_NAME = "akpilot_session";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateToken(): string {
  // 32 random bytes → 256 bits, base64url-encoded → 43 chars (no padding).
  return randomBytes(32).toString("base64url");
}

/** Create a session row + return the cookie value to set. */
export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const headerList = await headers();
  await prisma.userSession.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt,
      userAgent: headerList.get("user-agent")?.slice(0, 500) ?? null,
      ipAddress: extractIp(headerList),
    },
  });
  return { token, expiresAt };
}

/** Set the session cookie on the outgoing response. */
export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

/** Resolve the current logged-in user from the request cookie. */
export async function getCurrentUser(): Promise<UserAuthState | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  const tokenHash = hashToken(token);
  const session = await prisma.userSession.findUnique({
    where: { tokenHash },
    include: {
      user: {
        include: {
          pilotAccess: { select: { pilotId: true, allowedTabs: true } },
        },
      },
    },
  });
  if (!session) return null;
  // Hard expiry check.
  if (session.expiresAt.getTime() < Date.now()) {
    // Best-effort cleanup — don't await, don't fail login if it errors.
    prisma.userSession.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  if (!session.user.isActive) {
    return null;
  }
  // Sliding expiration: bump lastSeenAt asynchronously, expiresAt every 5 min
  // to avoid a write on every request. Cheap "good enough" approach.
  const lastSeenAge = Date.now() - session.lastSeenAt.getTime();
  if (lastSeenAge > 5 * 60_000) {
    prisma.userSession
      .update({
        where: { id: session.id },
        data: {
          lastSeenAt: new Date(),
          expiresAt: new Date(Date.now() + SESSION_TTL_MS),
        },
      })
      .catch(() => {});
  }

  // Build the resolved access map.
  const pilotAccess = new Map<string, ReadonlySet<TabKey>>();
  for (const grant of session.user.pilotAccess) {
    const tabs = grant.allowedTabs.filter((t): t is TabKey =>
      (ALL_TABS as readonly string[]).includes(t),
    );
    if (tabs.length > 0) pilotAccess.set(grant.pilotId, new Set(tabs));
  }

  return {
    id: session.user.id,
    username: session.user.username,
    isAdmin: session.user.isAdmin,
    pilotAccess,
  };
}

/** Delete the session row and clear the cookie. */
export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (token) {
    const tokenHash = hashToken(token);
    await prisma.userSession.deleteMany({ where: { tokenHash } });
  }
  cookieStore.delete(SESSION_COOKIE_NAME);
}

/** Extract caller IP from headers — best effort, X-Forwarded-For first. */
function extractIp(h: Headers): string | null {
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim().slice(0, 64);
  const real = h.get("x-real-ip");
  if (real) return real.slice(0, 64);
  return null;
}

/** Throw-helper for routes that require authentication. */
export async function requireUser(): Promise<UserAuthState> {
  const user = await getCurrentUser();
  if (!user) {
    const err = new Error("UNAUTHENTICATED");
    (err as Error & { code: string }).code = "UNAUTHENTICATED";
    throw err;
  }
  return user;
}
