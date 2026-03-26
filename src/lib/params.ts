/**
 * Centralized URL parameter validation.
 * All pages should use these helpers instead of raw parseInt().
 *
 * Invalid/malicious values fall back to safe defaults — no crashes, no NaN.
 */

/** Parse `days` param with safe defaults. Returns fractional days (e.g. 0.0417 for 1h). */
export function parsePeriodParams(params: {
  days?: string;
  hours?: string;
}): { days: number; hoursParam: number | null; periodLabel: string } {
  const hoursRaw = params.hours ? Number(params.hours) : null;
  const hoursParam =
    hoursRaw !== null && Number.isFinite(hoursRaw) && hoursRaw > 0 && hoursRaw <= 8760
      ? Math.round(hoursRaw)
      : null;

  let days: number;
  if (hoursParam) {
    days = hoursParam / 24;
  } else {
    const daysRaw = Number(params.days);
    days =
      Number.isFinite(daysRaw) && daysRaw > 0 && daysRaw <= 365
        ? Math.round(daysRaw)
        : 1; // safe default — 1 day
  }

  const periodLabel = hoursParam ? `${hoursParam}h` : `${Math.round(days)}d`;
  return { days, hoursParam, periodLabel };
}

/**
 * Sanitize a string parameter for safe display.
 * Strips HTML tags and limits length. Returns empty string for null/undefined.
 */
export function sanitizeParam(value: string | undefined | null, maxLength = 200): string {
  if (!value) return "";
  // Strip HTML tags and limit length
  return value.replace(/<[^>]*>/g, "").slice(0, maxLength);
}

/**
 * Validate a host filter against a list of known hosts.
 * Returns the host name if valid, empty string otherwise.
 */
export function validateHostFilter(
  hostFilter: string,
  knownHosts: string[]
): string {
  if (!hostFilter) return "";
  // Must match a known host exactly
  return knownHosts.includes(hostFilter) ? hostFilter : "";
}
