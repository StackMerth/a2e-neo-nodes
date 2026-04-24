// Overflow Scheduler (F3.2)
//
// Repeatable BullMQ job that wakes every 60 seconds and runs one pass of the
// overflow engine. A single tick does two things:
//
//   1. Look at idle nodes → decide whether to list them externally and, if so,
//      on which market. Listing mutates state via the listing-manager.
//   2. Look at active external deployments → decide whether to delist (SAFE or
//      FORCE). Delisting mutates state via the listing-manager; SAFE delists
//      additionally enqueue a delayed poll on the termination-policy queue.
//
// Deployment status syncing (polling adapters for workload state + accumulated
// cost) is the status-checker worker's job in F4.1 and is intentionally NOT
// done here. This scheduler only issues list/delist decisions.
//
// Wiring note: `createOverflowQueue`, `createOverflowWorker`, and
// `scheduleOverflowTick` are expected to be invoked from the API bootstrap
// (apps/api/src/index.ts) in a follow-up task (F6.3). This file purposely
// avoids importing the bootstrap or mutating any singleton at module load.

import { Queue, Worker, Job, type ConnectionOptions } from 'bullmq'
import type { PrismaClient } from '@a2e/database'
import type { AdapterRegistry, RateProvider } from '@a2e/core'
import type { Server as SocketServer } from 'socket.io'
import {
  detectIdleNodes as defaultDetectIdleNodes,
  getOrCreateOverflowConfig as defaultGetOrCreateOverflowConfig,
  selectBestMarket as defaultSelectBestMarket,
  shouldDelistExternally as defaultShouldDelistExternally,
  shouldListExternally as defaultShouldListExternally,
  type IdleNode,
  type OverflowDecisionContext,
} from '../services/overflow/engine'
import {
  delistNode as defaultDelistNode,
  listNodeExternally as defaultListNodeExternally,
} from '../services/overflow/listing-manager'

export const OVERFLOW_QUEUE_NAME = 'overflow-scheduler'
export const OVERFLOW_TICK_MS = 60_000
const REPEATABLE_JOB_ID = 'overflow-scheduler-repeatable'

export interface OverflowSchedulerDeps {
  redis: ConnectionOptions
  prisma: PrismaClient
  registry: AdapterRegistry
  rateProvider: RateProvider
  terminationQueue: Queue
  io?: SocketServer
  tickMs?: number
}

export interface OverflowTickSummary {
  listed: number
  delisted: number
  skipped: number
  errors: number
  enabled: boolean
}

// Injectable function references so tests can swap real engine / listing-
// manager imports for fakes without touching the module graph. Every override
// defaults to the real implementation.
export interface OverflowTickOverrides {
  getOrCreateOverflowConfig?: typeof defaultGetOrCreateOverflowConfig
  detectIdleNodes?: typeof defaultDetectIdleNodes
  shouldListExternally?: typeof defaultShouldListExternally
  shouldDelistExternally?: typeof defaultShouldDelistExternally
  selectBestMarket?: typeof defaultSelectBestMarket
  listNodeExternally?: typeof defaultListNodeExternally
  delistNode?: typeof defaultDelistNode
}

export interface RunOverflowTickInput {
  prisma: PrismaClient
  registry: AdapterRegistry
  rateProvider: RateProvider
  terminationQueue: Queue
  io?: SocketServer
  overrides?: OverflowTickOverrides
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

export function createOverflowQueue(redis: ConnectionOptions): Queue {
  return new Queue(OVERFLOW_QUEUE_NAME, {
    connection: redis,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  })
}

/**
 * Seed (or re-seed) the every-tickMs repeatable job. Safe to call on every
 * startup — BullMQ dedupes by `jobId`, and we additionally sweep any stale
 * repeatable keys that may have been left behind by a prior interval change.
 */
export async function scheduleOverflowTick(
  queue: Queue,
  everyMs: number = OVERFLOW_TICK_MS,
): Promise<void> {
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    if (job.id === REPEATABLE_JOB_ID || job.name === 'overflow-tick') {
      await queue.removeRepeatableByKey(job.key)
    }
  }

  await queue.add(
    'overflow-tick',
    {},
    {
      repeat: { every: everyMs },
      jobId: REPEATABLE_JOB_ID,
    },
  )

  console.log(`[overflow-scheduler] Scheduled to run every ${everyMs}ms`)
}

export function createOverflowWorker(deps: OverflowSchedulerDeps): Worker {
  const { redis, prisma, registry, rateProvider, terminationQueue, io } = deps

  const worker = new Worker(
    OVERFLOW_QUEUE_NAME,
    async (job: Job) => {
      const logger = {
        info: (msg: string, data?: object) =>
          console.log(`[overflow-scheduler] ${msg}`, data ?? ''),
        error: (msg: string, err?: unknown) =>
          console.error(`[overflow-scheduler] ${msg}`, err),
      }

      logger.info('tick start', { jobId: job.id })

      try {
        const summary = await runOverflowTick({
          prisma,
          registry,
          rateProvider,
          terminationQueue,
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
    console.log(`[overflow-scheduler] Job ${job.id} completed`)
  })

  worker.on('failed', (job: Job | undefined, err: Error) => {
    console.error(`[overflow-scheduler] Job ${job?.id} failed:`, err.message)
  })

  return worker
}

/**
 * One scheduler pass. Extracted so tests can exercise the orchestration
 * without spinning up BullMQ or Redis. Each per-node / per-deployment call is
 * individually try/caught so a single failure does not abort the tick — the
 * failure is counted in `errors` and the loop continues.
 */
export async function runOverflowTick(
  input: RunOverflowTickInput,
): Promise<OverflowTickSummary> {
  const { prisma, registry, rateProvider, terminationQueue, io } = input
  const overrides = input.overrides ?? {}

  const getConfig = overrides.getOrCreateOverflowConfig ?? defaultGetOrCreateOverflowConfig
  const detectIdle = overrides.detectIdleNodes ?? defaultDetectIdleNodes
  const shouldList = overrides.shouldListExternally ?? defaultShouldListExternally
  const shouldDelist = overrides.shouldDelistExternally ?? defaultShouldDelistExternally
  const pickMarket = overrides.selectBestMarket ?? defaultSelectBestMarket
  const listExternal = overrides.listNodeExternally ?? defaultListNodeExternally
  const delist = overrides.delistNode ?? defaultDelistNode

  const config = await getConfig(prisma)
  if (!config.enabled) {
    return { listed: 0, delisted: 0, skipped: 0, errors: 0, enabled: false }
  }

  const ctx: OverflowDecisionContext = {
    config,
    registry,
    rateProvider,
  }

  let listed = 0
  let delisted = 0
  let skipped = 0
  let errors = 0

  // 1) Idle nodes → consider listing.
  let idleNodes: IdleNode[] = []
  try {
    idleNodes = await detectIdle(prisma, config.idleThresholdMinutes)
  } catch (err) {
    errors += 1
    console.error('[overflow-scheduler] detectIdleNodes failed', err)
  }

  for (const node of idleNodes) {
    try {
      const decision = await shouldList(prisma, ctx, node.id)
      if (!decision.shouldList) {
        skipped += 1
        continue
      }

      const best = await pickMarket(ctx, node.gpuTier, node.customRatePerHour)
      if (best.market === null) {
        skipped += 1
        continue
      }

      const result = await listExternal(prisma, registry, {
        nodeId: node.id,
        market: best.market,
        ratePerHour: best.ratePerHour,
      })

      listed += 1
      io?.emit('external:listed', {
        nodeId: node.id,
        deploymentId: result.deploymentId,
        market: best.market,
        ratePerHour: best.ratePerHour,
        timestamp: new Date().toISOString(),
      })
    } catch (err) {
      errors += 1
      console.error(
        `[overflow-scheduler] listing failed for node ${node.id}`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  // 2) Active / pending deployments → consider delisting.
  let activeDeployments: Array<{ id: string; nodeId: string; market: string }> = []
  try {
    activeDeployments = await prisma.externalDeployment.findMany({
      where: { status: { in: ['ACTIVE', 'PENDING'] } },
      select: { id: true, nodeId: true, market: true },
    })
  } catch (err) {
    errors += 1
    console.error('[overflow-scheduler] fetching active deployments failed', err)
  }

  for (const dep of activeDeployments) {
    try {
      const decision = await shouldDelist(prisma, ctx, dep.nodeId)
      if (!decision.shouldDelist) {
        skipped += 1
        continue
      }

      await delist(prisma, registry, {
        deploymentId: dep.id,
        mode: decision.mode,
        reason: decision.reason,
        terminationQueue,
      })

      delisted += 1
      io?.emit('external:delisting', {
        nodeId: dep.nodeId,
        deploymentId: dep.id,
        market: dep.market,
        mode: decision.mode,
        reason: decision.reason,
        timestamp: new Date().toISOString(),
      })
    } catch (err) {
      errors += 1
      console.error(
        `[overflow-scheduler] delist failed for deployment ${dep.id}`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  return { listed, delisted, skipped, errors, enabled: true }
}
