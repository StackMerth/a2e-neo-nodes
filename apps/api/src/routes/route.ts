// Main Routing Endpoint
// POST /v1/route - Primary integration point for TokenOS

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { RoutingEngine } from '@a2e/core'
import { GPU_TIER_CONFIG, dailyToHourly } from '@a2e/shared'
import type { GpuTier, Market, JobStatus } from '@a2e/database'

const routeRequestSchema = z.object({
  deploymentId: z.string().min(1).max(128),
  gpuTier: z.enum(['H100', 'H200', 'B200', 'B300', 'GB300']),
  hasInternalDemand: z.boolean().default(false),
  durationSeconds: z.number().positive().optional(),
})

export async function routeRoutes(fastify: FastifyInstance) {
  // Main routing decision endpoint
  fastify.post(
    '/v1/route',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const parseResult = routeRequestSchema.safeParse(request.body)

      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: parseResult.error.errors[0]?.message ?? 'Invalid input',
          details: parseResult.error.errors,
        })
      }

      const { deploymentId, gpuTier, hasInternalDemand, durationSeconds } = parseResult.data
      const startTime = Date.now()

      // Get rates from cache/database
      const rates = await getRatesFromCache(fastify, gpuTier as GpuTier)
      const yieldFloor = await getYieldFloor(fastify, gpuTier as GpuTier)

      // Create routing engine with current rates
      const rateProvider = {
        getRates: async () => rates,
        refreshRates: async () => {},
      }

      const yieldFloorConfig = {
        getFloor: () => yieldFloor,
        setFloor: () => {},
      }

      const routingEngine = new RoutingEngine({
        rateProvider,
        yieldFloorConfig,
      })

      // Get routing decision
      const decision = await routingEngine.route({
        gpuTier: gpuTier as GpuTier,
        hasInternalDemand,
        deploymentId,
      })

      const decisionTimeMs = Date.now() - startTime

      // Create job and routing log in transaction
      const [job] = await fastify.prisma.$transaction([
        fastify.prisma.job.create({
          data: {
            deploymentId,
            gpuTier: gpuTier as GpuTier,
            market: decision.market as Market,
            ratePerHour: decision.ratePerHour,
            status: 'ASSIGNED' as JobStatus,
            routedAt: new Date(),
            durationSeconds,
          },
        }),
      ])

      // Create routing log after job is created
      await fastify.prisma.routingLog.create({
        data: {
          jobId: job.id,
          selectedMarket: decision.market as Market,
          selectedRate: decision.ratePerHour,
          internalRate: rates.internal.ratePerHour,
          akashRate: rates.akash.available ? rates.akash.ratePerHour : null,
          ionetRate: rates.ionet.available ? rates.ionet.ratePerHour : null,
          yieldFloor: yieldFloor.ratePerHour,
          yieldFloorApplied: decision.yieldFloorApplied,
          reason: decision.reason,
          decisionTimeMs,
        },
      })

      // Emit WebSocket event
      fastify.io?.emit('job:routed', {
        jobId: job.id,
        deploymentId,
        gpuTier,
        market: decision.market,
        ratePerHour: decision.ratePerHour,
        ratePerDay: decision.ratePerDay,
        reason: decision.reason,
        yieldFloorApplied: decision.yieldFloorApplied,
        timestamp: new Date().toISOString(),
      })

      reply.send({
        jobId: job.id,
        deploymentId,
        market: decision.market,
        ratePerHour: decision.ratePerHour,
        ratePerDay: decision.ratePerDay,
        reason: decision.reason,
        yieldFloorApplied: decision.yieldFloorApplied,
        decisionTimeMs,
        timestamp: decision.timestamp.toISOString(),
      })
    }
  )
}

async function getRatesFromCache(
  fastify: FastifyInstance,
  gpuTier: GpuTier
): Promise<{
  internal: { ratePerHour: number; ratePerDay: number; available: boolean; fetchedAt: Date }
  akash: { ratePerHour: number; ratePerDay: number; available: boolean; fetchedAt: Date }
  ionet: { ratePerHour: number; ratePerDay: number; available: boolean; fetchedAt: Date }
}> {
  const tierConfig = GPU_TIER_CONFIG[gpuTier]
  const now = new Date()

  // Internal rate from config
  const internal = {
    ratePerHour: dailyToHourly(tierConfig.retailRate),
    ratePerDay: tierConfig.retailRate,
    available: true,
    fetchedAt: now,
  }

  // Try to get external rates from database
  const [akashRate, ionetRate, akashConfig, ionetConfig] = await Promise.all([
    fastify.prisma.marketRate.findUnique({
      where: { market_gpuTier: { market: 'AKASH', gpuTier } },
    }),
    fastify.prisma.marketRate.findUnique({
      where: { market_gpuTier: { market: 'IONET', gpuTier } },
    }),
    fastify.prisma.marketConfig.findUnique({ where: { market: 'AKASH' } }),
    fastify.prisma.marketConfig.findUnique({ where: { market: 'IONET' } }),
  ])

  const akash = {
    ratePerHour: akashRate?.ratePerHour ?? 0,
    ratePerDay: akashRate?.ratePerDay ?? 0,
    available: akashRate?.available === true && akashConfig?.enabled !== false,
    fetchedAt: akashRate?.fetchedAt ?? now,
  }

  const ionet = {
    ratePerHour: ionetRate?.ratePerHour ?? 0,
    ratePerDay: ionetRate?.ratePerDay ?? 0,
    available: ionetRate?.available === true && ionetConfig?.enabled !== false,
    fetchedAt: ionetRate?.fetchedAt ?? now,
  }

  return { internal, akash, ionet }
}

async function getYieldFloor(
  fastify: FastifyInstance,
  gpuTier: GpuTier
): Promise<{ ratePerHour: number; ratePerDay: number }> {
  // Check for custom floor in database
  const customFloor = await fastify.prisma.yieldFloor.findUnique({
    where: { gpuTier },
  })

  if (customFloor) {
    return {
      ratePerHour: customFloor.ratePerHour,
      ratePerDay: customFloor.ratePerDay,
    }
  }

  // Fall back to cost floor from config
  const tierConfig = GPU_TIER_CONFIG[gpuTier]
  return {
    ratePerHour: dailyToHourly(tierConfig.costFloor),
    ratePerDay: tierConfig.costFloor,
  }
}
