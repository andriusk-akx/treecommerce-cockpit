-- CPU normalisation fix (spec §5.2): adds the three columns that let the
-- Retellect drill-down divide per-counter values by the host's real core
-- count even when Zabbix's `system.cpu.num` item is ZBX_NOTSUPPORTED.
--
-- All columns nullable: backfill is a separate step (`scripts/backfill-
-- device-cpu-cores.mjs`). Routes degrade gracefully when cpuCores IS NULL
-- by marking the response with `dataQuality.coresKnown = false` so the UI
-- can show a warning instead of mis-normalised numbers.

ALTER TABLE "Device" ADD COLUMN "cpuCores" INTEGER;
ALTER TABLE "Device" ADD COLUMN "cpuCoresSource" TEXT;
ALTER TABLE "Device" ADD COLUMN "cpuCoresProbedAt" TIMESTAMP(3);
