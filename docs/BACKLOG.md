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
