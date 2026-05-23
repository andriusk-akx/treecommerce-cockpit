/**
 * Shared on/off (and similar binary state) labels for the Retellect
 * dashboard.
 *
 * Why: pre-2026-05-23 the Rollout Insights matrix had inconsistent
 * treatment of ON/OFF — some columns coloured ON with a blue accent
 * (OnOffBars, AboveThresholdCell), others left both labels in the same
 * neutral gray (Hosts sub-line, Retellect CPU avg cell, legacy Min cell).
 * That visual drift made it harder than necessary to read the matrix at
 * a glance, especially when scanning multiple rows.
 *
 * This module defines the single source of truth for those labels. The
 * matrix imports `OnOffLabel` everywhere a Retellect ON/OFF state needs
 * to render, and the styling stays unified by construction.
 *
 * Spec (Variant A — minimalist, agreed 2026-05-23):
 *   ON  → text-blue-600  font-medium uppercase text-[10px] tracking-wide
 *   OFF → text-gray-400  font-medium uppercase text-[10px] tracking-wide
 *
 * Accessibility: ON / OFF are also distinct WORDS, not just colour
 * swatches — colour-blind users still distinguish them. A future
 * dot/icon variant could add a second visual channel if needed, but
 * the current data-dense matrix favours minimal additional weight.
 */
"use client";

import type { ReactNode } from "react";

export type OnOffState = "on" | "off";

/** Inline ON/OFF label — drop into any matrix cell where the same
 *  state needs to appear with the dashboard-wide treatment. Renders a
 *  span (not a block) so it inlines next to whatever value it labels. */
export function OnOffLabel({
  state,
  className = "",
}: {
  state: OnOffState;
  /** Optional extra Tailwind classes — useful for forcing block layout
   *  (`block`) inside stacked cells or adding a margin. */
  className?: string;
}) {
  const colour = state === "on" ? "text-blue-600" : "text-gray-400";
  return (
    <span
      className={`text-[10px] font-medium uppercase tracking-wide tabular-nums ${colour} ${className}`}
    >
      {state === "on" ? "ON" : "OFF"}
    </span>
  );
}

/** Convenience wrapper for stacked cells where a row is "value + label"
 *  with the label sitting next to the value at the same baseline. The
 *  callsite typically writes `<OnOffValueRow state="on">{value}</OnOffValueRow>`
 *  inside a flex container. Renders just the children + label as a
 *  fragment — no extra wrapper — to keep the existing parent layout
 *  control. */
export function OnOffValueRow({
  state,
  children,
}: {
  state: OnOffState;
  children: ReactNode;
}) {
  return (
    <>
      {children} <OnOffLabel state={state} />
    </>
  );
}
