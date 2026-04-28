# AKpilot Engineering Backlog

Items captured outside the active roadmap. Each item gets a short code so it can be referenced from code comments.

---

## RT-BACKFILL — Backfill `Device.retellectEnabled` from telemetry

**Status:** Open (added 2026-04-28)

**Context.** `scripts/seed_rimi_expand.ts:115` hardcodes `retellectEnabled: false` for every Device row created from the live Rimi host list. The DB flag therefore says "no Retellect" for every host on Railway prod, even though Zabbix `python.cpu` items prove some of them ARE running Retellect. The dashboard's "Retellect installed" filter (Overview, Timeline, Inventory) consequently returned an empty list — verified live in Chrome on 2026-04-28.

**Hot-fix already shipped.** Three filter sites switched from DB flag to live telemetry:

- `RtOverview.tsx` — filter on `r.rtActive` (python.cpu fresh + CPU > 1 %)
- `RtTimeline.tsx` — same signal, plus computes `retellectByHost` map
- `RtInventory.tsx` — filter on `h.rtProcessStatus === "running"`

Search for `RT-BACKFILL` in source for the exact rollback points.

**This task.** Make the DB flag truthful again so it can be used by the parts of the app that still read it (capacity-risk page, hypotheses tab, devices stats, CPU-comparison overlays). Then we can flip the three filters back to `r.retellectEnabled === true` (or, better, to `rtActive || retellectEnabled` — show running AND should-be-running).

**Approach.**

1. New script `scripts/backfill-retellect-enabled.ts`. For each `Device` matched by `sourceHostKey` to a live Zabbix host, set `retellectEnabled = true` if any `python.cpu` items exist for that host within the last 24 h.
2. Run it as a one-shot against the Railway DB after deploy.
3. Wire it into the existing ingestion path so reconciliation happens on each Zabbix sync (otherwise the flag goes stale again as hosts move in/out of Retellect coverage).
4. After the flag is reliable, revisit the three hot-fixed filters. Choice: either revert to DB-only or use `rtActive || retellectEnabled` (best UX — also surfaces "should be running but isn't" hosts).

**Acceptance.**

- Backfill script runs cleanly against prod DB.
- After run, `SELECT COUNT(*) FROM "Device" WHERE "retellectEnabled" = true;` returns a number that matches the count of hosts publishing `python.cpu` items in Zabbix.
- Reconciliation cron runs daily (or on each Zabbix sync) without divergence.
- Hot-fix comments in `Rt{Overview,Timeline,Inventory}.tsx` removed.

**Why not in the active roadmap.** Hot-fix unblocks the user today. The backfill is the proper fix but needs script work, ingestion-path changes, and a Railway run-book. Not a blocker for the current Retellect dashboard work, so it sits here until prioritised.

---

## RT-CPUMODEL — Missing CPU/RAM/OS data on the 115 Rimi devices

**Status:** Open (added 2026-04-28)

**Symptom.** CPU Threshold Timeline (RtTimeline) shows the CPU column empty for every host, and grouping by "CPU model" collapses all 115 hosts into a single "—" bucket. Verified live in Chrome on Railway prod.

**Root cause.** `scripts/seed_rimi_expand.ts` only writes 7 Device fields per row (`pilotId, storeId, name, sourceHostKey, deviceType, retellectEnabled, status`) — `cpuModel`, `ramGb`, and `os` are left null. Compounding it: the Zabbix client layer (`src/lib/zabbix/types.ts → HostResources`) does not fetch any hardware/inventory data, so even at runtime there is no live source the dashboard can fall back to.

**Approach.**

1. **Zabbix client extension.** Extend `HostResources` (and the underlying `host.get` call in `src/lib/zabbix/client.ts`) to include Zabbix host inventory fields when available: `inventory.hardware`, `inventory.os`, `inventory.cpu_model`, `inventory.ram`. Many Zabbix templates populate these via discovery rules; SP admin may need to enable inventory mode for the Rimi hosts.
2. **Seed expand update.** Read inventory from `rimi_hosts_filtered.json` (regenerate from Zabbix probe) so each Device row gets `cpuModel`, `ramGb`, `os` populated at seed time.
3. **Runtime fallback in UI.** If `device.cpuModel` is empty, prefer `zHost.inventory?.cpuModel` rendered straight from telemetry. Lets the dashboard be useful even before the seed is re-run.
4. **UX nicety.** When the user activates "Group by CPU model" and the visible set has &gt;50 % unknown CPUs, surface a one-line note above the heatmap: "CPU model unknown for X of Y hosts — group by Store or Host instead, or wait for inventory backfill."

**Acceptance.**

- After seed + Zabbix client update, &gt;90 % of devices have a non-null `cpuModel`.
- Grouping by CPU model in RtTimeline produces ≥ 2 distinct buckets.
- Inventory column in RtInventory shows the actual CPU model rather than "—".

**Why parked here.** The fix is a multi-layer change (Zabbix client → seed → UI fallback) and requires SP admin to confirm inventory mode is enabled on the Rimi hosts. Captured immediately so it's not forgotten while we focus on the filter and Data Health work.

---

## MON-2 — Template coverage diagnostic (hosts without `python.cpu` items)

**Status:** Open (added 2026-04-28)

**Context.** Live diagnostic against prod Zabbix on 2026-04-28 (probe: `scripts/probe-rt-running-filter.mjs`) showed a much larger monitoring gap than expected:

| Bucket | Count | What it means |
|---|---|---|
| Total enabled Rimi SCO hosts | 66 | Zabbix host status = "enabled" |
| Hosts with `python*.cpu` items at all | **8** | Retellect monitoring template attached |
| **Hosts with NO `python*.cpu` items** | **58 (88 %)** | Template never deployed / unattached |
| Hosts reporting fresh + CPU > 0.01 % | 7 | Filter shows these as "running" after FIX-1 |

The 58 host gap is a different failure mode from MON-1 (broken Zabbix agent → ZBX_NOTSUPPORTED). Here the agent may be perfectly healthy — it just has no python.cpu items configured, so the dashboard quietly classifies the host as "not running Retellect" by default. We can't tell from the dashboard whether those 58 hosts: (a) genuinely don't have Retellect deployed, (b) have Retellect but missing template attachment, or (c) need a new Zabbix template push.

**This task.** Make the gap visible so the user (and any reader) sees the real number of "we don't know" hosts, instead of confidently saying "only 7 hosts run Retellect".

**Approach.**

1. **Data Health tab — new section "No Retellect monitoring template".** Lists hosts that have ZERO retellect-pattern items (`python*.cpu` / `perf_counter[\Process(python*)\…]`). Distinct from the existing "Silent" and "Agent issues" sections so each failure mode is named. Source: extend `getAgentHealthSummary()` (or add a parallel call) to also return a per-host count of items matching the retellect key pattern.

2. **Overview "Retellect Active" tile — subtitle expansion.** Today: `"X hosts running Retellect (across Y of Z stores)"`. After: `"X running · 58 unknown (no template)"` with the unknown count clickable through to the Data Health section above. Keeps the small running number from looking like the whole story.

3. **SP admin request template.** A copy-paste paragraph in `docs/zabbix-prasymas-sp-adminui-LT.md` listing the 58 host names and asking which subset is (a)/(b)/(c) above. Lets the user push this back to SP without re-running the probe each time.

**Acceptance.**

- Data Health tab shows "No Retellect monitoring template (N)" section with host list and Zabbix host names visible.
- Overview tile subtitle calls out the unknown count.
- SP admin request doc generated with current host list.
- All three views update automatically when the gap shrinks (e.g. SP admin attaches template to 10 more hosts → "Retellect template missing" drops from 58 to 48).

**Out of scope.** Auto-detecting whether a host SHOULD have Retellect template — that's RT-BACKFILL above. MON-2 only describes the gap; closing it is SP admin work + RT-BACKFILL work.

**Why parked here.** Closing the gap depends on SP admin response (per-host accounting), which has its own coordination cost. Surfacing the gap is fast, but lower priority than FIX-1 which immediately corrects what users see today.

---
