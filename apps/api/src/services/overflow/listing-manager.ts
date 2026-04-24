// Overflow Listing Manager (F3.3)
//
// Write-side counterpart to the decision engine in ./engine.ts. The decision
// engine is a pure read — it tells the caller whether and where to list a node,
// but does not mutate anything. This module performs the actual mutations:
//   - list a node onto an external market (create deployment + DB row)
//   - delist a node (SAFE marks TERMINATING; FORCE calls the adapter)
//   - sync a deployment's current status and accumulated cost back to our DB
//   - translate accumulated cost into Earning rows via daily upsert
//
// Every adapter call is wrapped in try/catch to keep AdapterRegistry health
// accurate. The four functions are invoked by the overflow scheduler (F3.2),
// the status-checker worker (F4.1), and the earnings calculator (F4.2).

import type { Queue } from 'bullmq'
import type {
  PrismaClient,
  ExternalDeployment,
  ExternalDeploymentStatus,
  ExternalTerminationMode,
} from '@a2e/database'
import type { AdapterRegistry, DeploymentStatus } from '@a2e/core'
import { getOrCreateOverflowConfig } from './engine'
import { scheduleSafeTermination } from './termination-policy'

type ExternalMarket = 'AKASH' | 'IONET' | 'VASTAI'

// Deployment statuses that prevent a node from being listed again.
const BLOCKING_DEPLOYMENT_STATUSES: ReadonlyArray<ExternalDeploymentStatus> = [
  'PENDING',
  'ACTIVE',
  'TERMINATING',
]

// Terminal statuses — neither delist, sync, nor recordEarnings should mutate
// these (aside from idempotent no-ops).
const TERMINAL_DEPLOYMENT_STATUSES: ReadonlyArray<ExternalDeploymentStatus> = [
  'TERMINATED',
  'FAILED',
]

export interface ListNodeInput {
  nodeId: string
  market: ExternalMarket
  ratePerHour: number
}

export interface ListNodeResult {
  deploymentId: string
  externalId: string
  status: ExternalDeploymentStatus
}

export interface DelistNodeInput {
  deploymentId: string
  mode: ExternalTerminationMode
  reason: string
  /**
   * Optional BullMQ queue for the SAFE termination policy worker. When
   * provided and mode is SAFE and this call actually transitions ACTIVE→
   * TERMINATING (i.e. not a no-op), a delayed poll job is enqueued. Tests
   * and admin callers that drive the policy themselves can omit this.
   */
  terminationQueue?: Queue
}

export interface DelistNodeResult {
  status: ExternalDeploymentStatus
  terminated: boolean
}

export interface RecordEarningsResult {
  deltaUsd: number
  totalUsd: number
}

/**
 * Create an external deployment for an idle node.
 *
 * Calls `adapter.createDeployment` and persists a new ExternalDeployment row
 * reflecting the adapter's reported status. Health is recorded on the registry
 * for both success and failure paths. Throws if the adapter is unavailable,
 * the node is missing, the node already has a live deployment, or the adapter
 * itself rejects the call — callers retain retry control.
 */
export async function listNodeExternally(
  prisma: PrismaClient,
  registry: AdapterRegistry,
  input: ListNodeInput,
): Promise<ListNodeResult> {
  const adapter = registry.get(input.market)
  if (!adapter || !registry.isAvailable(input.market)) {
    throw new Error(`market ${input.market} not available`)
  }

  const node = await prisma.node.findUnique({
    where: { id: input.nodeId },
    select: { gpuTier: true },
  })
  if (!node) {
    throw new Error(`node ${input.nodeId} not found`)
  }

  const existing = await prisma.externalDeployment.findFirst({
    where: {
      nodeId: input.nodeId,
      status: { in: [...BLOCKING_DEPLOYMENT_STATUSES] },
    },
    select: { id: true },
  })
  if (existing) {
    throw new Error('node already has an active external deployment')
  }

  let result
  try {
    result = await adapter.createDeployment({
      nodeId: input.nodeId,
      gpuTier: node.gpuTier,
    })
    registry.recordSuccess(input.market)
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    registry.recordFailure(input.market, err)
    throw err
  }

  const row = await prisma.externalDeployment.create({
    data: {
      nodeId: input.nodeId,
      market: input.market,
      externalId: result.externalId,
      status: mapAdapterStatusToDbStatus(result.status),
      ratePerHour: input.ratePerHour,
    },
  })

  return {
    deploymentId: row.id,
    externalId: row.externalId,
    status: row.status,
  }
}

/**
 * Terminate an external deployment.
 *
 * SAFE mode only flips the row to TERMINATING and records the reason — the
 * termination-policy worker (F3.5) later calls this function again with FORCE
 * once the grace window expires or the workload completes.
 *
 * FORCE mode calls the adapter immediately. If the adapter call fails we still
 * mark the row TERMINATED locally; the orphan reconciler (F4.3) will reconcile
 * any leaked external state later. Idempotent on deployments already in a
 * terminal state.
 */
export async function delistNode(
  prisma: PrismaClient,
  registry: AdapterRegistry,
  input: DelistNodeInput,
): Promise<DelistNodeResult> {
  const deployment = await prisma.externalDeployment.findUnique({
    where: { id: input.deploymentId },
  })
  if (!deployment) {
    throw new Error(`deployment ${input.deploymentId} not found`)
  }

  if (TERMINAL_DEPLOYMENT_STATUSES.includes(deployment.status)) {
    return { status: deployment.status, terminated: false }
  }

  if (input.mode === 'SAFE') {
    if (deployment.status === 'TERMINATING') {
      return { status: deployment.status, terminated: false }
    }

    const updated = await prisma.externalDeployment.update({
      where: { id: deployment.id },
      data: {
        status: 'TERMINATING',
        terminationMode: 'SAFE',
        terminationReason: input.reason,
      },
    })

    if (input.terminationQueue) {
      const config = await getOrCreateOverflowConfig(prisma)
      await scheduleSafeTermination(input.terminationQueue, {
        deploymentId: deployment.id,
        reason: input.reason,
        gracePeriodSeconds: config.gracePeriodSeconds,
      })
    }

    return { status: updated.status, terminated: false }
  }

  // FORCE mode — call adapter, absorb failures, still mark TERMINATED.
  let augmentedReason = input.reason
  const market = deployment.market as ExternalMarket
  const adapter = registry.get(market)

  if (adapter) {
    try {
      await adapter.terminateDeployment(deployment.externalId)
      registry.recordSuccess(market)
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      registry.recordFailure(market, err)
      augmentedReason = `${input.reason} (adapter terminate failed: ${err.message})`
    }
  } else {
    augmentedReason = `${input.reason} (adapter terminate failed: no adapter registered for ${market})`
  }

  const updated = await prisma.externalDeployment.update({
    where: { id: deployment.id },
    data: {
      status: 'TERMINATED',
      terminatedAt: new Date(),
      terminationMode: 'FORCE',
      terminationReason: augmentedReason,
    },
  })

  return { status: updated.status, terminated: true }
}

/**
 * Pull the latest status + accumulated cost from the external market and
 * persist them. On status fetch failure we update `lastCheckedAt` only — the
 * row stays otherwise untouched and the failure is recorded against the
 * adapter. On cost fetch failure the status update still lands.
 *
 * No-op on deployments already in a terminal state.
 */
export async function syncDeploymentStatus(
  prisma: PrismaClient,
  registry: AdapterRegistry,
  deploymentId: string,
): Promise<ExternalDeployment> {
  const deployment = await prisma.externalDeployment.findUnique({
    where: { id: deploymentId },
  })
  if (!deployment) {
    throw new Error(`deployment ${deploymentId} not found`)
  }

  if (TERMINAL_DEPLOYMENT_STATUSES.includes(deployment.status)) {
    return deployment
  }

  const market = deployment.market as ExternalMarket
  const adapter = registry.get(market)
  if (!adapter) {
    return prisma.externalDeployment.update({
      where: { id: deployment.id },
      data: { lastCheckedAt: new Date() },
    })
  }

  let statusResult
  try {
    statusResult = await adapter.getDeploymentStatus(deployment.externalId)
    registry.recordSuccess(market)
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    registry.recordFailure(market, err)
    return prisma.externalDeployment.update({
      where: { id: deployment.id },
      data: { lastCheckedAt: new Date() },
    })
  }

  let costResult: { accumulatedUsd: number } | null = null
  try {
    costResult = await adapter.getDeploymentCost(deployment.externalId)
    registry.recordSuccess(market)
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    registry.recordFailure(market, err)
    costResult = null
  }

  const nextStatus = mapAdapterStatusToDbStatus(statusResult.status)
  const data: {
    status: ExternalDeploymentStatus
    costAccumulated?: number
    lastCheckedAt: Date
    terminatedAt?: Date
  } = {
    status: nextStatus,
    lastCheckedAt: new Date(),
  }

  if (costResult) {
    data.costAccumulated = costResult.accumulatedUsd
  }

  if (nextStatus === 'TERMINATED' && !deployment.terminatedAt) {
    data.terminatedAt = new Date()
  }

  return prisma.externalDeployment.update({
    where: { id: deployment.id },
    data,
  })
}

/**
 * Fetch the latest accumulated cost, compute the delta against what we have
 * already recorded, and upsert into Earning (keyed by nodeId/date/market).
 * The row's `earningsAccumulated` is advanced to the latest adapter total.
 *
 * `gpuSeconds` is best-effort: we have no direct wall-clock reading from the
 * adapter here, so we derive it from `deltaUsd / ratePerHour * 3600`. If the
 * adapter's reported cost moves backwards (shouldn't happen, but defensive),
 * we treat the delta as zero.
 */
export async function recordExternalEarnings(
  prisma: PrismaClient,
  registry: AdapterRegistry,
  deploymentId: string,
): Promise<RecordEarningsResult> {
  const deployment = await prisma.externalDeployment.findUnique({
    where: { id: deploymentId },
  })
  if (!deployment) {
    throw new Error(`deployment ${deploymentId} not found`)
  }

  const market = deployment.market as ExternalMarket
  const adapter = registry.get(market)
  if (!adapter) {
    return { deltaUsd: 0, totalUsd: deployment.earningsAccumulated }
  }

  let costResult
  try {
    costResult = await adapter.getDeploymentCost(deployment.externalId)
    registry.recordSuccess(market)
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    registry.recordFailure(market, err)
    return { deltaUsd: 0, totalUsd: deployment.earningsAccumulated }
  }

  const deltaUsd = costResult.accumulatedUsd - deployment.earningsAccumulated
  if (deltaUsd <= 0) {
    return { deltaUsd: 0, totalUsd: deployment.earningsAccumulated }
  }

  const date = new Date()
  date.setUTCHours(0, 0, 0, 0)

  const gpuSeconds =
    deployment.ratePerHour > 0
      ? Math.max(0, Math.round((deltaUsd / deployment.ratePerHour) * 3600))
      : 0

  await prisma.earning.upsert({
    where: {
      nodeId_date_market: {
        nodeId: deployment.nodeId,
        date,
        market: deployment.market,
      },
    },
    update: {
      earnings: { increment: deltaUsd },
      gpuSeconds: { increment: gpuSeconds },
    },
    create: {
      nodeId: deployment.nodeId,
      date,
      market: deployment.market,
      earnings: deltaUsd,
      gpuSeconds,
      jobCount: 0,
    },
  })

  await prisma.externalDeployment.update({
    where: { id: deployment.id },
    data: { earningsAccumulated: costResult.accumulatedUsd },
  })

  return { deltaUsd, totalUsd: costResult.accumulatedUsd }
}

// The adapter's DeploymentStatus enum and our Prisma ExternalDeploymentStatus
// enum use identical names by design — documented here so a future rename on
// either side trips this mapper rather than silently diverging.
function mapAdapterStatusToDbStatus(
  adapterStatus: DeploymentStatus,
): ExternalDeploymentStatus {
  return adapterStatus
}
