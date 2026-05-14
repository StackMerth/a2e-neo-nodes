-- Launch-blocker #2: agent-side SSH session state machine.
-- Adds the lifecycle status, buyer's pubkey, and timing fields to
-- ComputeRequest. The agent reads these via the heartbeat-response
-- channel and reports back via /v1/nodes/:id/sessions/:sid/status.

-- CreateEnum
CREATE TYPE "SshSessionStatus" AS ENUM (
    'PENDING',
    'PROVISIONING',
    'ACTIVE',
    'TERMINATING',
    'TERMINATED',
    'FAILED'
);

-- AlterTable: add SSH lifecycle columns to ComputeRequest.
-- sshSessionStatus defaults to PENDING so existing rows (pre-M2 rentals
-- already completed) are also reflected as "waiting" — but since their
-- status is COMPLETED/CANCELLED, the agent won't try to provision them.
ALTER TABLE "ComputeRequest"
    ADD COLUMN "sshSessionStatus" "SshSessionStatus" NOT NULL DEFAULT 'PENDING',
    ADD COLUMN "sshPubKey" TEXT,
    ADD COLUMN "sshProvisionedAt" TIMESTAMP(3),
    ADD COLUMN "sshTerminatedAt" TIMESTAMP(3),
    ADD COLUMN "sshErrorMessage" TEXT;
