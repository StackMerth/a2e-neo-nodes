/**
 * T5g — io.net VMaaS status polling worker.
 *
 * Mirror of runpod-poll.ts / phala-poll.ts for io.net. 10s tick:
 * io.net's POST /deploy returns immediately but the actual VM may
 * take ~30-90s to reach RUNNING (similar to Lambda/RunPod, faster
 * than Phala TEE attestation). Flips ExternalRental PENDING ->
 * ACTIVE once io.net reports the deployment is "running" + first
 * worker has ssh_access populated. Promotes the linked ComputeRequest
 * to ACTIVE so the per-minute meter starts ticking + SSH credentials
 * surface to the buyer.
 *
 * Failure handling mirrors RunPod:
 *   - 404 on getDeployment closes the row + cancels + refunds
 *   - CLOSING + still-PROVISIONING_EXTERNAL = early termination,
 *     cancel + refund
 *
 * Note: io.net charges first hour non-refundable. If a buyer
 * terminates within the first hour, we refund the buyer at our
 * marked-up rate; the platform absorbs the first-hour cost. Same
 * pattern as Lambda's billing semantics.
 */

import { Queue, Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { PrismaClient } from '@a2e/database'
import type { Server as SocketServer } from 'socket.io'
import { pollIoNetRentalStatus } from '../services/inbound/ionet-provision.js'
import { isIoNetConfigured } from '../services/inbound/ionet-adapter.js'
import { createNotification } from '../services/notification/service.js'
import { creditBalance } from '../services/balance/balance-service.js'
import {
  cleanupRentalTenantState,
  CLEANUP_SUCCESS_NOTE,
} from '../services/inbound/tenant-cleanup.js'

const QUEUE_NAME = 'ionet-poll'
const TICK_INTERVAL_MS = parseInt(process.env.IONET_POLL_TICK_MS ?? '10000', 10)
const BATCH_SIZE = 50

interface PollDeps {
  redis: ConnectionOptions
  prisma: PrismaClient
  io: SocketServer
}

export function createIoNetPollQueue(connection: ConnectionOptions): Queue {
  return new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    },
  })
}

export function createIoNetPollWorker(deps: PollDeps): Worker {
  return new Worker(
    QUEUE_NAME,
    async () => {
      await runIoNetPollTick(deps.prisma, deps.io)
    },
    {
      connection: deps.redis,
      concurrency: 1,
    },
  )
}

export async function scheduleIoNetPoll(queue: Queue): Promise<void> {
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key)
  }
  await queue.add('tick', {}, { repeat: { every: TICK_INTERVAL_MS } })
}

export async function runIoNetPollTick(prisma: PrismaClient, io: SocketServer): Promise<void> {
  if (!isIoNetConfigured()) return

  const rentals = await prisma.externalRental.findMany({
    where: {
      provider: 'IONET',
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
      console.error(`[ionet-poll] failed on rental ${r.id}:`, err)
    }
  }
}

async function pollOne(
  prisma: PrismaClient,
  io: SocketServer,
  r: { id: string; status: string; computeRequestId: string; sshHost: string | null },
): Promise<void> {
  const dep = await pollIoNetRentalStatus(prisma, r.id)
  if (!dep) {
    await cancelAndRefund(
      prisma,
      io,
      r.computeRequestId,
      r.id,
      'io.net terminated the deployment before it became ready',
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
    // Tenant cleanup runs ONCE before we promote the ComputeRequest to
    // ACTIVE. Without this, the buyer's first login can see the
    // previous tenant's bash_history, .aws/credentials, etc. (real
    // failure observed on rental cmq3p1gt0000 2026-06-07). Fails open
    // so a flaky cleanup doesn't block the buyer indefinitely; the
    // lastNote field records the outcome for ops triage.
    //
    // Idempotency: cleanupIoNetTenant skips the SSH round-trip when
    // lastNote already shows CLEANUP_SUCCESS_NOTE.
    if (fresh.lastNote !== CLEANUP_SUCCESS_NOTE) {
      const result = await cleanupRentalTenantState(prisma, fresh.id)
      if (!result.ok) {
        console.error(
          `[ionet-poll] tenant cleanup FAILED for ${fresh.id} after ${result.durationMs}ms: ${result.error}`,
        )
        // Fail open: still promote to ACTIVE. The lastNote captures
        // the failure for follow-up. Future hardening: retry N times
        // before promoting, OR fail closed when a strict-isolation
        // buyer flag is set.
      } else {
        console.log(
          `[ionet-poll] tenant cleanup OK for ${fresh.id} in ${result.durationMs}ms`,
        )
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
          `Your ${cr.gpuCount}x ${cr.gpuTier} rental is ready. SSH details are in your dashboard.`,
          `/buyer/requests/${cr.id}`,
        )
        io.emit('compute:active', {
          requestId: cr.id,
          userId: cr.userId,
          provider: 'IONET',
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
      'io.net began terminating before the VM was activated',
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
      adminNote: `io.net fallback failed: ${reason}`,
      sshSessionStatus: 'FAILED',
    },
  })

  if (cr.paymentSource === 'BUYER_BALANCE' && cr.totalCost > 0) {
    try {
      await creditBalance(prisma, {
        userId: cr.userId,
        amountUsd: cr.totalCost,
        type: 'REFUND_FAILED',
        description: `io.net fallback failed for rental ${cr.id}`,
        referenceId: cr.id,
      })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[ionet-poll] refund failed for ${cr.id}:`, err)
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
