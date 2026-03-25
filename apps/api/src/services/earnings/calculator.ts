import type { PrismaClient, Job, Market } from '@a2e/database'

export interface EarningsCalculation {
  jobId: string
  nodeId: string
  amount: number
  market: Market
  ratePerHour: number
  durationSeconds: number
}

export async function calculateJobEarnings(
  job: Job
): Promise<EarningsCalculation | null> {
  if (!job.nodeId || !job.market || !job.ratePerHour || !job.durationSeconds) {
    return null
  }

  const durationHours = job.durationSeconds / 3600
  const amount = durationHours * job.ratePerHour

  return {
    jobId: job.id,
    nodeId: job.nodeId,
    amount: Math.round(amount * 100) / 100,
    market: job.market,
    ratePerHour: job.ratePerHour,
    durationSeconds: job.durationSeconds,
  }
}

export async function recordJobEarnings(
  prisma: PrismaClient,
  job: Job
): Promise<void> {
  const calculation = await calculateJobEarnings(job)
  if (!calculation) {
    return
  }

  const date = new Date()
  date.setHours(0, 0, 0, 0)

  await prisma.earning.upsert({
    where: {
      nodeId_date_market: {
        nodeId: calculation.nodeId,
        date,
        market: calculation.market,
      },
    },
    update: {
      gpuSeconds: { increment: calculation.durationSeconds },
      earnings: { increment: calculation.amount },
      jobCount: { increment: 1 },
    },
    create: {
      nodeId: calculation.nodeId,
      date,
      market: calculation.market,
      gpuSeconds: calculation.durationSeconds,
      earnings: calculation.amount,
      jobCount: 1,
    },
  })

  await prisma.job.update({
    where: { id: job.id },
    data: { earnings: calculation.amount },
  })
}

export async function getEarningsSummary(
  prisma: PrismaClient,
  filters?: {
    nodeId?: string
    market?: Market
    startDate?: Date
    endDate?: Date
  }
): Promise<{
  totalEarnings: number
  totalGpuSeconds: number
  totalJobs: number
  byMarket: Record<string, { earnings: number; jobs: number }>
  byNode: Record<string, { earnings: number; jobs: number }>
}> {
  const where: Record<string, unknown> = {}

  if (filters?.nodeId) where.nodeId = filters.nodeId
  if (filters?.market) where.market = filters.market
  if (filters?.startDate || filters?.endDate) {
    where.date = {}
    if (filters.startDate) (where.date as Record<string, Date>).gte = filters.startDate
    if (filters.endDate) (where.date as Record<string, Date>).lte = filters.endDate
  }

  const earnings = await prisma.earning.findMany({ where })

  let totalEarnings = 0
  let totalGpuSeconds = 0
  let totalJobs = 0
  const byMarket: Record<string, { earnings: number; jobs: number }> = {}
  const byNode: Record<string, { earnings: number; jobs: number }> = {}

  for (const earning of earnings) {
    totalEarnings += earning.earnings
    totalGpuSeconds += earning.gpuSeconds
    totalJobs += earning.jobCount

    if (!byMarket[earning.market]) {
      byMarket[earning.market] = { earnings: 0, jobs: 0 }
    }
    const marketEntry = byMarket[earning.market]!
    marketEntry.earnings += earning.earnings
    marketEntry.jobs += earning.jobCount

    if (!byNode[earning.nodeId]) {
      byNode[earning.nodeId] = { earnings: 0, jobs: 0 }
    }
    const nodeEntry = byNode[earning.nodeId]!
    nodeEntry.earnings += earning.earnings
    nodeEntry.jobs += earning.jobCount
  }

  return {
    totalEarnings: Math.round(totalEarnings * 100) / 100,
    totalGpuSeconds,
    totalJobs,
    byMarket,
    byNode,
  }
}
