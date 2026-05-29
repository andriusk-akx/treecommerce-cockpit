-- Phase 4.5 of AKpilot spec v2.1: per-process hourly rollup.
--
-- The Rollout Insights matrix classifies each host-hour as "Retellect ON"
-- vs "Retellect OFF" against a per-host adaptive baseline of spss.cpu.
-- The classification threshold is configurable per request, so we have
-- to store the raw per-process CPU values (spss, sum-of-python, system),
-- not just a precomputed boolean.
--
-- Phase 4 already mirrored `system.cpu.util`; this table adds the two
-- remaining signals needed for ON/OFF classification.

CREATE TABLE "CpuProcessMetricHourly" (
  "id"            TEXT NOT NULL,
  "pilotId"       TEXT NOT NULL,
  "deviceId"      TEXT NOT NULL,
  "zHostId"       TEXT NOT NULL,
  "hourStart"     TIMESTAMPTZ NOT NULL,

  "spssCpu"       DOUBLE PRECISION,
  "retellectCpu"  DOUBLE PRECISION,
  "totalCpu"      DOUBLE PRECISION,
  "sawPython"     BOOLEAN NOT NULL,
  "weightMinutes" INTEGER NOT NULL,

  "source"        TEXT NOT NULL,
  "capturedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CpuProcessMetricHourly_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CpuProcessMetricHourly_zHostId_hourStart_key"
  ON "CpuProcessMetricHourly"("zHostId", "hourStart");

CREATE INDEX "CpuProcessMetricHourly_pilotId_hourStart_idx"
  ON "CpuProcessMetricHourly"("pilotId", "hourStart");

CREATE INDEX "CpuProcessMetricHourly_deviceId_hourStart_idx"
  ON "CpuProcessMetricHourly"("deviceId", "hourStart");

CREATE INDEX "CpuProcessMetricHourly_hourStart_idx"
  ON "CpuProcessMetricHourly"("hourStart");

ALTER TABLE "CpuProcessMetricHourly"
  ADD CONSTRAINT "CpuProcessMetricHourly_pilotId_fkey"
  FOREIGN KEY ("pilotId") REFERENCES "Pilot"("id") ON DELETE CASCADE;

ALTER TABLE "CpuProcessMetricHourly"
  ADD CONSTRAINT "CpuProcessMetricHourly_deviceId_fkey"
  FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE;
