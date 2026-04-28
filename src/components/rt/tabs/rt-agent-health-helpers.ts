/**
 * Helpers for surfacing Zabbix agent health on the Retellect dashboard.
 *
 * The data flow is:
 *   ZabbixClient.getAgentHealthSummary  →  page.tsx  →  ZabbixData.agentHealth
 *     →  this module's classifyAgentHealth → Data Health tab + Inventory badge
 *
 * Without this distinction, hosts whose local Zabbix agent reports
 * ZBX_NOTSUPPORTED for most items show on the dashboard as "0% Retellect /
 * 0% sp.sss" — visually identical to a host where the processes are simply
 * idle. That is misleading: silent agents and idle processes should look
 * different so users can act on the right thing (escalate to SP admin vs.
 * draw conclusions about Retellect impact).
 */

export type AgentHealthBucket = "healthy" | "partial" | "broken" | "no-data";

/**
 * Classify a host's overall agent health from item-state counts.
 *
 *   healthy   — < 25 % of enabled items unsupported
 *   partial   — 25–50 % unsupported (some perf counters failing, others fine)
 *   broken    — > 50 % unsupported (agent in degraded shape, treat dashboard
 *               numbers from this host with strong skepticism)
 *   no-data   — 0 enabled items (no monitoring template attached, or host
 *               just registered and items not yet provisioned)
 *
 * Why these thresholds: Dangeručio SCO2 (2026-04-28) sat at 22/24 = 92 %
 * unsupported, the canonical "broken" case. Healthy SCO1 sibling sat at
 * 8/24 = 33 % unsupported (driver items for processes that genuinely don't
 * run on every host) — which is "partial" rather than "healthy" by the
 * thresholds, intentionally. This gives users a middle warning state for
 * fleet-wide minor template drift before the host is flagged as broken.
 */
export function classifyAgentHealth(
  supported: number,
  unsupported: number,
  totalEnabled: number,
): AgentHealthBucket {
  if (totalEnabled === 0) return "no-data";
  const ratio = unsupported / totalEnabled;
  if (ratio > 0.5) return "broken";
  if (ratio >= 0.25) return "partial";
  // Defensive: if `supported + unsupported < totalEnabled` (shouldn't happen
  // but the data crosses a network boundary), still classify by ratio above.
  void supported;
  return "healthy";
}

/**
 * Human-readable label and tone for an AgentHealthBucket. Centralised so the
 * Data Health tab and the Inventory badge stay visually consistent.
 */
export function describeAgentHealth(bucket: AgentHealthBucket): {
  label: string;
  tooltip: string;
  tone: "ok" | "warn" | "alert" | "neutral";
} {
  switch (bucket) {
    case "healthy":
      return {
        label: "Agent OK",
        tooltip: "Most monitoring items reporting normally.",
        tone: "ok",
      };
    case "partial":
      return {
        label: "Partial",
        tooltip:
          "Some items in ZBX_NOTSUPPORTED state — typically driver/process items that don't apply to this host. Other metrics still reliable.",
        tone: "warn",
      };
    case "broken":
      return {
        label: "Agent issues",
        tooltip:
          "Most monitoring items in ZBX_NOTSUPPORTED state — local Zabbix agent or Windows perf counter problem. Dashboard numbers from this host are NOT reliable. Likely needs SP admin: lodctr /R, agent service restart, or perfmon privilege fix.",
        tone: "alert",
      };
    case "no-data":
      return {
        label: "No monitoring",
        tooltip:
          "No enabled items returned for this host — monitoring template may not be attached.",
        tone: "neutral",
      };
  }
}
