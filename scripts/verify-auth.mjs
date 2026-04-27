#!/usr/bin/env node
/**
 * End-to-end auth verification:
 *   1. POST /api/auth/login with the seeded credentials
 *   2. Use the cookie to GET /retellect (verify session works)
 *   3. As Sprimi1, GET the pilot detail and check tabs are restricted
 *   4. As Admin, GET /settings/users (must work)
 *   5. As Sprimi1, GET /settings/users (must 404 — non-admin)
 *   6. Wrong-password flow returns 401
 *   7. Lockout after 5 wrong attempts (don't actually trigger — costly)
 */
import assert from "node:assert/strict";

const BASE = process.env.APP_BASE || "http://localhost:3000";

let pass = 0, fail = 0;
function t(name, ok, detail = "") {
  if (ok) { pass++; console.log("  ✓", name); }
  else    { fail++; console.log("  ✗", name, "—", detail); }
}

async function login(username, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
    redirect: "manual",
  });
  const cookie = res.headers.getSetCookie?.()
    .find(c => c.startsWith("akpilot_session="))
    || res.headers.get("set-cookie")?.split(",").find(c => c.includes("akpilot_session="));
  return { status: res.status, body: await res.json(), cookie: cookie ?? null };
}

async function get(path, cookie) {
  return fetch(`${BASE}${path}`, {
    headers: cookie ? { Cookie: cookie.split(";")[0] } : {},
    redirect: "manual",
  });
}

console.log("\nA. Login flows");
const wrong = await login("Admin", "wrong");
t("wrong password → 401", wrong.status === 401, `got ${wrong.status}`);
t("wrong password → reason invalid_credentials",
  wrong.body.reason === "invalid_credentials",
  `got ${wrong.body.reason}`);

const unknown = await login("DoesNotExist", "anything");
t("unknown user → 401", unknown.status === 401);
t("unknown user → same reason as wrong-password (no enumeration)",
  unknown.body.reason === "invalid_credentials");

const adminLogin = await login("Admin", "Nvbcentux1");
t("Admin good password → 200", adminLogin.status === 200);
t("Admin login → ok=true", adminLogin.body.ok === true);
t("Admin login → cookie set", adminLogin.cookie !== null);

const sprimiLogin = await login("Sprimi1", "Sprimi1");
t("Sprimi1 good password → 200", sprimiLogin.status === 200);
t("Sprimi1 login → cookie set", sprimiLogin.cookie !== null);

console.log("\nB. Authorisation");
const adminCookie = adminLogin.cookie;
const sprimiCookie = sprimiLogin.cookie;

const noCookieRetellect = await get("/retellect");
// middleware → redirect to /login
t("anonymous /retellect → redirect to /login (307/308)",
  noCookieRetellect.status === 307 || noCookieRetellect.status === 308,
  `got ${noCookieRetellect.status}`);

const adminRetellect = await get("/retellect", adminCookie);
t("Admin /retellect → 200", adminRetellect.status === 200);
const adminBody = await adminRetellect.text();
t("Admin sees pilot card",
  adminBody.includes("Retellect SCO CPU Analysis"),
  "page didn't contain pilot name");

const sprimiRetellect = await get("/retellect", sprimiCookie);
t("Sprimi1 /retellect → 200", sprimiRetellect.status === 200);
const sprimiBody = await sprimiRetellect.text();
t("Sprimi1 sees their one pilot",
  sprimiBody.includes("Retellect SCO CPU Analysis"));

console.log("\nC. Settings admin gate");
const adminSettings = await get("/settings/users", adminCookie);
t("Admin /settings/users → 200", adminSettings.status === 200);
const sprimiSettings = await get("/settings/users", sprimiCookie);
t("Sprimi1 /settings/users → 404 (admin-only)",
  sprimiSettings.status === 404,
  `got ${sprimiSettings.status}`);

console.log("\nD. Pilot tab scoping (Sprimi1)");
// Look at the rendered HTML of the pilot page — only the tabs with permKey
// in [overview, timeline] should appear.
const pilotIdMatch = sprimiBody.match(/href="\/retellect\/([a-z0-9]+)"/);
const pilotId = pilotIdMatch?.[1];
t("found pilot id in hub", !!pilotId);
if (pilotId) {
  const pilotPage = await get(`/retellect/${pilotId}`, sprimiCookie);
  t("Sprimi1 pilot detail → 200", pilotPage.status === 200);
  const html = await pilotPage.text();
  // Tabs that SHOULD be present:
  t("tab: Overview visible", html.includes(">Overview<"));
  t("tab: CPU Timeline visible", html.includes(">CPU Timeline<"));
  // Tabs that MUST NOT be present:
  t("tab: Host Inventory hidden", !html.includes(">Host Inventory<"));
  t("tab: CPU Comparison hidden", !html.includes(">CPU Comparison<"));
  t("tab: Capacity Risk hidden", !html.includes(">Capacity Risk<"));
  t("tab: Hypotheses hidden", !html.includes(">Hypotheses & Recs<"));
  t("tab: Data Health hidden", !html.includes(">Data Health<"));
  t("tab: Resource Overview hidden", !html.includes(">Resource Overview<"));
}

console.log("\nE. Forbidden pilot returns 404");
// Pretend Sprimi1 tries to access a pilot they don't have access to.
// We don't have a non-Retellect pilot Sprimi1 lacks — but we can try a
// nonexistent id (also 404).
const ghost = await get(`/retellect/nonexistent-pilot-id-12345`, sprimiCookie);
t("Sprimi1 nonexistent pilot → not 200", ghost.status !== 200);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
