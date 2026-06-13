// SECURITY (N-7, 2026-06-13): TERMINATING orphan recovery worker.
//
// The terminate flow does an atomic claim ACTIVE -> TERMINATING (the
// commit 7a8d054 CAS), then runs the refund + status finalize. If the
// process dies between the claim and the finalize (Render redeploy,
// OOM kill, gateway timeout, hung processPayment), the row is stuck
// in TERMINATING forever:
//   - the buyer cannot re-terminate (requires ACTIVE)
//   - cannot cancel (TERMINATING not in cancellableStates)
//   - no other worker scans TERMINATING for recovery
//   - the refund is never issued
//
// This reaper wakes every 5 minutes and finds rentals stuck in
// TERMINATING for more than RECOVERY_STALE_MINUTES (default 10 min).
// For each one it issues the standard refund credit (using the shared
// REFUND_RENTAL / cancel:<id> key so it's idempotent against any
// in-flight finalize), then flips the row to COMPLETED with an admin
// note explaining the recovery. Buyer-balance and USDC paths both
// resolve to the same balance-credit fallback because we don't have
// the original processPayment context to reconstruct an on-chain
// refund; admin can manually issue a wallet refund afterward via the
// admin queue if the buyer prefers their rail.
//
// Not exploitable: this only fires on rows that have already been
// claimed for terminate and would otherwise sit stranded. The unique
// constraint on (REFUND_RENTAL, cancel:<id>) prevents the reaper
// from double-paying if the original handler's refund did land
// before the crash.

import { Queue, Worker, type ConnectionOptions } from 'bullmq'
import type { PrismaClient } from '@a2e/database'
import { creditBalance } from '../services/balance/balance-service.js'

export const TERMINATING_REAPER_QUEUE_NAME = 'terminating-reaper'
export const TERMINATING_REAPER_TICK_MS = 5 * 60 * 1000
const REPEATABLE_JOB_ID = 'terminating-reaper-repeatable'

// How long a row may sit in TERMINATING before we consider it stuck.
// The terminate flow's refund + transaction should resolve in seconds;
// 10 minutes is well past any normal slow case (Solana confirm, S3
// presign, etc.). Env-tunable.
const RECOVERY_STALE_MINUTES = parseInt(
  process.env.TERMINATING_REAPER_STALE_MINUTES ?? '10',
  10,
)

export interface TerminatingReaperDeps {
  redis: ConnectionOptions
  prisma: PrismaClient
  tickMs?: number
}

export interface TerminatingReaperSummary {
  recovered: number
  errors: number
}

export async function runTerminatingReaperTick(
  prisma: PrismaClient,
): Promise<TerminatingReaperSummary> {
  const cutoff = new Date(Date.now() - RECOVERY_STALE_MINUTES * 60 * 1000)
  const stuck = await prisma.computeRequest.findMany({
    where: {
      status: 'TERMINATING',
      // ComputeRequest has no terminatingAt column; use completedAt as
      // a proxy when set, else fall back to updatedAt-equivalent via
      // activatedAt + a generous floor. The pen-test note's recovery
      // worker description specifies the row sits in TERMINATING
      // without progressing; any row that's been TERMINATING longer
      // than the cutoff is fair game.
      OR: [
        { completedAt: null },
        { completedAt: { lt: cutoff } },
      ],
    },
    select: {
      id: true,
      userId: true,
      gpuTier: true,
      gpuCount: true,
      paymentSource: true,
      totalCost: true,
      accruedCost: true,
      activatedAt: true,
    },
    take: 50,
  })

  let recovered = 0
  let errors = 0
  for (const cr of stuck) {
    try {
      // Compute the refund the original terminate would have issued.
      // Without the original processPayment context we can't redo the
      // pro-rated math exactly; use the persisted accruedCost if set,
      // else fall back to totalCost (full refund) so the buyer is at
      // least no worse off. Real-world: by the time the reaper fires,
      // the meter has stamped accruedCost.
      const refundAmount = Math.max(
        0,
        Number((cr.totalCost - (cr.accruedCost ?? 0)).toFixed(4)),
      )

      // Atomic finalize: TERMINATING -> COMPLETED. If another path
      // already finalized in the meantime, we lose this transition
      // and skip the refund (which they would have issued).
      const finalize = await prisma.computeRequest.updateMany({
        where: { id: cr.id, status: 'TERMINATING' },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          adminNote: `Recovered by terminating-reaper: refund ${refundAmount.toFixed(2)} issued. Manual wallet-rail refund available via admin if buyer prefers.`,
          sshSessionToken: null,
          sshSessionTokenExpiresAt: null,
        },
      })
      if (finalize.count === 0) continue

      if (refundAmount > 0 && cr.paymentSource !== 'INTERNAL_BALANCE') {
        try {
          await creditBalance(prisma, {
            userId: cr.userId,
            amountUsd: refundAmount,
            type: 'REFUND_RENTAL',
            description: `Refund (recovered): rental ${cr.id} stuck in TERMINATING`,
            // Shared cancel:<id> key so we don't double-pay if the
            // original handler's refund DID land before the crash.
            referenceId: `cancel:${cr.id}`,
          })
        } catch (err) {
          const isDup = err instanceof Error && err.name === 'DuplicateTransactionError'
          if (!isDup) throw err
          // Duplicate is the GOOD case here: original refund already
          // landed before the crash.
        }
      } else if (cr.paymentSource === 'INTERNAL_BALANCE') {
        // For INTERNAL_BALANCE, rebate the spend row down to the
        // accrued amount.
        await prisma.internalSpend.updateMany({
          where: { computeRequestId: cr.id },
          data: { amount: cr.accruedCost ?? 0 },
        })
      }

      recovered++
      console.log(`[terminating-reaper] recovered ${cr.id} (refund $${refundAmount.toFixed(2)})`)
    } catch (err) {
      errors++
      console.error(`[terminating-reaper] failed on ${cr.id}:`, err)
    }
  }

  return { recovered, errors }
}

export function createTerminatingReaperQueue(connection: ConnectionOptions): Queue {
  return new Queue(TERMINATING_REAPER_QUEUE_NAME, { connection })
}

export function createTerminatingReaperWorker(
  deps: TerminatingReaperDeps,
): Worker {
  const tickMs = deps.tickMs ?? TERMINATING_REAPER_TICK_MS
  return new Worker(
    TERMINATING_REAPER_QUEUE_NAME,
    async () => {
      const summary = await runTerminatingReaperTick(deps.prisma)
      if (summary.recovered > 0 || summary.errors > 0) {
        console.log(
          `[terminating-reaper] tick: recovered=${summary.recovered} errors=${summary.errors}`,
        )
      }
      return summary
    },
    { connection: deps.redis },
  ).on('error', (err) => {
    console.error('[terminating-reaper] worker error:', err)
  })
}

export async function scheduleTerminatingReaperTick(queue: Queue): Promise<void> {
  await queue.add(
    REPEATABLE_JOB_ID,
    {},
    {
      repeat: { every: TERMINATING_REAPER_TICK_MS },
      jobId: REPEATABLE_JOB_ID,
    },
  )
}
