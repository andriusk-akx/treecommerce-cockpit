/**
 * GET /api/version
 *
 * Returns the build identity. Public — no auth required (this is the kind
 * of endpoint a load balancer or monitoring agent hits to verify what's
 * actually running). Returned fields are not secrets:
 *   - version (semver from package.json)
 *   - commit  (short SHA)
 *   - branch  (which branch produced the build)
 *   - dirty   (true = uncommitted changes; should be false in prod)
 *   - buildTime (ISO when version.ts was generated)
 *
 * commitFull is intentionally omitted from the public response — it adds
 * nothing for ops and is one extra bit of info for an attacker mapping
 * the codebase to a public repo. Admin's About panel sees the full SHA.
 */
import { NextResponse } from "next/server";
import { versionInfo } from "@/generated/version";

export const dynamic = "force-static";
export const revalidate = false;

export async function GET() {
  return NextResponse.json({
    version: versionInfo.version,
    commit: versionInfo.commit,
    branch: versionInfo.branch,
    dirty: versionInfo.dirty,
    buildTime: versionInfo.buildTime,
  });
}
