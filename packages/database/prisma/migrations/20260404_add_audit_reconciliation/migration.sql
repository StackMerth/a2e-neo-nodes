-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('PENDING', 'VERIFIED', 'FAILED', 'NOT_FOUND', 'MANUAL');

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "previousValue" TEXT,
    "newValue" TEXT,
    "actor" TEXT,
    "actorType" TEXT NOT NULL DEFAULT 'SYSTEM',
    "ipAddress" TEXT,
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "statusCode" INTEGER,
    "responseBody" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingReconciliation" (
    "id" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "settlementId" TEXT,
    "paymentId" TEXT,
    "expectedAmount" DOUBLE PRECISION NOT NULL,
    "recipientAddress" TEXT NOT NULL,
    "status" "ReconciliationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 10,
    "lastAttemptAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "PendingReconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actor_idx" ON "AuditLog"("actor");

-- CreateIndex
CREATE INDEX "IdempotencyKey_expiresAt_idx" ON "IdempotencyKey"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PendingReconciliation_txHash_key" ON "PendingReconciliation"("txHash");

-- CreateIndex
CREATE INDEX "PendingReconciliation_status_idx" ON "PendingReconciliation"("status");

-- CreateIndex
CREATE INDEX "PendingReconciliation_txHash_idx" ON "PendingReconciliation"("txHash");

-- CreateIndex
CREATE INDEX "PendingReconciliation_nextAttemptAt_idx" ON "PendingReconciliation"("nextAttemptAt");
