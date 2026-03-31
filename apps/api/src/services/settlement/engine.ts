import type { PrismaClient, Node } from '@a2e/database'
import { calculateUptimeEarnings } from '../earnings/uptime-calculator'

export interface SettlementCalculation {
  nodeId: string
  walletAddress: string
  amount: number
  uptimeHours: number
  periodStart: Date
  periodEnd: Date
}

/**
 * Calculate pending settlements based on UPTIME (not jobs).
 * Earnings = uptime hours × hourly rate for GPU tier
 */
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
    // Find last completed or processing settlement to determine period start
    const lastSettlement = await prisma.settlement.findFirst({
      where: { nodeId: node.id, status: { in: ['COMPLETED', 'PROCESSING', 'PENDING'] } },
      orderBy: { periodEnd: 'desc' },
    })

    // Period starts from last settlement end, or node creation, or 30 days ago
    let periodStart: Date
    if (lastSettlement?.periodEnd) {
      periodStart = lastSettlement.periodEnd
    } else {
      // For new nodes, start from 30 days ago or node creation
      const thirtyDaysAgo = new Date()
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
      periodStart = thirtyDaysAgo
    }

    // Skip if period is too short (less than 1 hour)
    if (periodEnd.getTime() - periodStart.getTime() < 3600000) {
      continue
    }

    // Calculate uptime-based earnings
    const uptimeEarnings = await calculateUptimeEarnings(prisma, node.id, periodStart, periodEnd)

    if (!uptimeEarnings || uptimeEarnings.earnings < minimumPayout) {
      continue
    }

    settlements.push({
      nodeId: node.id,
      walletAddress: node.walletAddress,
      amount: uptimeEarnings.earnings,
      uptimeHours: uptimeEarnings.uptimeHours,
      periodStart,
      periodEnd,
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
      jobCount: 0, // Uptime-based, not job-based
      periodStart: calculation.periodStart,
      periodEnd: calculation.periodEnd,
      status: 'PENDING',
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
    hour?: number
    autoSchedule?: boolean
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
