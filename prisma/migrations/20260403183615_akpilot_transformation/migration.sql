/*
  Warnings:

  - Added the required column `updatedAt` to the `Client` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ClientType" AS ENUM ('EXTERNAL', 'INTERNAL', 'PARTNER');

-- CreateEnum
CREATE TYPE "ClientStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'PROSPECT');

-- CreateEnum
CREATE TYPE "PilotProductType" AS ENUM ('TREECOMMERCE', 'RETELLECT', 'OTHER');

-- CreateEnum
CREATE TYPE "PilotStatus" AS ENUM ('PLANNED', 'ACTIVE', 'PAUSED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "PilotVisibility" AS ENUM ('INTERNAL', 'SHAREABLE', 'CLIENT_FACING');

-- CreateEnum
CREATE TYPE "DataSourceAuthType" AS ENUM ('TOKEN', 'BASIC', 'NONE');

-- CreateEnum
CREATE TYPE "DataSourceSyncMode" AS ENUM ('LIVE', 'CACHED', 'MANUAL');

-- CreateEnum
CREATE TYPE "DeviceType" AS ENUM ('SCO', 'POS', 'SERVER', 'VM', 'OTHER');

-- CreateEnum
CREATE TYPE "ViewType" AS ENUM ('OVERVIEW', 'BUSINESS', 'TECHNICAL', 'EXECUTIVE', 'SHARE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DataSourceType" ADD VALUE 'TREECOMMERCE_SALES_API';
ALTER TYPE "DataSourceType" ADD VALUE 'RETELLECT_API';
ALTER TYPE "DataSourceType" ADD VALUE 'CSV';
ALTER TYPE "DataSourceType" ADD VALUE 'MANUAL';

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "notes" TEXT,
ADD COLUMN     "ownerName" TEXT,
ADD COLUMN     "status" "ClientStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "type" "ClientType" NOT NULL DEFAULT 'EXTERNAL',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill updatedAt for existing rows
UPDATE "Client" SET "updatedAt" = "createdAt" WHERE "updatedAt" = CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "DataSource" ADD COLUMN     "authType" "DataSourceAuthType" NOT NULL DEFAULT 'TOKEN',
ADD COLUMN     "configJson" TEXT,
ADD COLUMN     "credentialRef" TEXT,
ADD COLUMN     "lastSyncAt" TIMESTAMP(3),
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "pilotId" TEXT,
ADD COLUMN     "syncMode" "DataSourceSyncMode" NOT NULL DEFAULT 'LIVE',
ALTER COLUMN "type" SET DEFAULT 'ZABBIX';

-- AlterTable
ALTER TABLE "Incident" ADD COLUMN     "pilotId" TEXT,
ALTER COLUMN "sourceType" SET DEFAULT 'ZABBIX';

-- AlterTable
ALTER TABLE "Note" ADD COLUMN     "pilotId" TEXT;

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "city" TEXT,
ADD COLUMN     "country" TEXT,
ADD COLUMN     "pilotId" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active';

-- CreateTable
CREATE TABLE "Pilot" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shortCode" TEXT NOT NULL,
    "productType" "PilotProductType" NOT NULL DEFAULT 'OTHER',
    "status" "PilotStatus" NOT NULL DEFAULT 'PLANNED',
    "visibility" "PilotVisibility" NOT NULL DEFAULT 'INTERNAL',
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "goalSummary" TEXT,
    "internalOwner" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pilot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "pilotId" TEXT NOT NULL,
    "storeId" TEXT,
    "name" TEXT NOT NULL,
    "sourceHostKey" TEXT,
    "deviceType" "DeviceType" NOT NULL DEFAULT 'OTHER',
    "cpuModel" TEXT,
    "ramGb" DOUBLE PRECISION,
    "os" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "retellectEnabled" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "View" (
    "id" TEXT NOT NULL,
    "pilotId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "viewType" "ViewType" NOT NULL DEFAULT 'OVERVIEW',
    "visibility" "PilotVisibility" NOT NULL DEFAULT 'INTERNAL',
    "configJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "View_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Pilot_shortCode_key" ON "Pilot"("shortCode");

-- CreateIndex
CREATE UNIQUE INDEX "View_pilotId_slug_key" ON "View"("pilotId", "slug");

-- AddForeignKey
ALTER TABLE "Pilot" ADD CONSTRAINT "Pilot_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataSource" ADD CONSTRAINT "DataSource_pilotId_fkey" FOREIGN KEY ("pilotId") REFERENCES "Pilot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Store" ADD CONSTRAINT "Store_pilotId_fkey" FOREIGN KEY ("pilotId") REFERENCES "Pilot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_pilotId_fkey" FOREIGN KEY ("pilotId") REFERENCES "Pilot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_pilotId_fkey" FOREIGN KEY ("pilotId") REFERENCES "Pilot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_pilotId_fkey" FOREIGN KEY ("pilotId") REFERENCES "Pilot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "View" ADD CONSTRAINT "View_pilotId_fkey" FOREIGN KEY ("pilotId") REFERENCES "Pilot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
