import type { NextConfig } from "next";

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
