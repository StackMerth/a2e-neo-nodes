/**
 * M5.7 / D2: referral commission worker (daily).
 *
 * For every ACTIVE Referral that hasn't expired, sum the referee's
 * earnings since `lastSettledAt` (or `createdAt` on first tick) and
 * accrue `REFERRAL_COMMISSION_PCT` (default 10%) of that sum onto the
 * referrer's `totalCommissionAccrued`. Stamp `lastSettledAt = now`.
 *
 * On the same pass, transition any Referral whose `expiresAt` has
 * passed from ACTIVE -> EXPIRED so it stops accruing.
 *
 * Why daily and not realtime:
 *   - Operator earnings are themselves rolled up per day via the
 *     existing Earning model. Computing commission on the daily roll is
 *     the simplest reconciliation point.
 *   - Per-minute or per-rental tick would generate huge worker pressure
 *     for a feature that only meaningfully affects monthly payout
 *     totals.
 *
 * Anti-abuse (not in this worker, lives elsewhere):
 *   - Commission cap per referrer per year is enforced at PAYOUT time
 *     by the settlement engine, not here. The worker accrues honestly;
 *     payout decides what to actually pay.
 *   - Sock-puppet detection (IP + wallet fingerprint at signup) lives
 *     in the attribution service, not here.
 */

import { Queue, Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { PrismaClient } from '@a2e/database'

const QUEUE_NAME = 'referral-commission'
const TICK_INTERVAL_MS = parseInt(
  process.env.REFERRAL_COMMISSION_TICK_MS ?? `${24 * 60 * 60 * 1000}`,
  10,
)
const COMMISSION_PCT = parseFloat(process.env.REFERRAL_COMMISSION_PCT ?? '0.10')

interface CommissionDeps {
  redis: ConnectionOptions
  prisma: PrismaClient
}

export function createReferralCommissionQueue(connection: ConnectionOptions): Queue {
  return new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 30 },
      removeOnFail: { count: 100 },
    },
  })
}

export function createReferralCommissionWorker(deps: CommissionDeps): Worker {
  return new Worker(
    QUEUE_NAME,
    async () => {
      await runReferralCommissionTick(deps.prisma)
    },
    {
      connection: deps.redis,
      concurrency: 1,
    },
  )
}

export async function scheduleReferralCommission(queue: Queue): Promise<void> {
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key)
  }
  await queue.add('tick', {}, { repeat: { every: TICK_INTERVAL_MS } })
}

export async function runReferralCommissionTick(prisma: PrismaClient): Promise<void> {
  const now = new Date()

  // Phase 1: expire any ACTIVE referrals whose window has elapsed.
  // Single bulk update; the worker on the next tick will skip them.
  const expired = await prisma.referral.updateMany({
    where: {
      status: 'ACTIVE',
      expiresAt: { lte: now },
    },
    data: { status: 'EXPIRED' },
  })

  // Phase 2: accrue commission on every still-ACTIVE referral.
  const active = await prisma.referral.findMany({
    where: { status: 'ACTIVE' },
    select: {
      id: true,
      refereeNodeRunnerId: true,
      lastSettledAt: true,
      createdAt: true,
      totalCommissionAccrued: true,
    },
  })

  let totalRowsTouched = 0
  let totalCommissionAdded = 0

  for (const r of active) {
    const periodStart = r.lastSettledAt ?? r.createdAt
    // findMany + reduce keeps the math obvious; for our sizes this is
    // a handful of rows per referee, so the query is cheap.
    const earningsRows = await prisma.earning.findMany({
      where: {
        date: { gte: periodStart, lt: now },
        node: { nodeRunnerId: r.refereeNodeRunnerId },
      },
      select: { earnings: true },
    })
    const refereeEarnings = earningsRows.reduce((sum, row) => sum + row.earnings, 0)
    if (refereeEarnings <= 0) {
      // Nothing earned in the window; still bump lastSettledAt so we
      // don't re-scan the same period forever.
      await prisma.referral.update({
        where: { id: r.id },
        data: { lastSettledAt: now },
      })
      continue
    }

    const commission = Number((refereeEarnings * COMMISSION_PCT).toFixed(4))
    await prisma.referral.update({
      where: { id: r.id },
      data: {
        totalCommissionAccrued: r.totalCommissionAccrued + commission,
        lastSettledAt: now,
      },
    })
    totalRowsTouched += 1
    totalCommissionAdded += commission
  }

  // eslint-disable-next-line no-console
  console.log(
    `[referral-commission] expired=${expired.count} accruedRows=${totalRowsTouched} ` +
      `commissionAdded=$${totalCommissionAdded.toFixed(2)}`,
  )
}
