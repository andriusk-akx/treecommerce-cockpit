/**
 * Rollout Insights tab.
 *
 * The tab used to host two sub-views — the decision-oriented "Matrix"
 * and the legacy per-host "Heatmap" — toggled via a small selector at
 * the top of the page. The Heatmap was retired on 2026-06-01: the
 * Matrix + drilldown workspace already exposes per-host detail in the
 * bottom pane, so the second view was carrying duplicate concepts
 * with extra visual chrome. Dropping it kills ~1900 lines of code and
 * the toggle that was confusing operators (one tab, two layouts).
 *
 * This file now exists only to preserve the `RtRolloutInsights`
 * symbol that RtPilotWorkspace imports for the "rollout" tab. The
 * matrix component itself lives in `RtCpuMatrix.tsx`.
 */

import { RtCpuMatrix } from "./RtCpuMatrix";
import type { RtPilotData, ZabbixData } from "../RtPilotWorkspace";

export function RtRolloutInsights({
  pilot,
  zabbix,
}: {
  pilot: RtPilotData;
  zabbix: ZabbixData;
}) {
  return <RtCpuMatrix pilot={pilot} zabbix={zabbix} />;
}
