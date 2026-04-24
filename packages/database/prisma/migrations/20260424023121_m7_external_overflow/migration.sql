-- CreateEnum
CREATE TYPE "JobSource" AS ENUM ('INTERNAL', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "ExternalDeploymentStatus" AS ENUM ('PENDING', 'ACTIVE', 'TERMINATING', 'TERMINATED', 'FAILED');

-- CreateEnum
CREATE TYPE "ExternalTerminationMode" AS ENUM ('SAFE', 'FORCE');

-- AlterEnum
ALTER TYPE "Market" ADD VALUE 'VASTAI';

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "externalDeploymentId" TEXT,
ADD COLUMN     "source" "JobSource" NOT NULL DEFAULT 'INTERNAL';

-- AlterTable
ALTER TABLE "RoutingLog" ADD COLUMN     "vastaiRate" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "ExternalDeployment" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "market" "Market" NOT NULL,
    "externalId" TEXT NOT NULL,
    "status" "ExternalDeploymentStatus" NOT NULL DEFAULT 'PENDING',
    "ratePerHour" DOUBLE PRECISION NOT NULL,
    "costAccumulated" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "earningsAccumulated" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "terminatedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "terminationMode" "ExternalTerminationMode",
    "terminationReason" TEXT,

    CONSTRAINT "ExternalDeployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OverflowConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "simulationMode" BOOLEAN NOT NULL DEFAULT true,
    "idleThresholdMinutes" INTEGER NOT NULL DEFAULT 10,
    "demandThresholdPercent" INTEGER NOT NULL DEFAULT 80,
    "marginProtectionPercent" INTEGER NOT NULL DEFAULT 15,
    "gracePeriodSeconds" INTEGER NOT NULL DEFAULT 300,
    "preferredMarkets" TEXT NOT NULL DEFAULT '["AKASH","IONET","VASTAI"]',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OverflowConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExternalDeployment_nodeId_idx" ON "ExternalDeployment"("nodeId");

-- CreateIndex
CREATE INDEX "ExternalDeployment_market_idx" ON "ExternalDeployment"("market");

-- CreateIndex
CREATE INDEX "ExternalDeployment_status_idx" ON "ExternalDeployment"("status");

-- CreateIndex
CREATE INDEX "ExternalDeployment_externalId_idx" ON "ExternalDeployment"("externalId");

-- CreateIndex
CREATE INDEX "Job_source_idx" ON "Job"("source");

-- CreateIndex
CREATE INDEX "Job_externalDeploymentId_idx" ON "Job"("externalDeploymentId");

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_externalDeploymentId_fkey" FOREIGN KEY ("externalDeploymentId") REFERENCES "ExternalDeployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalDeployment" ADD CONSTRAINT "ExternalDeployment_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

