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

import { useEffect, useRef, useState } from "react";
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

/** One option in a {@link FilterMultiSelect}. `tracked` marks stores we
 *  currently (or historically) receive Zabbix data for — those float to
 *  the top of the list under a "Zabbix data" group so the operator sees
 *  the monitored stores first. */
export interface MultiOption {
  v: string;
  l: string;
  /** True when this store has at least one device mapped to a configured
   *  Zabbix host (i.e. we get / have got monitoring data for it). */
  tracked?: boolean;
}

/**
 * Multi-select dropdown (checkbox list) bound to a `string[]` value.
 * Empty array = "all" (no filter). Replaces the single-value
 * {@link FilterSelect} for the Store filter so the operator can pin
 * several stores at once.
 *
 * Options are auto-grouped: `tracked` options (stores with Zabbix data)
 * render first under a "Zabbix data" header, the rest under "No Zabbix
 * data" and dimmed. Within each group the incoming order is preserved
 * (callers sort before passing).
 *
 * Closes on outside-click or Escape. Selecting toggles membership and
 * keeps the popover open so the operator can pick a few in one go.
 */
export function FilterMultiSelect({
  label,
  selected,
  options,
  onChange,
  allLabel = "All",
  title,
  groupLabels,
}: {
  label: string;
  /** Currently selected option values. Empty = no filter ("all"). */
  selected: string[];
  options: MultiOption[];
  onChange: (next: string[]) => void;
  /** Summary text + reset row label when nothing is selected. */
  allLabel?: string;
  title?: string;
  /** Override the two group headers (default: Zabbix data / No Zabbix data). */
  groupLabels?: { tracked: string; untracked: string };
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selectedSet = new Set(selected);
  const tracked = options.filter((o) => o.tracked);
  const untracked = options.filter((o) => !o.tracked);

  // Summary shown on the closed button.
  const summary =
    selected.length === 0
      ? allLabel
      : selected.length === 1
        ? (options.find((o) => o.v === selected[0])?.l ?? selected[0])
        : `${selected.length} selected`;

  const toggle = (v: string) => {
    const next = new Set(selectedSet);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    onChange([...next]);
  };

  const gl = groupLabels ?? { tracked: "Zabbix data", untracked: "No Zabbix data" };

  const renderRow = (o: MultiOption) => {
    const checked = selectedSet.has(o.v);
    return (
      <button
        key={o.v}
        type="button"
        onClick={() => toggle(o.v)}
        className={[
          "w-full flex items-center gap-2 px-2.5 py-1 text-left text-xs transition",
          checked ? "bg-blue-50 text-blue-800" : "text-gray-700 hover:bg-gray-50",
          o.tracked ? "" : "text-gray-400",
        ].join(" ")}
        role="option"
        aria-selected={checked}
      >
        <span
          className={[
            "inline-flex items-center justify-center w-3.5 h-3.5 rounded-sm border text-[9px] leading-none",
            checked ? "bg-blue-500 border-blue-500 text-white" : "border-gray-300 bg-white text-transparent",
          ].join(" ")}
          aria-hidden="true"
        >
          ✓
        </span>
        {o.tracked && (
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" aria-hidden="true" title="Has Zabbix data" />
        )}
        <span className="truncate">{o.l}</span>
      </button>
    );
  };

  return (
    <div className="relative" ref={rootRef}>
      <label className="flex items-center gap-2" title={title}>
        <span className="text-gray-500 font-medium">{label}</span>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
          className={[
            "inline-flex items-center gap-1.5 border rounded px-2 py-1 text-xs bg-white focus:outline-none focus:border-blue-400 transition",
            selected.length > 0 ? "border-blue-300 text-blue-800" : "border-gray-200 text-gray-700",
          ].join(" ")}
        >
          <span className="max-w-[10rem] truncate">{summary}</span>
          <span className="text-gray-400 text-[9px]">▾</span>
        </button>
      </label>

      {open && (
        <div
          className="absolute z-30 mt-1 w-60 max-h-72 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg py-1"
          role="listbox"
          aria-multiselectable="true"
        >
          {/* All-stores reset row. */}
          <button
            type="button"
            onClick={() => onChange([])}
            className={[
              "w-full flex items-center justify-between px-2.5 py-1 text-left text-xs transition",
              selected.length === 0 ? "bg-blue-50 text-blue-800 font-medium" : "text-gray-700 hover:bg-gray-50",
            ].join(" ")}
          >
            <span>{allLabel}</span>
            {selected.length > 0 && <span className="text-[10px] text-blue-500 font-medium">Clear</span>}
          </button>

          {tracked.length > 0 && (
            <>
              <div className="px-2.5 pt-2 pb-0.5 text-[9px] uppercase tracking-wide text-emerald-600 font-semibold">
                {gl.tracked}
              </div>
              {tracked.map(renderRow)}
            </>
          )}

          {untracked.length > 0 && (
            <>
              <div className="px-2.5 pt-2 pb-0.5 text-[9px] uppercase tracking-wide text-gray-400 font-semibold">
                {gl.untracked}
              </div>
              {untracked.map(renderRow)}
            </>
          )}

          {options.length === 0 && (
            <div className="px-2.5 py-2 text-[11px] text-gray-400">No stores</div>
          )}
        </div>
      )}
    </div>
  );
}
