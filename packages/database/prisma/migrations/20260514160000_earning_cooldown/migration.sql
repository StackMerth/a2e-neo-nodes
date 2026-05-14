-- Cooling-off period on Earning. Each row becomes withdrawable
-- only after availableAt passes (default = createdAt + 48 hours).
-- Buyer-dispute protection plus visibility into "pending" balance
-- on the operator dashboard.

-- AlterTable: add the column with the +48h default. Existing rows
-- are backfilled to createdAt + 48h so any historic earning whose
-- 48h window has already elapsed lands as immediately available
-- (correct behavior — these earnings predate the feature).
ALTER TABLE "Earning"
    ADD COLUMN "availableAt" TIMESTAMP(3) NOT NULL
    DEFAULT (CURRENT_TIMESTAMP + INTERVAL '48 hours');

UPDATE "Earning"
SET "availableAt" = "createdAt" + INTERVAL '48 hours';

-- CreateIndex
CREATE INDEX "Earning_availableAt_idx" ON "Earning"("availableAt");
