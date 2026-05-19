import type { FastifyInstance } from 'fastify'
import type { GpuTier, Market, JobStatus, NodeStatus } from '@a2e/database'

export async function statsRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/v1/stats',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const now = new Date()
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000)

      const nodeStats = await fastify.prisma.node.groupBy({
        by: ['status'],
        _count: true,
      })

      const nodesByStatus: Record<string, number> = {
        ONLINE: 0,
        DEGRADED: 0,
        OFFLINE: 0,
      }
      for (const stat of nodeStats) {
        nodesByStatus[stat.status] = stat._count
      }

      const nodesByTier = await fastify.prisma.node.groupBy({
        by: ['gpuTier'],
        _count: true,
      })

      const tierCounts: Record<string, number> = {}
      for (const stat of nodesByTier) {
        tierCounts[stat.gpuTier] = stat._count
      }

      const jobStats = await fastify.prisma.job.groupBy({
        by: ['status'],
        _count: true,
      })

      const jobsByStatus: Record<string, number> = {}
      for (const stat of jobStats) {
        jobsByStatus[stat.status] = stat._count
      }

      const recentJobs = await fastify.prisma.job.count({
        where: { createdAt: { gte: oneDayAgo } },
      })

      const jobsByMarket = await fastify.prisma.job.groupBy({
        by: ['market'],
        where: { market: { not: null } },
        _count: true,
      })

      const marketCounts: Record<string, number> = {}
      for (const stat of jobsByMarket) {
        if (stat.market) {
          marketCounts[stat.market] = stat._count
        }
      }

      const routingLogs = await fastify.prisma.routingLog.findMany({
        where: { timestamp: { gte: oneDayAgo } },
        select: {
          selectedMarket: true,
          selectedRate: true,
          yieldFloorApplied: true,
          decisionTimeMs: true,
        },
      })

      let totalRoutingTime = 0
      let yieldFloorAppliedCount = 0
      const routingByMarket: Record<string, number> = {}

      for (const log of routingLogs) {
        if (log.decisionTimeMs) totalRoutingTime += log.decisionTimeMs
        if (log.yieldFloorApplied) yieldFloorAppliedCount++
        routingByMarket[log.selectedMarket] = (routingByMarket[log.selectedMarket] ?? 0) + 1
      }

      const avgRoutingTimeMs = routingLogs.length > 0 ? totalRoutingTime / routingLogs.length : 0

      const earningsAgg = await fastify.prisma.earning.aggregate({
        where: { date: { gte: oneDayAgo } },
        _sum: { earnings: true, gpuSeconds: true, jobCount: true },
      })

      const heartbeatCount = await fastify.prisma.heartbeat.count({
        where: { timestamp: { gte: oneHourAgo } },
      })

      reply.send({
        timestamp: now.toISOString(),
        nodes: {
          total: Object.values(nodesByStatus).reduce((a, b) => a + b, 0),
          byStatus: nodesByStatus,
          byTier: tierCounts,
        },
        jobs: {
          total: Object.values(jobsByStatus).reduce((a, b) => a + b, 0),
          byStatus: jobsByStatus,
          byMarket: marketCounts,
          last24h: recentJobs,
        },
        routing: {
          decisionsLast24h: routingLogs.length,
          byMarket: routingByMarket,
          yieldFloorAppliedCount,
          avgDecisionTimeMs: Math.round(avgRoutingTimeMs * 100) / 100,
        },
        earnings: {
          last24h: {
            total: earningsAgg._sum.earnings ?? 0,
            gpuSeconds: earningsAgg._sum.gpuSeconds ?? 0,
            jobCount: earningsAgg._sum.jobCount ?? 0,
          },
        },
        health: {
          heartbeatsLastHour: heartbeatCount,
        },
      })
    }
  )

  fastify.get(
    '/v1/stats/nodes',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const nodes = await fastify.prisma.node.groupBy({
        by: ['gpuTier', 'status'],
        _count: true,
      })

      const tiers: GpuTier[] = ['H100', 'H200', 'B200', 'B300', 'GB300', 'CONSUMER', 'RTX_4090', 'RTX_3090']
      const statuses: NodeStatus[] = ['ONLINE', 'DEGRADED', 'OFFLINE']

      const result: Record<string, Record<string, number>> = {}

      for (const tier of tiers) {
        result[tier] = { ONLINE: 0, DEGRADED: 0, OFFLINE: 0, total: 0 }
      }

      for (const node of nodes) {
        const tierResult = result[node.gpuTier]
        if (tierResult) {
          tierResult[node.status] = node._count
          tierResult.total = (tierResult.total ?? 0) + node._count
        }
      }

      reply.send({ nodesByTier: result })
    }
  )

  fastify.get(
    '/v1/stats/routing',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
      const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

      const [last24h, lastWeek] = await Promise.all([
        fastify.prisma.routingLog.groupBy({
          by: ['selectedMarket'],
          where: { timestamp: { gte: oneDayAgo } },
          _count: true,
          _avg: { selectedRate: true },
        }),
        fastify.prisma.routingLog.groupBy({
          by: ['selectedMarket'],
          where: { timestamp: { gte: oneWeekAgo } },
          _count: true,
          _avg: { selectedRate: true },
        }),
      ])

      const formatStats = (stats: typeof last24h) => {
        const result: Record<string, { count: number; avgRate: number }> = {}
        for (const stat of stats) {
          result[stat.selectedMarket] = {
            count: stat._count,
            avgRate: Math.round((stat._avg.selectedRate ?? 0) * 100) / 100,
          }
        }
        return result
      }

      reply.send({
        last24h: formatStats(last24h),
        lastWeek: formatStats(lastWeek),
      })
    }
  )

  // Earnings trend for chart
  fastify.get(
    '/v1/stats/earnings/trend',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { days = '7' } = request.query as { days?: string }
      const numDays = Math.min(parseInt(days, 10) || 7, 90)

      const startDate = new Date()
      startDate.setDate(startDate.getDate() - numDays)
      startDate.setHours(0, 0, 0, 0)

      const earnings = await fastify.prisma.earning.findMany({
        where: { date: { gte: startDate } },
        orderBy: { date: 'asc' },
      })

      // Group by date and market
      const byDate: Record<string, { internal: number; akash: number; ionet: number }> = {}

      for (let i = 0; i < numDays; i++) {
        const date = new Date(startDate)
        date.setDate(date.getDate() + i)
        const dateStr = date.toISOString().split('T')[0] as string
        byDate[dateStr] = { internal: 0, akash: 0, ionet: 0 }
      }

      for (const earning of earnings) {
        const dateStr = earning.date.toISOString().split('T')[0] as string
        const entry = byDate[dateStr]
        if (entry) {
          const market = earning.market.toLowerCase() as 'internal' | 'akash' | 'ionet'
          entry[market] += earning.earnings
        }
      }

      const trend = Object.entries(byDate).map(([date, markets]) => ({
        date,
        ...markets,
        total: markets.internal + markets.akash + markets.ionet,
      }))

      reply.send({ trend, days: numDays })
    }
  )
}
