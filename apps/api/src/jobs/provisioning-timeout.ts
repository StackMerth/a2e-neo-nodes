/**
 * PROVISIONING_EXTERNAL timeout auto-cancel worker.
 *
 * Why this exists: rental cmq2vq1nu000 sat in PROVISIONING_EXTERNAL for
 * 15 HOURS on a Vast.ai CN host whose Docker Hub layer pull never
 * completed. The buyer's money was locked, the admin wallet was being
 * billed ~$0.17/h on a dead instance, and no automation noticed. The
 * geo filter (b5019b6) prevents the specific CN-host case going
 * forward, but ANY upstream failure mode that leaves a rental wedged
 * in PROVISIONING_EXTERNAL needs an automatic exit ramp.
 *
 * Behavior: every 60s, find every ExternalRental in PENDING whose
 * updatedAt is older than PROVISIONING_TIMEOUT_MS (default 20 min) AND
 * whose parent ComputeRequest is still in PROVISIONING_EXTERNAL. For
 * each, atomic transition to CANCELLED, refund per the same routing as
 * the buyer-cancel route, destroy the upstream instance via
 * terminate-dispatcher, and mark the ExternalRental rows CLOSED.
 *
 * Why ExternalRental.updatedAt is the right signal (PROGRESS-AWARE):
 * Prisma's @updatedAt directive auto-bumps the column on every write,
 * so every poll-worker tick that touches status, sshHost, sshPort,
 * lastError, providerRegion, etc. moves updatedAt forward. A rental
 * whose poll worker is actively reporting progress will never trigger
 * this timeout regardless of how slow the host is. A rental that has
 * had NO writes for 20 minutes is genuinely stuck (poll worker
 * crashing, provider unreachable, instance dropped without notice).
 *
 * The 20-minute default (raised from 10 min on 2026-06-07) covers the
 * long tail of legitimate slow boots: Phala TEE attestation (8-15
 * min), Lambda 8x bare-metal cold boot (5-15 min), Vast.ai cold image
 * pull on a remote host (5-12 min). Worst-case burn on an undetected
 * failure stays bounded: 20 min × $0.20/h = $0.07.
 *
 * Pre-requisite: a poll worker MUST exist for each provider, otherwise
 * its rentals will all false-cancel at the 20-min mark because nothing
 * writes to the row. As of 2026-06-07 all six provider poll workers
 * are wired in bootstrap (lambda-poll, runpod-poll, ionet-poll,
 * phala-poll, voltagegpu-poll, vastai-poll).
 *
 * Idempotency: status-guarded UPDATE ensures two ticks (or a tick
 * racing the buyer's cancel button) can't double-cancel. Refund credit
 * uses referenceId='provisioning-timeout:<id>' which the
 * BalanceTransaction unique-on-(type,referenceId) prevents from
 * double-writing even if the status guard somehow fails.
 *
 * Configurability:
 *   PROVISIONING_TIMEOUT_MS        default 600_000 (10 min)
 *   PROVISIONING_TIMEOUT_TICK_MS   default 60_000  (60s)
 */

import { Queue, Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { PrismaClient } from '@a2e/database'
import type { Server as SocketServer } from 'socket.io'
import { createNotification } from '../services/notification/service.js'
import { creditBalance } from '../services/balance/balance-service.js'
import {
  terminateExternalRentalForRequest,
  UnknownProviderError,
} from '../services/inbound/terminate-dispatcher.js'

const QUEUE_NAME = 'provisioning-timeout'
const TICK_INTERVAL_MS = parseInt(
  process.env.PROVISIONING_TIMEOUT_TICK_MS ?? '60000',
  10,
)
const TIMEOUT_MS = parseInt(
  process.env.PROVISIONING_TIMEOUT_MS ?? `${20 * 60 * 1000}`,
  10,
)
const BATCH_SIZE = 50

interface Deps {
  redis: ConnectionOptions
  prisma: PrismaClient
  io: SocketServer
}

export function createProvisioningTimeoutQueue(connection: ConnectionOptions): Queue {
  return new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    },
  })
}

export function createProvisioningTimeoutWorker(deps: Deps): Worker {
  return new Worker(
    QUEUE_NAME,
    async () => {
      await runProvisioningTimeoutTick(deps.prisma, deps.io)
    },
    {
      connection: deps.redis,
      concurrency: 1,
    },
  )
}

export async function scheduleProvisioningTimeout(queue: Queue): Promise<void> {
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key)
  }
  await queue.add('tick', {}, { repeat: { every: TICK_INTERVAL_MS } })
}

interface StuckRequest {
  id: string
  userId: string
  gpuTier: string
  gpuCount: number
  totalCost: number
  paymentSource: string
}

export async function runProvisioningTimeoutTick(
  prisma: PrismaClient,
  io: SocketServer,
): Promise<void> {
  const cutoff = new Date(Date.now() - TIMEOUT_MS)
  // Step 1: find ExternalRental rows still in PENDING whose updatedAt
  // has not moved in TIMEOUT_MS. Prisma's @updatedAt directive bumps
  // updatedAt on every write, so a healthy provider poll worker
  // (lambda-poll, runpod-poll, vastai-poll, etc.) will keep updatedAt
  // fresh as it pulls fresh status snapshots from the upstream API.
  // updatedAt going stale therefore means the poll worker hasn't been
  // able to make any progress on this row -- genuine stuck state, not
  // just slow-but-progressing boot.
  //
  // ExternalRental -> ComputeRequest is FK-only in the schema (no
  // Prisma relation field), so we resolve the parent ComputeRequest
  // with a second query rather than a join.
  const stuckRentals = await prisma.externalRental.findMany({
    where: {
      status: 'PENDING',
      updatedAt: { lte: cutoff },
    },
    take: BATCH_SIZE,
    select: { computeRequestId: true },
  })

  if (stuckRentals.length === 0) return

  // Step 2: filter to those whose parent ComputeRequest is still in
  // PROVISIONING_EXTERNAL. Skips rentals whose parent already moved on
  // (CANCELLED/FAILED/ACTIVE) but whose ExternalRental side never got
  // cleaned up; those need a different recovery path.
  const stuck = await prisma.computeRequest.findMany({
    where: {
      id: { in: stuckRentals.map((r) => r.computeRequestId) },
      status: 'PROVISIONING_EXTERNAL',
    },
    select: {
      id: true,
      userId: true,
      gpuTier: true,
      gpuCount: true,
      totalCost: true,
      paymentSource: true,
    },
  })

  if (stuck.length === 0) return

  console.log(
    `[provisioning-timeout] found ${stuck.length} stuck request(s) past ${Math.round(TIMEOUT_MS / 60000)}min cutoff`,
  )

  for (const cr of stuck) {
    try {
      await timeoutRequest(prisma, io, cr)
    } catch (err) {
      console.error(
        `[provisioning-timeout] failed on request ${cr.id}:`,
        err instanceof Error ? err.message : err,
      )
    }
  }
}

async function timeoutRequest(
  prisma: PrismaClient,
  io: SocketServer,
  cr: StuckRequest,
): Promise<void> {
  const now = new Date()

  // Atomic transition with status guard. If the poll worker flipped to
  // ACTIVE in the gap between findMany and now, updateMany returns
  // count=0 and we skip the rest. Same protection for two ticks racing.
  const updated = await prisma.computeRequest.updateMany({
    where: { id: cr.id, status: 'PROVISIONING_EXTERNAL' },
    data: { status: 'CANCELLED', adminNote: 'Auto-cancelled: PROVISIONING_EXTERNAL timeout' },
  })
  if (updated.count === 0) return

  console.log(
    `[provisioning-timeout] cancelling stuck request ${cr.id} (${cr.gpuCount}x ${cr.gpuTier}, refund $${cr.totalCost.toFixed(2)})`,
  )

  // Refund routing mirrors apps/api/src/routes/buyer-compute.ts cancel
  // handler so the buyer experience is identical to a manual cancel.
  // BUYER_BALANCE / USDC / STRIPE_DIRECT all credit the buyer's internal
  // balance; INTERNAL_BALANCE reverts the InternalSpend row.
  try {
    if (
      cr.paymentSource === 'BUYER_BALANCE'
      || cr.paymentSource === 'USDC'
      || cr.paymentSource === 'STRIPE_DIRECT'
    ) {
      await creditBalance(prisma, {
        userId: cr.userId,
        amountUsd: cr.totalCost,
        type: 'REFUND_RENTAL',
        description: `Refund: provisioning timed out for ${cr.gpuCount}x ${cr.gpuTier}`,
        referenceId: `provisioning-timeout:${cr.id}`,
      })
    } else if (cr.paymentSource === 'INTERNAL_BALANCE') {
      await prisma.internalSpend.deleteMany({ where: { computeRequestId: cr.id } })
    }
  } catch (err) {
    const isDuplicate = err instanceof Error && err.name === 'DuplicateTransactionError'
    if (!isDuplicate) {
      console.error(
        `[provisioning-timeout] refund FAILED for ${cr.id}; row is CANCELLED but money still owed to buyer:`,
        err,
      )
    }
  }

  // Destroy the upstream instance so the admin wallet stops paying the
  // supplier. Best-effort: a provider error shouldn't block the
  // ComputeRequest from staying CANCELLED. Logs loudly so ops can
  // manually clean up any phantom pod via the provider dashboard.
  try {
    await terminateExternalRentalForRequest(prisma, cr.id, 'PROVISIONING_TIMEOUT')
  } catch (err) {
    if (err instanceof UnknownProviderError) {
      console.error(
        `[provisioning-timeout] PROVIDER LEAK for ${cr.id}: ${err.message}; manual ops needed`,
      )
    } else {
      console.error(`[provisioning-timeout] upstream terminate failed for ${cr.id}:`, err)
    }
  }

  await prisma.externalRental.updateMany({
    where: { computeRequestId: cr.id, terminatedAt: null },
    data: { status: 'CLOSED', terminatedAt: now },
  })

  void createNotification(
    cr.userId,
    'COMPUTE_REJECTED',
    'Provisioning timed out',
    `Your ${cr.gpuCount}x ${cr.gpuTier} request was cancelled because the upstream provider didn't finish provisioning within ${Math.round(TIMEOUT_MS / 60000)} minutes. You have been refunded $${cr.totalCost.toFixed(2)}.`,
    `/buyer/requests/${cr.id}`,
  )

  io.emit('compute:terminated', {
    requestId: cr.id,
    userId: cr.userId,
    finalMinutes: null,
    finalAccrued: 0,
    refundAmount: cr.totalCost,
    refundStatus: 'PROVISIONING_TIMEOUT',
    refundTxHash: null,
    timestamp: now.toISOString(),
  })
}
