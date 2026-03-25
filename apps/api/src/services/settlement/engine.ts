import type { PrismaClient, Node } from '@a2e/database'

export interface SettlementCalculation {
  nodeId: string
  walletAddress: string
  amount: number
  jobCount: number
  periodStart: Date
  periodEnd: Date
  jobIds: string[]
}

export async function calculatePendingSettlements(
  prisma: PrismaClient,
  periodEnd: Date
): Promise<SettlementCalculation[]> {
  const config = await prisma.settlementConfig.findUnique({
    where: { id: 'default' },
  })

  const minimumPayout = config?.minimumPayout ?? 10

  const nodes = await prisma.node.findMany({
    select: { id: true, walletAddress: true },
  })

  const settlements: SettlementCalculation[] = []

  for (const node of nodes) {
    const lastSettlement = await prisma.settlement.findFirst({
      where: { nodeId: node.id, status: { in: ['COMPLETED', 'PROCESSING'] } },
      orderBy: { periodEnd: 'desc' },
    })

    const periodStart = lastSettlement?.periodEnd ?? new Date(0)

    const jobs = await prisma.job.findMany({
      where: {
        nodeId: node.id,
        status: 'COMPLETED',
        completedAt: { gt: periodStart, lte: periodEnd },
        earnings: { gt: 0 },
      },
      select: { id: true, earnings: true },
    })

    if (jobs.length === 0) continue

    const totalEarnings = jobs.reduce((sum, job) => sum + (job.earnings ?? 0), 0)

    if (totalEarnings < minimumPayout) continue

    settlements.push({
      nodeId: node.id,
      walletAddress: node.walletAddress,
      amount: Math.round(totalEarnings * 100) / 100,
      jobCount: jobs.length,
      periodStart,
      periodEnd,
      jobIds: jobs.map((j) => j.id),
    })
  }

  return settlements
}

export async function createSettlement(
  prisma: PrismaClient,
  calculation: SettlementCalculation
): Promise<string> {
  const settlement = await prisma.settlement.create({
    data: {
      nodeId: calculation.nodeId,
      walletAddress: calculation.walletAddress,
      amount: calculation.amount,
      jobCount: calculation.jobCount,
      periodStart: calculation.periodStart,
      periodEnd: calculation.periodEnd,
      status: 'PENDING',
      items: {
        create: calculation.jobIds.map((jobId) => ({
          jobId,
          amount: 0,
        })),
      },
    },
  })

  return settlement.id
}

export async function markSettlementProcessing(
  prisma: PrismaClient,
  settlementId: string
): Promise<void> {
  await prisma.settlement.update({
    where: { id: settlementId },
    data: { status: 'PROCESSING' },
  })
}

export async function markSettlementCompleted(
  prisma: PrismaClient,
  settlementId: string,
  txHash: string
): Promise<void> {
  await prisma.settlement.update({
    where: { id: settlementId },
    data: {
      status: 'COMPLETED',
      txHash,
      txConfirmed: false,
      processedAt: new Date(),
    },
  })
}

export async function markSettlementFailed(
  prisma: PrismaClient,
  settlementId: string,
  errorMessage: string
): Promise<void> {
  await prisma.settlement.update({
    where: { id: settlementId },
    data: {
      status: 'FAILED',
      errorMessage,
      processedAt: new Date(),
    },
  })
}

export async function confirmSettlementTransaction(
  prisma: PrismaClient,
  settlementId: string
): Promise<void> {
  await prisma.settlement.update({
    where: { id: settlementId },
    data: { txConfirmed: true },
  })
}

export async function getSettlementConfig(prisma: PrismaClient) {
  let config = await prisma.settlementConfig.findUnique({
    where: { id: 'default' },
  })

  if (!config) {
    config = await prisma.settlementConfig.create({
      data: {
        id: 'default',
        period: 'WEEKLY',
        minimumPayout: 10,
        dayOfWeek: 1,
      },
    })
  }

  return config
}

export async function updateSettlementConfig(
  prisma: PrismaClient,
  updates: {
    period?: string
    minimumPayout?: number
    dayOfWeek?: number
    dayOfMonth?: number
    solanaRpcUrl?: string
    payerPrivateKey?: string
    usdcMint?: string
  }
): Promise<void> {
  await prisma.settlementConfig.upsert({
    where: { id: 'default' },
    update: updates,
    create: {
      id: 'default',
      ...updates,
    },
  })
}
