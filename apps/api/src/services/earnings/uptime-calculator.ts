import type { PrismaClient, GpuTier } from '@a2e/database'
import { GPU_TIER_CONFIG, dailyToHourly } from '@a2e/shared'

export interface UptimeEarnings {
  nodeId: string
  walletAddress: string
  gpuTier: GpuTier
  periodStart: Date
  periodEnd: Date
  uptimeSeconds: number
  uptimeHours: number
  ratePerHour: number
  earnings: number
}

/**
 * Calculate uptime for a node based on heartbeat history.
 * A node is considered "online" when heartbeats are received within 90 seconds of each other.
 */
export async function calculateNodeUptime(
  prisma: PrismaClient | Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
  nodeId: string,
  periodStart: Date,
  periodEnd: Date
): Promise<number> {
  // Get all heartbeats in the period
  const heartbeats = await prisma.heartbeat.findMany({
    where: {
      nodeId,
      timestamp: {
        gte: periodStart,
        lte: periodEnd,
      },
    },
    orderBy: { timestamp: 'asc' },
    select: { timestamp: true },
  })

  if (heartbeats.length === 0) {
    return 0
  }

  // Calculate uptime by looking at gaps between heartbeats
  // If gap > 90 seconds, node was offline during that gap
  const HEARTBEAT_INTERVAL = 30 // Expected interval in seconds
  const MAX_GAP = 90 // Max gap before considered offline

  let totalUptimeSeconds = 0
  let lastTimestamp = heartbeats[0]!.timestamp

  for (let i = 1; i < heartbeats.length; i++) {
    const current = heartbeats[i]!.timestamp
    const gapSeconds = (current.getTime() - lastTimestamp.getTime()) / 1000

    if (gapSeconds <= MAX_GAP) {
      // Node was online during this gap
      totalUptimeSeconds += gapSeconds
    } else {
      // Node was offline, only count one heartbeat interval
      totalUptimeSeconds += HEARTBEAT_INTERVAL
    }

    lastTimestamp = current
  }

  // Add final interval for the last heartbeat
  totalUptimeSeconds += HEARTBEAT_INTERVAL

  // Cap at the period duration
  const periodDurationSeconds = (periodEnd.getTime() - periodStart.getTime()) / 1000
  return Math.min(totalUptimeSeconds, periodDurationSeconds)
}

/**
 * Get the hourly rate for a GPU tier
 */
export function getGpuTierRate(gpuTier: GpuTier, customRate?: number | null): number {
  if (gpuTier === 'OTHER' && customRate) {
    return customRate
  }

  const config = GPU_TIER_CONFIG[gpuTier]
  if (!config) {
    // Fallback for unknown tiers
    return 5.0
  }

  return dailyToHourly(config.retailRate)
}

/**
 * Calculate uptime-based earnings for a node in a given period
 */
export async function calculateUptimeEarnings(
  // M-3 (2026-06-13): allow either a top-level client or an interactive
  // transaction client; the buyer-compute INTERNAL_BALANCE path now
  // calls the getOperatorBalanceBreakdown chain from inside a
  // Serializable transaction to close the spend TOCTOU.
  prisma: PrismaClient | Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
  nodeId: string,
  periodStart: Date,
  periodEnd: Date
): Promise<UptimeEarnings | null> {
  const node = await prisma.node.findUnique({
    where: { id: nodeId },
    select: {
      id: true,
      walletAddress: true,
      gpuTier: true,
      benchmarkAttestedTier: true,
      customRatePerHour: true,
    },
  })

  if (!node) {
    return null
  }

  const uptimeSeconds = await calculateNodeUptime(prisma, nodeId, periodStart, periodEnd)
  const uptimeHours = uptimeSeconds / 3600

  // SECURITY (N-6, 2026-06-13): pay at the LOWER of declared and
  // attested tier. The declared gpuTier is operator-chosen at
  // registration; the attestedTier is what their benchmark proves.
  // Without this cap, an operator declaring B300 with no GPU
  // (M-1 self-attested benchmark or M-2 advisory tier-mismatch) was
  // paid the premium rate. Capping at attested means real H100
  // operators still earn premium, fake-B300-on-cheap-hardware ones
  // earn only what their numbers support. Null attested (never
  // benchmarked) falls through to declared so legacy nodes pre-
  // attestation column don't lose earnings; this is acceptable
  // because A7 layer 1 already gates LISTING on benchmarkScore > 0,
  // and B1 layer 1 blocks orphan payouts entirely.
  const effectiveTier = node.benchmarkAttestedTier
    ? gpuTierMin(node.gpuTier, node.benchmarkAttestedTier)
    : node.gpuTier
  const ratePerHour = getGpuTierRate(effectiveTier, node.customRatePerHour)
  const earnings = uptimeHours * ratePerHour

  return {
    nodeId: node.id,
    walletAddress: node.walletAddress,
    gpuTier: effectiveTier,
    periodStart,
    periodEnd,
    uptimeSeconds,
    uptimeHours: Math.round(uptimeHours * 100) / 100,
    ratePerHour,
    earnings: Math.round(earnings * 100) / 100,
  }
}

// SECURITY (N-6, 2026-06-13): return the LOWER of two tiers by
// settlement rate. Used to cap operator payout at what their
// benchmark actually proves. Imported by settlement engine.
export function gpuTierMin(a: GpuTier, b: GpuTier): GpuTier {
  const rateA = getGpuTierRate(a, null)
  const rateB = getGpuTierRate(b, null)
  return rateA <= rateB ? a : b
}

/**
 * Calculate uptime-based earnings for all active nodes
 */
export async function calculateAllNodesUptimeEarnings(
  prisma: PrismaClient,
  periodStart: Date,
  periodEnd: Date
): Promise<UptimeEarnings[]> {
  // Get all nodes that have had heartbeats in this period
  const nodesWithHeartbeats = await prisma.heartbeat.findMany({
    where: {
      timestamp: {
        gte: periodStart,
        lte: periodEnd,
      },
    },
    distinct: ['nodeId'],
    select: { nodeId: true },
  })

  const results: UptimeEarnings[] = []

  for (const { nodeId } of nodesWithHeartbeats) {
    const earnings = await calculateUptimeEarnings(prisma, nodeId, periodStart, periodEnd)
    if (earnings && earnings.earnings > 0) {
      results.push(earnings)
    }
  }

  return results
}

/**
 * Get daily uptime breakdown for a node
 */
export async function getDailyUptimeBreakdown(
  prisma: PrismaClient,
  nodeId: string,
  days: number = 30
): Promise<{
  date: string
  uptimeHours: number
  earnings: number
}[]> {
  const node = await prisma.node.findUnique({
    where: { id: nodeId },
    select: { gpuTier: true, customRatePerHour: true },
  })

  if (!node) {
    return []
  }

  const ratePerHour = getGpuTierRate(node.gpuTier, node.customRatePerHour)
  const results: { date: string; uptimeHours: number; earnings: number }[] = []

  const endDate = new Date()
  endDate.setHours(23, 59, 59, 999)

  for (let i = 0; i < days; i++) {
    const dayEnd = new Date(endDate)
    dayEnd.setDate(dayEnd.getDate() - i)
    dayEnd.setHours(23, 59, 59, 999)

    const dayStart = new Date(dayEnd)
    dayStart.setHours(0, 0, 0, 0)

    const uptimeSeconds = await calculateNodeUptime(prisma, nodeId, dayStart, dayEnd)
    const uptimeHours = Math.round((uptimeSeconds / 3600) * 100) / 100
    const earnings = Math.round(uptimeHours * ratePerHour * 100) / 100

    results.push({
      date: dayStart.toISOString().split('T')[0]!,
      uptimeHours,
      earnings,
    })
  }

  // Reverse to get chronological order
  return results.reverse()
}
