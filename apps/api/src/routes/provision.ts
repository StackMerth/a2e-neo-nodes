import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { GpuTier, ProvisionStatus } from '@a2e/database'
import { submitProvisionJob } from '../jobs/provision-processor'

const provisionRequestSchema = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).max(64),
  authMethod: z.enum(['password', 'privateKey']),
  password: z.string().max(256).optional(),
  privateKey: z.string().max(16384).optional(),
  passphrase: z.string().max(256).optional(),
  gpuTier: z.enum(['H100', 'H200', 'B200', 'B300', 'GB300', 'OTHER', 'CONSUMER', 'RTX_4090', 'RTX_3090']),
  nodeName: z.string().max(128).optional(),
  region: z.string().max(64).optional(),
  // Custom GPU fields for OTHER tier
  customGpuModel: z.string().max(64).optional(),
  customRatePerDay: z.number().positive().optional(),
  // Test mode - skip GPU verification and use mock GPU
  testMode: z.boolean().optional(),
}).refine(
  (data) => {
    if (data.authMethod === 'password') {
      return !!data.password
    } else {
      return !!data.privateKey
    }
  },
  {
    message: 'Password required for password auth, privateKey required for key auth',
  }
).refine(
  (data) => {
    // If OTHER tier, require custom fields
    if (data.gpuTier === 'OTHER') {
      return !!data.customGpuModel && !!data.customRatePerDay
    }
    return true
  },
  {
    message: 'customGpuModel and customRatePerDay are required for OTHER tier',
  }
)

export async function provisionRoutes(fastify: FastifyInstance) {
  /**
   * POST /v1/nodes/provision
   * Start provisioning a new node via SSH
   */
  fastify.post(
    '/v1/nodes/provision',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const parseResult = provisionRequestSchema.safeParse(request.body)

      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: parseResult.error.errors[0]?.message ?? 'Invalid input',
          details: parseResult.error.errors,
        })
      }

      const data = parseResult.data

      if (!fastify.provisionQueue) {
        return reply.code(503).send({
          error: 'Service Unavailable',
          message: 'Provisioning queue not initialized',
        })
      }

      try {
        const provisionId = await submitProvisionJob(
          fastify.provisionQueue,
          fastify.prisma,
          {
            host: data.host,
            port: data.port,
            username: data.username,
            authMethod: data.authMethod,
            password: data.password,
            privateKey: data.privateKey,
            passphrase: data.passphrase,
            gpuTier: data.gpuTier as GpuTier,
            nodeName: data.nodeName,
            region: data.region,
            customGpuModel: data.customGpuModel,
            customRatePerDay: data.customRatePerDay,
            testMode: data.testMode,
          }
        )

        reply.code(202).send({
          provisionId,
          status: 'PENDING',
          message: 'Provisioning job queued',
          createdAt: new Date().toISOString(),
        })
      } catch (error) {
        fastify.log.error(error, 'Failed to queue provision job')
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to start provisioning',
        })
      }
    }
  )

  /**
   * GET /v1/nodes/provision/:id
   * Get provisioning job status
   */
  fastify.get(
    '/v1/nodes/provision/:id',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const job = await fastify.prisma.provisionJob.findUnique({
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
        },
      })

      if (!job) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Provision job not found',
        })
      }

      reply.send({
        provisionId: job.id,
        status: job.status,
        host: job.host,
        port: job.port,
        username: job.username,
        gpuTier: job.gpuTier,
        nodeName: job.nodeName,
        region: job.region,
        currentStep: job.currentStep,
        totalSteps: job.totalSteps,
        currentAction: job.currentAction,
        logs: job.logs,
        node: job.node,
        error: job.error,
        createdAt: job.createdAt.toISOString(),
        startedAt: job.startedAt?.toISOString() ?? null,
        completedAt: job.completedAt?.toISOString() ?? null,
      })
    }
  )

  /**
   * GET /v1/nodes/provision
   * List all provisioning jobs
   */
  fastify.get(
    '/v1/nodes/provision',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const querySchema = z.object({
        status: z.enum([
          'PENDING', 'CONNECTING', 'VERIFYING', 'DOWNLOADING',
          'INSTALLING', 'CONFIGURING', 'STARTING', 'WAITING_REGISTRATION',
          'COMPLETED', 'FAILED', 'CANCELLED'
        ]).optional(),
        page: z.coerce.number().min(1).default(1),
        limit: z.coerce.number().min(1).max(100).default(20),
      })

      const parseResult = querySchema.safeParse(request.query)

      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: parseResult.error.errors[0]?.message ?? 'Invalid query',
        })
      }

      const { status, page, limit } = parseResult.data
      const skip = (page - 1) * limit

      const where: { status?: ProvisionStatus } = {}
      if (status) where.status = status as ProvisionStatus

      const [jobs, total] = await Promise.all([
        fastify.prisma.provisionJob.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            status: true,
            host: true,
            gpuTier: true,
            nodeName: true,
            currentStep: true,
            totalSteps: true,
            currentAction: true,
            nodeId: true,
            error: true,
            createdAt: true,
            completedAt: true,
          },
        }),
        fastify.prisma.provisionJob.count({ where }),
      ])

      reply.send({
        jobs: jobs.map((j) => ({
          ...j,
          createdAt: j.createdAt.toISOString(),
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

  /**
   * DELETE /v1/nodes/provision/:id
   * Cancel a provisioning job
   */
  fastify.delete(
    '/v1/nodes/provision/:id',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const job = await fastify.prisma.provisionJob.findUnique({
        where: { id },
      })

      if (!job) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Provision job not found',
        })
      }

      // Only allow cancelling jobs that are not completed or failed
      if (job.status === 'COMPLETED' || job.status === 'FAILED') {
        return reply.code(400).send({
          error: 'Bad Request',
          message: `Cannot cancel job with status ${job.status}`,
        })
      }

      // Update status to cancelled
      await fastify.prisma.provisionJob.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          completedAt: new Date(),
        },
      })

      // Emit cancellation event
      fastify.io?.emit('provision:cancelled', { provisionId: id })

      reply.send({
        provisionId: id,
        status: 'CANCELLED',
        message: 'Provisioning job cancelled',
      })
    }
  )
}
