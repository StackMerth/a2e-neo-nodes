// Overflow Safe Termination Policy (F3.5)
//
// Write-side complement to `delistNode` in ./listing-manager. When a SAFE
// delist is initiated, the row transitions to TERMINATING but the external
// market is still holding the workload. This worker polls on a delayed
// schedule until either:
//   - the workload naturally finishes, or
//   - the configured grace window elapses.
// At that point it escalates to FORCE, which calls the adapter. Every
// transition is mirrored to AuditLog so an operator can reconstruct the
// decision chain without scraping container logs.
//
// The worker is intentionally decoupled from the Fastify app — it receives
// its dependencies (Prisma, registry, optional delistNode function) via
// plain DI, and the job processor is exported as a standalone function so
// tests can drive it without spinning up Redis.

import { Queue, Worker, Job, type ConnectionOptions } from 'bullmq'
import type { Prisma, PrismaClient, ExternalDeploymentStatus } from '@a2e/database'
import type { AdapterRegistry } from '@a2e/core'
import { delistNode as defaultDelistNode } from './listing-manager'

export const TERMINATION_QUEUE_NAME = 'external-termination-policy'

const DEFAULT_POLL_INTERVAL_SECONDS = 30

export interface TerminationPolicyJobData {
  deploymentId: string
  reason: string
  mode: 'SAFE' | 'FORCE'
  gracePeriodSeconds: number
  safeInitiatedAt: string
  pollIntervalSeconds?: number
}

export interface TerminationPolicyDeps {
  redis: ConnectionOptions
  prisma: PrismaClient
  registry: AdapterRegistry
}

export type DelistNodeFn = (input: {
  deploymentId: string
  mode: 'SAFE' | 'FORCE'
  reason: string
}) => Promise<{ status: ExternalDeploymentStatus; terminated: boolean }>

export interface TerminationProcessorDeps {
  prisma: PrismaClient
  registry: AdapterRegistry
  queue: Queue
  delistNodeFn: DelistNodeFn
  pollIntervalSeconds: number
}

/**
 * Enqueue a SAFE termination poll for a deployment that has just been
 * transitioned to TERMINATING. The job fires after `pollIntervalSeconds`
 * and, if the workload hasn't finished by then, reschedules itself until
 * the grace window expires.
 */
export async function scheduleSafeTermination(
  queue: Queue,
  input: {
    deploymentId: string
    reason: string
    gracePeriodSeconds: number
    safeInitiatedAt?: Date
    pollIntervalSeconds?: number
  },
): Promise<void> {
  const pollInterval = input.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS
  const safeInitiatedAt = input.safeInitiatedAt ?? new Date()

  const data: TerminationPolicyJobData = {
    deploymentId: input.deploymentId,
    reason: input.reason,
    mode: 'SAFE',
    gracePeriodSeconds: input.gracePeriodSeconds,
    safeInitiatedAt: safeInitiatedAt.toISOString(),
    pollIntervalSeconds: pollInterval,
  }

  await queue.add('safe-termination-poll', data, {
    delay: pollInterval * 1000,
    removeOnComplete: 100,
    removeOnFail: 50,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  })
}

/**
 * Enqueue an immediate FORCE termination. Used by admin override or by the
 * scheduler when a market becomes unavailable mid-deployment.
 */
export async function scheduleForceTermination(
  queue: Queue,
  input: { deploymentId: string; reason: string },
): Promise<void> {
  const data: TerminationPolicyJobData = {
    deploymentId: input.deploymentId,
    reason: input.reason,
    mode: 'FORCE',
    gracePeriodSeconds: 0,
    safeInitiatedAt: new Date().toISOString(),
  }

  await queue.add('force-termination', data, {
    delay: 0,
    removeOnComplete: 100,
    removeOnFail: 50,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  })
}

/**
 * Pure decision function. Given a deployment's current state and whether
 * the node still has an active external job, decide whether to escalate
 * to FORCE now, reschedule another poll, or skip entirely.
 *
 * No DB reads, no adapter calls, no side effects — the caller supplies
 * everything and can unit-test every row of the truth table trivially.
 */
export function decideTerminationAction(args: {
  deploymentStatus: ExternalDeploymentStatus
  safeInitiatedAtMs: number
  nowMs: number
  gracePeriodSeconds: number
  nodeHasActiveExternalJob: boolean
}): 'FORCE_NOW' | 'RESCHEDULE' | 'SKIP' {
  const { deploymentStatus, safeInitiatedAtMs, nowMs, gracePeriodSeconds } = args

  if (deploymentStatus === 'TERMINATED' || deploymentStatus === 'FAILED') {
    return 'SKIP'
  }

  // Defensive: anything other than TERMINATING means the SAFE flow was
  // interrupted or never initiated correctly. Force-terminate so we don't
  // silently leak a deployment.
  if (deploymentStatus !== 'TERMINATING') {
    return 'FORCE_NOW'
  }

  const graceExpired = nowMs - safeInitiatedAtMs >= gracePeriodSeconds * 1000
  if (graceExpired) return 'FORCE_NOW'
  if (!args.nodeHasActiveExternalJob) return 'FORCE_NOW'
  return 'RESCHEDULE'
}

export function createTerminationQueue(redis: ConnectionOptions): Queue {
  return new Queue(TERMINATION_QUEUE_NAME, {
    connection: redis,
    defaultJobOptions: {
      removeOnComplete: 100,
      removeOnFail: 50,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    },
  })
}

/**
 * Log to AuditLog with best-effort semantics. A logging failure must never
 * break the worker — the alternative is silently losing the termination
 * action entirely, which is worse than a noisy console.error.
 */
async function safeAuditLog(
  prisma: PrismaClient,
  entry: {
    entityType: string
    entityId: string
    action: string
    reason?: string
    actorType?: string
    metadata?: Prisma.InputJsonValue
  },
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        entityType: entry.entityType,
        entityId: entry.entityId,
        action: entry.action,
        reason: entry.reason,
        actor: 'SYSTEM',
        actorType: entry.actorType ?? 'SYSTEM',
        metadata: entry.metadata ?? undefined,
      },
    })
  } catch (err) {
    console.error(
      '[termination-policy] failed to write AuditLog',
      entry.entityId,
      entry.action,
      err,
    )
  }
}

/**
 * Testable job processor. The BullMQ worker delegates to this. Extracted so
 * tests can call it directly with fake Prisma / registry / queue / delistFn
 * without running a real Redis instance.
 */
export async function processTerminationJob(
  job: Job<TerminationPolicyJobData>,
  deps: TerminationProcessorDeps,
): Promise<void> {
  const { prisma, queue, delistNodeFn, pollIntervalSeconds } = deps
  const { deploymentId, mode, reason, gracePeriodSeconds, safeInitiatedAt } = job.data

  const deployment = await prisma.externalDeployment.findUnique({
    where: { id: deploymentId },
  })

  if (!deployment) {
    await safeAuditLog(prisma, {
      entityType: 'ExternalDeployment',
      entityId: deploymentId,
      action: 'TERMINATION_DEPLOYMENT_MISSING',
      reason,
    })
    return
  }

  if (mode === 'FORCE') {
    await delistNodeFn({ deploymentId, mode: 'FORCE', reason })
    await safeAuditLog(prisma, {
      entityType: 'ExternalDeployment',
      entityId: deploymentId,
      action: 'FORCE_TERMINATED',
      reason,
      metadata: { jobId: String(job.id ?? '') },
    })
    return
  }

  // mode === 'SAFE' — poll cycle.
  const activeJobCount = await prisma.job.count({
    where: {
      nodeId: deployment.nodeId,
      externalDeploymentId: deployment.id,
      status: { in: ['PENDING', 'ROUTING', 'ASSIGNED', 'RUNNING'] },
    },
  })

  const action = decideTerminationAction({
    deploymentStatus: deployment.status,
    safeInitiatedAtMs: new Date(safeInitiatedAt).getTime(),
    nowMs: Date.now(),
    gracePeriodSeconds,
    nodeHasActiveExternalJob: activeJobCount > 0,
  })

  if (action === 'SKIP') {
    await safeAuditLog(prisma, {
      entityType: 'ExternalDeployment',
      entityId: deploymentId,
      action: 'SAFE_SKIPPED',
      reason,
      metadata: { currentStatus: deployment.status },
    })
    return
  }

  if (action === 'FORCE_NOW') {
    await delistNodeFn({ deploymentId, mode: 'FORCE', reason })
    await safeAuditLog(prisma, {
      entityType: 'ExternalDeployment',
      entityId: deploymentId,
      action: 'SAFE_ESCALATED_TO_FORCE',
      reason,
      metadata: {
        gracePeriodSeconds,
        safeInitiatedAt,
        activeJobCount,
      },
    })
    return
  }

  // RESCHEDULE — workload still running, grace window still open.
  await scheduleSafeTermination(queue, {
    deploymentId,
    reason,
    gracePeriodSeconds,
    safeInitiatedAt: new Date(safeInitiatedAt),
    pollIntervalSeconds: job.data.pollIntervalSeconds ?? pollIntervalSeconds,
  })
  await safeAuditLog(prisma, {
    entityType: 'ExternalDeployment',
    entityId: deploymentId,
    action: 'SAFE_RESCHEDULED',
    reason,
    metadata: {
      activeJobCount,
      pollIntervalSeconds: job.data.pollIntervalSeconds ?? pollIntervalSeconds,
    },
  })
}

/**
 * BullMQ worker that binds `processTerminationJob` against injected deps.
 * `delistNodeFn` defaults to the real `delistNode` from listing-manager but
 * can be overridden for tests or for wiring a transactional wrapper.
 */
export function createTerminationWorker(
  deps: TerminationPolicyDeps & {
    delistNodeFn?: DelistNodeFn
    pollIntervalSeconds?: number
  },
): Worker {
  const { redis, prisma, registry } = deps
  const pollIntervalSeconds = deps.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS
  const queue = createTerminationQueue(redis)

  const delistNodeFn: DelistNodeFn =
    deps.delistNodeFn ??
    (async (input) => defaultDelistNode(prisma, registry, input))

  const worker = new Worker<TerminationPolicyJobData>(
    TERMINATION_QUEUE_NAME,
    async (job) =>
      processTerminationJob(job, {
        prisma,
        registry,
        queue,
        delistNodeFn,
        pollIntervalSeconds,
      }),
    {
      connection: redis,
      concurrency: 4,
    },
  )

  worker.on('completed', (job: Job) => {
    console.log(`[termination-policy] Job ${job.id} completed`)
  })

  worker.on('failed', (job: Job | undefined, err: Error) => {
    console.error(`[termination-policy] Job ${job?.id} failed:`, err.message)
  })

  return worker
}
