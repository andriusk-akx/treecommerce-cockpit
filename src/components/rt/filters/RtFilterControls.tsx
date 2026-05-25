/**
 * Shared filter-bar primitives for the Retellect tabs.
 *
 * Why this exists: Rollout Insights and CPU Timeline both render a
 * filter row with overlapping controls (threshold dropdown, store
 * select, count-from segmented). Until 2026-05-23 each tab had its own
 * inline-styled version that drifted apart visually — different label
 * casing, different button heights, different border colours — making
 * it hard for users to tell that switching tabs was supposed to
 * preserve their context. These primitives are the single source of
 * truth: change the styling here and both filter bars pick it up.
 *
 * Each tab still owns its filter SET (Timeline has Metric, CPU,
 * Group-by, Retellect pills that Rollout doesn't; Rollout has the
 * Active-threshold slider that only makes sense in aggregate mode).
 * The primitives only own the visual language — label typography,
 * control sizing, spacing, focus ring.
 */
"use client";

import type { ReactNode } from "react";

/** Container wrapper for a filter row. Use as the outer element of a
 *  tab's filter bar — gives the white card background, rounded border,
 *  spacing and overall text scale. Pass `rows` when a tab needs more
 *  than one line of filters; the wrapper stacks them with consistent
 *  vertical rhythm. */
export function FilterBar({ children }: { children: ReactNode }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 px-4 py-3 mb-5 flex flex-col gap-2 text-xs">
      {children}
    </div>
  );
}

/** Row inside a FilterBar — flex-wrap with the standard horizontal gap.
 *  Tabs with a single row use FilterBar's flex-col with one FilterRow
 *  inside; multi-row tabs stack several FilterRows. */
export function FilterRow({ children, justify }: { children: ReactNode; justify?: "between" }) {
  return (
    <div className={`flex flex-wrap items-center gap-4 ${justify === "between" ? "justify-between" : ""}`}>
      {children}
    </div>
  );
}

/** Plain dropdown bound to a string value. Same look as the legacy
 *  Rollout `FilterSelect` it replaces — small label, white select,
 *  amber focus ring. */
export function FilterSelect({
  label,
  value,
  options,
  onChange,
  title,
  width,
}: {
  label: string;
  value: string;
  options: { v: string; l: string }[];
  onChange: (v: string) => void;
  title?: string;
  /** Optional fixed width (Tailwind utility) — useful for short bands
   *  like a percentage selector where the variable-width default
   *  makes the row jitter as you change selection. */
  width?: string;
}) {
  return (
    <label className="flex items-center gap-2" title={title}>
      <span className="text-gray-500 font-medium">{label}</span>
      <select
        className={`border border-gray-200 rounded px-2 py-1 text-xs bg-white text-gray-700 focus:outline-none focus:border-blue-400 ${width ?? ""}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.v} value={o.v}>
            {o.l}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Pill-style segmented control. Pass 2-N options; the active one
 *  carries the same blue tint we use everywhere for "selected". Use
 *  for binary toggles (Count from, Metric) and small enumerations
 *  (Period presets, Group by).
 *
 *  Disabled options: pass `disabled: true` on an option to render it
 *  greyed out and non-clickable. Used by Rollout Insights to keep the
 *  Timeline-style "Metric" segmented visible (so the row's visual
 *  rhythm matches across tabs) while signalling that Peak % isn't a
 *  selectable view in the matrix — Peak CPU has its own column there. */
export function FilterSegmented<T extends string>({
  label,
  value,
  options,
  onChange,
  info,
  ariaLabel,
}: {
  label: string;
  value: T;
  options: { v: T; l: string; title?: string; disabled?: boolean }[];
  onChange: (v: T) => void;
  /** Tooltip text — when provided, a small (i) help icon is rendered
   *  next to the label and the whole label group gets `cursor-help`. */
  info?: string;
  ariaLabel?: string;
}) {
  return (
    <label className="flex items-center gap-2" title={info}>
      <span className={`text-gray-500 font-medium ${info ? "inline-flex items-center gap-1" : ""}`}>
        {label}
        {info && (
          <span
            aria-hidden="true"
            className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-gray-300 text-[9px] font-semibold text-gray-400 cursor-help"
          >
            i
          </span>
        )}
      </span>
      <div className="inline-flex border border-gray-200 rounded overflow-hidden bg-white" role="radiogroup" aria-label={ariaLabel ?? label}>
        {options.map((opt, i) => {
          const active = value === opt.v;
          const isDisabled = !!opt.disabled;
          return (
            <button
              key={opt.v}
              type="button"
              role="radio"
              aria-checked={active}
              aria-disabled={isDisabled || undefined}
              disabled={isDisabled}
              onClick={() => {
                if (isDisabled) return;
                onChange(opt.v);
              }}
              title={opt.title}
              className={[
                "px-2 py-0.5 text-[11px] transition",
                i > 0 ? "border-l border-gray-200" : "",
                isDisabled
                  ? "text-gray-300 bg-gray-50 cursor-not-allowed"
                  : active
                    ? "bg-blue-50 text-blue-700 font-medium"
                    : "text-gray-500 hover:text-gray-700",
              ].join(" ")}
            >
              {opt.l}
            </button>
          );
        })}
      </div>
    </label>
  );
}

/** Thin vertical divider used between logically distinct control
 *  groups in a single row (e.g. threshold | store-and-cpu | period).
 *  Keeps Timeline's "primary vs secondary slicer" hierarchy without
 *  inlining border styles. */
export function FilterDivider() {
  return <span className="w-px h-4 bg-gray-200" aria-hidden="true" />;
}

/** Trailing hint text aligned to the right edge of a row — same
 *  treatment as Rollout's "Filters persist across tabs" footer. */
export function FilterHint({ children }: { children: ReactNode }) {
  return <span className="text-gray-300 ml-auto text-[11px]">{children}</span>;
}
