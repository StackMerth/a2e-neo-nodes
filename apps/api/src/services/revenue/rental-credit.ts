/**
 * Track 5 / M0.3 — credit a completed rental's revenue under Model C.
 *
 * Single entry point called from both rental completion paths:
 *   - rental-expiry.ts (natural expiry at end of term)
 *   - routes/buyer-compute.ts (buyer early-terminate)
 *
 * When the REVENUE_SPLIT_ENABLED kill switch is OFF, this function is
 * a no-op — operators continue to earn the legacy uptime stipend via
 * earnings-rollup and no per-rental credit is written. When the flag
 * is ON, the uptime stipend is suppressed (handled in
 * earnings-rollup.ts) and this function distributes the rental
 * revenue across the operator + staking + treasury per Model C:
 *
 *   For each allocated node N on the rental:
 *     grossUsd  = (rental's accruedCost) / nodeCount  (equal-split v1)
 *     costUsd   = cost-of-service for N over the rental duration
 *     splitRevenue() credits STAKING_POOL_SHARE + TREASURY_SHARE
 *     to virtual users, returns operatorTotalUsd
 *     One Earning row upserted with market='RENTAL' for this node
 *     keyed by (nodeId, completedAt.date, RENTAL) so re-runs are
 *     idempotent.
 *
 * Idempotency is enforced two layers deep:
 *   - RevenueShareEntry has unique(referenceId). Our referenceId is
 *     `${computeRequestId}:${nodeId}` so a retry of this helper for
 *     the same rental can't double-credit any of the three ledger
 *     destinations.
 *   - Earning has unique(nodeId, date, market). The upsert path is
 *     update-or-create, so a retry refreshes the same row in place.
 *
 * Multi-node note (v1 simplification): equal-split assumes every
 * allocated node contributed equally to the rental's gross revenue.
 * Long-term we'd weight by each node's listed price. For single-node
 * rentals (the common case) this is exact. The comment in the loop
 * flags the simplification for the M0.5 reconciliation reviewer.
 */

import type { PrismaClient, Market } from '@a2e/database'
import { computeCostOfService } from './cost-of-service.js'
import { splitRevenue, isRevenueSplitEnabled } from './split.js'

const MARKET_RENTAL: Market = 'RENTAL'

export interface CreditCompletedRentalResult {
  /** True iff the kill switch was ON and a credit was written. */
  applied: boolean
  /** Per-node breakdown for the M0.3 test script + reconciliation. */
  perNode: Array<{
    nodeId: string
    operatorUserId: string | null
    grossUsd: number
    costUsd: number
    operatorTotalUsd: number
    stakingShareUsd: number
    treasuryShareUsd: number
    earningId: string | null
    firstWrite: boolean
  }>
}

export interface CreditCompletedRentalArgs {
  /** ComputeRequest.id of the just-completed rental. */
  computeRequestId: string
  /**
   * Optional override for the gross to credit. When omitted, the
   * helper uses ComputeRequest.accruedCost (the actual amount the
   * buyer was charged after any refund). Passed explicitly by the
   * terminate route when it already knows the post-refund amount.
   */
  grossOverrideUsd?: number
}

/**
 * Idempotent helper. Safe to call multiple times on the same rental;
 * a retry inspects the existing RevenueShareEntry rows and returns
 * the prior result without re-crediting anyone.
 */
export async function creditCompletedRental(
  prisma: PrismaClient,
  args: CreditCompletedRentalArgs,
): Promise<CreditCompletedRentalResult> {
  if (!isRevenueSplitEnabled()) {
    return { applied: false, perNode: [] }
  }

  const cr = await prisma.computeRequest.findUnique({
    where: { id: args.computeRequestId },
    select: {
      id: true,
      status: true,
      activatedAt: true,
      completedAt: true,
      expiresAt: true,
      totalCost: true,
      accruedCost: true,
      allocatedNodeIds: true,
      gpuTier: true,
    },
  })
  if (!cr) {
    throw new Error(`creditCompletedRental: ComputeRequest not found: ${args.computeRequestId}`)
  }
  if (cr.status !== 'COMPLETED') {
    throw new Error(`creditCompletedRental: request ${cr.id} status is ${cr.status}, expected COMPLETED`)
  }
  if (cr.allocatedNodeIds.length === 0) {
    // Pathological — a rental was COMPLETED without any nodes. Nothing
    // to credit. We still log this for forensics but don't throw.
    console.warn(`[rental-credit] no allocated nodes on ${cr.id}; skipping split`)
    return { applied: true, perNode: [] }
  }

  // Gross = whichever override the caller passed, else what the buyer
  // was actually billed (accruedCost). For natural expiry that's
  // totalCost; for early term it's the partial amount.
  const grossTotal = args.grossOverrideUsd ?? cr.accruedCost ?? cr.totalCost
  const nodeCount = cr.allocatedNodeIds.length
  const grossPerNode = round4(grossTotal / nodeCount)

  // Rental duration in seconds: prefer completedAt - activatedAt for
  // precision; fall back to the request's planned duration if either
  // timestamp is missing (defensive — shouldn't happen for COMPLETED).
  const durationSeconds = computeDurationSeconds(cr)

  const settlementDate = startOfUtcDay(cr.completedAt ?? new Date())

  const perNode: CreditCompletedRentalResult['perNode'] = []

  for (const nodeId of cr.allocatedNodeIds) {
    const node = await prisma.node.findUnique({
      where: { id: nodeId },
      select: {
        id: true,
        nodeRunner: { select: { userId: true } },
      },
    })
    const operatorUserId = node?.nodeRunner?.userId ?? null

    if (!operatorUserId) {
      // Node has no nodeRunner — datacenter-provisioned with no
      // owner attached, or the operator account was deleted. We
      // record this in the result for reconciliation but skip the
      // credit (no recipient).
      perNode.push({
        nodeId,
        operatorUserId: null,
        grossUsd: grossPerNode,
        costUsd: 0,
        operatorTotalUsd: 0,
        stakingShareUsd: 0,
        treasuryShareUsd: 0,
        earningId: null,
        firstWrite: false,
      })
      continue
    }

    const breakdown = await computeCostOfService(prisma, {
      nodeId,
      durationSeconds,
    })
    const costPerNode = round4(breakdown.totalUsd)

    // Composite referenceId so multi-node rentals get one
    // RevenueShareEntry per (rental, node) pair. Idempotent on
    // retry: the existing row is returned.
    const referenceId = `${cr.id}:${nodeId}`

    const split = await splitRevenue(prisma, {
      sourceTxType: 'SPEND_RENTAL',
      referenceId,
      grossUsd: grossPerNode,
      costUsd: costPerNode,
      operatorUserId,
      description: `Rental ${cr.id} share on node ${nodeId}`,
    })

    // Write the operator's per-rental Earning. Keyed by
    // (nodeId, date, RENTAL) so re-running this helper updates the
    // existing row instead of creating a duplicate.
    let earningId: string | null = null
    if (split.operatorTotalUsd > 0) {
      const earning = await prisma.earning.upsert({
        where: {
          nodeId_date_market: {
            nodeId,
            date: settlementDate,
            market: MARKET_RENTAL,
          },
        },
        create: {
          nodeId,
          date: settlementDate,
          market: MARKET_RENTAL,
          gpuSeconds: durationSeconds,
          earnings: split.operatorTotalUsd,
          jobCount: 1,
        },
        update: {
          // Daily aggregation: a node serving multiple rentals on
          // the same day gets its earnings summed. The audit table
          // RevenueShareEntry retains the per-rental granularity.
          gpuSeconds: { increment: durationSeconds },
          earnings: { increment: split.firstWrite ? split.operatorTotalUsd : 0 },
          jobCount: { increment: split.firstWrite ? 1 : 0 },
        },
        select: { id: true },
      })
      earningId = earning.id
    }

    perNode.push({
      nodeId,
      operatorUserId,
      grossUsd: grossPerNode,
      costUsd: costPerNode,
      operatorTotalUsd: split.operatorTotalUsd,
      stakingShareUsd: split.stakingShareUsd,
      treasuryShareUsd: split.treasuryShareUsd,
      earningId,
      firstWrite: split.firstWrite,
    })
  }

  return { applied: true, perNode }
}

function computeDurationSeconds(cr: {
  activatedAt: Date | null
  completedAt: Date | null
  expiresAt: Date | null
}): number {
  if (cr.activatedAt && cr.completedAt) {
    return Math.max(0, Math.floor((cr.completedAt.getTime() - cr.activatedAt.getTime()) / 1000))
  }
  if (cr.activatedAt && cr.expiresAt) {
    return Math.max(0, Math.floor((cr.expiresAt.getTime() - cr.activatedAt.getTime()) / 1000))
  }
  return 0
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0))
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}
