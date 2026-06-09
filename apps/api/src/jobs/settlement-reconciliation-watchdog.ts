/**
 * Settlement reconciliation watchdog.
 *
 * Pen-test 2026-06-09 finding B-3: settlements were being marked
 * COMPLETED with txConfirmed=false at the time of submission, on the
 * assumption that the reconciler would later flip txConfirmed=true
 * once the chain finalized. The reconciler only operates on
 * PendingReconciliation rows, which Patch B-4 now creates atomically
 * with the settlement update. But a malformed/never-confirmed txHash
 * (or a reconciler outage long enough for the chain history to age
 * out) leaves a settlement permanently in COMPLETED + unverified.
 * Pen tester demonstrated this gives the auto-payout path an
 * "always-true on the books" status the operator-manual withdrawal
 * audit cannot distinguish from a real payment.
 *
 * This watchdog runs every 15 minutes and:
 *
 *   1. Finds settlements with status='COMPLETED' AND txConfirmed=false
 *      that are older than the grace period (default 60 minutes).
 *   2. For each, checks if its PendingReconciliation row has resolved
 *      to VERIFIED, FAILED, or NOT_FOUND:
 *        - VERIFIED: writes txConfirmed=true on the Settlement (closes
 *          the gap if the reconciler updated PendingReconciliation but
 *          missed propagating to Settlement).
 *        - FAILED or NOT_FOUND: demotes the Settlement back to FAILED
 *          with errorMessage="reconciliation_failed:<reason>". The
 *          operator's earnings become withdrawable again on next tick.
 *        - Still PENDING after the grace period: emits a metric/log
 *          alert and leaves the row alone (the reconciler is supposed
 *          to be retrying with exponential backoff).
 *   3. If the Settlement has NO PendingReconciliation row at all
 *      (shouldn't happen post-B-4 but defensive): demotes immediately.
 *
 * Why not just trust the reconciler? Because the reconciler can fail
 * silently (Solana RPC down, BullMQ worker crash, Redis outage) and
 * the existing settlement.txConfirmed=false state was unobservable.
 * This watchdog is the second layer that makes the silent failure
 * loud and reversible.
 *
 * Tuning:
 *   SETTLEMENT_WATCHDOG_INTERVAL_MS — tick cadence, default 900_000 (15min)
 *   SETTLEMENT_WATCHDOG_GRACE_MS    — age before action, default 3_600_000 (60min)
 *
 * The 60-minute grace is generous on purpose: it covers the full
 * 1+5+15+60 minute reconciler backoff envelope (81 min total, but
 * the first three attempts complete by ~21 min).
 */

import { Queue, Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { PrismaClient } from '@a2e/database'

const QUEUE_NAME = 'settlement-reconciliation-watchdog'

const TICK_INTERVAL_MS = parseInt(
  process.env.SETTLEMENT_WATCHDOG_INTERVAL_MS ?? `${15 * 60 * 1000}`,
  10,
)

const GRACE_MS = parseInt(
  process.env.SETTLEMENT_WATCHDOG_GRACE_MS ?? `${60 * 60 * 1000}`,
  10,
)

interface WatchdogDeps {
  redis: ConnectionOptions
  prisma: PrismaClient
}

export function createSettlementReconciliationWatchdogQueue(
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

export function createSettlementReconciliationWatchdogWorker(
  deps: WatchdogDeps,
): Worker {
  return new Worker(
    QUEUE_NAME,
    async () => {
      await runSettlementReconciliationWatchdogTick(deps.prisma)
    },
    {
      connection: deps.redis,
      concurrency: 1,
    },
  )
}

export async function scheduleSettlementReconciliationWatchdog(
  queue: Queue,
): Promise<void> {
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key)
  }
  await queue.add('tick', {}, { repeat: { every: TICK_INTERVAL_MS } })
}

export interface WatchdogSummary {
  scanned: number
  confirmedFromVerified: number
  demotedFromFailed: number
  demotedFromNotFound: number
  demotedNoReconciliationRow: number
  stillPending: number
  errors: Array<{ settlementId: string; reason: string }>
}

export async function runSettlementReconciliationWatchdogTick(
  prisma: PrismaClient,
): Promise<WatchdogSummary> {
  const summary: WatchdogSummary = {
    scanned: 0,
    confirmedFromVerified: 0,
    demotedFromFailed: 0,
    demotedFromNotFound: 0,
    demotedNoReconciliationRow: 0,
    stillPending: 0,
    errors: [],
  }

  const cutoff = new Date(Date.now() - GRACE_MS)

  // Find settlements that say "completed" but have never been
  // confirmed on-chain AND are old enough that the chain should have
  // finalized by now.
  const stale = await prisma.settlement.findMany({
    where: {
      status: 'COMPLETED',
      txConfirmed: false,
      processedAt: { lt: cutoff },
    },
    select: {
      id: true,
      txHash: true,
      processedAt: true,
    },
    take: 200,
  })

  summary.scanned = stale.length
  if (stale.length === 0) {
    return summary
  }

  for (const settlement of stale) {
    try {
      // Look up the reconciliation row for this settlement. With B-4 in
      // place, every settlement has one. Defensive fallback: if missing,
      // demote (we have no way to verify and the grace already elapsed).
      const recon = await prisma.pendingReconciliation.findFirst({
        where: { settlementId: settlement.id },
        orderBy: { createdAt: 'desc' },
      })

      if (!recon) {
        await prisma.settlement.update({
          where: { id: settlement.id },
          data: {
            status: 'FAILED',
            errorMessage: 'reconciliation_missing:no_pending_row_after_grace',
            processedAt: new Date(),
          },
        })
        summary.demotedNoReconciliationRow++
        continue
      }

      if (recon.status === 'VERIFIED') {
        // Reconciler verified the tx but never flipped txConfirmed on
        // the Settlement (or did, and we're seeing a stale read). Close
        // the loop by writing txConfirmed=true here.
        await prisma.settlement.update({
          where: { id: settlement.id },
          data: { txConfirmed: true },
        })
        summary.confirmedFromVerified++
        continue
      }

      if (recon.status === 'FAILED') {
        await prisma.settlement.update({
          where: { id: settlement.id },
          data: {
            status: 'FAILED',
            errorMessage: `reconciliation_failed:${recon.errorMessage ?? 'unknown'}`,
            processedAt: new Date(),
          },
        })
        summary.demotedFromFailed++
        continue
      }

      if (recon.status === 'NOT_FOUND') {
        await prisma.settlement.update({
          where: { id: settlement.id },
          data: {
            status: 'FAILED',
            errorMessage:
              'reconciliation_not_found:tx_never_finalized_within_attempts',
            processedAt: new Date(),
          },
        })
        summary.demotedFromNotFound++
        continue
      }

      // Reconciliation is still PENDING. Leave the Settlement alone but
      // log so an operator sees stuck reconciliation accumulating.
      summary.stillPending++
    } catch (err) {
      summary.errors.push({
        settlementId: settlement.id,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[settlement-watchdog] scanned=${summary.scanned}`
      + ` confirmed=${summary.confirmedFromVerified}`
      + ` demoted_failed=${summary.demotedFromFailed}`
      + ` demoted_notfound=${summary.demotedFromNotFound}`
      + ` demoted_orphan=${summary.demotedNoReconciliationRow}`
      + ` still_pending=${summary.stillPending}`
      + ` errors=${summary.errors.length}`,
  )

  return summary
}
