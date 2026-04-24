// External Job Execution Bridge (F3.4)
//
// Contract + DB-side orchestration for workloads that originate on an external
// market (Akash, IO.net, Vast.ai) and are routed to one of our listed nodes.
//
// In simulation mode (M7 ship target) no real external workload exists — this
// module is exercised only by tests. When live mode lands, adapter webhook
// handlers / polling loops will call these functions:
//   - `onWorkloadReceived`  — external market routed a workload to our node
//   - `onWorkloadCompleted` — workload finished on the node (success/failure)
//   - `onWorkloadFailed`    — workload errored on the node
//   - `getExternalJobsForDeployment` — audit helper for admin UI + tests
//
// The bridge is intentionally the only surface external adapters touch when
// they create Job rows. Keeping that funnel narrow means the job-processor,
// routing log, and earnings accrual paths all agree on one shape.
//
// Out of scope (explicit, deferred to live-mode):
//   - Routing external workload payloads into Docker containers on the node
//   - Calling adapter.terminateDeployment on failure — orphan reconciler owns
//     that on its next pass
//   - HTTP endpoints (F5.1) and bootstrap wiring

import type { PrismaClient, Job, JobStatus, JobSource } from '@a2e/database'
import type { AdapterRegistry } from '@a2e/core'
import { recordExternalEarnings } from './listing-manager'

export interface ExternalWorkload {
  /** Market-assigned ID (e.g., Akash bid/lease ID, IO.net job UUID). */
  externalWorkloadId: string
  /** GPU tier the external customer requested. */
  gpuTierRequired: string
  /** Expected workload duration, used to populate `Job.durationSeconds`. */
  durationHours: number
  /** Adapter-specific fields — docker image, env vars, entrypoint, etc. */
  metadata?: Record<string, unknown>
}

export interface WorkloadResult {
  logs?: string
  exitCode?: number
  success: boolean
}

export interface WorkloadFailure {
  errorMessage: string
  code?: string
}

const DEFAULT_MAX_RETRIES = 2

/**
 * Called by an adapter when an external market routes a workload to one of our
 * listed nodes. Creates a Job row with `source=EXTERNAL` linked to the
 * deployment in `ASSIGNED` status, and returns it.
 *
 * Rejects if the deployment is missing or not currently ACTIVE — workloads
 * cannot be accepted against a deployment that we have already begun
 * terminating or that never came online.
 */
export async function onWorkloadReceived(
  prisma: PrismaClient,
  input: {
    deploymentId: string
    workload: ExternalWorkload
  },
): Promise<Job> {
  const deployment = await prisma.externalDeployment.findUnique({
    where: { id: input.deploymentId },
    include: { node: true },
  })
  if (!deployment) {
    throw new Error('deployment not found')
  }
  if (deployment.status !== 'ACTIVE') {
    throw new Error('deployment not active — cannot accept workload')
  }

  const now = new Date()
  const durationSeconds = Math.round(input.workload.durationHours * 3600)

  const job = await prisma.job.create({
    data: {
      // Reuse Job.deploymentId for the external market's workload ID — this
      // mirrors how TokenOS-internal jobs carry their upstream reference in
      // the same column.
      deploymentId: input.workload.externalWorkloadId,
      source: 'EXTERNAL' as JobSource,
      externalDeploymentId: input.deploymentId,
      nodeId: deployment.nodeId,
      market: deployment.market,
      gpuTier: deployment.node.gpuTier,
      ratePerHour: deployment.ratePerHour,
      status: 'ASSIGNED' as JobStatus,
      requestedAt: now,
      routedAt: now,
      durationSeconds,
    },
  })

  return job
}

/**
 * Called when the node agent (or a simulation test) reports the external
 * workload has finished. Updates the Job to `COMPLETED`, computes earnings
 * from the planned duration, and delegates the Earning/Deployment updates to
 * `recordExternalEarnings` — the canonical path owned by listing-manager.
 *
 * Idempotent: calling twice on an already-completed Job returns zero delta.
 */
export async function onWorkloadCompleted(
  prisma: PrismaClient,
  registry: AdapterRegistry,
  input: {
    jobId: string
    result: WorkloadResult
  },
): Promise<{ job: Job; earningsDelta: number }> {
  const job = await prisma.job.findUnique({ where: { id: input.jobId } })
  if (!job) {
    throw new Error('job not found')
  }
  if (job.source !== 'EXTERNAL') {
    throw new Error('not an external job')
  }
  if (job.status === 'COMPLETED') {
    return { job, earningsDelta: 0 }
  }
  if (!job.externalDeploymentId) {
    throw new Error('external job missing externalDeploymentId')
  }

  const ratePerHour = job.ratePerHour ?? 0
  const durationSeconds = job.durationSeconds ?? 0
  const earnings = input.result.success
    ? ratePerHour * (durationSeconds / 3600)
    : 0

  const now = new Date()
  const updated = await prisma.job.update({
    where: { id: job.id },
    data: {
      status: 'COMPLETED' as JobStatus,
      completedAt: now,
      startedAt: job.startedAt ?? job.requestedAt,
      earnings,
    },
  })

  await recordExternalEarnings(prisma, registry, job.externalDeploymentId)

  return { job: updated, earningsDelta: earnings }
}

/**
 * Called when the node agent reports the external workload failed. Increments
 * `Job.retryCount` on every call. Once retries are exhausted the Job is
 * flipped to `FAILED` and the linked ExternalDeployment is marked `FAILED`
 * too — the orphan reconciler (F4.3) will pick up the deployment and call
 * `adapter.terminateDeployment` on its next pass.
 *
 * Below the retry threshold this is a soft failure: we record the error
 * message and bump the counter but leave status at `ASSIGNED` so the live-mode
 * caller can re-enqueue.
 */
export async function onWorkloadFailed(
  prisma: PrismaClient,
  input: {
    jobId: string
    failure: WorkloadFailure
    maxRetries?: number
  },
): Promise<{ job: Job; deploymentFailed: boolean }> {
  const job = await prisma.job.findUnique({ where: { id: input.jobId } })
  if (!job) {
    throw new Error('job not found')
  }
  if (job.source !== 'EXTERNAL') {
    throw new Error('not an external job')
  }

  const maxRetries = input.maxRetries ?? DEFAULT_MAX_RETRIES
  const nextRetryCount = job.retryCount + 1

  if (nextRetryCount >= maxRetries) {
    const updated = await prisma.job.update({
      where: { id: job.id },
      data: {
        status: 'FAILED' as JobStatus,
        errorMessage: input.failure.errorMessage,
        retryCount: nextRetryCount,
      },
    })

    if (job.externalDeploymentId) {
      await prisma.externalDeployment.update({
        where: { id: job.externalDeploymentId },
        data: {
          status: 'FAILED',
          terminatedAt: new Date(),
          terminationReason: `workload failed: ${input.failure.errorMessage}`,
        },
      })
    }

    return { job: updated, deploymentFailed: true }
  }

  const updated = await prisma.job.update({
    where: { id: job.id },
    data: {
      errorMessage: input.failure.errorMessage,
      retryCount: nextRetryCount,
    },
  })

  return { job: updated, deploymentFailed: false }
}

/**
 * Returns every Job linked to the given ExternalDeployment, newest first.
 * Used by admin UI to show per-deployment workload history and by tests.
 */
export async function getExternalJobsForDeployment(
  prisma: PrismaClient,
  deploymentId: string,
): Promise<Job[]> {
  return prisma.job.findMany({
    where: { externalDeploymentId: deploymentId },
    orderBy: { createdAt: 'desc' },
  })
}
