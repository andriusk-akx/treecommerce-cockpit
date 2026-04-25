# Zabbix Template Enhancement Request — Retellect SCO CPU Analysis

**Author:** Andrius K. (StrongPoint, AKpilot project)
**Date:** 2026-04-25
**Audience:** StrongPoint Zabbix admin / monitoring team
**Status:** Request — please review and confirm feasibility / timeline

---

## ⚠️ Important — please don't change anything that's already working

Before anything else: **everything we read today must keep working
exactly as it does now**. This is a request to **add** items, not modify
or replace existing ones. The dashboard depends on this exact set of
keys, and breaking any of them silently breaks user-facing screens.

Do **NOT**:

- Rename or remove any existing item key (`*.cpu`, `system.cpu.util[,,avg1]`,
  `system.cpu.load[,avg1]`, `system.cpu.num`, the `perf_counter[\Process(...)]`
  family, memory / disk / network items currently published).
- Change update intervals, retention (`history`/`trends`), value types or
  units of any existing item.
- Touch host names, host group membership ("Rimi"), proxy assignment, or
  any tagging that the API uses to identify hosts.
- Disable or unlink the current SCO host template; if a new template is
  introduced, it must coexist alongside the current one or be a strict
  superset.

Do:

- **Add** the new items / discovery rules described below as additional
  template entries.
- Roll the new items out gradually (e.g. one pilot store first, then the
  rest) so we can verify the dashboard sees them before they go everywhere.
- Let us know in advance of any maintenance window so we can pause
  background fetches and confirm coverage afterwards.

If a change to an existing item becomes necessary (e.g. you'd like to
deprecate `*.cpu` in favour of `proc.cpu.util[*]`), please flag it as a
separate item with at least one full release cycle of overlap — we'll
update the dashboard to read both, then drop the old read once we've
verified parity.

---

## TL;DR

The Retellect dashboard tracks CPU consumption per process category across
~115 Rimi SCO hosts. With current Zabbix template coverage we can attribute
about 65–70% of host CPU to specific processes; the remaining 25–35% shows
up as "Other" because no items capture it.

To close this gap and let the dashboard answer the question
**"what exactly is consuming CPU during a 95% peak?"**, we need three
template changes — none invasive, all standard Zabbix Windows agent items.

| # | Item / mechanism | Why we need it | Priority |
|---|------------------|----------------|----------|
| 1 | `system.cpu.util[,user]`, `[,system]`, `[,iowait]` | Split overall CPU into user-space vs kernel vs I/O wait. Tells us whether "Other" is Windows kernel work or untracked user processes. | **High** |
| 2 | `proc.cpu.util[*]` LLD discovery (top-N) | Auto-track every process consuming significant CPU, not just the hard-coded 4 (python/spss/sql/vm). | **High** |
| 3 | Read-write Zabbix API token for AKpilot | Lets the dashboard team add/tune items without round-tripping to admin every time. | Medium |

Without these we can keep showing accurate but coarse data; with these we
can pinpoint the actual cause of peaks like the 95.5% spike at SHM
Pavilnionys SCO2 on 2026-04-18 11:39.

---

## Context

The dashboard reads Zabbix data via the JSON-RPC API (read-only token,
group `Rimi`). Today the per-process telemetry available on each SCO host is:

```text
*.cpu items (custom keys, % of total host CPU, 1-min sampling):
  python.cpu, python1.cpu, python2.cpu, python3.cpu   → categorised "Retellect"
  spss.cpu                                            → categorised "SCO App"
  sql.cpu                                             → categorised "DB"
  vm.cpu                                              → categorised "System"
  cs300sd.cpu, NHSTW32.cpu, udm.cpu                   → niche, mostly idle

perf_counter[\Process(<name>)\% Processor Time] items (% of one core):
  same set of processes as *.cpu, different naming convention.
  Less convenient because it needs ÷cores normalization.

system.cpu.util[,,avg1] — overall host CPU, 1-min average.
system.cpu.load[,avg1]  — load average.
system.cpu.num          — core count (static).
```

Notably absent:

- `system.cpu.util[,user]`, `system.cpu.util[,system]`, `system.cpu.util[,iowait]`
- `proc.cpu.util[*]` LLD (low-level discovery) — agent doesn't enumerate
  processes dynamically; it only reports the hard-coded list above

## What this looks like in the dashboard right now

Example: **SHM Pavilnionys [T803] SCO2** on 2026-04-24 at 15:25:

```text
Host CPU:      91 %
─────────────────────
SCO App:       34.7 %  (spss.cpu)
DB (SQL):      19.7 %  (sql.cpu)
System:         5.9 %  (vmware-vmx)
Retellect:      1.1 %  (python*.cpu)
─────────────────────
Tracked sum:   61.4 %
Other:         29.5 %  ← unexplained
```

We verified directly against `history.get` for this host/minute that the
tracked-sum number is correct and the gap is real — those 29.5% really are
consumed somewhere on the host that no Zabbix item describes. It could be
kernel work, antivirus, Windows Update, a payment-processor sub-process, or
I/O wait time. Today we can't tell.

Before we close the loop with the business stakeholders ("the host is
saturated — what's saturating it?"), we need to be able to answer that
question.

---

## Request 1 — split `system.cpu.util` into user / system / iowait modes

**Items to add to the SCO host template:**

```text
system.cpu.util[,user]     → % of CPU consumed by user-space processes
system.cpu.util[,system]   → % of CPU consumed by Windows kernel
system.cpu.util[,iowait]   → % of CPU waiting on disk / network I/O
```

**Update interval:** 60 s (same as `system.cpu.util[,,avg1]`).

**Why we need this:**

`system.cpu.util[,,avg1]` (which we already have) sums all three. By itself
the dashboard can't distinguish "user processes consuming 90%" from
"kernel doing housekeeping at 90%". Splitting tells us which half of the
fence to look on.

For the Pavilnionys 29.5% Other example, this would split into something
like:

```text
Host CPU:       91 %
  user:         70 %   ← of which we already explain 61.4 % via *.cpu items;
                        the remaining 8.6 % is a real untracked user process
  system:       15 %   ← Windows kernel — structural, not actionable
  iowait:        6 %   ← disk/network wait — actionable if we suspect storage
```

That immediately reframes "Other" from a 30% black hole into "8.6% needs
identifying, 21% is structural OS overhead". Big difference for triage.

**Cost / risk:** None we know of — these are stock Zabbix Windows agent
keys. Three additional items per host × 115 hosts = 345 new items, sampling
at 1 min = ~5.75 samples/sec across the whole fleet. Negligible load.

---

## Request 2 — add `proc.cpu.util[*]` LLD discovery (top-N processes)

**Discovery rule to add to the SCO host template:**

```text
LLD rule:  proc.cpu.util.discovery
  Type: Zabbix agent (active recommended)
  Update interval: 1 h (process list rarely changes)

Item prototypes from the discovered process names:
  proc.cpu.util[{#PROC_NAME},,total,1m]    → % of total host CPU per process
  Update interval: 60 s
  History: 7 d, Trends: 30 d

Filter: keep only processes whose CPU usage exceeds 1% (noise floor) at
        discovery time. Limits the explosion of items.
```

**Why we need this:**

The current 7 hard-coded `*.cpu` items capture python / spss / sql / vmware
plus three idle ones (cs300sd, NHSTW32, udm). Anything else — antivirus,
Windows Update, third-party POS sub-processes, payment integration daemons
— is invisible.

LLD turns this into "discover whatever is hot, track it". The dashboard
can then show a top-10 process table per host per minute, automatically
covering whatever the "Other" category is hiding.

**Cost / risk:** Bigger. Each host might gain 5–15 new dynamic items
(top-N filtered). Across 115 hosts that's potentially 1,000–1,700 extra
items. Per-second sample rate would jump by ~25 samples/s. Still well
within typical Zabbix server capacity, but the admin should sanity-check
against the proxy / DB / disk load first.

**Alternative (cheaper):** static items for a curated list of known
processes that we suspect are hot but currently untracked. Examples to
consider based on common Windows / POS environments:

```text
proc.cpu.util[svchost]       — Windows service host (often hot)
proc.cpu.util[lsass]         — local security authority
proc.cpu.util[MsMpEng]       — Windows Defender realtime
proc.cpu.util[explorer]      — desktop shell
proc.cpu.util[WmiPrvSE]      — WMI provider
proc.cpu.util[Java]          — Java POS components if present
proc.cpu.util[node]          — any Node.js services
proc.cpu.util[chrome]/[msedge] — staff browser sessions
```

If LLD is too disruptive, even adding 4–8 of these statically would shrink
"Other" significantly.

---

## Request 3 — read-write Zabbix API token for AKpilot

**What:** issue an API token scoped to host group "Rimi" with permission
to call `item.create`, `item.update`, `item.delete`, `discoveryrule.create`
on hosts in that group. Or — equivalently — give the AKpilot service user
"Admin" role on the Rimi host group.

**Why:** lets the AKpilot team iterate on item coverage without filing a
ticket for every change. Faster turnaround when we need to tune what we
track. Fully reversible (token can be rotated or revoked any time).

**Scope guardrails we'd commit to:**

- Only `proc.cpu.util[*]` and `system.cpu.util[*]` items.
- No template-wide changes — only host-level overrides.
- All changes logged in our git repo (`prisma/seed.ts` will reference
  itemids; deployments are reviewable).

**Risk if denied:** Low — we'd just file tickets for every change. The
ask is convenience, not capability.

---

## What we'll do once Request 1 is in

Within ~1 day of `system.cpu.util[,user/system/iowait]` rolling out:

1. Update the dashboard's `process-history` API to fetch the three new items
   alongside the existing per-process keys.
2. Re-shape the "Other" bar in the drill-down detail panel into:
   - **Untracked user processes** = `[,user]` − Σ(monitored *.cpu)
   - **Kernel** = `[,system]`
   - **I/O wait** = `[,iowait]`
3. Add a separate "I/O wait spike" alert when `[,iowait]` > 20% for >5 min
   (potential disk/network bottleneck signal).

Within ~3–5 days after Request 2:

1. Pull the LLD-discovered process list per host on dashboard load.
2. Add a "Top processes" panel in the host drill-down: top-10 by current
   CPU, sortable, with sparkline.
3. Update categorisation logic to auto-bucket new processes (e.g. anything
   matching `python*` continues to fold into Retellect, regardless of how
   it was discovered).

---

## Concrete questions for the admin

Please confirm or push back on each:

1. Can you add `system.cpu.util[,user/system/iowait]` to the SCO host
   template, or do these need to live as host-level items?
2. Is LLD `proc.cpu.util[*]` viable on this Zabbix instance? If yes, what
   filter / top-N limit do you recommend to keep load manageable?
3. If LLD is off the table, are you comfortable adding a static list of
   say 5 candidate process names? If yes, which ones do you suspect are
   hottest based on past tickets?
4. Read-write API token for AKpilot — yes / no / need formal approval from
   security?
5. Roughly — what's a realistic deploy window for Request 1? (We'd love to
   catch the next monthly maintenance cycle.)

---

## Appendix — verification probe output

Probe results from 2026-04-25 confirming current item inventory on
`SHM Pavilnionys [T803] SCO2` (hostid 25247):

```text
Active items:           20
*.cpu (per-process):     7  → python (×4), spss, sql, vm + idle: cs300sd, NHSTW32, udm
perf_counter[\Process]: 10  → same processes, different keying
system.cpu.*:            3  → util[,,avg1], load[,avg1], num
system.run / vfs / agent.*: 0
```

Token permission probe:

```text
item.create  → DENIED: "No permissions to call item.create"
task.create  → DENIED: "No permissions to call task.create"
```

(Hence Request 3.)
