/**
 * Password hashing & verification.
 *
 * Uses bcrypt at cost factor 12 — the OWASP-recommended baseline as of 2024.
 * Cost 12 = ~250ms on a modern laptop, fast enough for login UX, slow enough
 * to make offline brute force impractical.
 *
 * For higher security tiers we could move to argon2id, but that requires a
 * native build. bcryptjs (pure JS) is portable across our deploy targets and
 * is widely accepted enterprise-grade.
 */
import bcrypt from "bcryptjs";

const BCRYPT_COST = 12;

export async function hashPassword(plaintext: string): Promise<string> {
  if (!plaintext || plaintext.length < 4) {
    throw new Error("Password must be at least 4 characters");
  }
  return bcrypt.hash(plaintext, BCRYPT_COST);
}

export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  // bcrypt.compare is constant-time on the hash itself, but throws on
  // malformed input. Guard so a corrupted DB row doesn't crash the login flow.
  try {
    return await bcrypt.compare(plaintext, hash);
  } catch {
    return false;
  }
}
