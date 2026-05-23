import type { PrismaClient, Market, GpuTier } from '@a2e/database'

export interface JobCostResult {
  cost: number
  costSource: 'market_rate' | 'external_api' | 'estimated'
  marketRate?: number
  externalFees?: number
}

/**
 * Calculate the cost of executing a job.
 *
 * For INTERNAL jobs: Cost is based on infrastructure/yield floor
 * For AKASH/IONET jobs: Cost is the external market rate
 */
export async function calculateJobCost(
  prisma: PrismaClient,
  params: {
    market: Market
    gpuTier: GpuTier
    durationSeconds: number
    ratePerHour?: number
  }
): Promise<JobCostResult> {
  const { market, gpuTier, durationSeconds, ratePerHour } = params
  const hours = durationSeconds / 3600

  // If we have the rate used at routing time, use that
  if (ratePerHour) {
    const cost = hours * ratePerHour
    return {
      cost: Math.round(cost * 100) / 100,
      costSource: 'market_rate',
      marketRate: ratePerHour,
    }
  }

  // Otherwise, look up the current market rate
  const marketRate = await prisma.marketRate.findUnique({
    where: { market_gpuTier: { market, gpuTier } },
  })

  if (marketRate) {
    const cost = hours * marketRate.ratePerHour
    return {
      cost: Math.round(cost * 100) / 100,
      costSource: 'market_rate',
      marketRate: marketRate.ratePerHour,
    }
  }

  // Fall back to yield floor as minimum cost estimate
  const yieldFloor = await prisma.yieldFloor.findUnique({
    where: { gpuTier },
  })

  if (yieldFloor) {
    const cost = hours * yieldFloor.ratePerHour
    return {
      cost: Math.round(cost * 100) / 100,
      costSource: 'estimated',
      marketRate: yieldFloor.ratePerHour,
    }
  }

  // Default fallback rates (should rarely hit this)
  const defaultRates: Record<GpuTier, number> = {
    H100: 3.46,
    H200: 4.38,
    // L40S: 21/day = 0.875/hr, matches GPU_TIER_CONFIG retailRate.
    L40S: 0.88,
    B200: 7.08,
    B300: 10.0,
    GB300: 15.0,
    OTHER: 5.0, // Custom tier uses fallback or node-specific rate
    // C2 wave 2: consumer / prosumer fallbacks — match GPU_TIER_CONFIG
    // retailRate / 24 in @a2e/shared so internal cost math lines up
    // with what buyers see on the request form.
    RTX_4090: 0.58,
    RTX_3090: 0.37,
    CONSUMER: 0.29,
  }

  const defaultRate = defaultRates[gpuTier] ?? 5.0
  const cost = hours * defaultRate

  return {
    cost: Math.round(cost * 100) / 100,
    costSource: 'estimated',
    marketRate: defaultRate,
  }
}

/**
 * Calculate profit for a job
 */
export function calculateJobProfit(earnings: number, cost: number): number {
  return Math.round((earnings - cost) * 100) / 100
}

/**
 * Calculate profit margin percentage
 */
export function calculateProfitMargin(earnings: number, cost: number): number {
  if (earnings === 0) return 0
  const margin = ((earnings - cost) / earnings) * 100
  return Math.round(margin * 100) / 100
}

/**
 * Get cost breakdown for a job including external fees if available
 */
export async function getJobCostBreakdown(
  prisma: PrismaClient,
  jobId: string
): Promise<{
  job: {
    id: string
    market: Market | null
    gpuTier: GpuTier
    durationSeconds: number | null
    earnings: number | null
    cost: number | null
    profit: number | null
  }
  breakdown: {
    marketRate: number
    hours: number
    baseCost: number
    externalFees: number
    totalCost: number
    profitMargin: number | null
  } | null
}> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      market: true,
      gpuTier: true,
      durationSeconds: true,
      ratePerHour: true,
      earnings: true,
      cost: true,
      profit: true,
    },
  })

  if (!job) {
    throw new Error(`Job ${jobId} not found`)
  }

  if (!job.durationSeconds || !job.market) {
    return { job, breakdown: null }
  }

  const hours = job.durationSeconds / 3600
  const marketRate = job.ratePerHour ?? 0
  const baseCost = hours * marketRate
  const externalFees = 0 // Placeholder for future external API fees
  const totalCost = baseCost + externalFees

  let profitMargin: number | null = null
  if (job.earnings && job.earnings > 0 && job.cost) {
    profitMargin = calculateProfitMargin(job.earnings, job.cost)
  }

  return {
    job,
    breakdown: {
      marketRate,
      hours: Math.round(hours * 100) / 100,
      baseCost: Math.round(baseCost * 100) / 100,
      externalFees,
      totalCost: Math.round(totalCost * 100) / 100,
      profitMargin,
    },
  }
}

/**
 * Recalculate cost and profit for all jobs in a date range
 * Useful for backfilling historical data
 */
export async function recalculateJobCosts(
  prisma: PrismaClient,
  options: {
    startDate?: Date
    endDate?: Date
    market?: Market
  } = {}
): Promise<{ updated: number; errors: number }> {
  const { startDate, endDate, market } = options

  const where: Record<string, unknown> = {
    status: 'COMPLETED',
    durationSeconds: { not: null },
    market: { not: null },
  }

  if (startDate || endDate) {
    where.completedAt = {}
    if (startDate) (where.completedAt as Record<string, Date>).gte = startDate
    if (endDate) (where.completedAt as Record<string, Date>).lte = endDate
  }

  if (market) {
    where.market = market
  }

  const jobs = await prisma.job.findMany({
    where,
    select: {
      id: true,
      market: true,
      gpuTier: true,
      durationSeconds: true,
      ratePerHour: true,
      earnings: true,
    },
  })

  let updated = 0
  let errors = 0

  for (const job of jobs) {
    try {
      if (!job.market || !job.durationSeconds) continue

      const costResult = await calculateJobCost(prisma, {
        market: job.market,
        gpuTier: job.gpuTier,
        durationSeconds: job.durationSeconds,
        ratePerHour: job.ratePerHour ?? undefined,
      })

      const profit = job.earnings ? calculateJobProfit(job.earnings, costResult.cost) : null

      await prisma.job.update({
        where: { id: job.id },
        data: {
          cost: costResult.cost,
          profit,
        },
      })

      updated++
    } catch (error) {
      console.error(`Error recalculating cost for job ${job.id}:`, error)
      errors++
    }
  }

  return { updated, errors }
}
