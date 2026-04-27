-- Reconstructed from DB state — this migration was applied but not committed
-- locally. Adds retellectConfidence column to Device (only difference between
-- the akpilot_transformation schema and the DB at the time of writing).

ALTER TABLE "Device" ADD COLUMN IF NOT EXISTS "retellectConfidence" TEXT;
