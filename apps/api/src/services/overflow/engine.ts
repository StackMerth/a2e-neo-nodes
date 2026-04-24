// Overflow Decision Engine (F3.1)
//
// Pure decision logic for deciding when a node should be listed on an external
// market (Akash / IO.net / Vast.ai) and which market offers the best rate.
// Called by the overflow scheduler (F3.2) every 60 seconds. This module does
// not mutate state — it reads config, inspects node state, and consults the
// rate provider to produce decisions.

import type { PrismaClient, Node, OverflowConfig } from '@a2e/database'
import type { GpuTier } from '@a2e/shared'
import {
  type AdapterRegistry,
  type RateProvider,
  type MarketRates,
  type MarketRateInfo,
  DefaultYieldFloorConfig,
  type YieldFloorConfig,
} from '@a2e/core'

type ExternalMarket = 'AKASH' | 'IONET' | 'VASTAI'

// Heartbeat freshness threshold. A node whose heartbeat is older than this
// is considered stale even if its status column still says ONLINE.
const RECENT_HEARTBEAT_MS = 5 * 60 * 1000

// Job statuses that count as "active" — the node is committed to an internal
// workload and should not be listed externally.
const ACTIVE_JOB_STATUSES = ['PENDING', 'ROUTING', 'ASSIGNED', 'RUNNING'] as const

// Job statuses that count as "busy" when measuring demand. PENDING is excluded
// here because unrouted pending jobs aren't yet committed to a specific node.
const BUSY_JOB_STATUSES = ['ROUTING', 'ASSIGNED', 'RUNNING'] as const

// Deployment statuses that block a node from being re-listed.
const BLOCKING_DEPLOYMENT_STATUSES = ['PENDING', 'ACTIVE', 'TERMINATING'] as const

export interface IdleNode {
  id: string
  gpuTier: GpuTier
  customRatePerHour: number | null
  walletAddress: string
}

export interface OverflowDecisionContext {
  config: OverflowConfig
  registry: AdapterRegistry
  rateProvider: RateProvider
  /**
   * Optional yield-floor override. Falls back to DefaultYieldFloorConfig when
   * omitted — which reads cost floor from GPU_TIER_CONFIG.
   */
  yieldFloor?: YieldFloorConfig
}

export interface MarketCandidate {
  market: ExternalMarket
  ratePerHour: number
  available: boolean
  /** Populated when excluded from selection. */
  excludedReason?: string
}

export interface BestMarketResult {
  market: ExternalMarket | null
  ratePerHour: number
  reason: string
  candidatesConsidered: MarketCandidate[]
}

/**
 * Load the singleton OverflowConfig, creating it with schema defaults on first
 * access. The config table has exactly one row with id='singleton'.
 */
export async function getOrCreateOverflowConfig(
  prisma: PrismaClient,
): Promise<OverflowConfig> {
  return prisma.overflowConfig.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton' },
    update: {},
  })
}

/**
 * Return nodes currently ONLINE, with a recent heartbeat, no active/pending
 * job, no active external deployment, and that have been idle for at least
 * `idleThresholdMinutes` (measured from last job completion, or creation time
 * if the node has never had a job).
 */
export async function detectIdleNodes(
  prisma: PrismaClient,
  idleThresholdMinutes: number,
): Promise<IdleNode[]> {
  const now = Date.now()
  const heartbeatCutoff = new Date(now - RECENT_HEARTBEAT_MS)
  const idleCutoff = new Date(now - idleThresholdMinutes * 60 * 1000)

  const nodes = await prisma.node.findMany({
    where: {
      status: 'ONLINE',
      pendingDeletion: false,
      lastHeartbeat: { gte: heartbeatCutoff },
      // No job currently occupying the node.
      jobs: {
        none: {
          status: { in: [...ACTIVE_JOB_STATUSES] },
        },
      },
      // Not already listed externally.
      externalDeployments: {
        none: {
          status: { in: [...BLOCKING_DEPLOYMENT_STATUSES] },
        },
      },
    },
    select: {
      id: true,
      gpuTier: true,
      customRatePerHour: true,
      walletAddress: true,
      createdAt: true,
      jobs: {
        select: { completedAt: true },
        orderBy: { completedAt: 'desc' },
        take: 1,
      },
    },
  })

  const idle: IdleNode[] = []
  for (const node of nodes) {
    const lastJob = node.jobs[0]
    const lastActivityAt = lastJob?.completedAt ?? node.createdAt
    if (!lastActivityAt) continue
    if (lastActivityAt.getTime() > idleCutoff.getTime()) continue

    idle.push({
      id: node.id,
      gpuTier: node.gpuTier,
      customRatePerHour: node.customRatePerHour,
      walletAddress: node.walletAddress,
    })
  }

  return idle
}

/**
 * Returns true when at least `demandThresholdPercent` of online nodes are
 * serving internal jobs (assigned to an active job or reserved to an ACTIVE
 * ComputeRequest). Nodes currently listed externally are excluded from the
 * denominator — they are not candidates for internal allocation.
 */
export async function detectHighDemand(
  prisma: PrismaClient,
  demandThresholdPercent: number,
): Promise<boolean> {
  const heartbeatCutoff = new Date(Date.now() - RECENT_HEARTBEAT_MS)

  const onlineNodes = await prisma.node.findMany({
    where: {
      status: 'ONLINE',
      pendingDeletion: false,
      lastHeartbeat: { gte: heartbeatCutoff },
      externalDeployments: {
        none: {
          status: { in: [...BLOCKING_DEPLOYMENT_STATUSES] },
        },
      },
    },
    select: {
      id: true,
      assignedComputeRequestId: true,
      jobs: {
        where: { status: { in: [...BUSY_JOB_STATUSES] } },
        select: { id: true },
        take: 1,
      },
    },
  })

  const total = onlineNodes.length
  if (total === 0) return false

  let busy = 0
  for (const node of onlineNodes) {
    if (node.assignedComputeRequestId !== null) {
      busy += 1
      continue
    }
    if (node.jobs.length > 0) {
      busy += 1
    }
  }

  const percent = (busy / total) * 100
  return percent >= demandThresholdPercent
}

/**
 * Decide whether the given node should be listed externally right now.
 * Returns `{ shouldList: false, reason }` on any precondition failure.
 */
export async function shouldListExternally(
  prisma: PrismaClient,
  ctx: OverflowDecisionContext,
  nodeId: string,
): Promise<{ shouldList: boolean; reason: string }> {
  if (!ctx.config.enabled) {
    return { shouldList: false, reason: 'overflow disabled' }
  }

  const node = await prisma.node.findUnique({
    where: { id: nodeId },
    select: {
      id: true,
      status: true,
      pendingDeletion: true,
      gpuTier: true,
      customRatePerHour: true,
    },
  })

  if (!node) {
    return { shouldList: false, reason: 'node not found' }
  }
  if (node.pendingDeletion) {
    return { shouldList: false, reason: 'node pending deletion' }
  }
  if (node.status !== 'ONLINE') {
    return { shouldList: false, reason: `node status ${node.status}` }
  }

  const activeJob = await prisma.job.findFirst({
    where: {
      nodeId,
      status: { in: [...ACTIVE_JOB_STATUSES] },
    },
    select: { id: true },
  })
  if (activeJob) {
    return { shouldList: false, reason: 'node has active job' }
  }

  const existingDeployment = await prisma.externalDeployment.findFirst({
    where: {
      nodeId,
      status: { in: [...BLOCKING_DEPLOYMENT_STATUSES] },
    },
    select: { id: true },
  })
  if (existingDeployment) {
    return { shouldList: false, reason: 'node already externally deployed' }
  }

  const highDemand = await detectHighDemand(prisma, ctx.config.demandThresholdPercent)
  if (highDemand) {
    return { shouldList: false, reason: 'internal demand high' }
  }

  const best = await selectBestMarket(ctx, node.gpuTier, node.customRatePerHour)
  if (best.market === null) {
    return { shouldList: false, reason: best.reason }
  }

  const rateLabel = best.ratePerHour.toFixed(2)
  return {
    shouldList: true,
    reason: `idle, demand low, ${best.market} rate $${rateLabel}/hr meets margin`,
  }
}

/**
 * Decide whether a node currently listed externally should be delisted.
 * `mode` is 'SAFE' by default (drain via grace period) and 'FORCE' only when
 * the adapter reports as unavailable — in which case we can't even talk to
 * the market to wind down gracefully.
 */
export async function shouldDelistExternally(
  prisma: PrismaClient,
  ctx: OverflowDecisionContext,
  nodeId: string,
): Promise<{ shouldDelist: boolean; reason: string; mode: 'SAFE' | 'FORCE' }> {
  if (!ctx.config.enabled) {
    return { shouldDelist: true, reason: 'overflow disabled', mode: 'SAFE' }
  }

  const deployment = await prisma.externalDeployment.findFirst({
    where: { nodeId, status: 'ACTIVE' },
    select: { id: true, market: true },
    orderBy: { createdAt: 'desc' },
  })

  if (!deployment) {
    return { shouldDelist: false, reason: 'not externally deployed', mode: 'SAFE' }
  }

  const highDemand = await detectHighDemand(prisma, ctx.config.demandThresholdPercent)
  if (highDemand) {
    return { shouldDelist: true, reason: 'internal demand high', mode: 'SAFE' }
  }

  if (deployment.market === 'INTERNAL') {
    // Defensive — should never happen. Treat as corrupted state.
    return {
      shouldDelist: true,
      reason: 'deployment market is INTERNAL (invalid)',
      mode: 'FORCE',
    }
  }

  if (!ctx.registry.isAvailable(deployment.market)) {
    return {
      shouldDelist: true,
      reason: `market ${deployment.market} unavailable`,
      mode: 'FORCE',
    }
  }

  return { shouldDelist: false, reason: 'still productive', mode: 'SAFE' }
}

/**
 * Select the highest-paying external market for this GPU tier, enforcing the
 * yield floor and the configured marginProtectionPercent over internal cost
 * floor. Returns `{ market: null, ... }` when nothing meets the criteria.
 * The returned `candidatesConsidered` is populated for all three markets to
 * provide an audit trail.
 */
export async function selectBestMarket(
  ctx: OverflowDecisionContext,
  gpuTier: GpuTier,
  customRatePerHour: number | null,
): Promise<BestMarketResult> {
  const yieldFloor = (ctx.yieldFloor ?? new DefaultYieldFloorConfig()).getFloor(gpuTier)

  // For OTHER tier the default floor is zero. Fall back to the node's own
  // custom hourly rate so we still enforce meaningful margin protection.
  const costFloorPerHour =
    gpuTier === 'OTHER' && customRatePerHour !== null && customRatePerHour > 0
      ? customRatePerHour
      : yieldFloor.ratePerHour

  const rates: MarketRates = await ctx.rateProvider.getRates(gpuTier)
  const marginProtection = ctx.config.marginProtectionPercent

  const markets: ReadonlyArray<{ market: ExternalMarket; info: MarketRateInfo }> = [
    { market: 'AKASH', info: rates.akash },
    { market: 'IONET', info: rates.ionet },
    { market: 'VASTAI', info: rates.vastai },
  ]

  const candidates: MarketCandidate[] = []
  const eligible: MarketCandidate[] = []

  for (const { market, info } of markets) {
    const available = info.available && ctx.registry.isAvailable(market)
    const candidate: MarketCandidate = {
      market,
      ratePerHour: info.ratePerHour,
      available,
    }

    if (!available) {
      candidate.excludedReason = info.available
        ? `${market} adapter unavailable`
        : `${market} rate unavailable`
      candidates.push(candidate)
      continue
    }

    if (costFloorPerHour <= 0) {
      // Without a positive cost floor we can't meaningfully gate on margin.
      // Accept any positive rate.
      if (info.ratePerHour <= 0) {
        candidate.excludedReason = `${market} rate is zero`
        candidates.push(candidate)
        continue
      }
      candidates.push(candidate)
      eligible.push(candidate)
      continue
    }

    const margin = calculateMargin(info.ratePerHour, costFloorPerHour)
    if (margin < marginProtection) {
      candidate.excludedReason = `margin ${margin.toFixed(1)}% below ${marginProtection}% floor`
      candidates.push(candidate)
      continue
    }

    candidates.push(candidate)
    eligible.push(candidate)
  }

  if (eligible.length === 0) {
    return {
      market: null,
      ratePerHour: 0,
      reason: 'no market meets margin protection',
      candidatesConsidered: candidates,
    }
  }

  eligible.sort((a, b) => b.ratePerHour - a.ratePerHour)
  const winner = eligible[0]!

  return {
    market: winner.market,
    ratePerHour: winner.ratePerHour,
    reason: `selected ${winner.market} at $${winner.ratePerHour.toFixed(2)}/hr (floor $${costFloorPerHour.toFixed(2)}/hr)`,
    candidatesConsidered: candidates,
  }
}

/**
 * Compute the percentage margin of `ratePerHour` over `costFloorPerHour`.
 * e.g. rate=1.20, cost=1.00 → 20. Returns -Infinity when the floor is not
 * strictly positive so comparisons against a minimum margin never accept it.
 */
export function calculateMargin(ratePerHour: number, costFloorPerHour: number): number {
  if (costFloorPerHour <= 0) return Number.NEGATIVE_INFINITY
  return ((ratePerHour - costFloorPerHour) / costFloorPerHour) * 100
}

// Re-export the Node type for downstream files that need it without pulling
// directly from @a2e/database in several places.
export type { Node }
