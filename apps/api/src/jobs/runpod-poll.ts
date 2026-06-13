/**
 * T5e — RunPod status polling worker.
 *
 * Mirror of lambda-poll.ts for RunPod. After tryRunPodFallback in
 * the allocator provisions a pod, the ComputeRequest is in
 * PROVISIONING_EXTERNAL and the ExternalRental row is PENDING. This
 * worker polls every ~10s, transitions ExternalRental PENDING ->
 * ACTIVE once RunPod reports the pod is RUNNING, and promotes the
 * ComputeRequest from PROVISIONING_EXTERNAL -> ACTIVE so the meter
 * starts ticking and SSH credentials surface to the buyer.
 *
 * Failure handling mirrors Lambda:
 *   - If RunPod 404s the pod or it terminates before reaching
 *     ACTIVE, we cancel the ComputeRequest and refund the buyer's
 *     SPEND_RENTAL debit via REFUND_FAILED.
 *   - Worker errors are logged but don't crash the tick — next tick
 *     re-tries.
 *
 * Tick interval defaults to 10s (same as Lambda) — pairing the two
 * means RunPod-provisioned rentals see the same ~30-90s wall-clock
 * boot-to-SSH that Lambda rentals do.
 */

import { Queue, Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { PrismaClient } from '@a2e/database'
import type { Server as SocketServer } from 'socket.io'
import { pollRunPodRentalStatus } from '../services/inbound/runpod-provision.js'
import { isRunPodConfigured } from '../services/inbound/runpod-adapter.js'
import { createNotification } from '../services/notification/service.js'
import { creditBalance } from '../services/balance/balance-service.js'
import {
  cleanupRentalTenantState,
  CLEANUP_SUCCESS_NOTE,
} from '../services/inbound/tenant-cleanup.js'

const QUEUE_NAME = 'runpod-poll'
const TICK_INTERVAL_MS = parseInt(process.env.RUNPOD_POLL_TICK_MS ?? '10000', 10)
const BATCH_SIZE = 50

interface PollDeps {
  redis: ConnectionOptions
  prisma: PrismaClient
  io: SocketServer
}

export function createRunPodPollQueue(connection: ConnectionOptions): Queue {
  return new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    },
  })
}

export function createRunPodPollWorker(deps: PollDeps): Worker {
  return new Worker(
    QUEUE_NAME,
    async () => {
      await runRunPodPollTick(deps.prisma, deps.io)
    },
    {
      connection: deps.redis,
      concurrency: 1,
    },
  )
}

export async function scheduleRunPodPoll(queue: Queue): Promise<void> {
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key)
  }
  await queue.add('tick', {}, { repeat: { every: TICK_INTERVAL_MS } })
}

// ---------------------------------------------------------------------------
// Core tick — exported for tests
// ---------------------------------------------------------------------------

export async function runRunPodPollTick(prisma: PrismaClient, io: SocketServer): Promise<void> {
  if (!isRunPodConfigured()) {
    // RunPod not configured on this deploy; nothing to poll. Same
    // silent no-op pattern as lambda-poll.
    return
  }

  // Same status filter as Lambda — PENDING/ACTIVE/CLOSING all benefit
  // from polling. CLOSED/FAILED are terminal.
  const rentals = await prisma.externalRental.findMany({
    where: {
      provider: 'RUNPOD',
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
      console.error(`[runpod-poll] failed on rental ${r.id}:`, err)
    }
  }
}

async function pollOne(
  prisma: PrismaClient,
  io: SocketServer,
  r: { id: string; status: string; computeRequestId: string; sshHost: string | null },
): Promise<void> {
  const pod = await pollRunPodRentalStatus(prisma, r.id)
  if (!pod) {
    // 404 / terminal. If linked ComputeRequest is still PROVISIONING_
    // EXTERNAL, RunPod dropped the pod before we surfaced SSH. Cancel
    // + refund.
    await cancelAndRefund(prisma, io, r.computeRequestId, r.id, 'RunPod terminated the pod before it became ready')
    return
  }

  const fresh = await prisma.externalRental.findUnique({
    where: { id: r.id },
    select: {
      id: true,
      status: true,
      sshHost: true,
      sshPort: true,
      sshUsername: true,
      computeRequestId: true,
      lastNote: true,
    },
  })
  if (!fresh) return

  // PENDING -> ACTIVE on the rental side promotes the ComputeRequest.
  // Guard on the request's current status so admin manual interventions
  // (terminate, etc.) can't be silently overwritten.
  if (fresh.status === 'ACTIVE' && fresh.sshHost) {
    // Tenant cleanup before surfacing credentials. Fails open, idempotent.
    if (fresh.lastNote !== CLEANUP_SUCCESS_NOTE) {
      const cleanup = await cleanupRentalTenantState(prisma, fresh.id)
      if (!cleanup.ok) {
        console.error(
          `[runpod-poll] tenant cleanup failed for ${fresh.id} after ${cleanup.durationMs}ms: ${cleanup.error}`,
        )
      } else {
        console.log(`[runpod-poll] tenant cleanup OK for ${fresh.id} in ${cleanup.durationMs}ms`)
      }
    }

    // SSH copy + status promote in one update; mirrors the vastai-poll
    // fix for the "looks stuck in dashboard" symptom that bit the
    // 2026-06-10 RTX_3090 rental.
    const promoted = await prisma.computeRequest.updateMany({
      where: { id: fresh.computeRequestId, status: 'PROVISIONING_EXTERNAL' },
      data: {
        status: 'ACTIVE',
        activatedAt: new Date(),
        sshSessionStatus: 'ACTIVE',
        sshHost: fresh.sshHost,
        sshPort: fresh.sshPort ?? 22,
        sshUsername: fresh.sshUsername ?? 'root',
        sshProvisionedAt: new Date(),
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
          `Your ${cr.gpuCount}x ${cr.gpuTier} RunPod-provisioned rental is ready. SSH details are in your dashboard.`,
          `/buyer/requests/${cr.id}`,
        )
        io.emit('compute:active', {
          requestId: cr.id,
          userId: cr.userId,
          provider: 'RUNPOD',
          sshHost: fresh.sshHost,
          timestamp: new Date().toISOString(),
        })
      }
    }
    return
  }

  // CLOSING + linked request still PROVISIONING_EXTERNAL = termination
  // raced ahead of activation. Refund the buyer.
  if (fresh.status === 'CLOSING') {
    await cancelAndRefund(prisma, io, fresh.computeRequestId, fresh.id, 'RunPod began terminating before the pod was activated')
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

  // SECURITY (N-4, 2026-06-13): capture updateMany.count and bail
  // when 0. Without this, a buyer-cancel or provisioning-timeout
  // that ALREADY flipped the row would let this worker still
  // proceed to credit a fresh refund. Pair with the (REFUND_RENTAL,
  // cancel:<id>) key alignment below so the cross-path
  // double-refund is hard-blocked by the (type, referenceId) unique
  // constraint on BalanceTransaction.
  const claim = await prisma.computeRequest.updateMany({
    where: { id: cr.id, status: 'PROVISIONING_EXTERNAL' },
    data: {
      status: 'CANCELLED',
      completedAt: new Date(),
      adminNote: `RunPod fallback failed: ${reason}`,
      sshSessionStatus: 'FAILED',
    },
  })
  if (claim.count === 0) {
    // Already transitioned out of PROVISIONING_EXTERNAL by another
    // path (buyer cancel, capacity-search-timeout, provisioning-
    // timeout). That path owns the refund; we no-op.
    return
  }

  if (cr.paymentSource === 'BUYER_BALANCE' && cr.totalCost > 0) {
    try {
      await creditBalance(prisma, {
        userId: cr.userId,
        amountUsd: cr.totalCost,
        type: 'REFUND_RENTAL',
        description: `RunPod fallback failed for rental ${cr.id} (auto-refund)`,
        referenceId: `cancel:${cr.id}`,
      })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[runpod-poll] refund failed for ${cr.id}:`, err)
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
