/**
 * T5b — Lambda Labs status polling worker.
 *
 * The compute-allocator's Lambda fallback transitions a request to
 * PROVISIONING_EXTERNAL and starts billing on the provider side, but
 * Lambda needs ~30-90s to boot the image and surface a public IP.
 * This worker polls every 10s, updates the ExternalRental row from
 * Lambda's /instances/{id} response, and when the provider reports
 * the instance is ACTIVE it flips the buyer's ComputeRequest to
 * ACTIVE too — at which point the per-minute meter starts ticking
 * and the buyer can SSH in.
 *
 * Failure mode: if Lambda terminates the instance before we ever
 * see status='active' (capacity loss, account billing reject,
 * region eviction), we mark the ComputeRequest CANCELLED and refund
 * the buyer's debit via REFUND_FAILED so they're whole. The
 * ExternalRental row stays around as the audit trail.
 *
 * Tick interval: 10s. Same as the allocator, intentionally — pairing
 * the two lets the end-to-end pay-to-SSH latency stay close to
 * Lambda's actual boot time (the allocator picks up the request in
 * under 10s, provisions, and the poller takes over within another
 * 10s). Tunable via env.
 */

import { Queue, Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { PrismaClient } from '@a2e/database'
import type { Server as SocketServer } from 'socket.io'
import { pollLambdaRentalStatus } from '../services/inbound/lambda-provision.js'
import { isLambdaConfigured } from '../services/inbound/lambda-adapter.js'
import { createNotification } from '../services/notification/service.js'
import { creditBalance } from '../services/balance/balance-service.js'

const QUEUE_NAME = 'lambda-poll'
const TICK_INTERVAL_MS = parseInt(process.env.LAMBDA_POLL_TICK_MS ?? '10000', 10)
const BATCH_SIZE = 50

interface PollDeps {
  redis: ConnectionOptions
  prisma: PrismaClient
  io: SocketServer
}

export function createLambdaPollQueue(connection: ConnectionOptions): Queue {
  return new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    },
  })
}

export function createLambdaPollWorker(deps: PollDeps): Worker {
  return new Worker(
    QUEUE_NAME,
    async () => {
      await runLambdaPollTick(deps.prisma, deps.io)
    },
    {
      connection: deps.redis,
      concurrency: 1,
    },
  )
}

export async function scheduleLambdaPoll(queue: Queue): Promise<void> {
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key)
  }
  await queue.add('tick', {}, { repeat: { every: TICK_INTERVAL_MS } })
}

// ---------------------------------------------------------------------------
// Core tick — exported for tests
// ---------------------------------------------------------------------------

export async function runLambdaPollTick(prisma: PrismaClient, io: SocketServer): Promise<void> {
  if (!isLambdaConfigured()) {
    // Lambda not configured on this deploy; nothing to poll. Returning
    // silently keeps log noise down on environments that don't use the
    // inbound supply path.
    return
  }

  // Only PENDING + CLOSING rentals need polling. ACTIVE rentals can
  // also drift (Lambda reports unhealthy or external eviction), so
  // we include them too but with a longer effective re-check window
  // via the BATCH_SIZE limit + ordering. CLOSED / FAILED rentals
  // are terminal and skipped.
  const rentals = await prisma.externalRental.findMany({
    where: {
      provider: 'LAMBDA',
      status: { in: ['PENDING', 'ACTIVE', 'CLOSING'] },
    },
    orderBy: { launchRequestedAt: 'asc' },
    take: BATCH_SIZE,
    select: {
      id: true,
      status: true,
      computeRequestId: true,
      sshHost: true,
    },
  })

  for (const r of rentals) {
    try {
      await pollOne(prisma, io, r)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[lambda-poll] failed on rental ${r.id}:`, err)
    }
  }
}

async function pollOne(
  prisma: PrismaClient,
  io: SocketServer,
  r: { id: string; status: string; computeRequestId: string; sshHost: string | null },
): Promise<void> {
  const inst = await pollLambdaRentalStatus(prisma, r.id)
  if (!inst) {
    // pollLambdaRentalStatus returned null = rental is closed/404'd.
    // If the linked ComputeRequest is still PROVISIONING_EXTERNAL,
    // it means Lambda dropped the instance before we ever surfaced
    // SSH credentials. Cancel + refund.
    await cancelAndRefund(prisma, io, r.computeRequestId, r.id, 'Lambda terminated the instance before it became ready')
    return
  }

  // Re-read the rental row to pick up the status change pollLambdaRentalStatus
  // just wrote, plus any new IP. Cheap query, keeps the transition logic
  // working against the freshest data.
  const fresh = await prisma.externalRental.findUnique({
    where: { id: r.id },
    select: {
      id: true,
      status: true,
      sshHost: true,
      computeRequestId: true,
    },
  })
  if (!fresh) return

  // Happy path: PENDING -> ACTIVE on the rental side promotes the
  // ComputeRequest from PROVISIONING_EXTERNAL to ACTIVE. We guard
  // on the request's current status so a manual admin intervention
  // (terminate, etc.) can't be silently overwritten.
  if (fresh.status === 'ACTIVE' && fresh.sshHost) {
    const promoted = await prisma.computeRequest.updateMany({
      where: { id: fresh.computeRequestId, status: 'PROVISIONING_EXTERNAL' },
      data: {
        status: 'ACTIVE',
        activatedAt: new Date(),
        sshSessionStatus: 'ACTIVE',
      },
    })
    if (promoted.count > 0) {
      // Just promoted. Pull the request for the notification copy.
      const cr = await prisma.computeRequest.findUnique({
        where: { id: fresh.computeRequestId },
        select: { id: true, userId: true, gpuTier: true, gpuCount: true },
      })
      if (cr) {
        void createNotification(
          cr.userId,
          'COMPUTE_ACTIVE',
          'Compute is Live',
          `Your ${cr.gpuCount}x ${cr.gpuTier} Lambda-provisioned rental is ready. SSH details are in your dashboard.`,
          `/buyer/requests/${cr.id}`,
        )
        io.emit('compute:active', {
          requestId: cr.id,
          userId: cr.userId,
          provider: 'LAMBDA',
          sshHost: fresh.sshHost,
          timestamp: new Date().toISOString(),
        })
      }
    }
    return
  }

  // CLOSING + the linked request is still PROVISIONING_EXTERNAL =
  // termination raced ahead of the activation. Refund the buyer.
  if (fresh.status === 'CLOSING') {
    await cancelAndRefund(prisma, io, fresh.computeRequestId, fresh.id, 'Lambda began terminating before the instance was activated')
  }
}

async function cancelAndRefund(
  prisma: PrismaClient,
  io: SocketServer,
  computeRequestId: string,
  externalRentalId: string,
  reason: string,
): Promise<void> {
  // Only refund if the request is still in PROVISIONING_EXTERNAL.
  // ACTIVE / COMPLETED requests already burned through the meter's
  // accruedCost and have their own refund path; we never want to
  // double-refund.
  const cr = await prisma.computeRequest.findUnique({
    where: { id: computeRequestId },
    select: {
      id: true,
      userId: true,
      status: true,
      totalCost: true,
      gpuTier: true,
      gpuCount: true,
      paymentSource: true,
      balanceTransactionId: true,
    },
  })
  if (!cr || cr.status !== 'PROVISIONING_EXTERNAL') return

  await prisma.computeRequest.updateMany({
    where: { id: cr.id, status: 'PROVISIONING_EXTERNAL' },
    data: {
      status: 'CANCELLED',
      completedAt: new Date(),
      adminNote: `Lambda fallback failed: ${reason}`,
      sshSessionStatus: 'FAILED',
    },
  })

  // Refund the buyer if they paid from balance. Solana / Stripe topup
  // paths credited the buyer's balance separately; their
  // SPEND_RENTAL debit needs a matching REFUND_FAILED credit to net
  // out. Use the ComputeRequest id as the referenceId so the
  // (type, referenceId) unique on BalanceTransaction makes the
  // refund idempotent even if this worker retries.
  if (cr.paymentSource === 'BUYER_BALANCE' && cr.totalCost > 0) {
    try {
      await creditBalance(prisma, {
        userId: cr.userId,
        amountUsd: cr.totalCost,
        type: 'REFUND_FAILED',
        description: `Lambda fallback failed for rental ${cr.id}`,
        referenceId: cr.id,
      })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[lambda-poll] refund failed for ${cr.id}:`, err)
    }
  }

  void createNotification(
    cr.userId,
    'COMPUTE_REJECTED',
    'Compute Provisioning Failed',
    `Your ${cr.gpuCount}x ${cr.gpuTier} rental could not be provisioned (${reason}). ` +
      (cr.paymentSource === 'BUYER_BALANCE'
        ? `Refund of $${cr.totalCost.toFixed(2)} credited back to your balance.`
        : 'Contact support if you were charged.'),
    `/buyer/requests/${cr.id}`,
  )

  io.emit('compute:provisioning-failed', {
    requestId: cr.id,
    userId: cr.userId,
    externalRentalId,
    reason,
    refundedUsd: cr.paymentSource === 'BUYER_BALANCE' ? cr.totalCost : 0,
    timestamp: new Date().toISOString(),
  })
}
