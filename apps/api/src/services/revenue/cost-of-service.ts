/**
 * Track 5 / M0.1 — cost-of-service computation.
 *
 * Under Model C, every revenue debit splits 50/25/25 of NET profit
 * across operator / staking pool / treasury. Net profit = gross −
 * cost-of-service. This module is the single source of truth for that
 * cost, computed deterministically from declared hardware so operators
 * can't inflate their cost to keep more of the 50% profit cut.
 *
 * Lookup order for the SKU baseline:
 *   1) Node.declaredGpuSku (preferred — set at install or by backfill)
 *   2) `TIER_DEFAULT_<gpuTier>` fallback row (always seeded)
 *   3) `TIER_DEFAULT_OTHER` last-resort (never null)
 *
 * Lookup order for the power rate:
 *   1) Node.powerRegion -> PowerRate.region
 *   2) PowerRate.region="GLOBAL" (always seeded)
 *
 * The service caches both lookups for 60s in-process. Both tables
 * change rarely (admin tunes them quarterly at most) and the meter
 * hot path hits this per inference call / per rental minute, so a
 * short TTL is the right tradeoff. Tests can clear the cache via
 * `_clearCostCache()`.
 */

import type { PrismaClient } from '@a2e/database'

interface BaselineRow {
  gpuSku: string
  kwhDraw: number
  hardwareAmortHourly: number
  bandwidthCostHourly: number
  overheadHourly: number
}

const CACHE_TTL_MS = 60_000

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

const baselineCache = new Map<string, CacheEntry<BaselineRow>>()
const rateCache = new Map<string, CacheEntry<number>>()

export function _clearCostCache(): void {
  baselineCache.clear()
  rateCache.clear()
}

async function getBaseline(
  prisma: PrismaClient,
  declaredSku: string | null | undefined,
  gpuTier: string,
): Promise<BaselineRow> {
  const lookupKey = declaredSku && declaredSku.length > 0
    ? declaredSku
    : `TIER_DEFAULT_${gpuTier}`

  const cached = baselineCache.get(lookupKey)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  let row = await prisma.gpuCostBaseline.findUnique({
    where: { gpuSku: lookupKey },
  })

  // Two fallback rungs: tier default if the declared SKU is unknown,
  // then OTHER as the last-resort net so this never throws on the
  // meter hot path.
  if (!row && declaredSku) {
    row = await prisma.gpuCostBaseline.findUnique({
      where: { gpuSku: `TIER_DEFAULT_${gpuTier}` },
    })
  }
  if (!row) {
    row = await prisma.gpuCostBaseline.findUnique({
      where: { gpuSku: 'TIER_DEFAULT_OTHER' },
    })
  }
  if (!row) {
    throw new Error(
      `cost-of-service: no GpuCostBaseline rows present. Run pnpm --filter @a2e/api seed:cost-baselines.`,
    )
  }

  const value: BaselineRow = {
    gpuSku: row.gpuSku,
    kwhDraw: row.kwhDraw,
    hardwareAmortHourly: row.hardwareAmortHourly,
    bandwidthCostHourly: row.bandwidthCostHourly,
    overheadHourly: row.overheadHourly,
  }
  baselineCache.set(lookupKey, {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS,
  })
  return value
}

async function getPowerRate(
  prisma: PrismaClient,
  region: string | null | undefined,
): Promise<number> {
  const lookupKey = region && region.length > 0 ? region : 'GLOBAL'
  const cached = rateCache.get(lookupKey)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  let row = await prisma.powerRate.findUnique({
    where: { region: lookupKey },
  })
  if (!row) {
    row = await prisma.powerRate.findUnique({
      where: { region: 'GLOBAL' },
    })
  }
  if (!row) {
    throw new Error(
      `cost-of-service: no PowerRate rows present. Run pnpm --filter @a2e/api seed:cost-baselines.`,
    )
  }

  rateCache.set(lookupKey, {
    value: row.usdPerKwh,
    expiresAt: Date.now() + CACHE_TTL_MS,
  })
  return row.usdPerKwh
}

export interface CostBreakdown {
  /** Resolved baseline + region used for the calculation. */
  gpuSku: string
  region: string
  /** Per-hour totals at the resolved rate, for admin/inspection UIs. */
  electricityHourly: number
  hardwareAmortHourly: number
  bandwidthCostHourly: number
  overheadHourly: number
  totalHourly: number
  /** What we actually charged for the requested duration. */
  durationSeconds: number
  totalUsd: number
}

export interface CostOfServiceArgs {
  /** Node id whose hardware we're charging cost-of-service for. */
  nodeId: string
  /** Period to charge cost for, in seconds. */
  durationSeconds: number
}

/**
 * Compute cost-of-service in USD for a given node + period.
 *
 * Reads Node.gpuTier, Node.declaredGpuSku, Node.powerRegion, joins
 * the seeded baseline + power rate, and returns a full breakdown so
 * the caller (splitRevenue, admin reconciliation script, etc.) can
 * persist or display every component.
 *
 * Throws if the Node doesn't exist. Returns zero cost for
 * durationSeconds <= 0 so a no-op call (e.g. zero-token inference)
 * doesn't reimburse a negative cost.
 */
export async function computeCostOfService(
  prisma: PrismaClient,
  args: CostOfServiceArgs,
): Promise<CostBreakdown> {
  if (args.durationSeconds <= 0) {
    return {
      gpuSku: 'NONE',
      region: 'NONE',
      electricityHourly: 0,
      hardwareAmortHourly: 0,
      bandwidthCostHourly: 0,
      overheadHourly: 0,
      totalHourly: 0,
      durationSeconds: 0,
      totalUsd: 0,
    }
  }

  const node = await prisma.node.findUnique({
    where: { id: args.nodeId },
    select: {
      gpuTier: true,
      declaredGpuSku: true,
      powerRegion: true,
    },
  })
  if (!node) {
    throw new Error(`cost-of-service: node not found: ${args.nodeId}`)
  }

  const [baseline, powerRate] = await Promise.all([
    getBaseline(prisma, node.declaredGpuSku, node.gpuTier),
    getPowerRate(prisma, node.powerRegion),
  ])

  const electricityHourly = baseline.kwhDraw * powerRate
  const totalHourly =
    electricityHourly +
    baseline.hardwareAmortHourly +
    baseline.bandwidthCostHourly +
    baseline.overheadHourly
  const totalUsd = totalHourly * (args.durationSeconds / 3600)

  return {
    gpuSku: baseline.gpuSku,
    region: node.powerRegion ?? 'GLOBAL',
    electricityHourly,
    hardwareAmortHourly: baseline.hardwareAmortHourly,
    bandwidthCostHourly: baseline.bandwidthCostHourly,
    overheadHourly: baseline.overheadHourly,
    totalHourly,
    durationSeconds: args.durationSeconds,
    totalUsd,
  }
}
