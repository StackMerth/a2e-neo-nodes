-- Admin payout lock + change new-operator default to MANUAL.
-- See NodeRunner.payoutLockUntil in schema.prisma for the
-- support-during-disputes use case.

-- AlterTable: change column default. Existing rows are unaffected;
-- this only changes what new NodeRunner rows get when payoutMode is
-- left unspecified at insert time.
ALTER TABLE "NodeRunner" ALTER COLUMN "payoutMode" SET DEFAULT 'MANUAL';

-- AlterTable: add admin-applied hard-hold fields. Both nullable; the
-- worker treats "not set" as "no lock".
ALTER TABLE "NodeRunner"
    ADD COLUMN "payoutLockUntil" TIMESTAMP(3),
    ADD COLUMN "payoutLockReason" TEXT;
