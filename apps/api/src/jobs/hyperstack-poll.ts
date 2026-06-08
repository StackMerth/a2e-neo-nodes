/**
 * Hyperstack status polling worker.
 *
 * Mirror of shadeform-poll.ts for Hyperstack-direct rentals. After
 * tryHyperstackFallback in the allocator creates a VM, the
 * ComputeRequest is in PROVISIONING_EXTERNAL and the ExternalRental row
 * is PENDING. This worker polls every ~30s, flips ExternalRental
 * PENDING -> ACTIVE once Hyperstack reports status='ACTIVE' with a
 * floating IP, and promotes the linked ComputeRequest to ACTIVE so the
 * meter starts ticking and SSH credentials surface in the buyer
 * dashboard.
 *
 * Tenant cleanup is intentionally SKIPPED for Hyperstack rows for the
 * same reason as Shadeform: every rental gets a fresh VM. Attempting an
 * SSH probe against an image where our ephemeral pubkey may not yet be
 * fully installed triggers an unhandled socket 'error' event on the
 * ssh2 library that historically crashed the API process. The buyer's
 * own SSH session is the only one that matters here.
 *
 * Failure handling mirrors Shadeform:
 *   - If Hyperstack 404s the VM or it terminates before reaching
 *     ACTIVE, we cancel the ComputeRequest and refund the buyer's
 *     SPEND_RENTAL debit via REFUND_FAILED.
 *   - Worker errors are logged but don't crash the tick; next tick
 *     re-tries.
 *
 * Tick interval: 30s. Hyperstack's REST API is generous on rate limits;
 * 30s is plenty given that boot times are typically 60-180s.
 */

import { Queue, Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { PrismaClient } from '@a2e/database'
import type { Server as SocketServer } from 'socket.io'
import { pollHyperstackRentalStatus } from '../services/inbound/hyperstack-provision.js'
import {
  isHyperstackConfigured,
  isHyperstackAllocatorEnabled,
} from '../services/inbound/hyperstack-adapter.js'
import { createNotification } from '../services/notification/service.js'
import { creditBalance } from '../services/balance/balance-service.js'

const QUEUE_NAME = 'hyperstack-poll'
const TICK_INTERVAL_MS = parseInt(process.env.HYPERSTACK_POLL_TICK_MS ?? '30000', 10)
const BATCH_SIZE = 20

interface PollDeps {
  redis: ConnectionOptions
  prisma: PrismaClient
  io: SocketServer
}

export function createHyperstackPollQueue(connection: ConnectionOptions): Queue {
  return new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    },
  })
}

export function createHyperstackPollWorker(deps: PollDeps): Worker {
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      try {
        await runHyperstackPollTick(deps.prisma, deps.io)
      } catch (err) {
        console.error(
          '[hyperstack-poll] tick crashed (caught at worker level):',
          err instanceof Error ? `${err.message}\n${err.stack}` : err,
        )
      }
    },
    {
      connection: deps.redis,
      concurrency: 1,
    },
  )
  worker.on('error', (err) => {
    console.error(
      '[hyperstack-poll] worker error event:',
      err instanceof Error ? `${err.message}\n${err.stack}` : err,
    )
  })
  worker.on('failed', (job, err) => {
    console.error(
      `[hyperstack-poll] job ${job?.id ?? '?'} failed:`,
      err instanceof Error ? `${err.message}\n${err.stack}` : err,
    )
  })
  return worker
}

export async function scheduleHyperstackPoll(queue: Queue): Promise<void> {
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key)
  }
  await queue.add('tick', {}, { repeat: { every: TICK_INTERVAL_MS } })
}

export async function runHyperstackPollTick(
  prisma: PrismaClient,
  io: SocketServer,
): Promise<void> {
  if (!isHyperstackConfigured() || !isHyperstackAllocatorEnabled()) {
    return
  }

  let rentals: Array<{
    id: string
    status: string
    computeRequestId: string
    sshHost: string | null
  }> = []
  try {
    rentals = await prisma.externalRental.findMany({
      where: {
        provider: 'HYPERSTACK',
        status: { in: ['PENDING', 'ACTIVE', 'CLOSING'] },
      },
      orderBy: { createdAt: 'asc' },
      take: BATCH_SIZE,
      select: {
        id: true,
        status: true,
        computeRequestId: true,
        sshHost: true,
      },
    })
  } catch (err) {
    console.error(
      '[hyperstack-poll] findMany failed:',
      err instanceof Error ? `${err.message}\n${err.stack}` : err,
    )
    return
  }

  for (const r of rentals) {
    try {
      await pollOne(prisma, io, r)
    } catch (err) {
      console.error(
        `[hyperstack-poll] failed on rental ${r.id}:`,
        err instanceof Error ? `${err.message}\n${err.stack}` : err,
      )
    }
  }
}

async function pollOne(
  prisma: PrismaClient,
  io: SocketServer,
  r: { id: string; status: string; computeRequestId: string; sshHost: string | null },
): Promise<void> {
  const info = await pollHyperstackRentalStatus(prisma, r.id)
  if (!info) {
    await cancelAndRefund(
      prisma,
      io,
      r.computeRequestId,
      r.id,
      'Hyperstack terminated the VM before it became ready',
    )
    return
  }

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
    // Skip tenant cleanup; Hyperstack provisions a fresh VM per rental
    // and an SSH probe here only adds crash surface, no value. Same
    // rationale as shadeform-poll.ts (see file doc for the 2026-06-08
    // crash incident).
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
          `Your ${cr.gpuCount}x ${cr.gpuTier} Hyperstack rental is ready. SSH details are in your dashboard.`,
          `/buyer/requests/${cr.id}`,
        )
        io.emit('compute:active', {
          requestId: cr.id,
          userId: cr.userId,
          provider: 'HYPERSTACK',
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
      'Hyperstack began terminating before the VM was activated',
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
      adminNote: `Hyperstack fallback failed: ${reason}`,
      sshSessionStatus: 'FAILED',
    },
  })

  if (cr.paymentSource === 'BUYER_BALANCE' && cr.totalCost > 0) {
    try {
      await creditBalance(prisma, {
        userId: cr.userId,
        amountUsd: cr.totalCost,
        type: 'REFUND_FAILED',
        description: `Hyperstack fallback failed for rental ${cr.id}`,
        referenceId: cr.id,
      })
    } catch (err) {
      console.error(`[hyperstack-poll] refund failed for ${cr.id}:`, err)
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
