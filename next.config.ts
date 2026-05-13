import type { NextConfig } from "next";

/**
 * Pin the Node process timezone to Europe/Vilnius BEFORE any other module
 * loads. Without this, Railway containers run in UTC and every server-side
 * Date method (`getHours`, `getDate`, …) returns UTC offsets. The CPU
 * Timeline drill-down was the first place this manifested as a visible
 * bug: a sample taken at 14:30 Vilnius local landed in the "11:30" slot
 * server-side, and the slot label "14:30" on the chart actually carried
 * 17:30 EEST data. Setting TZ here means every server tick — slot keys,
 * date parsing, history bucketing — speaks the same language as the
 * user's wall clock.
 *
 * Allow override via the standard TZ env var so local dev or future
 * multi-region deployments can pick a different zone without touching
 * code. Production Railway picks the default.
 *
 * Must be assigned at module top BEFORE any import that could create a
 * Date object (none of the imports below do, but stay defensive).
 */
process.env.TZ = process.env.TZ ?? "Europe/Vilnius";

/**
 * Security baseline headers — applied to every response.
 *
 *   X-Frame-Options: DENY              clickjacking
 *   X-Content-Type-Options: nosniff    MIME sniffing
 *   Referrer-Policy: same-origin       Referer header info leak
 *   Permissions-Policy                 disable unused powerful features
 *   Strict-Transport-Security          HSTS (prod only — dev runs HTTP)
 *
 * CSP is intentionally NOT set here as a wide-open `default-src *` would be
 * worse than nothing, and a tight policy needs careful per-page tuning
 * (Next.js inlines hydration scripts that need either a nonce or 'unsafe-inline').
 * Adding CSP is tracked as a follow-up; the rest of the headers cover the
 * highest-impact baseline.
 */
const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  {
    key: "Permissions-Policy",
    // Disable features we don't use. Page-level overrides via meta tag if needed.
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
];

if (process.env.NODE_ENV === "production") {
  SECURITY_HEADERS.push({
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  });
}

const nextConfig: NextConfig = {
  // Suppress the X-Powered-By: Next.js header — informational tech disclosure.
  poweredByHeader: false,
  // (output: "standalone" removed — server.js exited silently in Railway
  // crash-loop pattern. Reverted to regular next start with full node_modules.)
  async headers() {
    return [
      {
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default nextConfig;
