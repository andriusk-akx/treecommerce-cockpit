/**
 * Store X brand wordmark.
 *
 * Was an X-shape glyph (two crossed strokes) until 2026-05-25 — Andrius
 * supplied the new wordmark version where "Store" is in the primary
 * text colour and "X" sits in the brand olive. The wordmark carries
 * the brand name itself, so adjacent <h1>Store X</h1> markup in the
 * layout / login page is now removed (the logo IS the title).
 *
 * Sizing:
 *   `size` is the rendered HEIGHT in pixels. Width is auto-derived to
 *   preserve the ~3.4 : 1 aspect ratio of the wordmark image. This
 *   reverses the previous glyph version where `size` drove a square
 *   bounding box — callers passing the old size values (12 / 24 / 28
 *   / 36 / 48) still get a reasonable result because the height
 *   number stays comparable to the previous glyph cap-height.
 *
 * Colour:
 *   `mono` forces single-colour rendering using `currentColor` — used
 *   in tight contexts (footer chip) where the olive accent muddies
 *   readability at small sizes.
 *   `accent` forces two-tone rendering even when `mono` would otherwise
 *   apply. Default is two-tone.
 *
 *  Font:
 *    Uses Geist (already loaded in the root layout via `geistSans.variable`)
 *    with a generic sans-serif fallback so the wordmark stays visually
 *    consistent with the rest of the UI.
 */
interface LogoXProps {
  /** Rendered height of the wordmark in pixels. Defaults to 24. */
  size?: number;
  /** Force single-colour rendering using `currentColor`. */
  mono?: boolean;
  /** Force two-tone rendering even when `mono` would otherwise apply. */
  accent?: boolean;
  /** Extra class names appended to the root SVG. */
  className?: string;
  /** Accessible label for screen readers. Defaults to "Store X". */
  label?: string;
}

export function LogoX({ size = 24, mono = false, accent = false, className, label }: LogoXProps) {
  const useAccent = accent || !mono;
  // Brand palette: near-black + olive heritage green. The accent stays
  // the same #3f4f1f used everywhere else (inline "X" highlights in
  // text, etc.) so the wordmark slots into existing layouts without a
  // colour shift between body copy and logo.
  const accentColour = useAccent ? "#3f4f1f" : "currentColor";
  // Wordmark aspect: the source image is 882 × 296 ≈ 2.98 : 1. We pad
  // a touch of horizontal breathing room (no clipping at sub-pixel
  // rendering) so the working aspect is 3.4 : 1. ViewBox uses 100 units
  // tall for round-number font math.
  const aspect = 3.4;
  const width = Math.round(size * aspect);
  const accessibleLabel = label ?? "Store X";
  return (
    <svg
      viewBox="0 0 340 100"
      width={width}
      height={size}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={accessibleLabel}
      className={className}
    >
      <text
        x="0"
        y="80"
        fontFamily="var(--font-geist-sans), -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
        fontSize="92"
        fontWeight={400}
        letterSpacing="-1.5"
        fill="currentColor"
      >
        Store
      </text>
      <text
        x="240"
        y="80"
        fontFamily="var(--font-geist-sans), -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
        fontSize="92"
        fontWeight={300}
        letterSpacing="-1.5"
        fill={accentColour}
      >
        X
      </text>
    </svg>
  );
}
