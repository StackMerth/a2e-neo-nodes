-- Confidential compute waitlist captured when
-- CONFIDENTIAL_COMPUTE_UI_MODE=waitlist. Active while our
-- confidential GPU TEE supply is intermittent or not yet onboarded
-- (Phala h200 capacity exhausted, GCP A3 quota pending, Azure signup
-- blocked, io.net enterprise sales gated as of 2026-06-04).
--
-- Buyer checks "Require confidential compute" -> form swaps from
-- pay+submit to express-interest. No ComputeRequest is created, no
-- balance debited. Admin gets notified; buyer is added to the list
-- to contact when capacity is available.

CREATE TABLE "ConfidentialInterest" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "email" TEXT NOT NULL,
    "gpuTier" "GpuTier",
    "gpuCount" INTEGER,
    "workloadType" TEXT,
    "expectedHours" INTEGER,
    "timelineWeeks" INTEGER,
    "notes" TEXT,
    "notifiedAt" TIMESTAMP(3),
    "adminNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConfidentialInterest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ConfidentialInterest_createdAt_idx" ON "ConfidentialInterest"("createdAt");
CREATE INDEX "ConfidentialInterest_notifiedAt_idx" ON "ConfidentialInterest"("notifiedAt");
CREATE INDEX "ConfidentialInterest_userId_idx" ON "ConfidentialInterest"("userId");

ALTER TABLE "ConfidentialInterest" ADD CONSTRAINT "ConfidentialInterest_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
