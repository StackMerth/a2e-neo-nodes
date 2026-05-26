/**
 * Per-node operator-set pricing service. Operators can set their
 * own rate within a configurable band around the YieldFloor (the
 * platform-wide cost floor for their tier). The band protects two
 * things at once:
 *
 *   1. The operator from pricing below their cost (loss-making).
 *   2. Buyers from listings priced so high they distort the
 *      allocator's cheapest-first matching.
 *
 * Defaults: ±25% of the YieldFloor rate. Tunable via env vars
 * (OPERATOR_RATE_FLOOR_PCT / OPERATOR_RATE_CEILING_PCT) so the
 * window can widen for premium-tier hardware later without a code
 * change.
 *
 * Public surface:
 *   - getEffectiveRate(node)        : the rate the allocator + UI use
 *   - getRateBand(gpuTier)          : the [min, max] band for a tier
 *   - validateAndSetOperatorRate()  : write helper for the per-node
 *                                     UI; throws on out-of-band input
 */

import type { PrismaClient, Node, GpuTier } from '@a2e/database'

const FLOOR_PCT = parseFloat(process.env.OPERATOR_RATE_FLOOR_PCT ?? '0.75')      // 75% of YieldFloor
const CEILING_PCT = parseFloat(process.env.OPERATOR_RATE_CEILING_PCT ?? '1.25')  // 125% of YieldFloor

export interface RateBand {
  // Lower bound — operators can't list below this. Equal to
  // YieldFloor * FLOOR_PCT today.
  minPerHour: number
  minPerDay: number
  // Upper bound — operators can't list above this. Equal to
  // YieldFloor * CEILING_PCT.
  maxPerHour: number
  maxPerDay: number
  // The YieldFloor anchor itself, returned so UI can show "market
  // baseline" next to the operator's input slider.
  floorPerHour: number
  floorPerDay: number
}

/**
 * The rate the allocator + UI use for a node. Operator-set rate
 * wins when present; falls back to the YieldFloor rate for the
 * node's tier so pre-#7 nodes keep their existing behavior.
 */
export async function getEffectiveRate(
  prisma: PrismaClient,
  node: Pick<Node, 'gpuTier' | 'operatorRatePerHour' | 'operatorRatePerDay' | 'customRatePerHour' | 'customRatePerDay'>,
): Promise<{ ratePerHour: number; ratePerDay: number; source: 'operator' | 'custom' | 'floor' | 'none' }> {
  // Operator-set rate wins.
  if (node.operatorRatePerHour != null && node.operatorRatePerDay != null) {
    return {
      ratePerHour: node.operatorRatePerHour,
      ratePerDay: node.operatorRatePerDay,
      source: 'operator',
    }
  }

  // Custom-tier rate (OTHER tier) — used when the node is on a tier
  // not covered by YieldFloor.
  if (node.customRatePerHour != null && node.customRatePerDay != null) {
    return {
      ratePerHour: node.customRatePerHour,
      ratePerDay: node.customRatePerDay,
      source: 'custom',
    }
  }

  // Fall back to the YieldFloor rate for this tier.
  const floor = await prisma.yieldFloor.findUnique({
    where: { gpuTier: node.gpuTier },
  })
  if (floor) {
    return {
      ratePerHour: floor.ratePerHour,
      ratePerDay: floor.ratePerDay,
      source: 'floor',
    }
  }

  // Nothing configured at all — should not happen for production
  // tiers (YieldFloor seeded for each), but guard anyway.
  return { ratePerHour: 0, ratePerDay: 0, source: 'none' }
}

/**
 * Compute the allowed band for a given GPU tier. UI surfaces this so
 * the operator sees the min/max inline next to their input field.
 * Throws if no YieldFloor exists for the tier (caller should treat
 * that tier as "operator-set pricing not available yet").
 */
export async function getRateBand(prisma: PrismaClient, gpuTier: GpuTier): Promise<RateBand> {
  const floor = await prisma.yieldFloor.findUnique({ where: { gpuTier } })
  if (!floor) {
    throw new Error(`No YieldFloor seeded for ${gpuTier}; operator-set pricing not available for this tier.`)
  }
  return {
    floorPerHour: floor.ratePerHour,
    floorPerDay: floor.ratePerDay,
    minPerHour: round(floor.ratePerHour * FLOOR_PCT),
    minPerDay: round(floor.ratePerDay * FLOOR_PCT),
    maxPerHour: round(floor.ratePerHour * CEILING_PCT),
    maxPerDay: round(floor.ratePerDay * CEILING_PCT),
  }
}

export class RateOutOfBandError extends Error {
  constructor(public band: RateBand, public attempted: number, public unit: 'hour' | 'day') {
    super(
      `Operator rate $${attempted.toFixed(2)} / ${unit} is outside the allowed band ` +
      `[$${(unit === 'hour' ? band.minPerHour : band.minPerDay).toFixed(2)}, ` +
      `$${(unit === 'hour' ? band.maxPerHour : band.maxPerDay).toFixed(2)}].`,
    )
    this.name = 'RateOutOfBandError'
  }
}

/**
 * Validate + write the operator-set rate for a node. The caller
 * passes a per-hour value; we compute per-day as hour*24 so the
 * two columns stay consistent.
 *
 * Pass null to clear the override (reverts to YieldFloor default).
 */
export async function validateAndSetOperatorRate(
  prisma: PrismaClient,
  nodeId: string,
  newRatePerHour: number | null,
): Promise<{ ratePerHour: number | null; ratePerDay: number | null; source: 'operator' | 'floor' }> {
  const node = await prisma.node.findUnique({
    where: { id: nodeId },
    select: { id: true, gpuTier: true },
  })
  if (!node) throw new Error('Node not found')

  if (newRatePerHour === null) {
    await prisma.node.update({
      where: { id: nodeId },
      data: {
        operatorRatePerHour: null,
        operatorRatePerDay: null,
        operatorRateUpdatedAt: new Date(),
      },
    })
    return { ratePerHour: null, ratePerDay: null, source: 'floor' }
  }

  // OTHER tier doesn't have a YieldFloor anchor; reject the override
  // here and steer the caller to the customRatePerHour field instead.
  if (node.gpuTier === 'OTHER') {
    throw new Error('Operator-set pricing is not available for OTHER tier; use customRatePerHour on the node directly.')
  }

  const band = await getRateBand(prisma, node.gpuTier)
  if (newRatePerHour < band.minPerHour || newRatePerHour > band.maxPerHour) {
    throw new RateOutOfBandError(band, newRatePerHour, 'hour')
  }

  const newRatePerDay = round(newRatePerHour * 24)
  await prisma.node.update({
    where: { id: nodeId },
    data: {
      operatorRatePerHour: round(newRatePerHour),
      operatorRatePerDay: newRatePerDay,
      operatorRateUpdatedAt: new Date(),
    },
  })

  return {
    ratePerHour: round(newRatePerHour),
    ratePerDay: newRatePerDay,
    source: 'operator',
  }
}

function round(n: number): number {
  // 2dp avoids floating-point noise on round-trips; matches the
  // precision YieldFloor stores at.
  return Math.round(n * 100) / 100
}
