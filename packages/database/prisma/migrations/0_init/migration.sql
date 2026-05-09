-- CreateEnum
CREATE TYPE "GpuTier" AS ENUM ('H100', 'H200', 'B200', 'B300', 'GB300', 'OTHER');

-- CreateEnum
CREATE TYPE "NodeType" AS ENUM ('PROVISIONED', 'BYOG');

-- CreateEnum
CREATE TYPE "NodeStatus" AS ENUM ('ONLINE', 'DEGRADED', 'OFFLINE', 'PAUSED', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'ROUTING', 'ASSIGNED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "Market" AS ENUM ('INTERNAL', 'AKASH', 'IONET', 'VASTAI');

-- CreateEnum
CREATE TYPE "JobSource" AS ENUM ('INTERNAL', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "ExternalDeploymentStatus" AS ENUM ('PENDING', 'ACTIVE', 'TERMINATING', 'TERMINATED', 'FAILED');

-- CreateEnum
CREATE TYPE "ExternalTerminationMode" AS ENUM ('SAFE', 'FORCE');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('NODE_RUNNER', 'COMPUTE_BUYER', 'CUSTOMER', 'ADMIN');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('NODE_OFFLINE', 'PAYOUT_SENT', 'JOB_COMPLETED', 'JOB_FAILED', 'INVESTMENT_CONFIRMED', 'INVESTMENT_PROVISIONED', 'DEPLOYMENT_REQUESTED', 'DEPLOYMENT_STARTED', 'DEPLOYMENT_COMPLETED', 'COMPUTE_REQUEST_NEW', 'COMPUTE_REQUEST_APPROVED', 'COMPUTE_ALLOCATED', 'COMPUTE_ACTIVE', 'COMPUTE_EXPIRING', 'COMPUTE_COMPLETED', 'COMPUTE_REJECTED', 'WITHDRAWAL_REQUESTED', 'WITHDRAWAL_APPROVED', 'WITHDRAWAL_PROCESSING', 'WITHDRAWAL_COMPLETED', 'WITHDRAWAL_REJECTED');

-- CreateEnum
CREATE TYPE "InvestmentStatus" AS ENUM ('PENDING', 'PAID', 'DEPLOYMENT_REQUESTED', 'DEPLOYING', 'PROVISIONED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "ProvisionStatus" AS ENUM ('PENDING', 'CONNECTING', 'VERIFYING', 'DOWNLOADING', 'INSTALLING', 'CONFIGURING', 'STARTING', 'WAITING_REGISTRATION', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('PENDING', 'VERIFIED', 'FAILED', 'NOT_FOUND', 'MANUAL');

-- CreateEnum
CREATE TYPE "ComputeRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'ALLOCATED', 'ACTIVE', 'COMPLETED', 'CANCELLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('PENDING', 'APPROVED', 'PROCESSING', 'COMPLETED', 'REJECTED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "walletAddress" TEXT,
    "passwordHash" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'NODE_RUNNER',
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "twoFactorSecret" TEXT,
    "emailVerificationToken" TEXT,
    "emailVerificationExpiry" TIMESTAMP(3),
    "passwordResetToken" TEXT,
    "passwordResetExpiry" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "permissions" TEXT[] DEFAULT ARRAY['compute:read', 'compute:write']::TEXT[],
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NodeRunner" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "walletAddress" TEXT NOT NULL,
    "userId" TEXT,
    "payoutThreshold" DOUBLE PRECISION NOT NULL DEFAULT 10.0,
    "payoutFrequency" TEXT NOT NULL DEFAULT 'WEEKLY',
    "payoutDayOfWeek" INTEGER,
    "payoutDayOfMonth" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NodeRunner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Investment" (
    "id" TEXT NOT NULL,
    "nodeRunnerId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "nodeCount" INTEGER NOT NULL DEFAULT 1,
    "cryptoAmount" DOUBLE PRECISION,
    "cryptoCurrency" TEXT,
    "txHash" TEXT,
    "txConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "nodeId" TEXT,
    "gpuTier" "GpuTier" NOT NULL,
    "status" "InvestmentStatus" NOT NULL DEFAULT 'PENDING',
    "deploymentNote" TEXT,
    "sshHost" TEXT,
    "sshPort" INTEGER,
    "sshUsername" TEXT,
    "provisionJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "deploymentRequestedAt" TIMESTAMP(3),
    "provisionedAt" TIMESTAMP(3),

    CONSTRAINT "Investment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Node" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "gpuTier" "GpuTier" NOT NULL,
    "nodeType" "NodeType" NOT NULL,
    "status" "NodeStatus" NOT NULL DEFAULT 'ONLINE',
    "region" TEXT,
    "nodeRunnerId" TEXT,
    "customGpuModel" TEXT,
    "customRatePerHour" DOUBLE PRECISION,
    "customRatePerDay" DOUBLE PRECISION,
    "apiKey" TEXT,
    "pendingDeletion" BOOLEAN NOT NULL DEFAULT false,
    "assignedComputeRequestId" TEXT,
    "agentVersion" TEXT,
    "currentJobId" TEXT,
    "lastCommandAt" TIMESTAMP(3),
    "lastHeartbeat" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "missedBeats" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Node_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Heartbeat" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "gpuUtilization" DOUBLE PRECISION,
    "gpuTemperature" DOUBLE PRECISION,
    "gpuMemoryUsed" DOUBLE PRECISION,
    "gpuMemoryTotal" DOUBLE PRECISION,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Heartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "nodeId" TEXT,
    "market" "Market",
    "ratePerHour" DOUBLE PRECISION,
    "gpuTier" "GpuTier" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "source" "JobSource" NOT NULL DEFAULT 'INTERNAL',
    "externalDeploymentId" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "routedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "earnings" DOUBLE PRECISION,
    "cost" DOUBLE PRECISION,
    "profit" DOUBLE PRECISION,
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutingLog" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "selectedMarket" "Market" NOT NULL,
    "selectedRate" DOUBLE PRECISION NOT NULL,
    "internalRate" DOUBLE PRECISION,
    "akashRate" DOUBLE PRECISION,
    "ionetRate" DOUBLE PRECISION,
    "vastaiRate" DOUBLE PRECISION,
    "yieldFloor" DOUBLE PRECISION NOT NULL,
    "yieldFloorApplied" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT NOT NULL,
    "decisionTimeMs" INTEGER,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoutingLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketRate" (
    "id" TEXT NOT NULL,
    "market" "Market" NOT NULL,
    "gpuTier" "GpuTier" NOT NULL,
    "ratePerHour" DOUBLE PRECISION NOT NULL,
    "ratePerDay" DOUBLE PRECISION NOT NULL,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketRateHistory" (
    "id" TEXT NOT NULL,
    "market" "Market" NOT NULL,
    "gpuTier" "GpuTier" NOT NULL,
    "ratePerHour" DOUBLE PRECISION NOT NULL,
    "ratePerDay" DOUBLE PRECISION NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketRateHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Earning" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "market" "Market" NOT NULL,
    "gpuSeconds" INTEGER NOT NULL DEFAULT 0,
    "earnings" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "jobCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Earning_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Config" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Config_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "YieldFloor" (
    "gpuTier" "GpuTier" NOT NULL,
    "ratePerHour" DOUBLE PRECISION NOT NULL,
    "ratePerDay" DOUBLE PRECISION NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "YieldFloor_pkey" PRIMARY KEY ("gpuTier")
);

-- CreateTable
CREATE TABLE "MarketConfig" (
    "market" "Market" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "apiEndpoint" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketConfig_pkey" PRIMARY KEY ("market")
);

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

-- CreateTable
CREATE TABLE "Settlement" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" "SettlementStatus" NOT NULL DEFAULT 'PENDING',
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "jobCount" INTEGER NOT NULL,
    "txHash" TEXT,
    "txConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 3,
    "lastRetryAt" TIMESTAMP(3),
    "nextRetryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementItem" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "SettlementItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementConfig" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "period" TEXT NOT NULL DEFAULT 'WEEKLY',
    "minimumPayout" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "dayOfWeek" INTEGER DEFAULT 1,
    "dayOfMonth" INTEGER,
    "hour" INTEGER NOT NULL DEFAULT 9,
    "autoSchedule" BOOLEAN NOT NULL DEFAULT false,
    "lastScheduledAt" TIMESTAMP(3),
    "solanaRpcUrl" TEXT,
    "payerPrivateKey" TEXT,
    "usdcMint" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SettlementConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InfrastructureCost" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT,
    "category" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "description" TEXT,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InfrastructureCost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USDC',
    "recipientAddress" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "txHash" TEXT,
    "txConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "isDevMode" BOOLEAN NOT NULL DEFAULT false,
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 3,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProvisionJob" (
    "id" TEXT NOT NULL,
    "status" "ProvisionStatus" NOT NULL DEFAULT 'PENDING',
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "username" TEXT NOT NULL,
    "gpuTier" "GpuTier" NOT NULL,
    "nodeName" TEXT,
    "region" TEXT,
    "customGpuModel" TEXT,
    "customRatePerHour" DOUBLE PRECISION,
    "customRatePerDay" DOUBLE PRECISION,
    "apiKey" TEXT,
    "currentStep" INTEGER NOT NULL DEFAULT 0,
    "totalSteps" INTEGER NOT NULL DEFAULT 7,
    "currentAction" TEXT,
    "logs" JSONB NOT NULL DEFAULT '[]',
    "nodeId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ProvisionJob_pkey" PRIMARY KEY ("id")
);

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

-- CreateTable
CREATE TABLE "ComputeRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "gpuTier" "GpuTier" NOT NULL,
    "gpuCount" INTEGER NOT NULL DEFAULT 1,
    "durationDays" INTEGER NOT NULL DEFAULT 30,
    "purpose" TEXT,
    "ratePerDay" DOUBLE PRECISION NOT NULL,
    "totalCost" DOUBLE PRECISION NOT NULL,
    "txHash" TEXT,
    "txConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" "ComputeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "adminNote" TEXT,
    "allocatedNodeIds" TEXT[],
    "allocationMethod" TEXT,
    "sshHost" TEXT,
    "sshPort" INTEGER,
    "sshUsername" TEXT,
    "sshPassword" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "allocatedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ComputeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WithdrawalRequest" (
    "id" TEXT NOT NULL,
    "nodeRunnerId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'PENDING',
    "adminNote" TEXT,
    "txHash" TEXT,
    "processedBy" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),

    CONSTRAINT "WithdrawalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_walletAddress_key" ON "User"("walletAddress");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_key_key" ON "ApiKey"("key");

-- CreateIndex
CREATE INDEX "ApiKey_userId_idx" ON "ApiKey"("userId");

-- CreateIndex
CREATE INDEX "ApiKey_key_idx" ON "ApiKey"("key");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_token_key" ON "RefreshToken"("token");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");

-- CreateIndex
CREATE INDEX "Notification_userId_read_idx" ON "Notification"("userId", "read");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "NodeRunner_email_key" ON "NodeRunner"("email");

-- CreateIndex
CREATE UNIQUE INDEX "NodeRunner_walletAddress_key" ON "NodeRunner"("walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "NodeRunner_userId_key" ON "NodeRunner"("userId");

-- CreateIndex
CREATE INDEX "NodeRunner_walletAddress_idx" ON "NodeRunner"("walletAddress");

-- CreateIndex
CREATE INDEX "NodeRunner_userId_idx" ON "NodeRunner"("userId");

-- CreateIndex
CREATE INDEX "Investment_nodeRunnerId_idx" ON "Investment"("nodeRunnerId");

-- CreateIndex
CREATE INDEX "Investment_status_idx" ON "Investment"("status");

-- CreateIndex
CREATE INDEX "Investment_txHash_idx" ON "Investment"("txHash");

-- CreateIndex
CREATE UNIQUE INDEX "Node_walletAddress_key" ON "Node"("walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "Node_apiKey_key" ON "Node"("apiKey");

-- CreateIndex
CREATE INDEX "Node_status_idx" ON "Node"("status");

-- CreateIndex
CREATE INDEX "Node_gpuTier_idx" ON "Node"("gpuTier");

-- CreateIndex
CREATE INDEX "Node_lastHeartbeat_idx" ON "Node"("lastHeartbeat");

-- CreateIndex
CREATE INDEX "Node_nodeRunnerId_idx" ON "Node"("nodeRunnerId");

-- CreateIndex
CREATE INDEX "Heartbeat_nodeId_timestamp_idx" ON "Heartbeat"("nodeId", "timestamp");

-- CreateIndex
CREATE INDEX "Job_status_idx" ON "Job"("status");

-- CreateIndex
CREATE INDEX "Job_deploymentId_idx" ON "Job"("deploymentId");

-- CreateIndex
CREATE INDEX "Job_nodeId_idx" ON "Job"("nodeId");

-- CreateIndex
CREATE INDEX "Job_market_idx" ON "Job"("market");

-- CreateIndex
CREATE INDEX "Job_requestedAt_idx" ON "Job"("requestedAt");

-- CreateIndex
CREATE INDEX "Job_source_idx" ON "Job"("source");

-- CreateIndex
CREATE INDEX "Job_externalDeploymentId_idx" ON "Job"("externalDeploymentId");

-- CreateIndex
CREATE UNIQUE INDEX "RoutingLog_jobId_key" ON "RoutingLog"("jobId");

-- CreateIndex
CREATE INDEX "RoutingLog_selectedMarket_idx" ON "RoutingLog"("selectedMarket");

-- CreateIndex
CREATE INDEX "RoutingLog_timestamp_idx" ON "RoutingLog"("timestamp");

-- CreateIndex
CREATE INDEX "MarketRate_market_gpuTier_fetchedAt_idx" ON "MarketRate"("market", "gpuTier", "fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MarketRate_market_gpuTier_key" ON "MarketRate"("market", "gpuTier");

-- CreateIndex
CREATE INDEX "MarketRateHistory_market_gpuTier_fetchedAt_idx" ON "MarketRateHistory"("market", "gpuTier", "fetchedAt");

-- CreateIndex
CREATE INDEX "Earning_nodeId_date_idx" ON "Earning"("nodeId", "date");

-- CreateIndex
CREATE INDEX "Earning_date_idx" ON "Earning"("date");

-- CreateIndex
CREATE UNIQUE INDEX "Earning_nodeId_date_market_key" ON "Earning"("nodeId", "date", "market");

-- CreateIndex
CREATE INDEX "ExternalDeployment_nodeId_idx" ON "ExternalDeployment"("nodeId");

-- CreateIndex
CREATE INDEX "ExternalDeployment_market_idx" ON "ExternalDeployment"("market");

-- CreateIndex
CREATE INDEX "ExternalDeployment_status_idx" ON "ExternalDeployment"("status");

-- CreateIndex
CREATE INDEX "ExternalDeployment_externalId_idx" ON "ExternalDeployment"("externalId");

-- CreateIndex
CREATE INDEX "Settlement_nodeId_idx" ON "Settlement"("nodeId");

-- CreateIndex
CREATE INDEX "Settlement_status_idx" ON "Settlement"("status");

-- CreateIndex
CREATE INDEX "Settlement_createdAt_idx" ON "Settlement"("createdAt");

-- CreateIndex
CREATE INDEX "SettlementItem_settlementId_idx" ON "SettlementItem"("settlementId");

-- CreateIndex
CREATE INDEX "InfrastructureCost_nodeId_idx" ON "InfrastructureCost"("nodeId");

-- CreateIndex
CREATE INDEX "InfrastructureCost_category_idx" ON "InfrastructureCost"("category");

-- CreateIndex
CREATE INDEX "InfrastructureCost_periodStart_periodEnd_idx" ON "InfrastructureCost"("periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "Payment_settlementId_idx" ON "Payment"("settlementId");

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

-- CreateIndex
CREATE INDEX "Payment_txHash_idx" ON "Payment"("txHash");

-- CreateIndex
CREATE UNIQUE INDEX "ProvisionJob_apiKey_key" ON "ProvisionJob"("apiKey");

-- CreateIndex
CREATE UNIQUE INDEX "ProvisionJob_nodeId_key" ON "ProvisionJob"("nodeId");

-- CreateIndex
CREATE INDEX "ProvisionJob_status_idx" ON "ProvisionJob"("status");

-- CreateIndex
CREATE INDEX "ProvisionJob_createdAt_idx" ON "ProvisionJob"("createdAt");

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

-- CreateIndex
CREATE INDEX "ComputeRequest_userId_idx" ON "ComputeRequest"("userId");

-- CreateIndex
CREATE INDEX "ComputeRequest_status_idx" ON "ComputeRequest"("status");

-- CreateIndex
CREATE INDEX "ComputeRequest_requestedAt_idx" ON "ComputeRequest"("requestedAt");

-- CreateIndex
CREATE INDEX "ComputeRequest_expiresAt_idx" ON "ComputeRequest"("expiresAt");

-- CreateIndex
CREATE INDEX "WithdrawalRequest_nodeRunnerId_idx" ON "WithdrawalRequest"("nodeRunnerId");

-- CreateIndex
CREATE INDEX "WithdrawalRequest_status_idx" ON "WithdrawalRequest"("status");

-- CreateIndex
CREATE INDEX "WithdrawalRequest_requestedAt_idx" ON "WithdrawalRequest"("requestedAt");

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NodeRunner" ADD CONSTRAINT "NodeRunner_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Investment" ADD CONSTRAINT "Investment_nodeRunnerId_fkey" FOREIGN KEY ("nodeRunnerId") REFERENCES "NodeRunner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Node" ADD CONSTRAINT "Node_nodeRunnerId_fkey" FOREIGN KEY ("nodeRunnerId") REFERENCES "NodeRunner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Heartbeat" ADD CONSTRAINT "Heartbeat_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_externalDeploymentId_fkey" FOREIGN KEY ("externalDeploymentId") REFERENCES "ExternalDeployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutingLog" ADD CONSTRAINT "RoutingLog_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Earning" ADD CONSTRAINT "Earning_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalDeployment" ADD CONSTRAINT "ExternalDeployment_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementItem" ADD CONSTRAINT "SettlementItem_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InfrastructureCost" ADD CONSTRAINT "InfrastructureCost_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvisionJob" ADD CONSTRAINT "ProvisionJob_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComputeRequest" ADD CONSTRAINT "ComputeRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WithdrawalRequest" ADD CONSTRAINT "WithdrawalRequest_nodeRunnerId_fkey" FOREIGN KEY ("nodeRunnerId") REFERENCES "NodeRunner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
