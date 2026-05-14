-- Launch-blocker #1: BYOG install token system.
-- One-shot token authorizes a single `curl ... | bash` install on a
-- single operator machine. Issued from the operator portal, consumed
-- by the install script's /v1/byog/claim call.

-- CreateTable
CREATE TABLE "InstallToken" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "nodeRunnerId" TEXT NOT NULL,
    "region" TEXT,
    "consumedAt" TIMESTAMP(3),
    "consumedByNodeId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InstallToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InstallToken_token_key" ON "InstallToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "InstallToken_consumedByNodeId_key" ON "InstallToken"("consumedByNodeId");

-- CreateIndex
CREATE INDEX "InstallToken_nodeRunnerId_idx" ON "InstallToken"("nodeRunnerId");

-- CreateIndex
CREATE INDEX "InstallToken_expiresAt_idx" ON "InstallToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "InstallToken" ADD CONSTRAINT "InstallToken_nodeRunnerId_fkey" FOREIGN KEY ("nodeRunnerId") REFERENCES "NodeRunner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
