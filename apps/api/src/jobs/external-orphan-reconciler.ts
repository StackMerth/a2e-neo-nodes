// External Orphan Deployment Reconciler (F4.3)
//
// Repeatable BullMQ job that wakes every 15 minutes and reconciles drift
// between our DB's view of ExternalDeployment rows and the actual state on
// each external market. Also runs once at API startup (via
// `runOrphanReconciliationOnStartup`) so stale rows are cleaned up before the
// overflow scheduler and earnings worker begin acting on them.
//
// Two drift categories are handled:
//
// 1. Leaks — our DB believes PENDING/ACTIVE/TERMINATING but the market has
//    already terminated or forgotten the deployment. We reconcile the DB row
//    to TERMINATED/FAILED so we stop listing, billing, or routing against it.
//
// 2. Phantoms — our DB believes TERMINATED but the market still shows the
//    deployment running. We force-terminate through the adapter to stop the
//    meter. Bounded to a 24h lookback so we do not repeatedly poke ancient
//    historical rows.
//
// Wiring note: `createExternalOrphanQueue`, `createExternalOrphanWorker`, and
// `scheduleExternalOrphanTick` are expected to be invoked from the API
// bootstrap (apps/api/src/index.ts) in a follow-up task (F6.3). This file
// deliberately does not import the bootstrap or mutate any singleton at
// module load.

import { Queue, Worker, Job, type ConnectionOptions } from 'bullmq'
import type { PrismaClient, ExternalDeploymentStatus } from '@a2e/database'
import type { AdapterRegistry } from '@a2e/core'
import type { Server as SocketServer } from 'socket.io'

export const EXTERNAL_ORPHAN_QUEUE_NAME = 'external-orphan-reconciler'
export const EXTERNAL_ORPHAN_TICK_MS = 15 * 60_000
const REPEATABLE_JOB_ID = 'external-orphan-reconciler-repeatable'

// How far back we look when scanning TERMINATED rows for phantom deployments.
// A terminate call that happened more than 24 hours ago is either long gone
// adapter-side or stuck in a state no polling pass will resolve — the market
// operator has to clean up manually at that point.
const PHANTOM_LOOKBACK_MS = 24 * 60 * 60_000

// DB statuses we treat as "alive" for the leak pass. TERMINATED and FAILED
// are terminal and cannot legally transition back, so the leak pass skips
// them (the phantom pass handles TERMINATED separately).
const ACTIVE_STATUSES: ReadonlyArray<ExternalDeploymentStatus> = [
  'PENDING',
  'ACTIVE',
  'TERMINATING',
]

type AdapterMarket = 'AKASH' | 'IONET' | 'VASTAI'

export interface ExternalOrphanDeps {
  redis: ConnectionOptions
  prisma: PrismaClient
  registry: AdapterRegistry
  io?: SocketServer
  tickMs?: number
}

export type ReconcileActionKind =
  | 'MARKED_TERMINATED'
  | 'FORCED_TERMINATED'
  | 'MARKED_FAILED'
  | 'NONE'

export interface ReconcileAction {
  deploymentId: string
  externalId: string
  market: AdapterMarket
  kind: ReconcileActionKind
  // MARKED_TERMINATED: DB was ACTIVE, market was terminated — updated DB to TERMINATED
  // FORCED_TERMINATED: DB was TERMINATED but market still shows running — called adapter.terminateDeployment
  // MARKED_FAILED: market returned "unknown deployment" → marked our row FAILED, alert
  // NONE: no drift; nothing changed
  reason: string
}

export interface ExternalOrphanTickSummary {
  inspected: number
  reconciled: number
  errors: number
  actions: ReconcileAction[]
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

export function createExternalOrphanQueue(redis: ConnectionOptions): Queue {
  return new Queue(EXTERNAL_ORPHAN_QUEUE_NAME, {
    connection: redis,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  })
}

/**
 * Seed (or re-seed) the every-tickMs repeatable job. Safe to call on every
 * startup — BullMQ dedupes by `jobId`, and we additionally sweep any stale
 * repeatable keys that may have been left behind by a prior interval change.
 */
export async function scheduleExternalOrphanTick(
  queue: Queue,
  everyMs: number = EXTERNAL_ORPHAN_TICK_MS,
): Promise<void> {
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    if (job.id === REPEATABLE_JOB_ID || job.name === 'external-orphan-tick') {
      await queue.removeRepeatableByKey(job.key)
    }
  }

  await queue.add(
    'external-orphan-tick',
    {},
    {
      repeat: { every: everyMs },
      jobId: REPEATABLE_JOB_ID,
    },
  )

  console.log(`[external-orphan-reconciler] Scheduled to run every ${everyMs}ms`)
}

export function createExternalOrphanWorker(deps: ExternalOrphanDeps): Worker {
  const { redis, prisma, registry, io } = deps

  const worker = new Worker(
    EXTERNAL_ORPHAN_QUEUE_NAME,
    async (job: Job) => {
      const logger = {
        info: (msg: string, data?: object) =>
          console.log(`[external-orphan-reconciler] ${msg}`, data ?? ''),
        error: (msg: string, err?: unknown) =>
          console.error(`[external-orphan-reconciler] ${msg}`, err),
      }

      logger.info('tick start', { jobId: job.id })

      try {
        const summary = await runExternalOrphanTick({ redis, prisma, registry, io })
        logger.info('tick complete', {
          jobId: job.id,
          inspected: summary.inspected,
          reconciled: summary.reconciled,
          errors: summary.errors,
        })
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
    console.log(`[external-orphan-reconciler] Job ${job.id} completed`)
  })

  worker.on('failed', (job: Job | undefined, err: Error) => {
    console.error(
      `[external-orphan-reconciler] Job ${job?.id} failed:`,
      err.message,
    )
  })

  return worker
}

function isUnknownDeploymentError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '')
  return /unknown deployment/i.test(message)
}

/**
 * One reconciliation pass. Extracted so tests can exercise the orchestration
 * without spinning up BullMQ or Redis. Per-deployment calls are individually
 * try/caught so a single failure does not abort the tick.
 *
 * The pass has two phases:
 *   1. Leak pass — DB rows we believe are alive; if the market disagrees, we
 *      converge the DB toward the market.
 *   2. Phantom pass — DB rows we believe are dead (within the 24h lookback);
 *      if the market still shows them running, we force-terminate.
 */
export async function runExternalOrphanTick(
  deps: ExternalOrphanDeps,
): Promise<ExternalOrphanTickSummary> {
  const { prisma, registry, io } = deps

  const actions: ReconcileAction[] = []
  let errors = 0

  // ---------------------------------------------------------------------------
  // Phase 1: Leak pass
  //
  // Anything we think is PENDING/ACTIVE/TERMINATING gets checked against the
  // adapter. If the adapter says it is gone (or never existed), we reconcile.
  // ---------------------------------------------------------------------------
  const activeDeployments = await prisma.externalDeployment.findMany({
    where: { status: { in: [...ACTIVE_STATUSES] } },
    select: {
      id: true,
      externalId: true,
      market: true,
      nodeId: true,
      status: true,
    },
  })

  for (const dep of activeDeployments) {
    try {
      const market = dep.market as AdapterMarket
      const adapter = registry.get(market)
      if (!adapter) {
        // Market not registered (shouldn't happen in a healthy bootstrap).
        // Record a no-op so the summary shows we looked at the row.
        actions.push({
          deploymentId: dep.id,
          externalId: dep.externalId,
          market,
          kind: 'NONE',
          reason: 'adapter not registered',
        })
        continue
      }

      let externalStatus:
        | 'PENDING'
        | 'ACTIVE'
        | 'TERMINATING'
        | 'TERMINATED'
        | 'FAILED'
        | 'UNKNOWN'
      try {
        const statusResult = await adapter.getDeploymentStatus(dep.externalId)
        registry.recordSuccess(market)
        externalStatus = statusResult.status
      } catch (err) {
        if (isUnknownDeploymentError(err)) {
          externalStatus = 'UNKNOWN'
        } else {
          registry.recordFailure(market, err instanceof Error ? err : String(err))
          errors += 1
          console.error(
            `[external-orphan-reconciler] status check failed for ${dep.id}`,
            err instanceof Error ? err.message : err,
          )
          continue
        }
      }

      if (externalStatus === 'UNKNOWN') {
        await prisma.externalDeployment.update({
          where: { id: dep.id },
          data: {
            status: 'FAILED',
            terminatedAt: new Date(),
            terminationReason: 'Reconciler: unknown to market',
          },
        })
        actions.push({
          deploymentId: dep.id,
          externalId: dep.externalId,
          market,
          kind: 'MARKED_FAILED',
          reason: 'market returned unknown deployment',
        })
        io?.emit('external:orphan:failed', {
          deploymentId: dep.id,
          nodeId: dep.nodeId,
          market,
          timestamp: new Date().toISOString(),
        })
      } else if (
        dep.status !== 'TERMINATED' &&
        (externalStatus === 'TERMINATED' || externalStatus === 'FAILED')
      ) {
        await prisma.externalDeployment.update({
          where: { id: dep.id },
          data: {
            status: externalStatus,
            terminatedAt: new Date(),
            terminationReason: `Reconciler: market reports ${externalStatus}`,
          },
        })
        actions.push({
          deploymentId: dep.id,
          externalId: dep.externalId,
          market,
          kind: 'MARKED_TERMINATED',
          reason: `market reports ${externalStatus.toLowerCase()}`,
        })
        io?.emit('external:orphan:reconciled', {
          deploymentId: dep.id,
          nodeId: dep.nodeId,
          market,
          newStatus: externalStatus,
          timestamp: new Date().toISOString(),
        })
      } else {
        actions.push({
          deploymentId: dep.id,
          externalId: dep.externalId,
          market,
          kind: 'NONE',
          reason: 'states match',
        })
      }
    } catch (err) {
      errors += 1
      console.error(
        `[external-orphan-reconciler] reconcile failed for deployment ${dep.id}`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 2: Phantom pass
  //
  // Only inspect TERMINATED rows within the 24h lookback. Older rows are out
  // of scope — if the adapter still has them, that is a manual cleanup job.
  // ---------------------------------------------------------------------------
  const phantomCutoff = new Date(Date.now() - PHANTOM_LOOKBACK_MS)
  const recentTerminated = await prisma.externalDeployment.findMany({
    where: {
      status: 'TERMINATED',
      terminatedAt: { gte: phantomCutoff },
    },
    select: {
      id: true,
      externalId: true,
      market: true,
      nodeId: true,
    },
  })

  for (const dep of recentTerminated) {
    try {
      const market = dep.market as AdapterMarket
      const adapter = registry.get(market)
      if (!adapter) continue

      let externalStatus:
        | 'PENDING'
        | 'ACTIVE'
        | 'TERMINATING'
        | 'TERMINATED'
        | 'FAILED'
      try {
        const statusResult = await adapter.getDeploymentStatus(dep.externalId)
        registry.recordSuccess(market)
        externalStatus = statusResult.status
      } catch (err) {
        // The market has already forgotten about this deployment — that is the
        // expected state for a TERMINATED row, so it is a silent skip.
        if (isUnknownDeploymentError(err)) continue

        registry.recordFailure(market, err instanceof Error ? err : String(err))
        errors += 1
        console.error(
          `[external-orphan-reconciler] phantom status check failed for ${dep.id}`,
          err instanceof Error ? err.message : err,
        )
        continue
      }

      if (externalStatus === 'ACTIVE' || externalStatus === 'PENDING') {
        // DB says dead, market says alive — force-terminate the phantom.
        try {
          await adapter.terminateDeployment(dep.externalId)
          registry.recordSuccess(market)
        } catch (err) {
          if (!isUnknownDeploymentError(err)) {
            registry.recordFailure(
              market,
              err instanceof Error ? err : String(err),
            )
            errors += 1
            console.error(
              `[external-orphan-reconciler] phantom terminate failed for ${dep.id}`,
              err instanceof Error ? err.message : err,
            )
            continue
          }
          // If it became unknown between status and terminate, the job is done.
        }

        actions.push({
          deploymentId: dep.id,
          externalId: dep.externalId,
          market,
          kind: 'FORCED_TERMINATED',
          reason: 'DB TERMINATED but market still running',
        })
        io?.emit('external:orphan:force-terminated', {
          deploymentId: dep.id,
          nodeId: dep.nodeId,
          market,
          timestamp: new Date().toISOString(),
        })
      }
    } catch (err) {
      errors += 1
      console.error(
        `[external-orphan-reconciler] phantom reconcile failed for deployment ${dep.id}`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  return {
    inspected: activeDeployments.length + recentTerminated.length,
    reconciled: actions.filter((a) => a.kind !== 'NONE').length,
    errors,
    actions,
  }
}

/**
 * Startup-convenience helper. Invoke once when the API boots so orphans are
 * cleaned up before the overflow scheduler and earnings workers start taking
 * action on stale rows. This does NOT go through BullMQ — it simply runs one
 * pass synchronously and logs a summary. The fastify logger is not yet ready
 * at bootstrap time, so we use `console.*` directly.
 */
export async function runOrphanReconciliationOnStartup(
  deps: ExternalOrphanDeps,
): Promise<ExternalOrphanTickSummary> {
  console.log('[orphan-reconciler] startup pass: begin')
  try {
    const summary = await runExternalOrphanTick(deps)
    console.log('[orphan-reconciler] startup pass:', {
      inspected: summary.inspected,
      reconciled: summary.reconciled,
      errors: summary.errors,
      actions: summary.actions.map((a) => ({
        deploymentId: a.deploymentId,
        market: a.market,
        kind: a.kind,
      })),
    })
    return summary
  } catch (err) {
    console.error(
      '[orphan-reconciler] startup pass failed:',
      err instanceof Error ? err.message : err,
    )
    throw err
  }
}
