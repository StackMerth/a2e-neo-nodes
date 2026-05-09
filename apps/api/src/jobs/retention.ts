/**
 * M1 retention workers (A1 / Production Safety Pack).
 *
 * Two unbounded-growth tables in the schema:
 *
 *   - Heartbeat: every node sends one every 30s. With 1000 active nodes
 *     that's 2.88M rows per day, ~864M rows over 30 days. Postgres can
 *     handle it but indexes start to bloat and per-node detail queries
 *     get slow.
 *
 *   - MarketRateHistory: rate-fetcher writes one row per market+tier
 *     every 60s. That's 4 markets * 5 tiers * 1440/day = 28,800 rows/day,
 *     manageable but no reason to keep 6+ months of granular price data
 *     when we have aggregates.
 *
 * Both workers run on a 24h interval, delete rows older than the
 * configured retention period in batches, and log how many rows were
 * removed. Both are idempotent: if there's nothing old to delete, they
 * exit cleanly.
 *
 * Retention windows are env-tunable. Defaults match the eval finding:
 *   HEARTBEAT_RETENTION_DAYS=30
 *   RATE_HISTORY_RETENTION_DAYS=90
 */

import { Queue, Worker, Job } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { PrismaClient } from '@a2e/database'

const HEARTBEAT_QUEUE = 'heartbeat-retention'
const RATE_HISTORY_QUEUE = 'rate-history-retention'

const HEARTBEAT_RETENTION_DAYS = parseInt(process.env.HEARTBEAT_RETENTION_DAYS ?? '30', 10)
const RATE_HISTORY_RETENTION_DAYS = parseInt(process.env.RATE_HISTORY_RETENTION_DAYS ?? '90', 10)

// Run daily. 24h cadence is plenty; growth is gradual.
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000

// Batch size for the deleteMany. Keeps each query bounded so it doesn't
// hold a long lock on the table during the daily prune.
const BATCH_SIZE = 10_000

interface RetentionDeps {
  redis: ConnectionOptions
  prisma: PrismaClient
}

// ---------------------------------------------------------------------------
// Heartbeat retention
// ---------------------------------------------------------------------------

export function createHeartbeatRetentionQueue(connection: ConnectionOptions): Queue {
  return new Queue(HEARTBEAT_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { count: 30 },
      removeOnFail: { count: 30 },
    },
  })
}

export function createHeartbeatRetentionWorker(deps: RetentionDeps): Worker {
  const { redis, prisma } = deps

  return new Worker(
    HEARTBEAT_QUEUE,
    async (_job: Job) => {
      const cutoff = new Date(Date.now() - HEARTBEAT_RETENTION_DAYS * 24 * 60 * 60 * 1000)
      let totalDeleted = 0

      // Loop in batches so we don't hold a long-running transaction.
      // Postgres' deleteMany with a LIMIT-equivalent: we use take+findMany +
      // deleteMany on the IDs, which is the safest pattern across providers.
      while (true) {
        const batch = await prisma.heartbeat.findMany({
          where: { timestamp: { lt: cutoff } },
          select: { id: true },
          take: BATCH_SIZE,
        })
        if (batch.length === 0) break

        const result = await prisma.heartbeat.deleteMany({
          where: { id: { in: batch.map((r) => r.id) } },
        })
        totalDeleted += result.count

        if (batch.length < BATCH_SIZE) break
      }

      console.log(
        `[retention] heartbeat: deleted ${totalDeleted} rows older than ${HEARTBEAT_RETENTION_DAYS} days (cutoff ${cutoff.toISOString()})`,
      )
      return { deleted: totalDeleted, cutoff: cutoff.toISOString() }
    },
    { connection: redis, concurrency: 1 },
  )
}

export async function scheduleHeartbeatRetention(queue: Queue): Promise<void> {
  // Remove any existing repeatable jobs first (idempotent on redeploy).
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key)
  }
  await queue.add('purge-heartbeats', {}, { repeat: { every: RETENTION_INTERVAL_MS } })
  // Run once on startup too, so a redeploy after a long gap catches up.
  await queue.add('purge-heartbeats-immediate', {})
  console.log(
    `[retention] heartbeat scheduled: every ${RETENTION_INTERVAL_MS / 3_600_000}h, ` +
      `keep last ${HEARTBEAT_RETENTION_DAYS} days`,
  )
}

// ---------------------------------------------------------------------------
// MarketRateHistory retention
// ---------------------------------------------------------------------------

export function createRateHistoryRetentionQueue(connection: ConnectionOptions): Queue {
  return new Queue(RATE_HISTORY_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { count: 30 },
      removeOnFail: { count: 30 },
    },
  })
}

export function createRateHistoryRetentionWorker(deps: RetentionDeps): Worker {
  const { redis, prisma } = deps

  return new Worker(
    RATE_HISTORY_QUEUE,
    async (_job: Job) => {
      const cutoff = new Date(Date.now() - RATE_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000)
      let totalDeleted = 0

      while (true) {
        const batch = await prisma.marketRateHistory.findMany({
          where: { fetchedAt: { lt: cutoff } },
          select: { id: true },
          take: BATCH_SIZE,
        })
        if (batch.length === 0) break

        const result = await prisma.marketRateHistory.deleteMany({
          where: { id: { in: batch.map((r) => r.id) } },
        })
        totalDeleted += result.count

        if (batch.length < BATCH_SIZE) break
      }

      console.log(
        `[retention] rate-history: deleted ${totalDeleted} rows older than ${RATE_HISTORY_RETENTION_DAYS} days (cutoff ${cutoff.toISOString()})`,
      )
      return { deleted: totalDeleted, cutoff: cutoff.toISOString() }
    },
    { connection: redis, concurrency: 1 },
  )
}

export async function scheduleRateHistoryRetention(queue: Queue): Promise<void> {
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key)
  }
  await queue.add('purge-rate-history', {}, { repeat: { every: RETENTION_INTERVAL_MS } })
  await queue.add('purge-rate-history-immediate', {})
  console.log(
    `[retention] rate-history scheduled: every ${RETENTION_INTERVAL_MS / 3_600_000}h, ` +
      `keep last ${RATE_HISTORY_RETENTION_DAYS} days`,
  )
}
