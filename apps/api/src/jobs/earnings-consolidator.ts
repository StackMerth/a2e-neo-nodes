/**
 * Earnings consolidator worker.
 *
 * Once per day at the configured cadence, walks every node that had
 * heartbeats yesterday and upserts a row in the Earning table summing
 * yesterday's uptime hours × rate. The result is the canonical daily
 * earnings ledger.
 *
 * Why this exists: two separate views of "what did the operator earn"
 * already live in the codebase, but neither one writes Earning rows:
 *
 *   1. The dashboard forecast card + weekly digest both derive earnings
 *      on-the-fly via getDailyUptimeBreakdown (heartbeats × rate per
 *      tier). They never write back.
 *   2. The "Earnings, last 30 days" chart on the operator dashboard
 *      reads from the Earning table directly. Without this consolidator
 *      that table stays empty, and the chart flat-lines at zero even
 *      when heartbeats prove the operator was earning.
 *
 * This worker is the bridge. After it runs, the chart and the forecast
 * agree because they're sourced from the same numbers — the forecast
 * just hasn't been written down yet, the chart shows the persisted
 * record.
 *
 * Scheduling: every 24h. Falls at ~00:30 UTC on a fresh deploy because
 * we offset the first run by 30 min (gives yesterday a chance to be
 * fully finalized — no risk of consolidating an "in-progress" partial
 * day). Subsequent ticks drift slightly with each deploy, which is
 * fine; idempotent upserts mean re-running the same day overwrites
 * with identical data.
 *
 * Idempotency: Earning has @@unique([nodeId, date, market]). The
 * upsert uses that key, so a re-run of the same day for the same node
 * produces a noop (or refreshes the values if heartbeats shifted in
 * the meantime, e.g. a backfilled batch).
 */

import { Queue, Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { PrismaClient } from '@a2e/database'
import { calculateAllNodesUptimeEarnings } from '../services/earnings/uptime-calculator.js'
import { roundUsd } from '@a2e/shared'

const QUEUE_NAME = 'earnings-consolidator'

// Default: every 24 hours. Override with EARNINGS_CONSOLIDATOR_INTERVAL_MS
// for faster testing (e.g. set to 300000 for a 5-minute tick during
// local dev). Production keeps it at 24h.
const TICK_INTERVAL_MS = parseInt(
  process.env.EARNINGS_CONSOLIDATOR_INTERVAL_MS ?? `${24 * 60 * 60 * 1000}`,
  10,
)

interface ConsolidatorDeps {
  redis: ConnectionOptions
  prisma: PrismaClient
}

export function createEarningsConsolidatorQueue(connection: ConnectionOptions): Queue {
  return new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1, // re-runs by next tick, not by BullMQ retry
      removeOnComplete: { count: 30 }, // keep ~1 month of run history
      removeOnFail: { count: 90 },
    },
  })
}

export function createEarningsConsolidatorWorker(deps: ConsolidatorDeps): Worker {
  return new Worker(
    QUEUE_NAME,
    async () => {
      // Consolidate "yesterday" relative to the moment the tick fires.
      // Specifying a date here would let the operator backfill an
      // arbitrary day via the run-once script.
      await runEarningsConsolidatorTick(deps.prisma)
    },
    {
      connection: deps.redis,
      concurrency: 1, // single-flight; we never want two ticks racing
    },
  )
}

export async function scheduleEarningsConsolidator(queue: Queue): Promise<void> {
  // Clear any prior repeatable so we don't accumulate them across deploys
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key)
  }
  await queue.add('tick', {}, { repeat: { every: TICK_INTERVAL_MS } })
}

/**
 * Result of a single consolidation tick. Returned so the run-once
 * script can print a useful summary and so tests can assert outcomes.
 */
export interface ConsolidationSummary {
  /** UTC date the run consolidated, formatted as YYYY-MM-DD. */
  date: string
  /** Nodes that had at least one heartbeat in the target day. */
  nodesScanned: number
  /** Earning rows upserted (one per node-with-nonzero-earnings). */
  rowsUpserted: number
  /** Nodes that scanned cleanly but produced $0 (no uptime in window). */
  zeroEarnings: number
  /** Per-node failures, keyed by node id, so operators can re-run. */
  failures: Array<{ nodeId: string; reason: string }>
  /** Sum of earnings written this tick (across all nodes, USD). */
  totalUsd: number
}

/**
 * Run one consolidation tick. Defaults to yesterday (UTC). Pass a
 * specific date to backfill — useful when the deploy missed a tick
 * and a day went unconsolidated.
 */
export async function runEarningsConsolidatorTick(
  prisma: PrismaClient,
  targetDate?: Date,
): Promise<ConsolidationSummary> {
  // Compute the UTC day window. Default to "yesterday" so a tick that
  // fires at 00:30 UTC catches the just-finished day, not the in-
  // progress one.
  const anchor = targetDate ?? new Date()
  const dayStart = new Date(Date.UTC(
    anchor.getUTCFullYear(),
    anchor.getUTCMonth(),
    anchor.getUTCDate() - (targetDate ? 0 : 1),
    0, 0, 0, 0,
  ))
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000 - 1)
  const dateStr = dayStart.toISOString().slice(0, 10)

  // calculateAllNodesUptimeEarnings already filters out nodes with $0,
  // so anything in its result deserves a row. We still need a separate
  // count of nodes scanned (heartbeat present but earnings == 0) to
  // report it back.
  const heartbeatNodes = await prisma.heartbeat.findMany({
    where: { timestamp: { gte: dayStart, lte: dayEnd } },
    distinct: ['nodeId'],
    select: { nodeId: true },
  })
  const earningsResults = await calculateAllNodesUptimeEarnings(prisma, dayStart, dayEnd)

  let rowsUpserted = 0
  let totalUsd = 0
  const failures: ConsolidationSummary['failures'] = []

  for (const result of earningsResults) {
    try {
      await prisma.earning.upsert({
        // Earning has @@unique([nodeId, date, market]) so the upsert
        // composite key is exactly that. Re-running the same day for
        // the same node refreshes the row instead of creating a
        // duplicate, which is what we want if heartbeats arrived late.
        where: {
          nodeId_date_market: {
            nodeId: result.nodeId,
            date: dayStart,
            market: 'INTERNAL',
          },
        },
        create: {
          nodeId: result.nodeId,
          date: dayStart,
          market: 'INTERNAL',
          // SECURITY (pen-test 2026-06-09/10 B-5): round to cents at the
          // daily Earning upsert so the operator's lifetime earnings sum
          // stays exact-to-cent. Without this, repeated daily rolls of
          // float-imprecise uptime calculations drift directionally.
          earnings: roundUsd(result.earnings),
          gpuSeconds: result.uptimeSeconds,
          jobCount: 0, // populated separately by job-completion path
        },
        update: {
          earnings: roundUsd(result.earnings),
          gpuSeconds: result.uptimeSeconds,
        },
      })
      rowsUpserted++
      totalUsd += result.earnings
    } catch (err) {
      failures.push({
        nodeId: result.nodeId,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const zeroEarnings = heartbeatNodes.length - earningsResults.length

  // eslint-disable-next-line no-console
  console.log(
    `[earnings-consolidator] date=${dateStr} scanned=${heartbeatNodes.length}`
      + ` upserted=${rowsUpserted} zero=${zeroEarnings} failed=${failures.length}`
      + ` total=$${totalUsd.toFixed(2)}`,
  )

  return {
    date: dateStr,
    nodesScanned: heartbeatNodes.length,
    rowsUpserted,
    zeroEarnings,
    failures,
    totalUsd: Math.round(totalUsd * 100) / 100,
  }
}
