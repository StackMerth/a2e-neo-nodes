import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { GPU_TIER_CONFIG, dailyToHourly } from '@a2e/shared'
import type { GpuTier, Market } from '@a2e/database'

const ratesQuerySchema = z.object({
  gpuTier: z.enum(['H100', 'H200', 'A100', 'L40S', 'B200', 'B300', 'GB300', 'CONSUMER', 'RTX_4090', 'RTX_3090']).optional(),
  market: z.enum(['INTERNAL', 'AKASH', 'IONET', 'VASTAI']).optional(),
})

const rateHistoryQuerySchema = z.object({
  gpuTier: z.enum(['H100', 'H200', 'A100', 'L40S', 'B200', 'B300', 'GB300', 'CONSUMER', 'RTX_4090', 'RTX_3090']),
  market: z.enum(['AKASH', 'IONET', 'VASTAI']),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  limit: z.coerce.number().min(1).max(1000).default(100),
})

export async function rateRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/v1/rates',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const parseResult = ratesQuerySchema.safeParse(request.query)

      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: parseResult.error.errors[0]?.message ?? 'Invalid query',
        })
      }

      const { gpuTier, market } = parseResult.data

      const externalRates = await fastify.prisma.marketRate.findMany({
        where: {
          ...(gpuTier ? { gpuTier: gpuTier as GpuTier } : {}),
          ...(market && market !== 'INTERNAL' ? { market: market as Market } : {}),
        },
        orderBy: [{ gpuTier: 'asc' }, { market: 'asc' }],
      })

      const marketConfigs = await fastify.prisma.marketConfig.findMany()
      const configMap = new Map(marketConfigs.map((c) => [c.market, c]))

      const tiers: GpuTier[] = gpuTier
        ? [gpuTier as GpuTier]
        : ['H100', 'H200', 'A100', 'L40S', 'B200', 'B300', 'GB300', 'CONSUMER', 'RTX_4090', 'RTX_3090']

      const rates: Array<{
        market: string
        gpuTier: string
        ratePerHour: number
        ratePerDay: number
        available: boolean
        enabled: boolean
        fetchedAt: string
      }> = []

      for (const tier of tiers) {
        const tierConfig = GPU_TIER_CONFIG[tier]

        if (!market || market === 'INTERNAL') {
          rates.push({
            market: 'INTERNAL',
            gpuTier: tier,
            ratePerHour: dailyToHourly(tierConfig.retailRate),
            ratePerDay: tierConfig.retailRate,
            available: true,
            enabled: true,
            fetchedAt: new Date().toISOString(),
          })
        }
      }

      for (const rate of externalRates) {
        const config = configMap.get(rate.market)
        rates.push({
          market: rate.market,
          gpuTier: rate.gpuTier,
          ratePerHour: rate.ratePerHour,
          ratePerDay: rate.ratePerDay,
          available: rate.available,
          enabled: config?.enabled ?? true,
          fetchedAt: rate.fetchedAt.toISOString(),
        })
      }

      const tierOrder: Record<string, number> = { H100: 1, H200: 2, L40S: 2.5, B200: 3, B300: 4, GB300: 5 }
      const marketOrder: Record<string, number> = { INTERNAL: 1, AKASH: 2, IONET: 3, VASTAI: 4 }
      rates.sort((a, b) => {
        const tierDiff = (tierOrder[a.gpuTier] ?? 99) - (tierOrder[b.gpuTier] ?? 99)
        if (tierDiff !== 0) return tierDiff
        return (marketOrder[a.market] ?? 99) - (marketOrder[b.market] ?? 99)
      })

      reply.send({
        rates,
        lastUpdated: new Date().toISOString(),
      })
    }
  )

  fastify.get(
    '/v1/rates/history',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const parseResult = rateHistoryQuerySchema.safeParse(request.query)

      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: parseResult.error.errors[0]?.message ?? 'Invalid query',
        })
      }

      const { gpuTier, market, startDate, endDate, limit } = parseResult.data

      const where: {
        gpuTier: GpuTier
        market: Market
        fetchedAt?: { gte?: Date; lte?: Date }
      } = {
        gpuTier: gpuTier as GpuTier,
        market: market as Market,
      }

      if (startDate || endDate) {
        where.fetchedAt = {}
        if (startDate) where.fetchedAt.gte = new Date(startDate)
        if (endDate) where.fetchedAt.lte = new Date(endDate)
      }

      const history = await fastify.prisma.marketRateHistory.findMany({
        where,
        take: limit,
        orderBy: { fetchedAt: 'desc' },
      })

      reply.send({
        gpuTier,
        market,
        history: history.map((h) => ({
          ratePerHour: h.ratePerHour,
          ratePerDay: h.ratePerDay,
          fetchedAt: h.fetchedAt.toISOString(),
        })),
        count: history.length,
      })
    }
  )
}
