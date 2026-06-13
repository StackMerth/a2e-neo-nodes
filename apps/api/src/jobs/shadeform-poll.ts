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
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      // Top-level try/catch: anything escaping runShadeFormPollTick
      // must NOT crash the API process. The worker LOGS and moves on.
      // Render observed 3 process-level crashes within 5 minutes after
      // this poll worker first deployed; the cause was an exception
      // leaking past the per-rental try/catch into the tick promise.
      // Surrounding the whole tick in another catch removes that
      // failure mode regardless of which line throws.
      try {
        await runShadeFormPollTick(deps.prisma, deps.io)
      } catch (err) {
        console.error(
          '[shadeform-poll] tick crashed (caught at worker level):',
          err instanceof Error ? `${err.message}\n${err.stack}` : err,
        )
      }
    },
    {
      connection: deps.redis,
      concurrency: 1,
    },
  )
  // BullMQ surfaces some failures via .on('error') instead of throwing
  // from the job handler. Catch those too so a Redis/queue blip doesn't
  // crash the process.
  worker.on('error', (err) => {
    console.error(
      '[shadeform-poll] worker error event:',
      err instanceof Error ? `${err.message}\n${err.stack}` : err,
    )
  })
  worker.on('failed', (job, err) => {
    console.error(
      `[shadeform-poll] job ${job?.id ?? '?'} failed:`,
      err instanceof Error ? `${err.message}\n${err.stack}` : err,
    )
  })
  return worker
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

  let rentals: Array<{
    id: string
    status: string
    computeRequestId: string
    sshHost: string | null
  }> = []
  try {
    rentals = await prisma.externalRental.findMany({
      where: {
        provider: 'SHADEFORM',
        status: { in: ['PENDING', 'ACTIVE', 'CLOSING'] },
      },
      // Use createdAt instead of launchRequestedAt because the column
      // name may differ from vastai-poll's assumption depending on the
      // current Prisma schema; createdAt is always present on any cuid
      // model. Either ordering picks oldest first which is what we want.
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
      '[shadeform-poll] findMany failed:',
      err instanceof Error ? `${err.message}\n${err.stack}` : err,
    )
    return
  }

  for (const r of rentals) {
    try {
      await pollOne(prisma, io, r)
    } catch (err) {
      console.error(
        `[shadeform-poll] failed on rental ${r.id}:`,
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
      sshPort: true,
      sshUsername: true,
      computeRequestId: true,
      lastNote: true,
    },
  })
  if (!fresh) return

  if (fresh.status === 'ACTIVE' && fresh.sshHost) {
    // SKIP tenant cleanup for Shadeform: every underlying cloud
    // (massedcompute, latitude, crusoe, hyperstack, etc.) provisions a
    // fresh VM per rental via Shade Cloud accounts, so there is no
    // prior-tenant residue. Attempting cleanup triggered a fatal SSH
    // auth crash on 2026-06-08: ssh2 library's socket emits an
    // unhandled 'error' event when our ephemeral key doesn't match the
    // VM's authorized_keys (Shadeform's ssh_key field may not always
    // propagate cleanly through massedcompute's provisioning). That
    // unhandled emit took down the API every minute. Skipping cleanup
    // here removes both the unnecessary work AND the crash vector.

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

  // N-4 (2026-06-13): updateMany.count check + shared refund key.
  const claim = await prisma.computeRequest.updateMany({
    where: { id: cr.id, status: 'PROVISIONING_EXTERNAL' },
    data: {
      status: 'CANCELLED',
      completedAt: new Date(),
      adminNote: `Shadeform fallback failed: ${reason}`,
      sshSessionStatus: 'FAILED',
    },
  })
  if (claim.count === 0) return

  if (cr.paymentSource === 'BUYER_BALANCE' && cr.totalCost > 0) {
    try {
      await creditBalance(prisma, {
        userId: cr.userId,
        amountUsd: cr.totalCost,
        type: 'REFUND_RENTAL',
        description: `Shadeform fallback failed for rental ${cr.id} (auto-refund)`,
        referenceId: `cancel:${cr.id}`,
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
