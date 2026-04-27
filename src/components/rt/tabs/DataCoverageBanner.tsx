"use client";

import { useState, type ReactNode } from "react";

/**
 * Collapsible amber banner that declares, in one place on a tab, what the
 * dashboard is actually getting from the source (Zabbix) and what it is still
 * missing. Each tab that depends on live telemetry should render one near the
 * top so the user does not have to guess why a column says "—" or why a chart
 * looks empty.
 *
 * Intentionally content-agnostic so the same component can front the Host
 * Inventory, CPU Timeline, CPU Comparison, and Resource Overview tabs with
 * scope-appropriate copy.
 */
export function DataCoverageBanner({
  title,
  available,
  missing,
  footer,
  defaultOpen = false,
}: {
  /** Headline — shown always, even when collapsed. Keep it short. */
  title: string;
  /** Human description of what IS published today (English copy). */
  available: ReactNode;
  /** Human description of what is NOT published yet and why. */
  missing: ReactNode;
  /**
   * Optional final paragraph — typically a note explaining what changes
   * automatically once the upstream gap is fixed.
   */
  footer?: ReactNode;
  /** Start expanded on tabs where the gap is critical context. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50/40 text-xs">
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-2 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex items-center gap-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400" />
          <span className="font-medium text-amber-900">{title}</span>
        </span>
        <span className="text-amber-700">{open ? "hide" : "details"}</span>
      </button>
      {open && (
        <div className="px-4 pb-3 pt-1 border-t border-amber-200 text-amber-900 space-y-2">
          <div>
            <span className="font-medium">Available today: </span>
            {available}
          </div>
          <div>
            <span className="font-medium">Missing (requested from Rimi Zabbix admin): </span>
            {missing}
          </div>
          {footer && <div className="text-[11px] text-amber-700">{footer}</div>}
        </div>
      )}
    </div>
  );
}
