import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { GpuTier, JobStatus, Market } from '@a2e/database'
import { submitJobToQueue, requeueJob } from '../jobs/job-processor'
import { calculateJobCost, calculateJobProfit } from '../services/cost/calculator'
import { recordJobEarnings } from '../services/earnings/calculator'
import { roundUsd } from '@a2e/shared'
import '../types' // Type augmentations

const submitJobSchema = z.object({
  deploymentId: z.string().min(1).max(128),
  gpuTier: z.enum(['H100', 'H200', 'L40S', 'B200', 'B300', 'GB300', 'CONSUMER', 'RTX_4090', 'RTX_3090']),
  nodeId: z.string().optional(),
  hasInternalDemand: z.boolean().optional().default(false),
  autoRoute: z.boolean().optional().default(true),
})

const listJobsQuerySchema = z.object({
  status: z.enum(['PENDING', 'ROUTING', 'ASSIGNED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']).optional(),
  market: z.enum(['INTERNAL', 'AKASH', 'IONET']).optional(),
  // C2 wave 2: include consumer tiers so the admin dashboard's tier
  // filter dropdown can narrow by RTX_4090 / RTX_3090 / CONSUMER too.
  gpuTier: z.enum(['H100', 'H200', 'L40S', 'B200', 'B300', 'GB300', 'CONSUMER', 'RTX_4090', 'RTX_3090']).optional(),
  nodeId: z.string().optional(),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
})

const updateJobSchema = z.object({
  status: z.enum(['RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']).optional(),
  durationSeconds: z.number().positive().optional(),
  errorMessage: z.string().max(1000).optional(),
  nodeId: z.string().optional(),
})

export async function jobRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/v1/jobs',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const parseResult = submitJobSchema.safeParse(request.body)

      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: parseResult.error.errors[0]?.message ?? 'Invalid input',
          details: parseResult.error.errors,
        })
      }

      const { deploymentId, gpuTier, nodeId, hasInternalDemand, autoRoute } = parseResult.data

      if (nodeId) {
        const node = await fastify.prisma.node.findUnique({ where: { id: nodeId } })
        if (!node) {
          return reply.code(404).send({
            error: 'Not Found',
            message: 'Specified node not found',
          })
        }
      }

      const job = await fastify.prisma.job.create({
        data: {
          deploymentId,
          gpuTier: gpuTier as GpuTier,
          nodeId,
          status: 'PENDING' as JobStatus,
        },
      })

      // Submit to job processing queue for auto-routing and node assignment
      if (autoRoute && fastify.jobQueue) {
        await submitJobToQueue(fastify.jobQueue, {
          jobId: job.id,
          deploymentId,
          gpuTier: gpuTier as GpuTier,
          hasInternalDemand,
          preferredNodeId: nodeId,
        })
      }

      reply.code(201).send({
        id: job.id,
        deploymentId: job.deploymentId,
        gpuTier: job.gpuTier,
        status: job.status,
        nodeId: job.nodeId,
        queued: autoRoute,
        createdAt: job.createdAt.toISOString(),
      })
    }
  )

  fastify.get(
    '/v1/jobs',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const parseResult = listJobsQuerySchema.safeParse(request.query)

      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: parseResult.error.errors[0]?.message ?? 'Invalid query',
        })
      }

      const { status, market, gpuTier, nodeId, page, limit } = parseResult.data
      const skip = (page - 1) * limit

      const where: { status?: JobStatus; market?: Market; gpuTier?: GpuTier; nodeId?: string } = {}
      if (status) where.status = status as JobStatus
      if (market) where.market = market as Market
      if (gpuTier) where.gpuTier = gpuTier as GpuTier
      if (nodeId) where.nodeId = nodeId

      const [jobs, total] = await Promise.all([
        fastify.prisma.job.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            deploymentId: true,
            nodeId: true,
            gpuTier: true,
            status: true,
            market: true,
            ratePerHour: true,
            requestedAt: true,
            routedAt: true,
            startedAt: true,
            completedAt: true,
            durationSeconds: true,
            earnings: true,
            cost: true,
            profit: true,
          },
        }),
        fastify.prisma.job.count({ where }),
      ])

      reply.send({
        jobs: jobs.map((j) => ({
          ...j,
          requestedAt: j.requestedAt.toISOString(),
          routedAt: j.routedAt?.toISOString() ?? null,
          startedAt: j.startedAt?.toISOString() ?? null,
          completedAt: j.completedAt?.toISOString() ?? null,
        })),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      })
    }
  )

  fastify.get(
    '/v1/jobs/:id',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const job = await fastify.prisma.job.findUnique({
        where: { id },
        include: {
          node: {
            select: {
              id: true,
              walletAddress: true,
              gpuTier: true,
              status: true,
            },
          },
          routingLog: true,
        },
      })

      if (!job) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Job not found',
        })
      }

      reply.send({
        id: job.id,
        deploymentId: job.deploymentId,
        gpuTier: job.gpuTier,
        status: job.status,
        market: job.market,
        ratePerHour: job.ratePerHour,
        node: job.node,
        timing: {
          requestedAt: job.requestedAt.toISOString(),
          routedAt: job.routedAt?.toISOString() ?? null,
          startedAt: job.startedAt?.toISOString() ?? null,
          completedAt: job.completedAt?.toISOString() ?? null,
          durationSeconds: job.durationSeconds,
        },
        financials: {
          earnings: job.earnings,
          cost: job.cost,
          profit: job.profit,
          profitMargin: job.earnings && job.cost && job.earnings > 0
            ? Math.round(((job.earnings - job.cost) / job.earnings) * 10000) / 100
            : null,
        },
        errorMessage: job.errorMessage,
        retryCount: job.retryCount,
        routingLog: job.routingLog
          ? {
              selectedMarket: job.routingLog.selectedMarket,
              selectedRate: job.routingLog.selectedRate,
              internalRate: job.routingLog.internalRate,
              akashRate: job.routingLog.akashRate,
              ionetRate: job.routingLog.ionetRate,
              yieldFloor: job.routingLog.yieldFloor,
              yieldFloorApplied: job.routingLog.yieldFloorApplied,
              reason: job.routingLog.reason,
              decisionTimeMs: job.routingLog.decisionTimeMs,
              timestamp: job.routingLog.timestamp.toISOString(),
            }
          : null,
      })
    }
  )

  fastify.patch(
    '/v1/jobs/:id',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const parseResult = updateJobSchema.safeParse(request.body)

      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: parseResult.error.errors[0]?.message ?? 'Invalid input',
        })
      }

      const job = await fastify.prisma.job.findUnique({ where: { id } })

      if (!job) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Job not found',
        })
      }

      // SECURITY (pen-test 2026-06-09 step 5): allow PATCH only from
      //   - the owning node-agent (X-API-Key matches node.apiKey and
      //     node.id matches job.nodeId), or
      //   - an admin (X-API-Key matches ADMIN_API_KEY or user role=ADMIN).
      // Any other caller previously got through with just JWT auth and
      // could mint unbounded earnings via durationSeconds.
      const isAdmin =
        request.authType === 'admin' ||
        (request.authType === 'user' && request.user?.role === 'ADMIN')
      const isOwningNode =
        request.authType === 'node' && request.authNodeId === job.nodeId
      if (!isAdmin && !isOwningNode) {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'Only the assigned node or an admin can update this job.',
        })
      }

      const { status, durationSeconds, errorMessage, nodeId } = parseResult.data

      const updateData: {
        status?: JobStatus
        durationSeconds?: number
        errorMessage?: string
        startedAt?: Date
        completedAt?: Date
        earnings?: number
        cost?: number
        profit?: number
        nodeId?: string
      } = {}

      if (nodeId !== undefined) {
        // Admin-only: re-assigning a job to a different node.
        if (!isAdmin) {
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'Only admins can reassign job.nodeId.',
          })
        }
        updateData.nodeId = nodeId
      }

      // Compute the effective completedAt FIRST so terminal-status
      // earnings math below can derive a server-attested duration.
      let effectiveCompletedAt: Date | null = job.completedAt
      if (status) {
        updateData.status = status as JobStatus

        if (status === 'RUNNING' && !job.startedAt) {
          updateData.startedAt = new Date()
        }

        if ((status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED') && !job.completedAt) {
          const now = new Date()
          updateData.completedAt = now
          effectiveCompletedAt = now
        }
      }

      if (durationSeconds !== undefined) {
        // SECURITY (pen-test 2026-06-09 step 5): non-admin client cannot
        // mint earnings via client-supplied durationSeconds. We record
        // their value as informational only; earnings are derived from
        // server-attested wall-clock (startedAt -> completedAt). Admin
        // retains the ability to attribute a specific duration for
        // ops/backfill scenarios.
        updateData.durationSeconds = durationSeconds
      }

      const isTerminal = status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED'
      if (isTerminal && job.ratePerHour && effectiveCompletedAt) {
        // Server-attested duration: wall-clock between startedAt and
        // completedAt. If startedAt is missing (job never moved to
        // RUNNING) the job earned nothing.
        const startedAt = job.startedAt ?? effectiveCompletedAt
        const attestedDuration = Math.max(
          0,
          Math.floor((effectiveCompletedAt.getTime() - startedAt.getTime()) / 1000),
        )

        // Admin override: if admin explicitly supplied durationSeconds,
        // honor it; otherwise use the server-attested value. Node-agent
        // requests always use server-attested (durationSeconds is
        // informational only for them).
        const billableDuration =
          isAdmin && durationSeconds !== undefined ? durationSeconds : attestedDuration

        // Overwrite the durationSeconds we wrote above so the row
        // reflects what was actually billed.
        updateData.durationSeconds = billableDuration

        // SECURITY (pen-test 2026-06-09/10 finding B-5): round earnings,
        // cost, and profit to cents on write. Pen tester reproduced
        // +$1,212 (H100) / -$2,430 (CONSUMER) directional drift over
        // 500K jobs because (billableDuration / 3600) * ratePerHour
        // carries IEEE 754 residue and Postgres stores it verbatim. With
        // rounding at the boundary each job's earnings is exact-to-cent
        // and downstream balance credits stay exact too.
        updateData.earnings = roundUsd((billableDuration / 3600) * job.ratePerHour)

        if (status === 'COMPLETED' && job.market) {
          const costResult = await calculateJobCost(fastify.prisma, {
            market: job.market,
            gpuTier: job.gpuTier,
            durationSeconds: billableDuration,
            ratePerHour: job.ratePerHour ?? undefined,
          })
          updateData.cost = roundUsd(costResult.cost)
          updateData.profit = roundUsd(
            calculateJobProfit(updateData.earnings, costResult.cost),
          )
        }
      }

      if (errorMessage !== undefined) {
        updateData.errorMessage = errorMessage
      }

      const updatedJob = await fastify.prisma.job.update({
        where: { id },
        data: updateData,
      })

      // Record earnings to daily aggregation table if job completed successfully
      if (status === 'COMPLETED' && updatedJob.nodeId && updatedJob.market) {
        await recordJobEarnings(fastify.prisma, updatedJob)
      }

      reply.send({
        id: updatedJob.id,
        status: updatedJob.status,
        durationSeconds: updatedJob.durationSeconds,
        earnings: updatedJob.earnings,
        cost: updatedJob.cost,
        profit: updatedJob.profit,
        updatedAt: updatedJob.updatedAt.toISOString(),
      })
    }
  )

  // Retry a failed job
  fastify.post(
    '/v1/jobs/:id/retry',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const job = await fastify.prisma.job.findUnique({ where: { id } })

      if (!job) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Job not found',
        })
      }

      if (job.status !== 'FAILED') {
        return reply.code(400).send({
          error: 'Bad Request',
          message: `Cannot retry job with status ${job.status}. Only FAILED jobs can be retried.`,
        })
      }

      if (job.retryCount >= 3) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Job has exceeded maximum retry attempts (3)',
        })
      }

      if (!fastify.jobQueue) {
        return reply.code(503).send({
          error: 'Service Unavailable',
          message: 'Job queue not initialized',
        })
      }

      const requeued = await requeueJob(fastify.jobQueue, fastify.prisma, id)

      if (!requeued) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Could not requeue job',
        })
      }

      reply.send({
        id: job.id,
        status: 'PENDING',
        message: 'Job requeued for retry',
        retryCount: job.retryCount + 1,
      })
    }
  )
}
