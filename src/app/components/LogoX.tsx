/**
 * Store X brand mark.
 *
 * Two rounded diagonal strokes forming an X — minimalistic, geometric,
 * works at any size. The accent leg (top-right → bottom-left) uses a
 * brand blue so the mark reads as more than just a letter while staying
 * monochrome at small sizes (favicon falls back to currentColor).
 *
 * Usage:
 *   <LogoX size={28} />            // header
 *   <LogoX size={48} accent />     // login splash, hero
 *   <LogoX size={16} mono />       // tight contexts (chips, badges)
 *
 * `mono` forces single-colour rendering using `currentColor`. `accent`
 * forces the two-tone treatment regardless of context. Default picks
 * two-tone — the component is a brand mark, so colour is on by default.
 */
interface LogoXProps {
  /** Pixel size of the rendered SVG (square). Defaults to 24. */
  size?: number;
  /** Force single-colour rendering using `currentColor`. */
  mono?: boolean;
  /** Force two-tone rendering even when `mono` would otherwise apply. */
  accent?: boolean;
  /** Extra class names appended to the root SVG. */
  className?: string;
  /** Accessible label for screen readers. Hidden by default. */
  label?: string;
}

export function LogoX({ size = 24, mono = false, accent = false, className, label }: LogoXProps) {
  const useAccent = accent || !mono;
  // Brand palette: near-black + olive heritage green. Black anchors the
  // mark (weight, gravitas), olive carries identity without ever being
  // loud. Picked over Tailwind green-900 (#14532d) and emerald variants
  // because the goal is quietly premium with a hint of warmth — olive
  // reads "heritage / boutique" rather than "tech-corporate", which sits
  // better with a consultant-led product than a saturated forest tone.
  // #3f4f1f is dark enough to coexist with body text at favicon size and
  // the footer mono chip without losing legibility.
  const primaryStroke = "currentColor";
  const accentStroke = useAccent ? "#3f4f1f" : "currentColor";
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      xmlns="http://www.w3.org/2000/svg"
      role={label ? "img" : "presentation"}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={className}
    >
      {/* Left-leaning diagonal — primary leg, currentColor so it inherits
          surrounding text colour (e.g. white on dark mode). */}
      <line
        x1="6"
        y1="6"
        x2="26"
        y2="26"
        stroke={primaryStroke}
        strokeWidth="4"
        strokeLinecap="round"
      />
      {/* Right-leaning diagonal — accent leg in brand blue. Renders ON TOP
          so the intersection picks up the accent colour for a subtle hit
          of identity at the centre. */}
      <line
        x1="26"
        y1="6"
        x2="6"
        y2="26"
        stroke={accentStroke}
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  );
}
