/**
 * Track 5 / 3.A — daily usage aggregator.
 *
 * The meter writes one TokenUsage row per inference call (and debits
 * the buyer's balance live). The aggregator is the periodic process
 * that rolls those raw rows up into Invoice line items so the buyer
 * has a monthly statement they can audit, dispute, or export.
 *
 * Why a separate process: keeping the meter hot-path lightweight
 * matters — every call already does a pricing lookup + ledger debit
 * + usage insert in one transaction. Adding an UPSERT into Invoice
 * on the same path would slow it noticeably. The aggregator runs in
 * the background, rebuilds the invoice for the current period from
 * scratch each tick, and upserts the row. Idempotent + simple.
 *
 * Cadence: daily at ~01:00 UTC. Falls inside the dead zone after
 * UTC midnight when the current day's usage is closed but the
 * previous day's metering has fully settled. Each tick rebuilds the
 * current month's invoice (DRAFT status while the month is open;
 * flipped to FINALIZED on the first tick of the next month).
 *
 * The same daily tick also feeds the burn-rate alert worker via a
 * Redis publish — but that lives in burn-rate-alerts.ts to keep
 * single-responsibility per worker.
 */

import { Queue, Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { PrismaClient } from '@a2e/database'

const QUEUE_NAME = 'usage-aggregator'

// Default: every 24h. Override with USAGE_AGGREGATOR_INTERVAL_MS for
// faster testing (e.g. 5 minutes during local dev). Production keeps
// the 24h tick.
const TICK_INTERVAL_MS = parseInt(
  process.env.USAGE_AGGREGATOR_INTERVAL_MS ?? `${24 * 60 * 60 * 1000}`,
  10,
)

interface AggregatorDeps {
  redis: ConnectionOptions
  prisma: PrismaClient
}

export function createUsageAggregatorQueue(connection: ConnectionOptions): Queue {
  return new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1, // tick again tomorrow if today fails — no retry storm
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    },
  })
}

export function createUsageAggregatorWorker(deps: AggregatorDeps): Worker {
  return new Worker(
    QUEUE_NAME,
    async () => {
      await runAggregatorTick(deps.prisma)
    },
    {
      connection: deps.redis,
      concurrency: 1, // single-flight — no point running two roll-ups at once
    },
  )
}

export async function scheduleUsageAggregator(queue: Queue): Promise<void> {
  // Clear any prior repeatable so we don't accumulate them across
  // deploys; matches the pattern used by every other worker in the
  // codebase.
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key)
  }
  await queue.add('tick', {}, { repeat: { every: TICK_INTERVAL_MS } })
}

// ---------------------------------------------------------------------------
// Core tick — exported for tests
// ---------------------------------------------------------------------------

interface ModelLineItem {
  model: string
  inputTokens: number
  outputTokens: number
  costUsd: number
  callCount: number
}

/**
 * Rebuild the current-period invoice for every user that had usage
 * this period. Also flips the previous period's invoice to
 * FINALIZED if it's still sitting in DRAFT.
 *
 * Period key is YYYY-MM in UTC so the boundary is consistent across
 * regions and matches how downstream billing systems (Stripe, QBO,
 * etc.) expect monthly statements.
 */
export async function runAggregatorTick(prisma: PrismaClient): Promise<void> {
  const now = new Date()
  const currentPeriod = formatPeriod(now)
  const previousPeriod = formatPeriod(prevMonth(now))

  // Finalize any DRAFT invoice for the previous period that may still
  // be open. Happens once on the first tick of a new month; idempotent
  // on subsequent ticks.
  await prisma.invoice.updateMany({
    where: { period: previousPeriod, status: 'DRAFT' },
    data: { status: 'FINALIZED', dueAt: new Date() },
  })

  // Pull all distinct users with usage in the current period. Doing
  // this as a single GROUP BY keeps it cheap even with millions of
  // rows; the index on (userId, createdAt) keeps the scan fast.
  const periodStart = startOfPeriod(now)
  const periodEnd = startOfPeriod(nextMonth(now))

  // Need both (userId) for the upsert key AND (userId, model) for
  // the line-item breakdown. One groupBy with both dimensions covers
  // both — line items get re-aggregated per user below.
  const grouped = await prisma.tokenUsage.groupBy({
    by: ['userId', 'model'],
    where: {
      createdAt: { gte: periodStart, lt: periodEnd },
    },
    _sum: {
      inputTokens: true,
      outputTokens: true,
      costUsd: true,
    },
    _count: { _all: true },
  })

  if (grouped.length === 0) {
    // Nothing to invoice this period; the previous-period flip
    // above was the only work needed.
    return
  }

  // Re-pivot the flat (userId, model) array into per-user line items.
  const byUser = new Map<string, ModelLineItem[]>()
  for (const row of grouped) {
    const lineItem: ModelLineItem = {
      model: row.model,
      inputTokens: row._sum.inputTokens ?? 0,
      outputTokens: row._sum.outputTokens ?? 0,
      costUsd: row._sum.costUsd ?? 0,
      callCount: row._count._all,
    }
    const arr = byUser.get(row.userId) ?? []
    arr.push(lineItem)
    byUser.set(row.userId, arr)
  }

  // Upsert one invoice per user for the current period. DRAFT status
  // — usage may still grow between now and the next tick.
  for (const [userId, lineItems] of byUser) {
    const totalUsd = lineItems.reduce((sum, li) => sum + li.costUsd, 0)
    // Sort the breakdown most-expensive-first so the buyer's
    // statement leads with where their money went.
    lineItems.sort((a, b) => b.costUsd - a.costUsd)

    await prisma.invoice.upsert({
      where: { userId_period: { userId, period: currentPeriod } },
      create: {
        userId,
        period: currentPeriod,
        lineItems: lineItems as unknown as object,
        totalUsd,
        status: 'DRAFT',
      },
      update: {
        lineItems: lineItems as unknown as object,
        totalUsd,
      },
    })
  }
}

// ---------------------------------------------------------------------------
// Period math (UTC)
// ---------------------------------------------------------------------------

function formatPeriod(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

function startOfPeriod(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0))
}

function nextMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0))
}

function prevMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1, 0, 0, 0, 0))
}
