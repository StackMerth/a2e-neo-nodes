-- Payout mode for NodeRunner. Lets operators hold rewards on the
-- platform instead of auto-depositing, or schedule a specific
-- future payout date. See NodeRunner.payoutMode in schema.prisma
-- and apps/api/src/services/settlement/engine.ts for the worker
-- logic that consumes these fields.

-- CreateEnum
CREATE TYPE "PayoutMode" AS ENUM ('AUTO', 'MANUAL', 'SCHEDULED');

-- AlterTable: existing rows default to AUTO so legacy operators
-- keep their current behavior. payoutScheduledAt is nullable and
-- only meaningful when payoutMode = 'SCHEDULED'.
ALTER TABLE "NodeRunner"
    ADD COLUMN "payoutMode" "PayoutMode" NOT NULL DEFAULT 'AUTO',
    ADD COLUMN "payoutScheduledAt" TIMESTAMP(3);
