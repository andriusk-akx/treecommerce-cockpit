#!/usr/bin/env node
/**
 * Version-tracking verification:
 *   1. /api/version is publicly accessible (no cookie required).
 *   2. Returns the expected fields with sane shapes.
 *   3. Footer shows the version string.
 *   4. /settings/general (admin) shows the full About panel.
 *   5. Sprimi1 sees the footer version too (it's not admin-gated).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE = process.env.APP_BASE || "http://localhost:3000";
const here = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const t = (n, ok, d = "") => {
  if (ok) { pass++; console.log("  ✓", n); }
  else    { fail++; console.log("  ✗", n, "—", d); }
};

console.log("\nA. /api/version is public + well-formed");
const r = await fetch(`${BASE}/api/version`);
t("returns 200 without auth cookie", r.status === 200, `got ${r.status}`);
const body = await r.json();
t("has 'version' (semver-ish)",
  typeof body.version === "string" && /^\d+\.\d+\.\d+/.test(body.version),
  `version=${body.version}`);
t("has 'commit' (short SHA)",
  typeof body.commit === "string" && body.commit.length >= 7,
  `commit=${body.commit}`);
t("has 'branch' string",
  typeof body.branch === "string" && body.branch.length > 0,
  `branch=${body.branch}`);
t("has 'dirty' boolean",
  typeof body.dirty === "boolean", `dirty=${body.dirty}`);
t("has 'buildTime' ISO timestamp",
  typeof body.buildTime === "string" && !isNaN(Date.parse(body.buildTime)),
  `buildTime=${body.buildTime}`);
t("does NOT expose commitFull (kept admin-only)",
  body.commitFull === undefined);

console.log("\nB. Generator matches /api/version");
const generated = readFileSync(join(here, "../src/generated/version.ts"), "utf-8");
const genVersion = generated.match(/VERSION = "([^"]+)"/)?.[1];
const genCommit = generated.match(/COMMIT = "([^"]+)"/)?.[1];
t("generated VERSION matches API",
  genVersion === body.version, `gen=${genVersion} api=${body.version}`);
t("generated COMMIT matches API",
  genCommit === body.commit, `gen=${genCommit} api=${body.commit}`);

console.log("\nC. Footer shows version (visible to everyone)");
async function login(username, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return res.headers.getSetCookie?.()
    .find(c => c.startsWith("akpilot_session=")) ?? null;
}

// Reset Admin lockout if previous probes locked it.
const adminCookie = (await login("Admin", "Nvbcentux1"))?.split(";")[0] ?? "";
const adminLogin = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "Admin", password: "Nvbcentux1" }),
});
const adminCookieFresh = adminLogin.headers.getSetCookie?.()
  .find(c => c.startsWith("akpilot_session="))?.split(";")[0] ?? adminCookie;

const homePage = await fetch(`${BASE}/`, {
  headers: { Cookie: adminCookieFresh },
  redirect: "manual",
});
const homeHtml = await homePage.text();
t("footer contains version number",
  homeHtml.includes(`v${body.version}`),
  "footer didn't render the version string");
t("footer contains short commit",
  homeHtml.includes(body.commit),
  "footer didn't render the commit");

console.log("\nD. Settings → General About panel (admin)");
const genPage = await fetch(`${BASE}/settings`, {
  headers: { Cookie: adminCookieFresh },
});
const genHtml = await genPage.text();
t("About panel shows version",
  genHtml.includes(body.version) && genHtml.includes("About AKpilot"),
  "About panel missing version");
t("About panel shows branch",
  genHtml.includes(body.branch),
  `branch=${body.branch} not in HTML`);

const sprimiCookie = (await login("Sprimi1", "Sprimi1"))?.split(";")[0] ?? "";
// Manually walk the redirect chain — fetch's "follow" mode drops cookies
// across redirects when we set them via the Cookie header.
async function followWithCookie(start, cookie, max = 5) {
  let url = start;
  for (let i = 0; i < max; i++) {
    const r = await fetch(url, { headers: { Cookie: cookie }, redirect: "manual" });
    if (r.status >= 300 && r.status < 400) {
      const next = r.headers.get("location");
      if (!next) return r;
      url = next.startsWith("http") ? next : new URL(next, url).toString();
      continue;
    }
    return r;
  }
  throw new Error("redirect chain too long");
}
const sprimiHomeRes = await followWithCookie(`${BASE}/`, sprimiCookie);
const sprimiHtml = await sprimiHomeRes.text();
t("Sprimi1 still sees footer with version",
  sprimiHtml.includes(`v${body.version}`),
  `status=${sprimiHomeRes.status} contained 'v${body.version}'? ${sprimiHtml.includes(`v${body.version}`)}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
