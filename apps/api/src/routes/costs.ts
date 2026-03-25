import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

const createCostSchema = z.object({
  nodeId: z.string().optional(),
  category: z.enum(['HOSTING', 'POWER', 'NETWORK', 'OTHER']),
  amount: z.number().positive(),
  currency: z.string().default('USD'),
  description: z.string().optional(),
  periodStart: z.string(),
  periodEnd: z.string(),
})

export async function costsRoutes(fastify: FastifyInstance) {
  // POST /v1/costs - Record infrastructure cost
  fastify.post(
    '/v1/costs',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const parseResult = createCostSchema.safeParse(request.body)

      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: parseResult.error.errors[0]?.message ?? 'Invalid input',
        })
      }

      const { nodeId, category, amount, currency, description, periodStart, periodEnd } =
        parseResult.data

      if (nodeId) {
        const node = await fastify.prisma.node.findUnique({ where: { id: nodeId } })
        if (!node) {
          return reply.code(404).send({ error: 'Node not found' })
        }
      }

      const cost = await fastify.prisma.infrastructureCost.create({
        data: {
          nodeId,
          category,
          amount,
          currency,
          description,
          periodStart: new Date(periodStart),
          periodEnd: new Date(periodEnd),
        },
        include: nodeId ? { node: { select: { walletAddress: true, gpuTier: true } } } : undefined,
      })

      reply.code(201).send({
        id: cost.id,
        nodeId: cost.nodeId,
        category: cost.category,
        amount: cost.amount,
        currency: cost.currency,
        description: cost.description,
        periodStart: cost.periodStart.toISOString(),
        periodEnd: cost.periodEnd.toISOString(),
        createdAt: cost.createdAt.toISOString(),
      })
    }
  )

  // GET /v1/costs - List costs with filters
  fastify.get(
    '/v1/costs',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { nodeId, category, startDate, endDate, limit = '100', offset = '0' } =
        request.query as {
          nodeId?: string
          category?: string
          startDate?: string
          endDate?: string
          limit?: string
          offset?: string
        }

      const where: Record<string, unknown> = {}
      if (nodeId) where.nodeId = nodeId
      if (category) where.category = category
      if (startDate || endDate) {
        where.periodStart = {}
        if (startDate) (where.periodStart as Record<string, Date>).gte = new Date(startDate)
        if (endDate) (where.periodStart as Record<string, Date>).lte = new Date(endDate)
      }

      const [costs, total] = await Promise.all([
        fastify.prisma.infrastructureCost.findMany({
          where,
          include: { node: { select: { walletAddress: true, gpuTier: true } } },
          orderBy: { createdAt: 'desc' },
          take: parseInt(limit, 10),
          skip: parseInt(offset, 10),
        }),
        fastify.prisma.infrastructureCost.count({ where }),
      ])

      reply.send({
        costs: costs.map((c) => ({
          id: c.id,
          nodeId: c.nodeId,
          node: c.node
            ? { walletAddress: c.node.walletAddress, gpuTier: c.node.gpuTier }
            : null,
          category: c.category,
          amount: c.amount,
          currency: c.currency,
          description: c.description,
          periodStart: c.periodStart.toISOString(),
          periodEnd: c.periodEnd.toISOString(),
          createdAt: c.createdAt.toISOString(),
        })),
        total,
        limit: parseInt(limit, 10),
        offset: parseInt(offset, 10),
      })
    }
  )

  // GET /v1/costs/summary - Cost summary by category
  fastify.get(
    '/v1/costs/summary',
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

      const costs = await fastify.prisma.infrastructureCost.findMany({
        where: {
          periodStart: { gte: dateFrom },
          periodEnd: { lte: dateTo },
        },
      })

      const byCategory: Record<string, number> = {
        HOSTING: 0,
        POWER: 0,
        NETWORK: 0,
        OTHER: 0,
      }

      let total = 0
      for (const cost of costs) {
        byCategory[cost.category] = (byCategory[cost.category] ?? 0) + cost.amount
        total += cost.amount
      }

      reply.send({
        period: {
          start: dateFrom.toISOString().split('T')[0],
          end: dateTo.toISOString().split('T')[0],
        },
        total: Math.round(total * 100) / 100,
        byCategory: Object.fromEntries(
          Object.entries(byCategory).map(([k, v]) => [k, Math.round(v * 100) / 100])
        ),
      })
    }
  )

  // GET /v1/margins - Margin analysis (revenue - costs)
  fastify.get(
    '/v1/margins',
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

      const [earningsData, costsData] = await Promise.all([
        fastify.prisma.earning.aggregate({
          where: { date: { gte: dateFrom, lte: dateTo } },
          _sum: { earnings: true },
        }),
        fastify.prisma.infrastructureCost.aggregate({
          where: {
            periodStart: { gte: dateFrom },
            periodEnd: { lte: dateTo },
          },
          _sum: { amount: true },
        }),
      ])

      const revenue = earningsData._sum.earnings ?? 0
      const costs = costsData._sum.amount ?? 0
      const profit = revenue - costs
      const margin = revenue > 0 ? (profit / revenue) * 100 : 0

      reply.send({
        period: {
          start: dateFrom.toISOString().split('T')[0],
          end: dateTo.toISOString().split('T')[0],
        },
        revenue: Math.round(revenue * 100) / 100,
        costs: Math.round(costs * 100) / 100,
        profit: Math.round(profit * 100) / 100,
        marginPercent: Math.round(margin * 100) / 100,
      })
    }
  )

  // DELETE /v1/costs/:id - Delete a cost entry
  fastify.delete(
    '/v1/costs/:id',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const cost = await fastify.prisma.infrastructureCost.findUnique({ where: { id } })
      if (!cost) {
        return reply.code(404).send({ error: 'Cost entry not found' })
      }

      await fastify.prisma.infrastructureCost.delete({ where: { id } })

      reply.send({ success: true, id })
    }
  )
}
