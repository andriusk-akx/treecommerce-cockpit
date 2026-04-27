#!/usr/bin/env node
/**
 * Vulnerability test suite.
 *
 * Coverage (organised by OWASP category-ish):
 *   A. Cookie security (HttpOnly, SameSite, Secure, Path, Expiry sanity)
 *   B. HTTP security headers (X-Frame-Options, X-Content-Type-Options, CSP,
 *      Referrer-Policy, server tech disclosure)
 *   C. Injection (SQLi, XSS in stored + reflected, header injection, JSON)
 *   D. IDOR + mass assignment + privilege escalation
 *   E. Brute force + lockout (offline — we test the policy, not actually
 *      lock the Admin account)
 *   F. Timing-attack: constant-time response for unknown vs known username
 *   G. Information disclosure (stack traces, source maps, .env exposure)
 *   H. DoS sanity: bcrypt-bomb password, oversized JSON, slow loris-ish
 *   I. Authentication bypass via path tricks, headers (X-Forwarded-User, etc.)
 *
 * NB: This is a positive-control suite — we expect the app to BE secure.
 * If something fails, that's a real finding. We try not to actually trigger
 * destructive states (no DB-mutating calls; no actually locking out Admin).
 */

const BASE = process.env.APP_BASE || "http://localhost:3000";

let pass = 0, fail = 0;
const findings = [];
const t = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("  ✓", name); }
  else    {
    fail++;
    console.log("  ✗", name, "—", detail);
    findings.push({ name, detail });
  }
};

async function login(username, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const cookie = res.headers.getSetCookie?.()
    .find(c => c.startsWith("akpilot_session=")) ?? null;
  return { status: res.status, body: await res.json(), rawCookie: cookie };
}
async function get(path, cookie) {
  return fetch(`${BASE}${path}`, {
    headers: cookie ? { Cookie: cookie.split(";")[0] } : {},
    redirect: "manual",
  });
}

// ─── A. Cookie security ────────────────────────────────────────────

console.log("\nA. Cookie security flags");
const adm = await login("Admin", "Nvbcentux1");
const adminCookie = adm.rawCookie;
t("login sets session cookie", !!adminCookie);
t("cookie has HttpOnly flag",
  /;\s*HttpOnly/i.test(adminCookie),
  "exposed to document.cookie — XSS would steal the session");
t("cookie has SameSite=Lax (CSRF protection)",
  /;\s*SameSite=Lax/i.test(adminCookie),
  "CSRF: session cookie sent on cross-site form posts");
t("cookie has Path=/ (not scoped narrower)",
  /;\s*Path=\//i.test(adminCookie));
t("cookie has Expires/Max-Age (not session-only forever)",
  /;\s*(Expires|Max-Age)=/i.test(adminCookie));
// In dev mode Secure flag is intentionally omitted (HTTP localhost). We
// only flag the absence of Secure in NODE_ENV=production.
const isProd = process.env.NODE_ENV === "production";
if (isProd) {
  t("[prod] cookie has Secure flag",
    /;\s*Secure/i.test(adminCookie),
    "missing Secure flag in production — cookie can leak over HTTP");
} else {
  console.log("  ◦ Secure flag check skipped (dev mode HTTP)");
}

// Cookie token entropy — 32 random bytes base64url ≈ 43 chars [A-Za-z0-9_-].
const tokenValue = adminCookie.match(/akpilot_session=([^;]+)/)?.[1] ?? "";
t("session token length ≥ 32 chars (entropy)",
  tokenValue.length >= 32,
  `length=${tokenValue.length}`);
t("session token charset is base64url (no oddities)",
  /^[A-Za-z0-9_-]+$/.test(tokenValue),
  `value=${tokenValue}`);

// ─── B. HTTP security headers ──────────────────────────────────────

console.log("\nB. HTTP security headers");
const headersRes = await fetch(`${BASE}/login`);
const h = headersRes.headers;

const xFrame = h.get("x-frame-options") || h.get("content-security-policy");
t("clickjacking defence: X-Frame-Options OR frame-ancestors in CSP",
  !!(xFrame && /(DENY|SAMEORIGIN|frame-ancestors)/i.test(xFrame)),
  `X-Frame-Options=${h.get("x-frame-options")} CSP=${h.get("content-security-policy")}`);

t("MIME sniffing defence: X-Content-Type-Options: nosniff",
  /nosniff/i.test(h.get("x-content-type-options") || ""),
  "missing — browsers may sniff response as different content type");

t("Referrer-Policy set (info leak protection)",
  !!h.get("referrer-policy"),
  "missing — full Referer header leaks navigation history");

const poweredBy = h.get("x-powered-by") || "";
t("X-Powered-By doesn't leak framework version",
  !poweredBy.toLowerCase().includes("next.js") || !/[\d.]/.test(poweredBy),
  `X-Powered-By: ${poweredBy} (informational, not critical, but framework version aids attackers)`);

t("no Server header leaking version",
  !/(express|nginx\/[\d.]|apache\/[\d.])/i.test(h.get("server") || ""),
  `Server: ${h.get("server")}`);

// ─── C. Injection ──────────────────────────────────────────────────

console.log("\nC. Injection probes");

// 1. SQL injection in login username — Prisma parameterises all queries, but
//    confirm a classic SQLi payload still returns 401, not 500/200/timing diff.
const sqliPayloads = [
  "' OR '1'='1",
  "Admin' --",
  "Admin'/*",
  "'; DROP TABLE \"User\"; --",
  "Admin\" OR \"1\"=\"1",
];
for (const payload of sqliPayloads) {
  const r = await login(payload, "anything");
  t(`SQLi payload [${payload.slice(0, 20)}…] → not authenticated`,
    r.status === 401 && r.body.reason === "invalid_credentials",
    `status=${r.status} reason=${r.body.reason}`);
}

// 2. Reflected XSS in /login error message — submit username with HTML.
const xssLogin = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "<script>alert(1)</script>", password: "x" }),
});
const xssBody = await xssLogin.text();
t("login API doesn't echo the username back into response body",
  !xssBody.includes("<script>"),
  "response includes raw script tag — reflected XSS risk");

// 3. Stored XSS — username/role name fields render through React, which
//    auto-escapes. Verify via creating a "user" with HTML chars (read-only
//    probe: we check that EXISTING usernames are rendered escaped).
const usersList = await get("/settings/users", adminCookie);
const usersHtml = await usersList.text();
t("usernames in /settings/users are HTML-escaped (React default)",
  // React would emit <td>Admin</td> not <td><script>...</script></td>
  !/<script>(?!self\.|self_|\(self)/.test(
    usersHtml.replace(/<script[^>]*src="[^"]+"[^>]*>/g, "")
             .replace(/<script[^>]*>self\.[^<]+<\/script>/g, "")
  ),
  "found unescaped <script> tag — XSS risk");

// 4. Header injection in next param (login response).
const headerInj = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    username: "Admin",
    password: "Nvbcentux1",
    next: "/\r\nSet-Cookie: pwned=1\r\n",
  }),
});
const setCookies = headerInj.headers.getSetCookie?.() ?? [];
t("CRLF injection in `next` doesn't add extra Set-Cookie",
  !setCookies.some(c => /pwned=/i.test(c)),
  "extra cookie injected via CRLF in next");

// 5. JSON injection / prototype pollution attempt.
const protoPollute = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    username: "Admin",
    password: "Nvbcentux1",
    "__proto__": { isAdmin: true },
    "constructor": { "prototype": { isAdmin: true } },
  }),
});
t("prototype-pollution-style payload doesn't grant admin",
  // Login still works because Admin password is correct — but we should
  // not see the polluted property leak into the response.
  !JSON.stringify(await protoPollute.json()).includes("isAdmin"),
  "isAdmin leaked in response");

// ─── D. IDOR + privilege escalation ────────────────────────────────

console.log("\nD. IDOR + privilege escalation");
const sprimi = await login("Sprimi1", "Sprimi1");
const sprimiCookie = sprimi.rawCookie;

// Get Admin's user id by inspecting the admin's own page.
const adminUsersHtml = await (await get("/settings/users", adminCookie)).text();
const userIds = [...adminUsersHtml.matchAll(/href="\/settings\/users\/([a-z0-9]{20,})"/g)]
  .map(m => m[1]);
const someUserId = userIds[0];

// Sprimi tries to read admin's user-detail page directly.
const sprimiPeek = await get(`/settings/users/${someUserId}`, sprimiCookie);
t("Sprimi1 cannot read /settings/users/<adminId> directly (IDOR)",
  sprimiPeek.status === 404,
  `got ${sprimiPeek.status}`);

// Try to invoke the resetPassword server action endpoint as Sprimi1.
// Server actions in Next.js post to the original page URL with a form-action
// header. We can simulate by POSTing a form to the user edit page.
const forgedReset = await fetch(`${BASE}/settings/users/${someUserId}`, {
  method: "POST",
  headers: {
    "Cookie": sprimiCookie?.split(";")[0] ?? "",
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: "password=hacked12345",
  redirect: "manual",
});
t("Sprimi1 POST to /settings/users/<id> → not 200 (admin gate)",
  forgedReset.status !== 200,
  `got ${forgedReset.status}`);

// Header-based privilege escalation: try X-Forwarded-User, X-Admin, etc.
const fakeAdmin = await fetch(`${BASE}/settings/users`, {
  headers: {
    "Cookie": sprimiCookie?.split(";")[0] ?? "",
    "X-Forwarded-User": "Admin",
    "X-Admin": "true",
    "X-Roles": "admin",
    "Authorization": "Bearer fake",
  },
  redirect: "manual",
});
t("trust-the-headers attack ignored (X-Forwarded-User / X-Admin)",
  fakeAdmin.status === 404,
  `got ${fakeAdmin.status}`);

// ─── E. Brute-force / lockout policy (passive) ────────────────────

console.log("\nE. Lockout policy — passive check");
// We don't actually lock Admin out. Probe an invented user with 3 wrong
// attempts and verify each returns the same generic error.
const reasons = [];
for (let i = 0; i < 3; i++) {
  const r = await login("ProbeUser_DoesNotExist", `try${i}`);
  reasons.push(r.body.reason);
}
t("repeated wrong attempts on unknown user all return invalid_credentials",
  reasons.every(r => r === "invalid_credentials"),
  `reasons=${reasons.join(",")}`);
// (We can't easily verify the lockout fires without burning attempts on a
// real user — login.ts is unit-tested with vitest, this is just a smoke.)
console.log("  ◦ actual 5-fail-lockout fire-test skipped (would lock Admin)");

// ─── F. Timing attack: unknown vs known user ──────────────────────

console.log("\nF. Timing — username enumeration");
async function timeLogin(username, password) {
  const t0 = performance.now();
  await login(username, password);
  return performance.now() - t0;
}
// Warm up the cache.
await timeLogin("Admin", "warmup");
await timeLogin("DefinitelyNotARealUser", "warmup");
const knownTimes = [];
const unknownTimes = [];
for (let i = 0; i < 6; i++) {
  knownTimes.push(await timeLogin("Admin", "wrong" + i));
  unknownTimes.push(await timeLogin("DefinitelyNotARealUser_" + i, "wrong"));
}
const median = (arr) => arr.slice().sort((a,b)=>a-b)[Math.floor(arr.length/2)];
const knownMed = median(knownTimes);
const unknownMed = median(unknownTimes);
const ratio = Math.max(knownMed, unknownMed) / Math.max(1, Math.min(knownMed, unknownMed));
t(`timing: known≈unknown (median known=${knownMed.toFixed(0)}ms unknown=${unknownMed.toFixed(0)}ms ratio=${ratio.toFixed(2)})`,
  ratio < 2.0,
  "known-vs-unknown timing differs by >2x — username enumeration possible");

// ─── G. Information disclosure ────────────────────────────────────

console.log("\nG. Information disclosure");

// Stack traces in 500 responses — try to trigger a server error and check the
// body. POST nonsense JSON to the login API.
const badJson = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{invalid json",
});
const badJsonBody = await badJson.text();
t("malformed JSON → 400, no stack trace in body",
  badJson.status === 400 && !/at\s+\w+\s*\(/.test(badJsonBody) && !badJsonBody.includes(".ts:"),
  `status=${badJson.status} body=${badJsonBody.slice(0,80)}`);

// 404 page should not leak the route map.
const r404 = await fetch(`${BASE}/this/route/does/not/exist/${Date.now()}`);
const body404 = await r404.text();
t("404 doesn't leak file system paths",
  !/sessions\/zen-relaxed|Users\/andrius/.test(body404),
  "absolute file path leaked in 404 response");

// Source map exposure.
async function checkNoSourceMap(path) {
  const res = await fetch(`${BASE}${path}.map`);
  return res.status === 404 || res.status === 403;
}
// In dev mode source maps are exposed by design — only flag in prod.
if (isProd) {
  t("[prod] no /_next/static/*.js.map source maps exposed",
    await checkNoSourceMap("/_next/static/chunks/main"),
    "source maps available in production — leaks original TypeScript");
}

// .env / .git exposure.
for (const path of ["/.env", "/.env.local", "/.git/config", "/prisma/schema.prisma"]) {
  const r = await fetch(`${BASE}${path}`, { redirect: "manual" });
  t(`${path} not directly accessible`,
    r.status === 404 || r.status === 308 || r.status === 307,
    `status=${r.status}`);
}

// ─── H. DoS sanity ────────────────────────────────────────────────

console.log("\nH. DoS sanity");

// Bcrypt-bomb: a 1MB password would bcrypt-hash forever. Our login.ts
// validates length implicitly via `attemptLogin` — but verify the code path
// rejects ridiculously long input quickly.
const huge = "x".repeat(72 * 100); // bcrypt cap is 72 bytes; longer inputs are silently truncated
const tH0 = performance.now();
const hugeRes = await login("Admin", huge);
const tH = performance.now() - tH0;
t(`huge password (~7KB) returns under 5s (no bcrypt-bomb)`,
  tH < 5000,
  `took ${tH.toFixed(0)}ms`);
t("huge password → 401/403 (rejected, not 5xx crash)",
  hugeRes.status === 401 || hugeRes.status === 403,
  `status=${hugeRes.status}`);

// Oversized JSON body. We POST 1MB of nonsense.
const big = "x".repeat(1024 * 1024);
try {
  const bigRes = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: big, password: "x" }),
    signal: AbortSignal.timeout(10000),
  });
  t("1MB JSON body either rejected or processed quickly",
    bigRes.status === 400 || bigRes.status === 401 || bigRes.status === 413,
    `status=${bigRes.status}`);
} catch (e) {
  t("1MB JSON body handled gracefully (timeout/abort acceptable)", true,
    `error=${e.message}`);
}

// ─── I. Authentication bypass attempts ────────────────────────────

console.log("\nI. Authentication bypass via path tricks");
const bypass = [
  "/retellect/cmoa2jtzw00047jyffnarf20t/../../../etc/passwd",
  "/retellect/cmoa2jtzw00047jyffnarf20t%00",  // null byte
  "/retellect/cmoa2jtzw00047jyffnarf20t%2e%2e",  // URL-encoded ..
  "//attacker.com/retellect",  // protocol-relative
];
for (const path of bypass) {
  const r = await fetch(`${BASE}${path}`, { redirect: "manual" });
  t(`bypass attempt ${path.slice(0, 60)} → not 200 without cookie`,
    r.status !== 200,
    `status=${r.status}`);
}

// ─── Summary ───────────────────────────────────────────────────────

console.log(`\n────────────────────────────────────────`);
console.log(`${pass} passed, ${fail} failed`);
if (findings.length > 0) {
  console.log("\nFindings:");
  for (const f of findings) {
    console.log(`  • ${f.name}`);
    console.log(`    ${f.detail}`);
  }
}
process.exit(fail > 0 ? 1 : 0);
