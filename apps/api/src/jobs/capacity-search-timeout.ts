/**
 * Capacity-search timeout auto-cancel worker.
 *
 * Companion to provisioning-timeout.ts. The two workers handle the
 * two distinct ways a rental can hang:
 *
 *   provisioning-timeout: rental got past the allocator (a provider
 *     was picked, an ExternalRental row was created) but the upstream
 *     provider stalled during boot. Cancels via updatedAt no-progress.
 *
 *   capacity-search-timeout (THIS FILE): rental never got past the
 *     allocator. ComputeRequest stuck in PENDING with the
 *     SEARCHING_CAPACITY or NO_REGION_CAPACITY flag because NO
 *     provider in the cascade reported capacity for the requested
 *     (tier, count, region) combination. Cancels by request age.
 *
 * Without this worker, a buyer requesting an unusual SKU (say, 8x B200
 * or H200 in a specific region) with no supply anywhere in the cascade
 * would have their money locked indefinitely. The allocator would keep
 * polling every 10s and never find anything. Buyer-visible UX: stuck
 * on "Looking for available capacity" page forever.
 *
 * Behavior: every 60s, find every PENDING ComputeRequest whose
 * requestedAt is older than CAPACITY_SEARCH_TIMEOUT_MS (default 15
 * min). For each, atomic transition to CANCELLED with an
 * informative adminNote explaining no capacity was found across the
 * cascade. Same refund routing as the buyer-cancel route, plus a
 * COMPUTE_REJECTED notification with the timeout reason.
 *
 * Why requestedAt and not updatedAt: ComputeRequest does NOT have an
 * @updatedAt column today (the allocator bumps eligibilityFlags but
 * Prisma doesn't auto-track updates on this model). requestedAt is a
 * stable wall-clock start point, which is what we want for a
 * search-budget timeout anyway: the search has had N minutes of
 * wall-clock to find capacity, not N minutes of database-write
 * activity.
 *
 * Configurability:
 *   CAPACITY_SEARCH_TIMEOUT_MS       default 900_000 (15 min)
 *   CAPACITY_SEARCH_TIMEOUT_TICK_MS  default 60_000  (60s)
 */

import { Queue, Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { PrismaClient } from '@a2e/database'
import type { Server as SocketServer } from 'socket.io'
import { createNotification } from '../services/notification/service.js'
import { creditBalance } from '../services/balance/balance-service.js'

const QUEUE_NAME = 'capacity-search-timeout'
const TICK_INTERVAL_MS = parseInt(
  process.env.CAPACITY_SEARCH_TIMEOUT_TICK_MS ?? '60000',
  10,
)
const TIMEOUT_MS = parseInt(
  process.env.CAPACITY_SEARCH_TIMEOUT_MS ?? `${15 * 60 * 1000}`,
  10,
)
const BATCH_SIZE = 50

interface Deps {
  redis: ConnectionOptions
  prisma: PrismaClient
  io: SocketServer
}

export function createCapacitySearchTimeoutQueue(
  connection: ConnectionOptions,
): Queue {
  return new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    },
  })
}

export function createCapacitySearchTimeoutWorker(deps: Deps): Worker {
  return new Worker(
    QUEUE_NAME,
    async () => {
      await runCapacitySearchTimeoutTick(deps.prisma, deps.io)
    },
    {
      connection: deps.redis,
      concurrency: 1,
    },
  )
}

export async function scheduleCapacitySearchTimeout(queue: Queue): Promise<void> {
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key)
  }
  await queue.add('tick', {}, { repeat: { every: TICK_INTERVAL_MS } })
}

interface StuckSearch {
  id: string
  userId: string
  gpuTier: string
  gpuCount: number
  totalCost: number
  paymentSource: string
  eligibilityFlags: string[]
  requiredRegion: string | null
  preferConfidential: boolean
}

export async function runCapacitySearchTimeoutTick(
  prisma: PrismaClient,
  io: SocketServer,
): Promise<void> {
  const cutoff = new Date(Date.now() - TIMEOUT_MS)
  // SECURITY (A12/D7, 2026-06-11): extended state coverage. Was
  // PENDING-only, but consumer-tier rentals (RTX_3090/4090/CONSUMER)
  // routed to capacity-starved Vast.ai/IO.net land in WAITLISTED
  // immediately, not PENDING. They never get auto-cancelled and the
  // buyer's money stays locked. Cover the full pre-ACTIVE state
  // surface: PENDING (capacity search), WAITLISTED (eligibility hold
  // or capacity stall), APPROVED (admin approved but allocator
  // didn't pick it up), ALLOCATED (SSH ready but agent didn't flip
  // to ACTIVE). The refund leg is identical regardless of which
  // pre-ACTIVE state we cancel from (no usage accrued yet).
  const stuck = await prisma.computeRequest.findMany({
    where: {
      status: { in: ['PENDING', 'WAITLISTED', 'APPROVED', 'ALLOCATED'] },
      requestedAt: { lte: cutoff },
    },
    take: BATCH_SIZE,
    select: {
      id: true,
      userId: true,
      gpuTier: true,
      gpuCount: true,
      totalCost: true,
      paymentSource: true,
      eligibilityFlags: true,
      requiredRegion: true,
      preferConfidential: true,
    },
  })

  if (stuck.length === 0) return

  console.log(
    `[capacity-search-timeout] found ${stuck.length} request(s) stuck in PENDING past ${Math.round(TIMEOUT_MS / 60000)}min`,
  )

  for (const cr of stuck) {
    try {
      await timeoutSearch(prisma, io, cr)
    } catch (err) {
      console.error(
        `[capacity-search-timeout] failed on request ${cr.id}:`,
        err instanceof Error ? err.message : err,
      )
    }
  }
}

async function timeoutSearch(
  prisma: PrismaClient,
  io: SocketServer,
  cr: StuckSearch,
): Promise<void> {
  const now = new Date()
  const reason = buildCancellationReason(cr)

  // Atomic transition. Status guard prevents a race with the allocator
  // or admin approve action picking up the request at the same instant.
  // Covers all pre-ACTIVE states (see A12/D7 comment on the outer
  // findMany above).
  const updated = await prisma.computeRequest.updateMany({
    where: {
      id: cr.id,
      status: { in: ['PENDING', 'WAITLISTED', 'APPROVED', 'ALLOCATED'] },
    },
    data: {
      status: 'CANCELLED',
      completedAt: now,
      adminNote: `Auto-cancelled: ${reason}`,
    },
  })
  if (updated.count === 0) return

  console.log(
    `[capacity-search-timeout] cancelling ${cr.id} (${cr.gpuCount}x ${cr.gpuTier}, refund $${cr.totalCost.toFixed(2)}): ${reason}`,
  )

  // Refund routing mirrors the buyer-cancel and provisioning-timeout
  // workers. Idempotent via referenceId.
  try {
    if (
      cr.paymentSource === 'BUYER_BALANCE'
      || cr.paymentSource === 'USDC'
      || cr.paymentSource === 'STRIPE_DIRECT'
    ) {
      // N-4 alignment (2026-06-13): shared cancel:<id> key.
      await creditBalance(prisma, {
        userId: cr.userId,
        amountUsd: cr.totalCost,
        type: 'REFUND_RENTAL',
        description: `Refund: capacity search timed out for ${cr.gpuCount}x ${cr.gpuTier}`,
        referenceId: `cancel:${cr.id}`,
      })
    } else if (cr.paymentSource === 'INTERNAL_BALANCE') {
      await prisma.internalSpend.deleteMany({ where: { computeRequestId: cr.id } })
    }
  } catch (err) {
    const isDuplicate = err instanceof Error && err.name === 'DuplicateTransactionError'
    if (!isDuplicate) {
      console.error(
        `[capacity-search-timeout] refund FAILED for ${cr.id}; row is CANCELLED but money still owed to buyer:`,
        err,
      )
    }
  }

  void createNotification(
    cr.userId,
    'COMPUTE_REJECTED',
    'No capacity found',
    buildBuyerMessage(cr, reason),
    `/buyer/requests/${cr.id}`,
  )

  io.emit('compute:cancelled', {
    requestId: cr.id,
    userId: cr.userId,
    reason: 'CAPACITY_SEARCH_TIMEOUT',
    refundAmountUsd: cr.totalCost,
    detail: reason,
    timestamp: now.toISOString(),
  })
}

/**
 * Build a one-line reason that distinguishes the common failure
 * modes so the admin note + buyer notification can be informative.
 * Reads the eligibilityFlags array the allocator writes every tick.
 */
function buildCancellationReason(cr: StuckSearch): string {
  const minutes = Math.round(TIMEOUT_MS / 60000)
  const flags = cr.eligibilityFlags

  if (flags.includes('NO_REGION_CAPACITY') && cr.requiredRegion) {
    return `No ${cr.gpuCount}x ${cr.gpuTier} capacity in region ${cr.requiredRegion} after ${minutes} min. `
      + 'Try relaxing the region constraint or pick a different tier.'
  }

  if (cr.preferConfidential) {
    return `No confidential-compute (TEE) capacity for ${cr.gpuCount}x ${cr.gpuTier} after ${minutes} min. `
      + 'Confidential suppliers (Phala, VoltageGPU) had no available SKUs.'
  }

  if (flags.includes('SEARCHING_CAPACITY')) {
    return `No supplier in the cascade reported available ${cr.gpuCount}x ${cr.gpuTier} capacity after ${minutes} min. `
      + 'Try a different tier, fewer GPUs, or wait and resubmit later.'
  }

  // Catch-all when the request is stuck PENDING for some other flag set
  // we don't recognize. Caller still cancels + refunds; this is just the
  // admin-facing message.
  return `Request stuck in PENDING for ${minutes} min without allocation; flags=[${flags.join(',') || 'none'}].`
}

function buildBuyerMessage(cr: StuckSearch, reason: string): string {
  const refundMsg = cr.paymentSource === 'INTERNAL_BALANCE'
    ? 'No refund needed (internal balance only).'
    : `Refund of $${cr.totalCost.toFixed(2)} credited back to your balance.`
  return `Your ${cr.gpuCount}x ${cr.gpuTier} rental was cancelled: ${reason} ${refundMsg}`
}
