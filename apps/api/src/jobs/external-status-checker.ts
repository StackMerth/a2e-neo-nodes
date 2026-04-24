// External Status Checker (F4.1)
//
// Repeatable BullMQ job that wakes every 30 seconds and pulls the latest
// status + accumulated cost for every non-terminal external deployment. This
// runs on a faster cadence than the overflow scheduler (60s) because our
// dashboards and downstream delist decisions benefit from a fresher view of
// adapter-side state.
//
// Each deployment is funneled through `syncDeploymentStatus` (F3.3), which
// already performs the adapter call, DB update, and registry health bookkeeping.
// This worker's only extra responsibility is emitting a WebSocket event when a
// status actually transitions, so UI clients do not have to poll.
//
// Wiring note: `createExternalStatusQueue`, `createExternalStatusWorker`, and
// `scheduleExternalStatusTick` are expected to be invoked from the API
// bootstrap (apps/api/src/index.ts) in a follow-up task (F6.3). This file
// purposely avoids importing the bootstrap or mutating any singleton at module
// load.

import { Queue, Worker, Job, type ConnectionOptions } from 'bullmq'
import type { PrismaClient, ExternalDeploymentStatus } from '@a2e/database'
import type { AdapterRegistry } from '@a2e/core'
import type { Server as SocketServer } from 'socket.io'
import { syncDeploymentStatus as defaultSyncDeploymentStatus } from '../services/overflow/listing-manager'

export const EXTERNAL_STATUS_QUEUE_NAME = 'external-status-checker'
export const EXTERNAL_STATUS_TICK_MS = 30_000
const REPEATABLE_JOB_ID = 'external-status-checker-repeatable'

// Statuses we actively poll. Terminal states (TERMINATED, FAILED) are
// deliberately excluded — they cannot legally transition back, so polling them
// would waste adapter calls and muddy health metrics.
const POLLABLE_STATUSES: ReadonlyArray<ExternalDeploymentStatus> = [
  'PENDING',
  'ACTIVE',
  'TERMINATING',
]

export interface ExternalStatusCheckerDeps {
  redis: ConnectionOptions
  prisma: PrismaClient
  registry: AdapterRegistry
  io?: SocketServer
  tickMs?: number
}

export interface ExternalStatusTickSummary {
  checked: number
  transitioned: number
  errors: number
}

export interface ExternalStatusTickOverrides {
  syncDeploymentStatus?: typeof defaultSyncDeploymentStatus
}

export interface RunExternalStatusTickInput {
  prisma: PrismaClient
  registry: AdapterRegistry
  io?: SocketServer
  overrides?: ExternalStatusTickOverrides
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

export function createExternalStatusQueue(redis: ConnectionOptions): Queue {
  return new Queue(EXTERNAL_STATUS_QUEUE_NAME, {
    connection: redis,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  })
}

/**
 * Seed (or re-seed) the every-tickMs repeatable job. Safe to call on every
 * startup — BullMQ dedupes by `jobId`, and we additionally sweep any stale
 * repeatable keys that may have been left behind by a prior interval change.
 */
export async function scheduleExternalStatusTick(
  queue: Queue,
  everyMs: number = EXTERNAL_STATUS_TICK_MS,
): Promise<void> {
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    if (job.id === REPEATABLE_JOB_ID || job.name === 'external-status-tick') {
      await queue.removeRepeatableByKey(job.key)
    }
  }

  await queue.add(
    'external-status-tick',
    {},
    {
      repeat: { every: everyMs },
      jobId: REPEATABLE_JOB_ID,
    },
  )

  console.log(`[external-status-checker] Scheduled to run every ${everyMs}ms`)
}

export function createExternalStatusWorker(deps: ExternalStatusCheckerDeps): Worker {
  const { redis, prisma, registry, io } = deps

  const worker = new Worker(
    EXTERNAL_STATUS_QUEUE_NAME,
    async (job: Job) => {
      const logger = {
        info: (msg: string, data?: object) =>
          console.log(`[external-status-checker] ${msg}`, data ?? ''),
        error: (msg: string, err?: unknown) =>
          console.error(`[external-status-checker] ${msg}`, err),
      }

      logger.info('tick start', { jobId: job.id })

      try {
        const summary = await runExternalStatusTick({
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
    console.log(`[external-status-checker] Job ${job.id} completed`)
  })

  worker.on('failed', (job: Job | undefined, err: Error) => {
    console.error(`[external-status-checker] Job ${job?.id} failed:`, err.message)
  })

  return worker
}

/**
 * One status-checker pass. Extracted so tests can exercise the orchestration
 * without spinning up BullMQ or Redis. Each per-deployment sync is individually
 * try/caught so a single adapter failure does not abort the tick — the failure
 * is counted in `errors` and the loop continues.
 */
export async function runExternalStatusTick(
  input: RunExternalStatusTickInput,
): Promise<ExternalStatusTickSummary> {
  const { prisma, registry, io } = input
  const overrides = input.overrides ?? {}
  const syncStatus = overrides.syncDeploymentStatus ?? defaultSyncDeploymentStatus

  const deployments = await prisma.externalDeployment.findMany({
    where: { status: { in: [...POLLABLE_STATUSES] } },
    select: { id: true, status: true },
  })

  let checked = 0
  let transitioned = 0
  let errors = 0

  for (const dep of deployments) {
    const previousStatus = dep.status
    try {
      const updated = await syncStatus(prisma, registry, dep.id)
      checked += 1

      if (updated.status !== previousStatus) {
        transitioned += 1
        io?.emit('external:status', {
          deploymentId: updated.id,
          nodeId: updated.nodeId,
          market: updated.market,
          status: updated.status,
          previousStatus,
          costAccumulated: updated.costAccumulated,
          timestamp: new Date().toISOString(),
        })
      }
    } catch (err) {
      errors += 1
      console.error(
        `[external-status-checker] sync failed for deployment ${dep.id}`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  return { checked, transitioned, errors }
}
