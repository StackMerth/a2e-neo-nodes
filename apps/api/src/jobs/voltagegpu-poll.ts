/**
 * T5h — VoltageGPU status polling worker.
 *
 * Mirror of ionet-poll.ts. 10s tick. Flips ExternalRental PENDING ->
 * ACTIVE once VoltageGPU reports the pod is running + sshHost
 * populates. Promotes the linked ComputeRequest to ACTIVE so the
 * meter ticks and SSH details surface to the buyer.
 */

import { Queue, Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { PrismaClient } from '@a2e/database'
import type { Server as SocketServer } from 'socket.io'
import { pollVoltageGpuRentalStatus } from '../services/inbound/voltagegpu-provision.js'
import { isVoltageGpuConfigured } from '../services/inbound/voltagegpu-adapter.js'
import { createNotification } from '../services/notification/service.js'
import { creditBalance } from '../services/balance/balance-service.js'
import {
  cleanupRentalTenantState,
  CLEANUP_SUCCESS_NOTE,
} from '../services/inbound/tenant-cleanup.js'

const QUEUE_NAME = 'voltagegpu-poll'
const TICK_INTERVAL_MS = parseInt(process.env.VOLTAGEGPU_POLL_TICK_MS ?? '10000', 10)
const BATCH_SIZE = 50

interface PollDeps {
  redis: ConnectionOptions
  prisma: PrismaClient
  io: SocketServer
}

export function createVoltageGpuPollQueue(connection: ConnectionOptions): Queue {
  return new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    },
  })
}

export function createVoltageGpuPollWorker(deps: PollDeps): Worker {
  return new Worker(
    QUEUE_NAME,
    async () => {
      await runVoltageGpuPollTick(deps.prisma, deps.io)
    },
    {
      connection: deps.redis,
      concurrency: 1,
    },
  )
}

export async function scheduleVoltageGpuPoll(queue: Queue): Promise<void> {
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key)
  }
  await queue.add('tick', {}, { repeat: { every: TICK_INTERVAL_MS } })
}

export async function runVoltageGpuPollTick(prisma: PrismaClient, io: SocketServer): Promise<void> {
  if (!isVoltageGpuConfigured()) return

  const rentals = await prisma.externalRental.findMany({
    where: {
      provider: 'VOLTAGE_GPU',
      status: { in: ['PENDING', 'ACTIVE', 'CLOSING'] },
    },
    orderBy: { launchRequestedAt: 'asc' },
    take: BATCH_SIZE,
    select: { id: true, status: true, computeRequestId: true, sshHost: true },
  })

  for (const r of rentals) {
    try {
      await pollOne(prisma, io, r)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[voltagegpu-poll] failed on rental ${r.id}:`, err)
    }
  }
}

async function pollOne(
  prisma: PrismaClient,
  io: SocketServer,
  r: { id: string; status: string; computeRequestId: string; sshHost: string | null },
): Promise<void> {
  const pod = await pollVoltageGpuRentalStatus(prisma, r.id)
  if (!pod) {
    await cancelAndRefund(
      prisma,
      io,
      r.computeRequestId,
      r.id,
      'VoltageGPU terminated the pod before it became ready',
    )
    return
  }

  const fresh = await prisma.externalRental.findUnique({
    where: { id: r.id },
    select: {
      id: true, status: true, sshHost: true, sshPort: true, sshUsername: true,
      computeRequestId: true, lastNote: true,
    },
  })
  if (!fresh) return

  if (fresh.status === 'ACTIVE' && fresh.sshHost) {
    // Tenant cleanup before surfacing credentials. Fails open, idempotent.
    if (fresh.lastNote !== CLEANUP_SUCCESS_NOTE) {
      const cleanup = await cleanupRentalTenantState(prisma, fresh.id)
      if (!cleanup.ok) {
        console.error(
          `[voltagegpu-poll] tenant cleanup failed for ${fresh.id} after ${cleanup.durationMs}ms: ${cleanup.error}`,
        )
      } else {
        console.log(`[voltagegpu-poll] tenant cleanup OK for ${fresh.id} in ${cleanup.durationMs}ms`)
      }
    }

    // SSH copy + status promote in one update; see vastai-poll for the
    // dashboard-looks-stuck symptom that bit the 2026-06-10 rental.
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
          `Your ${cr.gpuCount}x ${cr.gpuTier} confidential rental is ready. SSH details are in your dashboard.`,
          `/buyer/requests/${cr.id}`,
        )
        io.emit('compute:active', {
          requestId: cr.id,
          userId: cr.userId,
          provider: 'VOLTAGE_GPU',
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
      'VoltageGPU began terminating the pod before it was activated',
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
      adminNote: `VoltageGPU fallback failed: ${reason}`,
      sshSessionStatus: 'FAILED',
    },
  })

  if (cr.paymentSource === 'BUYER_BALANCE' && cr.totalCost > 0) {
    try {
      await creditBalance(prisma, {
        userId: cr.userId,
        amountUsd: cr.totalCost,
        type: 'REFUND_FAILED',
        description: `VoltageGPU fallback failed for rental ${cr.id}`,
        referenceId: cr.id,
      })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[voltagegpu-poll] refund failed for ${cr.id}:`, err)
    }
  }

  void createNotification(
    cr.userId,
    'COMPUTE_REJECTED',
    'Compute Provisioning Failed',
    `Your ${cr.gpuCount}x ${cr.gpuTier} confidential rental could not be provisioned (${reason}). ` +
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
