/**
 * Vast.ai status polling worker.
 *
 * Mirror of runpod-poll.ts for Vast.ai. After tryVastAiFallback in
 * the allocator books an instance, the ComputeRequest is in
 * PROVISIONING_EXTERNAL and the ExternalRental row is PENDING. This
 * worker polls every ~30s, transitions ExternalRental PENDING ->
 * ACTIVE once Vast.ai reports actual_status='running', and promotes
 * the linked ComputeRequest from PROVISIONING_EXTERNAL -> ACTIVE so
 * the meter starts ticking and SSH credentials surface to the buyer.
 *
 * Critical context: this worker did NOT exist until 2026-06-07 and
 * Vast.ai rentals could NEVER transition out of PROVISIONING_EXTERNAL
 * on their own. Rental cmq2vq1nu000 sat in PROVISIONING_EXTERNAL for
 * 15 HOURS because of this gap (compounded by the CN host's slow
 * Docker Hub pull). With this worker plus the provisioning-timeout
 * worker, the upper-bound burn on any single rental is now ~$0.07
 * (20 min at $0.20/h), down from hours.
 *
 * Failure handling mirrors RunPod:
 *   - If Vast.ai 404s the instance or it terminates before reaching
 *     ACTIVE, we cancel the ComputeRequest and refund the buyer's
 *     SPEND_RENTAL debit via REFUND_FAILED.
 *   - Worker errors are logged but don't crash the tick; next tick
 *     re-tries.
 *
 * Tick interval: 30s (vs RunPod's 10s) because Vast.ai's REST API
 * rate-limits aggressively (5 req per ~10s window, observed via 429
 * storms on the inspect-vastai-catalog diagnostic). 30s tick + batch
 * size of 20 keeps us at <1 call/sec even with a full batch, well
 * under the rate limit. Boot-to-SSH wall-clock is dominated by image
 * pull anyway (1-15 min) so 30s vs 10s tick doesn't meaningfully
 * change buyer-visible UX.
 */

import { Queue, Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { PrismaClient } from '@a2e/database'
import type { Server as SocketServer } from 'socket.io'
import { pollVastAiRentalStatus } from '../services/inbound/vastai-provision.js'
import {
  isVastAiConfigured,
  isVastAiAllocatorEnabled,
} from '../services/inbound/vastai-adapter.js'
import { createNotification } from '../services/notification/service.js'
import { creditBalance } from '../services/balance/balance-service.js'

const QUEUE_NAME = 'vastai-poll'
const TICK_INTERVAL_MS = parseInt(process.env.VASTAI_POLL_TICK_MS ?? '30000', 10)
const BATCH_SIZE = 20

interface PollDeps {
  redis: ConnectionOptions
  prisma: PrismaClient
  io: SocketServer
}

export function createVastAiPollQueue(connection: ConnectionOptions): Queue {
  return new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    },
  })
}

export function createVastAiPollWorker(deps: PollDeps): Worker {
  return new Worker(
    QUEUE_NAME,
    async () => {
      await runVastAiPollTick(deps.prisma, deps.io)
    },
    {
      connection: deps.redis,
      concurrency: 1,
    },
  )
}

export async function scheduleVastAiPoll(queue: Queue): Promise<void> {
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key)
  }
  await queue.add('tick', {}, { repeat: { every: TICK_INTERVAL_MS } })
}

export async function runVastAiPollTick(
  prisma: PrismaClient,
  io: SocketServer,
): Promise<void> {
  // Gate on BOTH configured AND allocator-enabled. If an operator has
  // a key but flagged Vast.ai off in the cascade, we still shouldn't
  // be polling stale rentals (they'll get cleaned up by the
  // provisioning-timeout worker if they're truly orphaned).
  if (!isVastAiConfigured() || !isVastAiAllocatorEnabled()) {
    return
  }

  const rentals = await prisma.externalRental.findMany({
    where: {
      provider: 'VASTAI',
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
      console.error(
        `[vastai-poll] failed on rental ${r.id}:`,
        err instanceof Error ? err.message : err,
      )
    }
  }
}

async function pollOne(
  prisma: PrismaClient,
  io: SocketServer,
  r: { id: string; status: string; computeRequestId: string; sshHost: string | null },
): Promise<void> {
  const instance = await pollVastAiRentalStatus(prisma, r.id)
  if (!instance) {
    // 404 / terminal. If the linked ComputeRequest is still
    // PROVISIONING_EXTERNAL, Vast.ai dropped the instance before we
    // surfaced SSH (host went offline, billing failure, etc.). Cancel
    // + refund.
    await cancelAndRefund(
      prisma,
      io,
      r.computeRequestId,
      r.id,
      'Vast.ai terminated the instance before it became ready',
    )
    return
  }

  // Re-read the row after pollVastAiRentalStatus has applied its
  // status/sshHost/sshPort updates. The poll function does NOT promote
  // the ComputeRequest, only the ExternalRental side; that's this
  // worker's responsibility (matches the RunPod separation).
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

  // PENDING -> ACTIVE on the rental side promotes the ComputeRequest.
  // Guard on the request's PROVISIONING_EXTERNAL status so an admin
  // manual intervention (terminate, cancel) can't be silently
  // overwritten by a stale poll.
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
      const cr = await prisma.computeRequest.findUnique({
        where: { id: fresh.computeRequestId },
        select: { id: true, userId: true, gpuTier: true, gpuCount: true },
      })
      if (cr) {
        void createNotification(
          cr.userId,
          'COMPUTE_ACTIVE',
          'Compute is Live',
          `Your ${cr.gpuCount}x ${cr.gpuTier} Vast.ai-provisioned rental is ready. SSH details are in your dashboard.`,
          `/buyer/requests/${cr.id}`,
        )
        io.emit('compute:active', {
          requestId: cr.id,
          userId: cr.userId,
          provider: 'VASTAI',
          sshHost: fresh.sshHost,
          timestamp: new Date().toISOString(),
        })
      }
    }
    return
  }

  // CLOSING + linked request still PROVISIONING_EXTERNAL means the
  // upstream instance is being torn down before it activated. Refund
  // the buyer (matches RunPod's CLOSING handling).
  if (fresh.status === 'CLOSING') {
    await cancelAndRefund(
      prisma,
      io,
      fresh.computeRequestId,
      fresh.id,
      'Vast.ai began terminating before the instance was activated',
    )
  }
}

async function cancelAndRefund(
  prisma: PrismaClient,
  io: SocketServer,
  computeRequestId: string,
  externalRentalId: string,
  reason: string,
): Promise<void> {
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
      adminNote: `Vast.ai fallback failed: ${reason}`,
      sshSessionStatus: 'FAILED',
    },
  })

  if (cr.paymentSource === 'BUYER_BALANCE' && cr.totalCost > 0) {
    try {
      await creditBalance(prisma, {
        userId: cr.userId,
        amountUsd: cr.totalCost,
        type: 'REFUND_FAILED',
        description: `Vast.ai fallback failed for rental ${cr.id}`,
        referenceId: cr.id,
      })
    } catch (err) {
      console.error(`[vastai-poll] refund failed for ${cr.id}:`, err)
    }
  }

  void createNotification(
    cr.userId,
    'COMPUTE_REJECTED',
    'Compute Provisioning Failed',
    `Your ${cr.gpuCount}x ${cr.gpuTier} rental could not be provisioned (${reason}). `
      + (cr.paymentSource === 'BUYER_BALANCE'
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
