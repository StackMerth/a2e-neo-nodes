/**
 * Shadeform status polling worker.
 *
 * Mirror of vastai-poll.ts for Shadeform. After tryShadeFormFallback in
 * the allocator creates an instance, the ComputeRequest is in
 * PROVISIONING_EXTERNAL and the ExternalRental row is PENDING. This
 * worker polls every ~30s, transitions ExternalRental PENDING -> ACTIVE
 * once Shadeform reports status='active' with an IP + port, and
 * promotes the linked ComputeRequest from PROVISIONING_EXTERNAL ->
 * ACTIVE so the meter starts ticking and SSH credentials surface in
 * the buyer dashboard.
 *
 * Critical context: this worker did NOT exist when the first Shadeform
 * rental was placed on 2026-06-08 via the portal. Rental cmq5d5idm000
 * sat in PROVISIONING_EXTERNAL for 2 HOURS because of this gap; the
 * actual Shadeform instance had been active for most of that time
 * (massedcompute boots a fresh L40S in ~2-3 min) but our row never
 * learned about it.
 *
 * Failure handling mirrors Vast.ai:
 *   - If Shadeform 404s the instance or it terminates before reaching
 *     ACTIVE, we cancel the ComputeRequest and refund the buyer's
 *     SPEND_RENTAL debit via REFUND_FAILED.
 *   - Worker errors are logged but don't crash the tick; next tick
 *     re-tries.
 *
 * Tick interval: 30s. Shadeform's REST API doesn't aggressively rate
 * limit but 30s is plenty for a buyer's perspective (cascade boot is
 * dominated by the underlying cloud's VM-spawn time, 60-180s).
 */

import { Queue, Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { PrismaClient } from '@a2e/database'
import type { Server as SocketServer } from 'socket.io'
import { pollShadeFormRentalStatus } from '../services/inbound/shadeform-provision.js'
import {
  isShadeFormConfigured,
  isShadeFormAllocatorEnabled,
} from '../services/inbound/shadeform-adapter.js'
import { createNotification } from '../services/notification/service.js'
import { creditBalance } from '../services/balance/balance-service.js'
import {
  cleanupRentalTenantState,
  CLEANUP_SUCCESS_NOTE,
} from '../services/inbound/tenant-cleanup.js'

const QUEUE_NAME = 'shadeform-poll'
const TICK_INTERVAL_MS = parseInt(process.env.SHADEFORM_POLL_TICK_MS ?? '30000', 10)
const BATCH_SIZE = 20

interface PollDeps {
  redis: ConnectionOptions
  prisma: PrismaClient
  io: SocketServer
}

export function createShadeFormPollQueue(connection: ConnectionOptions): Queue {
  return new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    },
  })
}

export function createShadeFormPollWorker(deps: PollDeps): Worker {
  return new Worker(
    QUEUE_NAME,
    async () => {
      await runShadeFormPollTick(deps.prisma, deps.io)
    },
    {
      connection: deps.redis,
      concurrency: 1,
    },
  )
}

export async function scheduleShadeFormPoll(queue: Queue): Promise<void> {
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key)
  }
  await queue.add('tick', {}, { repeat: { every: TICK_INTERVAL_MS } })
}

export async function runShadeFormPollTick(
  prisma: PrismaClient,
  io: SocketServer,
): Promise<void> {
  if (!isShadeFormConfigured() || !isShadeFormAllocatorEnabled()) {
    return
  }

  const rentals = await prisma.externalRental.findMany({
    where: {
      provider: 'SHADEFORM',
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
        `[shadeform-poll] failed on rental ${r.id}:`,
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
  const info = await pollShadeFormRentalStatus(prisma, r.id)
  if (!info) {
    // 404 / terminal. If the linked ComputeRequest is still
    // PROVISIONING_EXTERNAL, Shadeform dropped the instance before we
    // surfaced SSH (underlying cloud went offline, billing failure
    // upstream, etc.). Cancel + refund.
    await cancelAndRefund(
      prisma,
      io,
      r.computeRequestId,
      r.id,
      'Shadeform terminated the instance before it became ready',
    )
    return
  }

  // Re-read the row after pollShadeFormRentalStatus has applied its
  // status / sshHost / sshPort updates.
  const fresh = await prisma.externalRental.findUnique({
    where: { id: r.id },
    select: {
      id: true,
      status: true,
      sshHost: true,
      computeRequestId: true,
      lastNote: true,
    },
  })
  if (!fresh) return

  if (fresh.status === 'ACTIVE' && fresh.sshHost) {
    // Tenant cleanup before surfacing credentials. Shadeform creates a
    // fresh VM via Shade Cloud accounts per booking, so this is mostly
    // a no-op; kept for defense-in-depth parity with the other poll
    // workers.
    if (fresh.lastNote !== CLEANUP_SUCCESS_NOTE) {
      const cleanup = await cleanupRentalTenantState(prisma, fresh.id)
      if (!cleanup.ok) {
        console.error(
          `[shadeform-poll] tenant cleanup failed for ${fresh.id} after ${cleanup.durationMs}ms: ${cleanup.error}`,
        )
      } else {
        console.log(`[shadeform-poll] tenant cleanup OK for ${fresh.id} in ${cleanup.durationMs}ms`)
      }
    }

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
          `Your ${cr.gpuCount}x ${cr.gpuTier} Shadeform-provisioned rental is ready. SSH details are in your dashboard.`,
          `/buyer/requests/${cr.id}`,
        )
        io.emit('compute:active', {
          requestId: cr.id,
          userId: cr.userId,
          provider: 'SHADEFORM',
          sshHost: fresh.sshHost,
          timestamp: new Date().toISOString(),
        })
      }
    }
    return
  }

  if (fresh.status === 'CLOSING') {
    await cancelAndRefund(
      prisma,
      io,
      fresh.computeRequestId,
      fresh.id,
      'Shadeform began terminating before the instance was activated',
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
      adminNote: `Shadeform fallback failed: ${reason}`,
      sshSessionStatus: 'FAILED',
    },
  })

  if (cr.paymentSource === 'BUYER_BALANCE' && cr.totalCost > 0) {
    try {
      await creditBalance(prisma, {
        userId: cr.userId,
        amountUsd: cr.totalCost,
        type: 'REFUND_FAILED',
        description: `Shadeform fallback failed for rental ${cr.id}`,
        referenceId: cr.id,
      })
    } catch (err) {
      console.error(`[shadeform-poll] refund failed for ${cr.id}:`, err)
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
