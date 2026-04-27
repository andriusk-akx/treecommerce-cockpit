/**
 * POST /api/auth/login
 *
 * Body: { username, password, next? }
 * On success: sets session cookie, returns { ok: true, redirect }
 * On failure: { ok: false, reason }
 */
import { NextRequest, NextResponse } from "next/server";
import { attemptLogin } from "@/lib/auth/login";
import { createSession, setSessionCookie } from "@/lib/auth/sessions";

export async function POST(req: NextRequest) {
  let body: { username?: string; password?: string; next?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_body" }, { status: 400 });
  }
  const { username = "", password = "", next = "/" } = body;
  const result = await attemptLogin(username, password);
  if (!result.ok) {
    // Generic 401 — don't leak which of the two reasons (unknown user / wrong
    // password) failed. "locked" and "disabled" are safe to surface.
    return NextResponse.json(
      { ok: false, reason: result.reason },
      { status: result.reason === "locked" || result.reason === "disabled" ? 403 : 401 },
    );
  }
  const { token, expiresAt } = await createSession(result.userId);
  await setSessionCookie(token, expiresAt);
  // Sanitize the redirect target to a same-origin path to prevent open
  // redirects via `next=https://attacker.example`.
  const safeNext = typeof next === "string" && next.startsWith("/") && !next.startsWith("//")
    ? next
    : "/";
  return NextResponse.json({ ok: true, redirect: safeNext });
}
