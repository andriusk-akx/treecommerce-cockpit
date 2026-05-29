-- Phase 4 of AKpilot spec v2.1: CPU metric rollup tables.
--
-- Mirrors the Zabbix CPU history into our own DB at daily and hourly
-- grains so the Compare-periods sub-view (and eventually RT Timeline
-- and Rollout Insights) can read >29-day windows that exceed Zabbix's
-- own retention. Tables are populated by `/api/internal/rollup-cpu`
-- running daily at 02:00 Vilnius; consumers query the rollup tables
-- for dates older than ~10 days and fall back to Zabbix for recent
-- data via the hybrid reader in `src/lib/cpu-rollup/reader.ts`.
--
-- Both tables key on Zabbix host id (`zHostId`) — the source of truth
-- for joining back to Zabbix queries — and also carry denormalised
-- `pilotId` / `deviceId` for query-speed (the alternative would be
-- joining through Device on every read).

-- ─── Daily rollup ──────────────────────────────────────────────────
CREATE TABLE "CpuMetricDaily" (
  "id"             TEXT NOT NULL,
  "pilotId"        TEXT NOT NULL,
  "deviceId"       TEXT NOT NULL,
  "zHostId"        TEXT NOT NULL,
  "date"           DATE NOT NULL,

  "cpuMax"         DOUBLE PRECISION NOT NULL,
  "cpuAvg"         DOUBLE PRECISION NOT NULL,
  "cpuMin"         DOUBLE PRECISION NOT NULL,
  "totalSamples"   INTEGER NOT NULL,

  "minutesAbove20" INTEGER NOT NULL DEFAULT 0,
  "minutesAbove30" INTEGER NOT NULL DEFAULT 0,
  "minutesAbove40" INTEGER NOT NULL DEFAULT 0,
  "minutesAbove50" INTEGER NOT NULL DEFAULT 0,
  "minutesAbove60" INTEGER NOT NULL DEFAULT 0,
  "minutesAbove70" INTEGER NOT NULL DEFAULT 0,
  "minutesAbove80" INTEGER NOT NULL DEFAULT 0,
  "minutesAbove90" INTEGER NOT NULL DEFAULT 0,

  "source"         TEXT NOT NULL,
  "capturedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CpuMetricDaily_pkey" PRIMARY KEY ("id")
);

-- Unique constraint = idempotency key for ON CONFLICT … DO UPDATE.
CREATE UNIQUE INDEX "CpuMetricDaily_zHostId_date_key"
  ON "CpuMetricDaily"("zHostId", "date");

CREATE INDEX "CpuMetricDaily_pilotId_date_idx"
  ON "CpuMetricDaily"("pilotId", "date");

CREATE INDEX "CpuMetricDaily_deviceId_date_idx"
  ON "CpuMetricDaily"("deviceId", "date");

CREATE INDEX "CpuMetricDaily_date_idx"
  ON "CpuMetricDaily"("date");

ALTER TABLE "CpuMetricDaily"
  ADD CONSTRAINT "CpuMetricDaily_pilotId_fkey"
  FOREIGN KEY ("pilotId") REFERENCES "Pilot"("id") ON DELETE CASCADE;

ALTER TABLE "CpuMetricDaily"
  ADD CONSTRAINT "CpuMetricDaily_deviceId_fkey"
  FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE;


-- ─── Hourly rollup ─────────────────────────────────────────────────
CREATE TABLE "CpuMetricHourly" (
  "id"             TEXT NOT NULL,
  "pilotId"        TEXT NOT NULL,
  "deviceId"       TEXT NOT NULL,
  "zHostId"        TEXT NOT NULL,
  "hourStart"      TIMESTAMPTZ NOT NULL,

  "cpuMax"         DOUBLE PRECISION NOT NULL,
  "cpuAvg"         DOUBLE PRECISION NOT NULL,
  "cpuMin"         DOUBLE PRECISION NOT NULL,
  "totalSamples"   INTEGER NOT NULL,

  "source"         TEXT NOT NULL,
  "capturedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CpuMetricHourly_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CpuMetricHourly_zHostId_hourStart_key"
  ON "CpuMetricHourly"("zHostId", "hourStart");

CREATE INDEX "CpuMetricHourly_pilotId_hourStart_idx"
  ON "CpuMetricHourly"("pilotId", "hourStart");

CREATE INDEX "CpuMetricHourly_deviceId_hourStart_idx"
  ON "CpuMetricHourly"("deviceId", "hourStart");

CREATE INDEX "CpuMetricHourly_hourStart_idx"
  ON "CpuMetricHourly"("hourStart");

ALTER TABLE "CpuMetricHourly"
  ADD CONSTRAINT "CpuMetricHourly_pilotId_fkey"
  FOREIGN KEY ("pilotId") REFERENCES "Pilot"("id") ON DELETE CASCADE;

ALTER TABLE "CpuMetricHourly"
  ADD CONSTRAINT "CpuMetricHourly_deviceId_fkey"
  FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE;
