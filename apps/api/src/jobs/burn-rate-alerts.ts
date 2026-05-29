/**
 * Track 5 / 3.A — burn-rate alerts.
 *
 * Watches inference spend per buyer and fires a notification when
 * the last-hour spend exceeds 2x their 7-day rolling hourly average.
 * The threshold catches both runaway scripts (loop hammering an
 * expensive model) and successful demos that quietly burn through
 * a buyer's prepaid credit before they notice.
 *
 * Why not real-time at meter call time: a one-off expensive call
 * isn't a "burn rate" — it's a single expensive call. Burn rate is
 * a rate, so it only makes sense over a window. Hourly window is
 * the right granularity: short enough to catch a problem before the
 * buyer's balance is gone, long enough that single calls don't
 * trigger false positives.
 *
 * Cadence: every 30 minutes. Each tick scans buyers with any usage
 * in the last hour, computes (sum / sum-7d / 168) and fires when the
 * ratio crosses 2x. Dedup: each (userId, period-bucket) only alerts
 * once via the BURN_RATE_ALERT notification's natural dedup at the
 * notification service.
 *
 * Cost: this is a tight aggregation query (indexed on userId +
 * createdAt) over rows already in cache from the previous tick. Even
 * at 10K active buyers it's a single scan in ~ms.
 */

import { Queue, Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { PrismaClient } from '@a2e/database'
import { createNotification } from '../services/notification/service.js'

const QUEUE_NAME = 'burn-rate-alerts'

// Default: every 30 minutes. Override via env for tests.
const TICK_INTERVAL_MS = parseInt(
  process.env.BURN_RATE_ALERTS_INTERVAL_MS ?? `${30 * 60 * 1000}`,
  10,
)

// Threshold ratio: current hour spend / 7-day hourly average. 2.0
// = "twice the normal rate." Tunable via env so we can dial it
// down if we get false-positive complaints, or up if we get
// missed-burn complaints.
const BURN_RATIO_THRESHOLD = parseFloat(
  process.env.BURN_RATE_ALERTS_RATIO ?? '2.0',
)

// Minimum baseline below which we don't bother alerting — avoids
// "1c/hour vs 5c/hour" false positives for buyers who normally
// don't spend anything. $0.50 / hour is a reasonable signal floor;
// below that, a 10x ratio is still trivial money.
const MIN_BASELINE_USD_PER_HOUR = parseFloat(
  process.env.BURN_RATE_ALERTS_MIN_BASELINE ?? '0.50',
)

interface BurnRateDeps {
  redis: ConnectionOptions
  prisma: PrismaClient
}

export function createBurnRateAlertsQueue(connection: ConnectionOptions): Queue {
  return new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    },
  })
}

export function createBurnRateAlertsWorker(deps: BurnRateDeps): Worker {
  return new Worker(
    QUEUE_NAME,
    async () => {
      await runBurnRateTick(deps.prisma)
    },
    {
      connection: deps.redis,
      concurrency: 1,
    },
  )
}

export async function scheduleBurnRateAlerts(queue: Queue): Promise<void> {
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key)
  }
  await queue.add('tick', {}, { repeat: { every: TICK_INTERVAL_MS } })
}

// ---------------------------------------------------------------------------
// Core tick — exported for tests
// ---------------------------------------------------------------------------

export async function runBurnRateTick(prisma: PrismaClient): Promise<void> {
  const now = Date.now()
  const oneHourAgo = new Date(now - 60 * 60 * 1000)
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000)

  // Step 1: per-user last-hour spend. groupBy keeps this cheap.
  const lastHour = await prisma.tokenUsage.groupBy({
    by: ['userId'],
    where: { createdAt: { gte: oneHourAgo } },
    _sum: { costUsd: true },
  })

  if (lastHour.length === 0) return // nobody burning anything, fast path

  const userIds = lastHour.map(r => r.userId)

  // Step 2: per-user 7-day spend for the same users (no point
  // querying users with zero recent activity).
  const sevenDay = await prisma.tokenUsage.groupBy({
    by: ['userId'],
    where: {
      userId: { in: userIds },
      createdAt: { gte: sevenDaysAgo },
    },
    _sum: { costUsd: true },
  })
  const sevenDayMap = new Map(sevenDay.map(r => [r.userId, r._sum.costUsd ?? 0]))

  // Step 3: per-user evaluate and fire.
  for (const r of lastHour) {
    const lastHourUsd = r._sum.costUsd ?? 0
    const sevenDayUsd = sevenDayMap.get(r.userId) ?? 0
    // 168 hours per 7 days. If the buyer has < 7 days of history,
    // this still produces a usable baseline — the comparison just
    // gets noisier, and the MIN_BASELINE check below filters out
    // the truly silly cases.
    const baselineUsdPerHour = sevenDayUsd / 168
    if (baselineUsdPerHour < MIN_BASELINE_USD_PER_HOUR) continue

    const ratio = lastHourUsd / baselineUsdPerHour
    if (ratio < BURN_RATIO_THRESHOLD) continue

    // Fire the alert. The notification service handles its own
    // dedup so re-firing the same alert within a short window is a
    // no-op (per the existing pattern on NODE_OFFLINE etc.).
    void createNotification(
      r.userId,
      'BURN_RATE_ALERT',
      'Inference spend spike',
      `Your last hour's inference spend is $${lastHourUsd.toFixed(2)} — about ${ratio.toFixed(1)}x your normal hourly rate of $${baselineUsdPerHour.toFixed(2)}. Check your API key usage if this wasn't expected.`,
      '/buyer/inference',
    )
  }
}
