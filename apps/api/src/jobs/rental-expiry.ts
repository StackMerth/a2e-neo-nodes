/**
 * M2 / B3 final piece: auto-complete rentals when their term expires.
 *
 * Without this worker, an ACTIVE ComputeRequest whose `expiresAt` has
 * passed would stay ACTIVE forever — the per-minute meter caps at
 * totalCost so the buyer isn't overcharged, but the assigned nodes stay
 * locked and can never be re-rented. That's a worse failure mode than
 * a buyer noticing late: it silently breaks inventory.
 *
 * Tick interval: 60s. The allocator runs every 10s, so a node freed by
 * expiry is back in the idle pool by the next allocator cycle within
 * ~70s of expiry. That's good enough — real buyers don't notice
 * minute-level latency on a rental ending.
 *
 * Idempotency: every status transition uses `where: { status: 'ACTIVE' }`
 * as a guard so two ticks (or a tick racing the buyer's terminate) can't
 * double-process. The losing transition becomes a no-op.
 *
 * Refund handling: rentals that hit their full duration have nothing
 * to refund (accruedCost == totalCost). We don't trigger the refund
 * path for natural expiry, only for early terminate.
 */

import { Queue, Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { PrismaClient } from '@a2e/database'
import type { Server as SocketServer } from 'socket.io'
import { createNotification } from '../services/notification/service.js'

const QUEUE_NAME = 'rental-expiry'
const TICK_INTERVAL_MS = parseInt(process.env.EXPIRY_TICK_MS ?? '60000', 10)
const BATCH_SIZE = 200

interface ExpiryDeps {
  redis: ConnectionOptions
  prisma: PrismaClient
  io: SocketServer
}

export function createRentalExpiryQueue(connection: ConnectionOptions): Queue {
  return new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    },
  })
}

export function createRentalExpiryWorker(deps: ExpiryDeps): Worker {
  return new Worker(
    QUEUE_NAME,
    async () => {
      await runExpiryTick(deps.prisma, deps.io)
    },
    {
      connection: deps.redis,
      concurrency: 1,
    },
  )
}

export async function scheduleRentalExpiry(queue: Queue): Promise<void> {
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key)
  }
  await queue.add('tick', {}, { repeat: { every: TICK_INTERVAL_MS } })
}

export async function runExpiryTick(prisma: PrismaClient, io: SocketServer): Promise<void> {
  const now = new Date()

  const expired = await prisma.computeRequest.findMany({
    where: {
      status: 'ACTIVE',
      expiresAt: { lte: now },
    },
    take: BATCH_SIZE,
    select: {
      id: true,
      userId: true,
      gpuTier: true,
      gpuCount: true,
      totalCost: true,
      allocatedNodeIds: true,
    },
  })

  for (const cr of expired) {
    try {
      await completeRental(prisma, io, cr, now)
    } catch (err) {
      // Don't poison the batch on one bad row.
      // eslint-disable-next-line no-console
      console.error(`[rental-expiry] failed on request ${cr.id}:`, err)
    }
  }
}

async function completeRental(
  prisma: PrismaClient,
  io: SocketServer,
  cr: { id: string; userId: string; gpuTier: string; gpuCount: number; totalCost: number; allocatedNodeIds: string[] },
  now: Date,
): Promise<void> {
  // Atomic transition: status guard prevents double-processing if the
  // buyer's terminate route races us.
  const result = await prisma.$transaction(async tx => {
    const updated = await tx.computeRequest.updateMany({
      where: { id: cr.id, status: 'ACTIVE' },
      data: {
        status: 'COMPLETED',
        completedAt: now,
        // Clear ephemeral SSH so the buyer's old credential becomes useless
        // even if they cached it. Mirrors what the terminate route does.
        sshSessionToken: null,
        sshSessionTokenExpiresAt: null,
        adminNote: 'Auto-completed: rental term reached',
      },
    })
    if (updated.count === 0) {
      // Lost the race — buyer's terminate already moved this to COMPLETED.
      return { processed: false }
    }

    // Release every assigned node back to the idle pool.
    if (cr.allocatedNodeIds.length > 0) {
      await tx.node.updateMany({
        where: { id: { in: cr.allocatedNodeIds } },
        data: { assignedComputeRequestId: null },
      })
    }

    // Bump trust signals — buyer rode out the full term, that's a
    // successful rental for the eligibility engine.
    await tx.user.update({
      where: { id: cr.userId },
      data: {
        successfulRentalCount: { increment: 1 },
        lastRentalAt: now,
      },
    })

    return { processed: true }
  })

  if (!result.processed) return

  void createNotification(
    cr.userId,
    'COMPUTE_COMPLETED',
    'Rental Ended',
    `Your ${cr.gpuCount}x ${cr.gpuTier} rental has reached its end of term. Thank you for using A²E.`,
  )

  io.emit('compute:terminated', {
    requestId: cr.id,
    userId: cr.userId,
    finalMinutes: null,
    finalAccrued: cr.totalCost, // full rental ran its course
    refundAmount: 0,
    refundStatus: 'SKIPPED_FULL_TERM',
    refundTxHash: null,
    timestamp: now.toISOString(),
  })
}
