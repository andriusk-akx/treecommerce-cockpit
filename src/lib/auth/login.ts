/**
 * Login + lockout logic.
 *
 * Account lockout policy (enterprise baseline):
 *   • 5 consecutive failed attempts → account locked for 15 minutes.
 *   • Successful login resets the counter.
 *   • Lockout window slides — every failed attempt during a lockout extends
 *     it (anti-bruteforce).
 *
 * Returns:
 *   { ok: true, userId } on success
 *   { ok: false, reason } on failure — reasons are kept generic to avoid
 *     username-enumeration leaks ("invalid credentials" for both unknown
 *     username and wrong password).
 */
import { prisma } from "@/lib/db";
import { verifyPassword } from "./passwords";

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

// Pre-computed bcrypt hash of the string "dummy-password-for-timing-defence"
// at cost 12 — used to simulate a real bcrypt comparison when the lookup
// returns no user. Without this, "user not found" returns in ~5ms while
// "user found, wrong password" takes ~250ms — the timing leak alone lets
// an attacker enumerate valid usernames.
//
// The hash was generated once at build time. It's not a secret (it's a
// hash of a known string); regenerating it doesn't change behaviour.
const DUMMY_HASH = "$2b$12$zst.jphxSctQHSMDp.AnXe0Mp4oXK060SLfvNHm6a1vS9pvNAFnsO";

export type LoginResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "invalid_credentials" | "locked" | "disabled" };

export async function attemptLogin(username: string, password: string): Promise<LoginResult> {
  // Normalise the username — case-insensitive lookup, trimmed input.
  const normalized = (username || "").trim();
  if (!normalized || !password) return { ok: false, reason: "invalid_credentials" };

  const user = await prisma.user.findFirst({
    where: { username: { equals: normalized, mode: "insensitive" } },
  });

  // Always run a dummy bcrypt compare on unknown usernames — keeps response
  // time roughly constant whether or not the username exists. (Side-channel
  // protection for username enumeration.)
  if (!user) {
    await verifyPassword(password, DUMMY_HASH);
    return { ok: false, reason: "invalid_credentials" };
  }

  if (!user.isActive) {
    return { ok: false, reason: "disabled" };
  }

  // Lockout check.
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    // Bump failed attempts so a constant-rate attack still triggers backoff.
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: { increment: 1 },
        lockedUntil: new Date(Date.now() + LOCKOUT_DURATION_MS),
      },
    });
    return { ok: false, reason: "locked" };
  }

  const passwordOk = await verifyPassword(password, user.passwordHash);
  if (!passwordOk) {
    const newAttempts = user.failedLoginAttempts + 1;
    const shouldLock = newAttempts >= MAX_FAILED_ATTEMPTS;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: newAttempts,
        lockedUntil: shouldLock ? new Date(Date.now() + LOCKOUT_DURATION_MS) : null,
      },
    });
    return { ok: false, reason: shouldLock ? "locked" : "invalid_credentials" };
  }

  // Success — reset counter, stamp last login.
  await prisma.user.update({
    where: { id: user.id },
    data: {
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
    },
  });
  return { ok: true, userId: user.id };
}
