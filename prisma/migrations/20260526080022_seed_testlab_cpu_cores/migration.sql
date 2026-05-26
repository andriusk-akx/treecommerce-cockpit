-- StrongPoint Testlab SCO data migration.
--
-- Background:
--   The testlab host's perf_counter[\Process(*)\% Processor Time] values
--   are "% of one core". To stack them with system.cpu.util[,,avg1] (which
--   is already "% of host"), the drill-down divides perf_counter by the
--   host's core count. When resolveCoresForHost can't find a cores value
--   (Zabbix system.cpu.num missing or ZBX_NOTSUPPORTED, Device.cpuCores
--   null, no cpuModel inference), it returns value=1 with coresKnown=false
--   and the route SKIPS normalisation — leaving the per-process stack
--   overshooting 100% on the drill-down.
--
-- What this does:
--   Stamp the manual ground-truth (cpuCores=4, source='manual') confirmed
--   by Andrius 2026-05-26 on the testlab Device. Idempotent: only writes
--   when the row exists AND the current values differ, so re-running this
--   migration after manual edits is safe (and a no-op if already correct).
--
-- Why a migration, not a script:
--   Migrations run automatically on every Railway redeploy via
--   `npx prisma migrate deploy` in the Dockerfile CMD, so the prod DB
--   self-heals without anyone hitting a curl endpoint or running a one-off
--   from a laptop. Idempotency guarantees a clean redeploy stays clean.
--
-- Future hardware swap: update the value here AND clear cpuCoresProbedAt
-- so resolveCoresForHost re-probes Zabbix at the next drill-down.

UPDATE "Device"
SET
  "cpuCores" = 4,
  "cpuCoresSource" = 'manual'
WHERE
  "sourceHostKey" = 'Strongpoint testlab SCO'
  AND (
    "cpuCores" IS DISTINCT FROM 4
    OR "cpuCoresSource" IS DISTINCT FROM 'manual'
  );
