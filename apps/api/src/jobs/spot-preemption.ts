/**
 * M3 / B6: SPOT preemption worker.
 *
 * When ON_DEMAND demand spikes and SPOT-tier rentals are blocking the
 * inventory the auto-allocator wants for ON_DEMAND requests, gracefully
 * evict SPOT rentals with a 90-second warning. The preemption protocol
 * is two-phase to give buyers time to checkpoint their workspace:
 *
 *   T+0s   : detect demand pressure → mark SPOT victim with
 *            preemptionScheduledFor = now + 90s, emit
 *            'compute:preemption-notice' WS event so the buyer's
 *            dashboard shows a countdown banner
 *   T+90s  : terminate the SPOT rental, mark COMPLETED with adminNote
 *            'Preempted: capacity needed for ON_DEMAND traffic',
 *            refund prorated minutes-not-used
 *
 * Hard rules (never violated):
 *   - RESERVED rentals are NEVER preemption candidates (commitment is
 *     commitment; honoring reserved capacity is the entire point of
 *     paying for it)
 *   - ON_DEMAND rentals are NEVER preemption candidates (they pay full
 *     price specifically to never be interrupted)
 *   - Only SPOT rentals are eligible
 *
 * Cadence: 30s tick. Demand pressure builds slowly enough that 30s
 * latency between detection and notice is fine; the 90s grace window
 * dominates the user experience anyway.
 *
 * Detection trigger:
 *   For each gpuTier T, count idle ONLINE nodes of T (excluding nodes
 *   currently assigned to SPOT rentals). If a PENDING ON_DEMAND request
 *   for T is waiting AND there's at least one SPOT rental running on a
 *   T-tier node, pick the SPOT rental that's been running longest as
 *   the victim and schedule preemption.
 *
 * Why 'longest running' as the victim heuristic:
 *   - Gives newer SPOT rentals a fair shot at completing useful work
 *   - Caps the per-rental disruption: anyone running a long-lived spot
 *     rental should expect to be interrupted eventually
 *   - Simple and deterministic
 */

import { Queue, Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { PrismaClient, GpuTier } from '@a2e/database'
import type { Server as SocketServer } from 'socket.io'
import { createNotification } from '../services/notification/service.js'
import { getSolanaConfig, processPayment } from '../services/payment/solana.js'

const QUEUE_NAME = 'spot-preemption'
const TICK_INTERVAL_MS = parseInt(process.env.SPOT_PREEMPTION_TICK_MS ?? '30000', 10)
const PREEMPTION_GRACE_MS = parseInt(process.env.SPOT_PREEMPTION_GRACE_MS ?? '90000', 10)

const HEARTBEAT_FRESH_MS = 2 * 60 * 1000

interface PreemptionDeps {
  redis: ConnectionOptions
  prisma: PrismaClient
  io: SocketServer
}

export function createSpotPreemptionQueue(connection: ConnectionOptions): Queue {
  return new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    },
  })
}

export function createSpotPreemptionWorker(deps: PreemptionDeps): Worker {
  return new Worker(
    QUEUE_NAME,
    async () => {
      await runSpotPreemptionTick(deps.prisma, deps.io)
    },
    {
      connection: deps.redis,
      concurrency: 1,
    },
  )
}

export async function scheduleSpotPreemption(queue: Queue): Promise<void> {
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key)
  }
  await queue.add('tick', {}, { repeat: { every: TICK_INTERVAL_MS } })
}

// ---------------------------------------------------------------------------
// Core preemption logic — exported for tests / manual triggers
// ---------------------------------------------------------------------------

export async function runSpotPreemptionTick(
  prisma: PrismaClient,
  io: SocketServer,
): Promise<void> {
  const now = new Date()

  // Phase 1: terminate any SPOT rentals whose 90s grace has elapsed.
  await terminateGracedRentals(prisma, io, now)

  // Phase 2: detect new demand pressure and schedule preemptions.
  await scheduleNewPreemptions(prisma, io, now)
}

// Phase 1: hard cutoff — any SPOT rental with adminNote indicating a
// preemption-scheduled time in the past gets terminated now. We use
// adminNote as the carrier (no schema change needed) with a JSON-style
// marker the worker can parse: 'PREEMPT_AT:<iso-timestamp>'.
async function terminateGracedRentals(
  prisma: PrismaClient,
  io: SocketServer,
  now: Date,
): Promise<void> {
  const cutoffMarker = `PREEMPT_AT:`
  const candidates = await prisma.computeRequest.findMany({
    where: {
      status: 'ACTIVE',
      tier: 'SPOT',
      adminNote: { startsWith: cutoffMarker },
    },
    select: {
      id: true,
      userId: true,
      gpuTier: true,
      gpuCount: true,
      ratePerMinute: true,
      activatedAt: true,
      totalCost: true,
      durationDays: true,
      adminNote: true,
      allocatedNodeIds: true,
      // Drives refund routing: INTERNAL_BALANCE rebates the
      // InternalSpend ledger row; USDC routes through Solana.
      paymentSource: true,
    },
  })

  for (const cr of candidates) {
    if (!cr.adminNote) continue
    const isoMatch = cr.adminNote.slice(cutoffMarker.length).split('|')[0]
    const preemptAt = isoMatch ? new Date(isoMatch) : null
    if (!preemptAt || Number.isNaN(preemptAt.getTime())) continue
    if (preemptAt > now) continue // still in grace window

    // SECURITY (2026-06-11 fourth-round audit): atomic claim ACTIVE
    // -> TERMINATING before computing refund / calling processPayment.
    // Two preemption ticks could otherwise process the same SPOT
    // rental, each call processPayment, drain N times. Same TOCTOU
    // shape as the terminate route (which was the original drain
    // vector). Mirrors that fix.
    const claimed = await prisma.computeRequest.updateMany({
      where: { id: cr.id, status: 'ACTIVE' },
      data: { status: 'TERMINATING' },
    })
    if (claimed.count === 0) {
      // Another preemption tick beat us to it. Skip; the winner
      // is responsible for refund + status finalization.
      continue
    }

    // Compute final accrual + refund
    const ratePerMinute = cr.ratePerMinute ?? (cr.totalCost / cr.durationDays / 24 / 60)
    const elapsedMs = cr.activatedAt ? now.getTime() - cr.activatedAt.getTime() : 0
    const elapsedMinutes = Math.floor(elapsedMs / 60000)
    const maxMinutes = cr.durationDays * 24 * 60
    const finalMinutes = Math.min(elapsedMinutes, maxMinutes)
    const finalAccrued = Math.min(
      Number((finalMinutes * ratePerMinute).toFixed(4)),
      cr.totalCost,
    )
    const refundAmount = Math.max(0, Number((cr.totalCost - finalAccrued).toFixed(4)))

    // Issue the refund BEFORE flipping status to COMPLETED. Two reasons:
    //   1. INTERNAL_BALANCE rebate just updates a row, so it composes
    //      naturally with the transaction below.
    //   2. USDC refund is an external Solana hop. If it fails we still
    //      want the rental released (so the node returns to the idle
    //      pool and ON_DEMAND demand gets served), but the failure
    //      reason needs to land in adminNote so admin can manually
    //      reconcile.
    let refundStatus:
      | 'SENT'
      | 'INTERNAL_REBATED'
      | 'SKIPPED_NO_WALLET'
      | 'SKIPPED_ZERO'
      | 'FAILED' = 'SKIPPED_ZERO'
    let refundTxHash: string | null = null
    let refundError: string | null = null

    if (refundAmount <= 0) {
      refundStatus = 'SKIPPED_ZERO'
    } else if (cr.paymentSource === 'INTERNAL_BALANCE') {
      try {
        await prisma.internalSpend.update({
          where: { computeRequestId: cr.id },
          data: { amount: finalAccrued },
        })
        refundStatus = 'INTERNAL_REBATED'
      } catch (err) {
        refundStatus = 'FAILED'
        refundError = err instanceof Error ? err.message : 'InternalSpend rebate failed'
        // eslint-disable-next-line no-console
        console.error(`[spot-preemption] InternalSpend rebate failed for ${cr.id}:`, err)
      }
    } else {
      // USDC path — refund to the buyer's saved wallet if one exists.
      const user = await prisma.user.findUnique({
        where: { id: cr.userId },
        select: { walletAddress: true },
      })
      if (!user?.walletAddress) {
        refundStatus = 'SKIPPED_NO_WALLET'
      } else {
        try {
          const solanaConfig = await getSolanaConfig(prisma)
          const result = await processPayment(solanaConfig, user.walletAddress, refundAmount, 'USDC')
          if (result.success && result.txHash) {
            refundTxHash = result.txHash
            refundStatus = 'SENT'
          } else {
            refundStatus = 'FAILED'
            refundError = result.error ?? 'Unknown payment failure'
          }
        } catch (err) {
          refundStatus = 'FAILED'
          refundError = err instanceof Error ? err.message : 'Refund processing error'
          // eslint-disable-next-line no-console
          console.error(`[spot-preemption] USDC refund failed for ${cr.id}:`, err)
        }
      }
    }

    // Build a single-line adminNote that captures everything the next
    // admin (or post-mortem reader) needs to know about this preemption.
    const noteParts = [
      `Preempted: capacity needed for ON_DEMAND traffic.`,
      `Refund $${refundAmount.toFixed(2)} for ${maxMinutes - finalMinutes} unused minutes.`,
      `Status: ${refundStatus}.`,
    ]
    if (refundTxHash) noteParts.push(`TX: ${refundTxHash}.`)
    if (refundError) noteParts.push(`Error: ${refundError}.`)

    const result = await prisma.$transaction(async tx => {
      // We claimed the row to TERMINATING above, so finalize from
      // TERMINATING -> COMPLETED. The status guard prevents a third
      // party from racing the finalization.
      const updated = await tx.computeRequest.updateMany({
        where: { id: cr.id, status: 'TERMINATING' },
        data: {
          status: 'COMPLETED',
          completedAt: now,
          minutesUsed: finalMinutes,
          accruedCost: finalAccrued,
          sshSessionToken: null,
          sshSessionTokenExpiresAt: null,
          adminNote: noteParts.join(' '),
        },
      })
      if (updated.count === 0) return false

      if (cr.allocatedNodeIds.length > 0) {
        await tx.node.updateMany({
          where: { id: { in: cr.allocatedNodeIds } },
          data: { assignedComputeRequestId: null },
        })
      }
      return true
    })

    if (!result) continue

    // Phrase the buyer notification per actual refund outcome so we
    // don't promise something that didn't happen (the old code said
    // "processed" regardless).
    const buyerMessage = (() => {
      const prefix = `Your ${cr.gpuCount}x ${cr.gpuTier} SPOT rental was preempted to free capacity for On-Demand demand.`
      if (refundStatus === 'SENT') {
        return `${prefix} Refund of $${refundAmount.toFixed(2)} sent to your wallet.`
      }
      if (refundStatus === 'INTERNAL_REBATED') {
        return `${prefix} $${refundAmount.toFixed(2)} credited back to your operator balance for unused minutes.`
      }
      if (refundStatus === 'SKIPPED_NO_WALLET') {
        return `${prefix} Add a wallet address in settings to receive future refunds.`
      }
      if (refundStatus === 'FAILED') {
        return `${prefix} Refund of $${refundAmount.toFixed(2)} failed — admin notified.`
      }
      return `${prefix} No unused minutes to refund.`
    })()

    void createNotification(
      cr.userId,
      'COMPUTE_COMPLETED',
      'SPOT Rental Preempted',
      buyerMessage,
      `/buyer/requests/${cr.id}`,
    )

    io.emit('compute:terminated', {
      requestId: cr.id,
      userId: cr.userId,
      gpuTier: cr.gpuTier,
      gpuCount: cr.gpuCount,
      finalMinutes,
      finalAccrued,
      refundAmount,
      refundStatus: refundStatus === 'SENT' || refundStatus === 'INTERNAL_REBATED'
        ? 'PREEMPTED'
        : `PREEMPTED_${refundStatus}`,
      refundTxHash,
      timestamp: now.toISOString(),
    })

    // eslint-disable-next-line no-console
    console.log(
      `[spot-preemption] terminated ${cr.id} (${cr.gpuCount}x ${cr.gpuTier}) ` +
        `after grace; refund $${refundAmount} status=${refundStatus}`,
    )
  }
}

// Phase 2: scan for tier-pressure scenarios and schedule preemptions on
// the most-eligible SPOT victims (longest-running first).
async function scheduleNewPreemptions(
  prisma: PrismaClient,
  io: SocketServer,
  now: Date,
): Promise<void> {
  // Find all PENDING+txConfirmed ON_DEMAND requests waiting on capacity
  const waitingOnDemand = await prisma.computeRequest.findMany({
    where: {
      status: 'PENDING',
      txConfirmed: true,
      tier: 'ON_DEMAND',
    },
    select: { id: true, gpuTier: true, gpuCount: true },
  })

  if (waitingOnDemand.length === 0) return

  // Group needed capacity by tier
  const neededByTier: Map<GpuTier, number> = new Map()
  for (const req of waitingOnDemand) {
    neededByTier.set(req.gpuTier, (neededByTier.get(req.gpuTier) ?? 0) + req.gpuCount)
  }

  // For each tier with demand, count idle ONLINE nodes of that tier
  // and decide whether preemption is needed.
  for (const [tier, needed] of neededByTier.entries()) {
    const idleCount = await prisma.node.count({
      where: {
        gpuTier: tier,
        status: 'ONLINE',
        currentJobId: null,
        assignedComputeRequestId: null,
        pendingDeletion: false,
        agentVersion: { not: null },
        lastHeartbeat: { gte: new Date(now.getTime() - HEARTBEAT_FRESH_MS) },
      },
    })

    const shortfall = needed - idleCount
    if (shortfall <= 0) continue

    // Find SPOT rentals on this tier, NOT already preemption-scheduled,
    // sorted by longest-running first (oldest activatedAt).
    //
    // Prisma null-handling note: a naive `adminNote: { not: { startsWith }}}`
    // translates to NOT (col LIKE 'X%'), which evaluates to FALSE for
    // NULL values — so SPOT rentals with no adminNote (the common case)
    // would be excluded. We need OR(adminNote IS NULL, adminNote NOT LIKE).
    const victims = await prisma.computeRequest.findMany({
      where: {
        status: 'ACTIVE',
        tier: 'SPOT',
        gpuTier: tier,
        OR: [
          { adminNote: null },
          { adminNote: { not: { startsWith: 'PREEMPT_AT:' } } },
        ],
      },
      orderBy: { activatedAt: 'asc' },
      take: shortfall,
      select: {
        id: true,
        userId: true,
        gpuTier: true,
        gpuCount: true,
      },
    })

    // Schedule preemption (write the marker, fire the WS event).
    const preemptAt = new Date(now.getTime() + PREEMPTION_GRACE_MS)
    for (const victim of victims) {
      const result = await prisma.computeRequest.updateMany({
        where: {
          id: victim.id,
          status: 'ACTIVE',
          // Same null-handling fix as the victim query above.
          OR: [
            { adminNote: null },
            { adminNote: { not: { startsWith: 'PREEMPT_AT:' } } },
          ],
        },
        data: {
          adminNote: `PREEMPT_AT:${preemptAt.toISOString()}|reason=ON_DEMAND_PRESSURE`,
        },
      })
      if (result.count === 0) continue

      void createNotification(
        victim.userId,
        'COMPUTE_EXPIRING',
        'SPOT Preemption Notice',
        `Your ${victim.gpuCount}x ${victim.gpuTier} SPOT rental will be preempted in ` +
          `${Math.round(PREEMPTION_GRACE_MS / 1000)}s to free capacity for On-Demand demand. ` +
          `Save your work now. Unused minutes will be refunded.`,
        `/buyer/requests/${victim.id}`,
      )

      io.emit('compute:preemption-notice', {
        requestId: victim.id,
        userId: victim.userId,
        gpuTier: victim.gpuTier,
        gpuCount: victim.gpuCount,
        preemptAt: preemptAt.toISOString(),
        graceMs: PREEMPTION_GRACE_MS,
        reason: 'ON_DEMAND_PRESSURE',
        timestamp: now.toISOString(),
      })

      // eslint-disable-next-line no-console
      console.log(
        `[spot-preemption] scheduled ${victim.id} (${victim.gpuCount}x ${victim.gpuTier}) ` +
          `for preemption at ${preemptAt.toISOString()} (90s grace)`,
      )
    }
  }
}
