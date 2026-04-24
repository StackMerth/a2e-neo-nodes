// External Earnings Calculator (F4.2)
//
// Repeatable BullMQ job that wakes every 5 minutes and asks each non-terminal
// external deployment how much cost has accumulated adapter-side, then records
// the USD delta against our `Earning` table via `recordExternalEarnings` (F3.3).
//
// We run on a slower cadence than the status checker (30s) because:
//   - Earnings accumulate gradually — a 5 minute granularity is plenty for both
//     dashboards and nightly rollups.
//   - Adapter cost endpoints are typically the most expensive external calls;
//     polling them every 30s would burn rate limits with no upside.
//
// Each deployment is funneled through `recordExternalEarnings`, which already
// handles:
//   - adapter call + registry health bookkeeping
//   - delta computation vs the last-known accumulated cost
//   - idempotent upsert into Earning keyed by (nodeId, date, market)
//   - backwards-moving-cost defensive no-op
//
// This worker's only extra responsibilities are (a) iterating the deployment
// set, (b) emitting a WebSocket event on non-zero deltas so UI clients do not
// have to poll, and (c) counting per-tick outcomes for observability.
//
// Wiring note: `createExternalEarningsQueue`, `createExternalEarningsWorker`,
// and `scheduleExternalEarningsTick` are expected to be invoked from the API
// bootstrap (apps/api/src/index.ts) in a follow-up task (F6.3). This file
// deliberately does not import the bootstrap or mutate any singleton at
// module load.

import { Queue, Worker, Job, type ConnectionOptions } from 'bullmq'
import type { PrismaClient, ExternalDeploymentStatus } from '@a2e/database'
import type { AdapterRegistry } from '@a2e/core'
import type { Server as SocketServer } from 'socket.io'
import { recordExternalEarnings as defaultRecordExternalEarnings } from '../services/overflow/listing-manager'

export const EXTERNAL_EARNINGS_QUEUE_NAME = 'external-earnings-calculator'
export const EXTERNAL_EARNINGS_TICK_MS = 5 * 60_000
const REPEATABLE_JOB_ID = 'external-earnings-calculator-repeatable'

// Deployments eligible for earnings tracking. We include TERMINATING so that
// earnings which accrue during the safe-termination grace window are still
// captured; PENDING has no adapter-side cost yet; TERMINATED and FAILED are
// terminal and cannot produce further earnings.
const EARNING_ELIGIBLE_STATUSES: ReadonlyArray<ExternalDeploymentStatus> = [
  'ACTIVE',
  'TERMINATING',
]

export interface ExternalEarningsDeps {
  redis: ConnectionOptions
  prisma: PrismaClient
  registry: AdapterRegistry
  io?: SocketServer
  tickMs?: number
}

export interface ExternalEarningsTickSummary {
  /** Number of deployments we attempted to record. */
  processed: number
  /** Number of deployments that produced a non-zero USD delta. */
  recorded: number
  /** Reserved for live-mode: number of deployments whose cost fetch used a stale/fallback rate. Currently always 0. */
  flagged: number
  errors: number
}

export interface ExternalEarningsTickOverrides {
  recordExternalEarnings?: typeof defaultRecordExternalEarnings
}

export interface RunExternalEarningsTickInput {
  prisma: PrismaClient
  registry: AdapterRegistry
  io?: SocketServer
  overrides?: ExternalEarningsTickOverrides
}

const DEFAULT_JOB_OPTIONS = {
  removeOnComplete: 100,
  removeOnFail: 50,
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 5000,
  },
}

export function createExternalEarningsQueue(redis: ConnectionOptions): Queue {
  return new Queue(EXTERNAL_EARNINGS_QUEUE_NAME, {
    connection: redis,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  })
}

/**
 * Seed (or re-seed) the every-tickMs repeatable job. Safe to call on every
 * startup — BullMQ dedupes by `jobId`, and we additionally sweep any stale
 * repeatable keys that may have been left behind by a prior interval change.
 */
export async function scheduleExternalEarningsTick(
  queue: Queue,
  everyMs: number = EXTERNAL_EARNINGS_TICK_MS,
): Promise<void> {
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    if (job.id === REPEATABLE_JOB_ID || job.name === 'external-earnings-tick') {
      await queue.removeRepeatableByKey(job.key)
    }
  }

  await queue.add(
    'external-earnings-tick',
    {},
    {
      repeat: { every: everyMs },
      jobId: REPEATABLE_JOB_ID,
    },
  )

  console.log(`[external-earnings-calculator] Scheduled to run every ${everyMs}ms`)
}

export function createExternalEarningsWorker(deps: ExternalEarningsDeps): Worker {
  const { redis, prisma, registry, io } = deps

  const worker = new Worker(
    EXTERNAL_EARNINGS_QUEUE_NAME,
    async (job: Job) => {
      const logger = {
        info: (msg: string, data?: object) =>
          console.log(`[external-earnings-calculator] ${msg}`, data ?? ''),
        error: (msg: string, err?: unknown) =>
          console.error(`[external-earnings-calculator] ${msg}`, err),
      }

      logger.info('tick start', { jobId: job.id })

      try {
        const summary = await runExternalEarningsTick({
          prisma,
          registry,
          io,
        })
        logger.info('tick complete', { jobId: job.id, ...summary })
        return summary
      } catch (err) {
        logger.error('tick failed', err)
        // Rethrow so BullMQ applies the configured retry policy.
        throw err
      }
    },
    {
      connection: redis,
      concurrency: 1,
    },
  )

  worker.on('completed', (job: Job) => {
    console.log(`[external-earnings-calculator] Job ${job.id} completed`)
  })

  worker.on('failed', (job: Job | undefined, err: Error) => {
    console.error(
      `[external-earnings-calculator] Job ${job?.id} failed:`,
      err.message,
    )
  })

  return worker
}

/**
 * One earnings-calculator pass. Extracted so tests can exercise the
 * orchestration without spinning up BullMQ or Redis. Each per-deployment call
 * is individually try/caught so a single failure does not abort the tick — the
 * failure is counted in `errors` and the loop continues.
 */
export async function runExternalEarningsTick(
  input: RunExternalEarningsTickInput,
): Promise<ExternalEarningsTickSummary> {
  const { prisma, registry, io } = input
  const overrides = input.overrides ?? {}
  const recordEarnings =
    overrides.recordExternalEarnings ?? defaultRecordExternalEarnings

  const deployments = await prisma.externalDeployment.findMany({
    where: { status: { in: [...EARNING_ELIGIBLE_STATUSES] } },
    select: { id: true, nodeId: true, market: true },
  })

  let processed = 0
  let recorded = 0
  let errors = 0

  for (const dep of deployments) {
    try {
      const result = await recordEarnings(prisma, registry, dep.id)
      processed += 1

      if (result.deltaUsd > 0) {
        recorded += 1
        io?.emit('external:earnings', {
          deploymentId: dep.id,
          nodeId: dep.nodeId,
          market: dep.market,
          deltaUsd: result.deltaUsd,
          totalUsd: result.totalUsd,
          timestamp: new Date().toISOString(),
        })
      }
    } catch (err) {
      errors += 1
      console.error(
        `[external-earnings-calculator] record failed for deployment ${dep.id}`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  return { processed, recorded, flagged: 0, errors }
}
