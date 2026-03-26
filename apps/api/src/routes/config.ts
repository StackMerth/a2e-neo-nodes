import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { GPU_TIER_CONFIG, dailyToHourly } from '@a2e/shared'
import type { GpuTier, Market } from '@a2e/database'

const updateYieldFloorSchema = z.object({
  gpuTier: z.enum(['H100', 'H200', 'B200', 'B300', 'GB300']),
  ratePerDay: z.number().positive(),
})

const updateMarketConfigSchema = z.object({
  market: z.enum(['AKASH', 'IONET']),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  apiEndpoint: z.string().url().optional().nullable(),
})

export async function configRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/v1/config/yield-floors',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const storedFloors = await fastify.prisma.yieldFloor.findMany()
      const floorMap = new Map(storedFloors.map((f) => [f.gpuTier, f]))

      const tiers: GpuTier[] = ['H100', 'H200', 'B200', 'B300', 'GB300']

      const floors = tiers.map((tier) => {
        const stored = floorMap.get(tier)
        const tierConfig = GPU_TIER_CONFIG[tier]

        return {
          gpuTier: tier,
          ratePerHour: stored?.ratePerHour ?? dailyToHourly(tierConfig.costFloor),
          ratePerDay: stored?.ratePerDay ?? tierConfig.costFloor,
          isCustom: !!stored,
          defaultFloor: tierConfig.costFloor,
          updatedAt: stored?.updatedAt?.toISOString() ?? null,
        }
      })

      reply.send({ floors })
    }
  )

  fastify.patch(
    '/v1/config/yield-floors',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const parseResult = updateYieldFloorSchema.safeParse(request.body)

      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: parseResult.error.errors[0]?.message ?? 'Invalid input',
        })
      }

      const { gpuTier, ratePerDay } = parseResult.data
      const tierConfig = GPU_TIER_CONFIG[gpuTier as GpuTier]

      if (ratePerDay < tierConfig.costFloor) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: `Rate cannot be below cost floor ($${tierConfig.costFloor}/day)`,
        })
      }

      const floor = await fastify.prisma.yieldFloor.upsert({
        where: { gpuTier: gpuTier as GpuTier },
        update: {
          ratePerHour: dailyToHourly(ratePerDay),
          ratePerDay,
        },
        create: {
          gpuTier: gpuTier as GpuTier,
          ratePerHour: dailyToHourly(ratePerDay),
          ratePerDay,
        },
      })

      reply.send({
        gpuTier: floor.gpuTier,
        ratePerHour: floor.ratePerHour,
        ratePerDay: floor.ratePerDay,
        updatedAt: floor.updatedAt.toISOString(),
      })
    }
  )

  fastify.delete(
    '/v1/config/yield-floors/:gpuTier',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { gpuTier } = request.params as { gpuTier: string }

      if (!['H100', 'H200', 'B200', 'B300', 'GB300'].includes(gpuTier)) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: 'Invalid GPU tier',
        })
      }

      await fastify.prisma.yieldFloor.delete({
        where: { gpuTier: gpuTier as GpuTier },
      }).catch(() => {})

      const tierConfig = GPU_TIER_CONFIG[gpuTier as GpuTier]

      reply.send({
        gpuTier,
        ratePerHour: dailyToHourly(tierConfig.costFloor),
        ratePerDay: tierConfig.costFloor,
        isDefault: true,
      })
    }
  )

  fastify.get(
    '/v1/config/markets',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const configs = await fastify.prisma.marketConfig.findMany({
        orderBy: { priority: 'desc' },
      })

      const markets: Market[] = ['INTERNAL', 'AKASH', 'IONET']
      const configMap = new Map(configs.map((c) => [c.market, c]))

      const result = markets.map((market) => {
        const config = configMap.get(market)

        if (market === 'INTERNAL') {
          return {
            market,
            enabled: true,
            priority: 100,
            apiEndpoint: null,
            updatedAt: null,
          }
        }

        return {
          market,
          enabled: config?.enabled ?? true,
          priority: config?.priority ?? 0,
          apiEndpoint: config?.apiEndpoint ?? null,
          updatedAt: config?.updatedAt?.toISOString() ?? null,
        }
      })

      reply.send({ markets: result })
    }
  )

  fastify.patch(
    '/v1/config/markets',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const parseResult = updateMarketConfigSchema.safeParse(request.body)

      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: parseResult.error.errors[0]?.message ?? 'Invalid input',
        })
      }

      const { market, enabled, priority, apiEndpoint } = parseResult.data

      const updateData: {
        enabled?: boolean
        priority?: number
        apiEndpoint?: string | null
      } = {}

      if (enabled !== undefined) updateData.enabled = enabled
      if (priority !== undefined) updateData.priority = priority
      if (apiEndpoint !== undefined) updateData.apiEndpoint = apiEndpoint

      const config = await fastify.prisma.marketConfig.upsert({
        where: { market: market as Market },
        update: updateData,
        create: {
          market: market as Market,
          enabled: enabled ?? true,
          priority: priority ?? 0,
          apiEndpoint: apiEndpoint ?? null,
        },
      })

      reply.send({
        market: config.market,
        enabled: config.enabled,
        priority: config.priority,
        apiEndpoint: config.apiEndpoint,
        updatedAt: config.updatedAt.toISOString(),
      })
    }
  )

  // Config audit log (placeholder - returns recent config changes)
  fastify.get(
    '/v1/config/audit',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { limit = '20' } = request.query as { limit?: string }
      const numLimit = Math.min(parseInt(limit, 10) || 20, 100)

      // Get recent yield floor and market config updates
      const [yieldFloors, marketConfigs] = await Promise.all([
        fastify.prisma.yieldFloor.findMany({
          orderBy: { updatedAt: 'desc' },
          take: numLimit,
        }),
        fastify.prisma.marketConfig.findMany({
          orderBy: { updatedAt: 'desc' },
          take: numLimit,
        }),
      ])

      const logs = [
        ...yieldFloors.map((f) => ({
          id: `yf-${f.gpuTier}`,
          action: 'UPDATE' as const,
          field: `yield_floor.${f.gpuTier}`,
          oldValue: 'previous value',
          newValue: `$${f.ratePerDay.toFixed(2)}/day`,
          changedBy: 'admin',
          changedAt: f.updatedAt.toISOString(),
        })),
        ...marketConfigs.map((c) => ({
          id: `mc-${c.market}`,
          action: 'UPDATE' as const,
          field: `market.${c.market}`,
          oldValue: c.enabled ? 'disabled' : 'enabled',
          newValue: c.enabled ? 'enabled' : 'disabled',
          changedBy: 'admin',
          changedAt: c.updatedAt.toISOString(),
        })),
      ]
        .sort((a, b) => new Date(b.changedAt).getTime() - new Date(a.changedAt).getTime())
        .slice(0, numLimit)

      reply.send({
        logs,
        pagination: { page: 1, limit: numLimit, total: logs.length }
      })
    }
  )
}
