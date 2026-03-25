import type { FastifyInstance } from 'fastify'
import type { Market, GpuTier } from '@a2e/database'
import { getEarningsSummary } from '../services/earnings/calculator'

export async function earningsRoutes(fastify: FastifyInstance) {
  // GET /v1/earnings - List earnings with filters
  fastify.get(
    '/v1/earnings',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { nodeId, market, startDate, endDate, limit = '100', offset = '0' } =
        request.query as {
          nodeId?: string
          market?: Market
          startDate?: string
          endDate?: string
          limit?: string
          offset?: string
        }

      const where: Record<string, unknown> = {}
      if (nodeId) where.nodeId = nodeId
      if (market) where.market = market
      if (startDate || endDate) {
        where.date = {}
        if (startDate) (where.date as Record<string, Date>).gte = new Date(startDate)
        if (endDate) (where.date as Record<string, Date>).lte = new Date(endDate)
      }

      const [earnings, total] = await Promise.all([
        fastify.prisma.earning.findMany({
          where,
          include: { node: { select: { walletAddress: true, gpuTier: true } } },
          orderBy: { date: 'desc' },
          take: parseInt(limit, 10),
          skip: parseInt(offset, 10),
        }),
        fastify.prisma.earning.count({ where }),
      ])

      reply.send({
        earnings: earnings.map((e) => ({
          id: e.id,
          nodeId: e.nodeId,
          walletAddress: e.node.walletAddress,
          gpuTier: e.node.gpuTier,
          date: e.date.toISOString().split('T')[0],
          market: e.market,
          earnings: e.earnings,
          gpuSeconds: e.gpuSeconds,
          jobCount: e.jobCount,
        })),
        total,
        limit: parseInt(limit, 10),
        offset: parseInt(offset, 10),
      })
    }
  )

  // GET /v1/earnings/summary - Aggregated earnings summary
  fastify.get(
    '/v1/earnings/summary',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { nodeId, market, startDate, endDate } = request.query as {
        nodeId?: string
        market?: Market
        startDate?: string
        endDate?: string
      }

      const summary = await getEarningsSummary(fastify.prisma, {
        nodeId,
        market,
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
      })

      reply.send(summary)
    }
  )

  // GET /v1/earnings/by-node/:nodeId - Node-specific earnings
  fastify.get(
    '/v1/earnings/by-node/:nodeId',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { nodeId } = request.params as { nodeId: string }
      const { startDate, endDate, days = '30' } = request.query as {
        startDate?: string
        endDate?: string
        days?: string
      }

      const node = await fastify.prisma.node.findUnique({
        where: { id: nodeId },
        select: { id: true, walletAddress: true, gpuTier: true },
      })

      if (!node) {
        return reply.code(404).send({ error: 'Node not found' })
      }

      let dateFrom = startDate ? new Date(startDate) : new Date()
      if (!startDate) {
        dateFrom.setDate(dateFrom.getDate() - parseInt(days, 10))
        dateFrom.setHours(0, 0, 0, 0)
      }
      const dateTo = endDate ? new Date(endDate) : new Date()

      const earnings = await fastify.prisma.earning.findMany({
        where: {
          nodeId,
          date: { gte: dateFrom, lte: dateTo },
        },
        orderBy: { date: 'desc' },
      })

      const totals = earnings.reduce(
        (acc, e) => ({
          earnings: acc.earnings + e.earnings,
          gpuSeconds: acc.gpuSeconds + e.gpuSeconds,
          jobCount: acc.jobCount + e.jobCount,
        }),
        { earnings: 0, gpuSeconds: 0, jobCount: 0 }
      )

      reply.send({
        node: {
          id: node.id,
          walletAddress: node.walletAddress,
          gpuTier: node.gpuTier,
        },
        period: {
          start: dateFrom.toISOString().split('T')[0],
          end: dateTo.toISOString().split('T')[0],
        },
        totals: {
          earnings: Math.round(totals.earnings * 100) / 100,
          gpuHours: Math.round((totals.gpuSeconds / 3600) * 100) / 100,
          jobCount: totals.jobCount,
        },
        daily: earnings.map((e) => ({
          date: e.date.toISOString().split('T')[0],
          market: e.market,
          earnings: e.earnings,
          gpuSeconds: e.gpuSeconds,
          jobCount: e.jobCount,
        })),
      })
    }
  )

  // GET /v1/earnings/by-market - Earnings breakdown by market
  fastify.get(
    '/v1/earnings/by-market',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { startDate, endDate, days = '30' } = request.query as {
        startDate?: string
        endDate?: string
        days?: string
      }

      let dateFrom = startDate ? new Date(startDate) : new Date()
      if (!startDate) {
        dateFrom.setDate(dateFrom.getDate() - parseInt(days, 10))
        dateFrom.setHours(0, 0, 0, 0)
      }
      const dateTo = endDate ? new Date(endDate) : new Date()

      const marketStats = await fastify.prisma.earning.groupBy({
        by: ['market'],
        where: { date: { gte: dateFrom, lte: dateTo } },
        _sum: { earnings: true, gpuSeconds: true, jobCount: true },
      })

      const markets: Record<string, { earnings: number; gpuHours: number; jobCount: number }> = {
        INTERNAL: { earnings: 0, gpuHours: 0, jobCount: 0 },
        AKASH: { earnings: 0, gpuHours: 0, jobCount: 0 },
        IONET: { earnings: 0, gpuHours: 0, jobCount: 0 },
      }

      for (const stat of marketStats) {
        markets[stat.market] = {
          earnings: Math.round((stat._sum.earnings ?? 0) * 100) / 100,
          gpuHours: Math.round(((stat._sum.gpuSeconds ?? 0) / 3600) * 100) / 100,
          jobCount: stat._sum.jobCount ?? 0,
        }
      }

      const total = Object.values(markets).reduce(
        (acc, m) => ({
          earnings: acc.earnings + m.earnings,
          gpuHours: acc.gpuHours + m.gpuHours,
          jobCount: acc.jobCount + m.jobCount,
        }),
        { earnings: 0, gpuHours: 0, jobCount: 0 }
      )

      reply.send({
        period: {
          start: dateFrom.toISOString().split('T')[0],
          end: dateTo.toISOString().split('T')[0],
        },
        total,
        byMarket: markets,
      })
    }
  )

  // GET /v1/earnings/by-tier - Earnings breakdown by GPU tier
  fastify.get(
    '/v1/earnings/by-tier',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { startDate, endDate, days = '30' } = request.query as {
        startDate?: string
        endDate?: string
        days?: string
      }

      let dateFrom = startDate ? new Date(startDate) : new Date()
      if (!startDate) {
        dateFrom.setDate(dateFrom.getDate() - parseInt(days, 10))
        dateFrom.setHours(0, 0, 0, 0)
      }
      const dateTo = endDate ? new Date(endDate) : new Date()

      const earnings = await fastify.prisma.earning.findMany({
        where: { date: { gte: dateFrom, lte: dateTo } },
        include: { node: { select: { gpuTier: true } } },
      })

      const tiers: Record<GpuTier, { earnings: number; gpuHours: number; jobCount: number }> = {
        H100: { earnings: 0, gpuHours: 0, jobCount: 0 },
        H200: { earnings: 0, gpuHours: 0, jobCount: 0 },
        B200: { earnings: 0, gpuHours: 0, jobCount: 0 },
        B300: { earnings: 0, gpuHours: 0, jobCount: 0 },
        GB300: { earnings: 0, gpuHours: 0, jobCount: 0 },
      }

      for (const e of earnings) {
        const tier = tiers[e.node.gpuTier]
        if (tier) {
          tier.earnings += e.earnings
          tier.gpuHours += e.gpuSeconds / 3600
          tier.jobCount += e.jobCount
        }
      }

      for (const tier of Object.values(tiers)) {
        tier.earnings = Math.round(tier.earnings * 100) / 100
        tier.gpuHours = Math.round(tier.gpuHours * 100) / 100
      }

      reply.send({
        period: {
          start: dateFrom.toISOString().split('T')[0],
          end: dateTo.toISOString().split('T')[0],
        },
        byTier: tiers,
      })
    }
  )

  // GET /v1/earnings/trends - Earnings trend data
  fastify.get(
    '/v1/earnings/trends',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { days = '30', groupBy = 'day' } = request.query as {
        days?: string
        groupBy?: 'day' | 'week' | 'month'
      }

      const numDays = Math.min(parseInt(days, 10) || 30, 365)
      const startDate = new Date()
      startDate.setDate(startDate.getDate() - numDays)
      startDate.setHours(0, 0, 0, 0)

      const earnings = await fastify.prisma.earning.findMany({
        where: { date: { gte: startDate } },
        orderBy: { date: 'asc' },
      })

      const trend: { date: string; earnings: number; gpuHours: number; jobCount: number }[] = []
      const grouped: Map<string, { earnings: number; gpuSeconds: number; jobCount: number }> =
        new Map()

      for (const e of earnings) {
        let key: string
        if (groupBy === 'week') {
          const weekStart = new Date(e.date)
          weekStart.setDate(weekStart.getDate() - weekStart.getDay())
          key = weekStart.toISOString().split('T')[0] as string
        } else if (groupBy === 'month') {
          key = e.date.toISOString().substring(0, 7)
        } else {
          key = e.date.toISOString().split('T')[0] as string
        }

        const existing = grouped.get(key) ?? { earnings: 0, gpuSeconds: 0, jobCount: 0 }
        existing.earnings += e.earnings
        existing.gpuSeconds += e.gpuSeconds
        existing.jobCount += e.jobCount
        grouped.set(key, existing)
      }

      for (const [date, data] of grouped.entries()) {
        trend.push({
          date,
          earnings: Math.round(data.earnings * 100) / 100,
          gpuHours: Math.round((data.gpuSeconds / 3600) * 100) / 100,
          jobCount: data.jobCount,
        })
      }

      trend.sort((a, b) => a.date.localeCompare(b.date))

      reply.send({
        period: {
          start: startDate.toISOString().split('T')[0],
          end: new Date().toISOString().split('T')[0],
          days: numDays,
          groupBy,
        },
        trend,
      })
    }
  )
}
