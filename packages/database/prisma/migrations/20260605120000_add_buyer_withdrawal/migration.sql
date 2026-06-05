-- BuyerWithdrawal: tracks buyer-initiated withdrawals of unused
-- balance back to their own Solana wallet (USDC). v1 ships SOLANA
-- method only; the enum is structured so STRIPE_REFUND etc. can be
-- added later without a breaking change.

-- Add the WITHDRAW_USDC value to the existing BalanceTxType enum.
ALTER TYPE "BalanceTxType" ADD VALUE 'WITHDRAW_USDC';

-- New enums for the withdrawal row.
CREATE TYPE "BuyerWithdrawalMethod" AS ENUM ('SOLANA');
CREATE TYPE "BuyerWithdrawalStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- New audit column on BuyerBalance.
ALTER TABLE "BuyerBalance" ADD COLUMN "totalWithdrawn" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Main withdrawal table.
CREATE TABLE "BuyerWithdrawal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amountUsd" DOUBLE PRECISION NOT NULL,
    "method" "BuyerWithdrawalMethod" NOT NULL DEFAULT 'SOLANA',
    "status" "BuyerWithdrawalStatus" NOT NULL DEFAULT 'PENDING',
    "walletAddress" TEXT NOT NULL,
    "txHash" TEXT,
    "error" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "BuyerWithdrawal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BuyerWithdrawal_userId_requestedAt_idx"
    ON "BuyerWithdrawal"("userId", "requestedAt");

CREATE INDEX "BuyerWithdrawal_status_idx"
    ON "BuyerWithdrawal"("status");

ALTER TABLE "BuyerWithdrawal"
    ADD CONSTRAINT "BuyerWithdrawal_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
