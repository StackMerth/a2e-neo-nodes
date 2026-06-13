import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { JobStatus, NodeStatus } from '@a2e/database'
import crypto from 'node:crypto'
import { recordJobEarnings } from '../services/earnings/calculator'
import { notifyJobCompleted, notifyJobFailed } from '../services/notification/service.js'
import {
  isCheckpointS3Configured,
  presignCheckpointUpload,
  presignCheckpointDownload,
} from '../services/checkpoints/s3.js'

/**
 * Agent Communication Endpoints
 *
 * These endpoints are used by the A²E Node Agent to communicate with the server.
 * They handle job polling, acceptance, progress reporting, and remote commands.
 */

// Request schemas
const pollJobsSchema = z.object({
  capabilities: z.object({
    gpuTier: z.enum(['H100', 'H200', 'L40S', 'B200', 'B300', 'GB300', 'CONSUMER', 'RTX_4090', 'RTX_3090']),
    gpuCount: z.number().int().min(1).default(1),
    vramGb: z.number().min(0).optional(),
    cudaVersion: z.string().optional(),
    driverVersion: z.string().optional(),
  }),
  agentVersion: z.string().min(1).max(32),
  maxJobs: z.number().int().min(1).max(10).default(1),
})

const acceptJobSchema = z.object({
  nodeId: z.string().min(1),
  estimatedStartTime: z.string().datetime().optional(),
})

const rejectJobSchema = z.object({
  nodeId: z.string().min(1),
  reason: z.string().max(500),
  retryable: z.boolean().default(true),
})

const progressSchema = z.object({
  nodeId: z.string().min(1),
  progress: z.number().min(0).max(100),
  stage: z.string().max(64).optional(),
  logs: z.string().max(10000).optional(),
  metrics: z
    .object({
      gpuUtilization: z.number().min(0).max(100).optional(),
      gpuMemoryUsed: z.number().min(0).optional(),
      gpuTemperature: z.number().min(0).max(150).optional(),
    })
    .optional(),
})

const completeJobSchema = z.object({
  nodeId: z.string().min(1),
  durationSeconds: z.number().positive(),
  exitCode: z.number().int().default(0),
  output: z.string().max(100000).optional(),
  logs: z.string().max(100000).optional(),
  metrics: z
    .object({
      peakGpuUtilization: z.number().min(0).max(100).optional(),
      peakGpuMemory: z.number().min(0).optional(),
      peakGpuTemperature: z.number().min(0).max(150).optional(),
      totalGpuSeconds: z.number().min(0).optional(),
    })
    .optional(),
})

const failJobSchema = z.object({
  nodeId: z.string().min(1),
  errorMessage: z.string().max(2000),
  errorCode: z.string().max(64).optional(),
  logs: z.string().max(100000).optional(),
  retryable: z.boolean().default(true),
  durationSeconds: z.number().min(0).optional(),
})

const commandSchema = z.object({
  command: z.enum(['pause', 'resume', 'restart', 'update', 'shutdown']),
  params: z.record(z.unknown()).optional(),
})

export async function agentRoutes(fastify: FastifyInstance) {
  /**
   * POST /v1/nodes/:id/jobs/poll
   * Agent polls for available jobs matching its capabilities
   */
  fastify.post(
    '/v1/nodes/:id/jobs/poll',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const parseResult = pollJobsSchema.safeParse(request.body)

      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: parseResult.error.errors[0]?.message ?? 'Invalid input',
          details: parseResult.error.errors,
        })
      }

      const { capabilities, agentVersion, maxJobs } = parseResult.data

      // Verify node exists and update agent version
      const node = await fastify.prisma.node.findUnique({ where: { id } })

      if (!node) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Node not found',
        })
      }

      // Update agent version if changed
      if (node.agentVersion !== agentVersion) {
        await fastify.prisma.node.update({
          where: { id },
          data: { agentVersion },
        })
      }

      // Check if node is allowed to accept jobs
      if (node.status === 'PAUSED' || node.status === 'MAINTENANCE' || node.status === 'OFFLINE') {
        return reply.send({
          jobs: [],
          message: `Node is ${node.status.toLowerCase()}, not accepting jobs`,
        })
      }

      // Find assigned jobs for this node that are ready to run
      const assignedJobs = await fastify.prisma.job.findMany({
        where: {
          nodeId: id,
          status: 'ASSIGNED',
          gpuTier: capabilities.gpuTier,
        },
        take: maxJobs,
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          deploymentId: true,
          gpuTier: true,
          market: true,
          ratePerHour: true,
          requestedAt: true,
        },
      })

      // If no assigned jobs, check for pending jobs that can be auto-assigned
      if (assignedJobs.length === 0) {
        const pendingJobs = await fastify.prisma.job.findMany({
          where: {
            status: 'PENDING',
            gpuTier: capabilities.gpuTier,
            nodeId: null,
          },
          take: maxJobs,
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            deploymentId: true,
            gpuTier: true,
            market: true,
            ratePerHour: true,
            requestedAt: true,
          },
        })

        reply.send({
          jobs: pendingJobs.map((job) => ({
            id: job.id,
            deploymentId: job.deploymentId,
            gpuTier: job.gpuTier,
            market: job.market,
            ratePerHour: job.ratePerHour,
            requestedAt: job.requestedAt.toISOString(),
            autoAssign: true,
          })),
          nodeStatus: node.status,
          pendingCommands: [],
        })
        return
      }

      reply.send({
        jobs: assignedJobs.map((job) => ({
          id: job.id,
          deploymentId: job.deploymentId,
          gpuTier: job.gpuTier,
          market: job.market,
          ratePerHour: job.ratePerHour,
          requestedAt: job.requestedAt.toISOString(),
          autoAssign: false,
        })),
        nodeStatus: node.status,
        pendingCommands: [],
      })
    }
  )

  /**
   * POST /v1/jobs/:id/accept
   * Agent accepts a job and begins execution
   */
  fastify.post(
    '/v1/jobs/:id/accept',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const parseResult = acceptJobSchema.safeParse(request.body)

      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: parseResult.error.errors[0]?.message ?? 'Invalid input',
        })
      }

      const { nodeId } = parseResult.data

      const job = await fastify.prisma.job.findUnique({ where: { id } })

      if (!job) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Job not found',
        })
      }

      // Check job is in acceptable state
      if (job.status !== 'PENDING' && job.status !== 'ASSIGNED') {
        return reply.code(409).send({
          error: 'Conflict',
          message: `Job cannot be accepted in ${job.status} status`,
        })
      }

      // If job is assigned to another node, reject
      if (job.nodeId && job.nodeId !== nodeId) {
        return reply.code(409).send({
          error: 'Conflict',
          message: 'Job is assigned to a different node',
        })
      }

      // Update job and node atomically
      const [updatedJob] = await fastify.prisma.$transaction([
        fastify.prisma.job.update({
          where: { id },
          data: {
            status: 'RUNNING' as JobStatus,
            nodeId,
            startedAt: new Date(),
          },
        }),
        fastify.prisma.node.update({
          where: { id: nodeId },
          data: {
            currentJobId: id,
            status: 'ONLINE' as NodeStatus,
          },
        }),
      ])

      // Emit WebSocket event
      fastify.io?.emit('job:started', {
        id: updatedJob.id,
        nodeId,
        deploymentId: updatedJob.deploymentId,
        gpuTier: updatedJob.gpuTier,
        startedAt: updatedJob.startedAt?.toISOString(),
        timestamp: new Date().toISOString(),
      })

      reply.send({
        id: updatedJob.id,
        status: updatedJob.status,
        startedAt: updatedJob.startedAt?.toISOString(),
        accepted: true,
      })
    }
  )

  /**
   * POST /v1/jobs/:id/reject
   * Agent rejects a job (cannot execute)
   */
  fastify.post(
    '/v1/jobs/:id/reject',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const parseResult = rejectJobSchema.safeParse(request.body)

      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: parseResult.error.errors[0]?.message ?? 'Invalid input',
        })
      }

      const { nodeId, reason, retryable } = parseResult.data

      const job = await fastify.prisma.job.findUnique({ where: { id } })

      if (!job) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Job not found',
        })
      }

      // Check job is in acceptable state
      if (job.status !== 'PENDING' && job.status !== 'ASSIGNED') {
        return reply.code(409).send({
          error: 'Conflict',
          message: `Job cannot be rejected in ${job.status} status`,
        })
      }

      // Update job status
      const updatedJob = await fastify.prisma.job.update({
        where: { id },
        data: {
          status: retryable ? ('PENDING' as JobStatus) : ('FAILED' as JobStatus),
          nodeId: null,
          errorMessage: `Rejected by node ${nodeId}: ${reason}`,
          retryCount: { increment: retryable ? 1 : 0 },
        },
      })

      // Emit WebSocket event
      fastify.io?.emit('job:rejected', {
        id: updatedJob.id,
        nodeId,
        reason,
        retryable,
        timestamp: new Date().toISOString(),
      })

      reply.send({
        id: updatedJob.id,
        status: updatedJob.status,
        rejected: true,
        requeued: retryable,
      })
    }
  )

  /**
   * POST /v1/jobs/:id/progress
   * Agent reports job progress
   */
  fastify.post(
    '/v1/jobs/:id/progress',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const parseResult = progressSchema.safeParse(request.body)

      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: parseResult.error.errors[0]?.message ?? 'Invalid input',
        })
      }

      const { nodeId, progress, stage, metrics } = parseResult.data

      const job = await fastify.prisma.job.findUnique({ where: { id } })

      if (!job) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Job not found',
        })
      }

      if (job.nodeId !== nodeId) {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'Node is not assigned to this job',
        })
      }

      // Record heartbeat with metrics if provided
      if (metrics) {
        await fastify.prisma.heartbeat.create({
          data: {
            nodeId,
            gpuUtilization: metrics.gpuUtilization,
            gpuMemoryUsed: metrics.gpuMemoryUsed,
            gpuTemperature: metrics.gpuTemperature,
          },
        })
      }

      // Emit WebSocket event with progress
      fastify.io?.emit('job:progress', {
        id: job.id,
        nodeId,
        deploymentId: job.deploymentId,
        progress,
        stage,
        timestamp: new Date().toISOString(),
      })

      reply.send({
        id: job.id,
        progress,
        acknowledged: true,
      })
    }
  )

  /**
   * POST /v1/jobs/:id/complete
   * Agent reports job completion
   */
  fastify.post(
    '/v1/jobs/:id/complete',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const parseResult = completeJobSchema.safeParse(request.body)

      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: parseResult.error.errors[0]?.message ?? 'Invalid input',
        })
      }

      const { nodeId, durationSeconds, exitCode } = parseResult.data

      const job = await fastify.prisma.job.findUnique({ where: { id } })

      if (!job) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Job not found',
        })
      }

      if (job.nodeId !== nodeId) {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'Node is not assigned to this job',
        })
      }

      if (job.status !== 'RUNNING') {
        return reply.code(409).send({
          error: 'Conflict',
          message: `Job cannot be completed in ${job.status} status`,
        })
      }

      // Calculate earnings
      let earnings: number | undefined
      if (job.ratePerHour) {
        earnings = (durationSeconds / 3600) * job.ratePerHour
      }

      // Update job and node atomically
      const [updatedJob] = await fastify.prisma.$transaction([
        fastify.prisma.job.update({
          where: { id },
          data: {
            status: exitCode === 0 ? ('COMPLETED' as JobStatus) : ('FAILED' as JobStatus),
            completedAt: new Date(),
            durationSeconds,
            earnings,
            errorMessage: exitCode !== 0 ? `Process exited with code ${exitCode}` : null,
          },
        }),
        fastify.prisma.node.update({
          where: { id: nodeId },
          data: {
            currentJobId: null,
          },
        }),
      ])

      // Record earnings to daily aggregation table if job completed successfully
      if (exitCode === 0 && updatedJob.nodeId && updatedJob.market) {
        await recordJobEarnings(fastify.prisma, updatedJob)
      }

      // Emit WebSocket event
      fastify.io?.emit('job:completed', {
        id: updatedJob.id,
        nodeId,
        deploymentId: updatedJob.deploymentId,
        status: updatedJob.status,
        durationSeconds,
        earnings,
        completedAt: updatedJob.completedAt?.toISOString(),
        timestamp: new Date().toISOString(),
      })

      // Notify node runner
      void notifyJobCompleted(nodeId, updatedJob.id, earnings)

      reply.send({
        id: updatedJob.id,
        status: updatedJob.status,
        durationSeconds: updatedJob.durationSeconds,
        earnings: updatedJob.earnings,
        completedAt: updatedJob.completedAt?.toISOString(),
      })
    }
  )

  /**
   * POST /v1/jobs/:id/fail
   * Agent reports job failure
   */
  fastify.post(
    '/v1/jobs/:id/fail',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const parseResult = failJobSchema.safeParse(request.body)

      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: parseResult.error.errors[0]?.message ?? 'Invalid input',
        })
      }

      const { nodeId, errorMessage, errorCode, retryable, durationSeconds } = parseResult.data

      const job = await fastify.prisma.job.findUnique({ where: { id } })

      if (!job) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Job not found',
        })
      }

      if (job.nodeId !== nodeId) {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'Node is not assigned to this job',
        })
      }

      // Determine if job should be retried
      const maxRetries = 3
      const shouldRetry = retryable && job.retryCount < maxRetries

      // Update job and node atomically
      const [updatedJob] = await fastify.prisma.$transaction([
        fastify.prisma.job.update({
          where: { id },
          data: {
            status: shouldRetry ? ('PENDING' as JobStatus) : ('FAILED' as JobStatus),
            completedAt: shouldRetry ? null : new Date(),
            durationSeconds,
            errorMessage: errorCode ? `[${errorCode}] ${errorMessage}` : errorMessage,
            retryCount: { increment: 1 },
            nodeId: shouldRetry ? null : job.nodeId,
          },
        }),
        fastify.prisma.node.update({
          where: { id: nodeId },
          data: {
            currentJobId: null,
          },
        }),
      ])

      // Emit WebSocket event
      fastify.io?.emit('job:failed', {
        id: updatedJob.id,
        nodeId,
        deploymentId: updatedJob.deploymentId,
        errorMessage,
        errorCode,
        retryable: shouldRetry,
        retryCount: updatedJob.retryCount,
        timestamp: new Date().toISOString(),
      })

      // Notify node runner (only on final failure, not retries)
      if (!shouldRetry) {
        void notifyJobFailed(nodeId, updatedJob.id, errorMessage)
      }

      reply.send({
        id: updatedJob.id,
        status: updatedJob.status,
        errorMessage: updatedJob.errorMessage,
        retryCount: updatedJob.retryCount,
        willRetry: shouldRetry,
      })
    }
  )

  /**
   * POST /v1/nodes/:id/command
   * Send remote command to node agent
   */
  fastify.post(
    '/v1/nodes/:id/command',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const parseResult = commandSchema.safeParse(request.body)

      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: parseResult.error.errors[0]?.message ?? 'Invalid input',
        })
      }

      const { command, params } = parseResult.data

      const node = await fastify.prisma.node.findUnique({ where: { id } })

      if (!node) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Node not found',
        })
      }

      // Update node status based on command
      let newStatus: NodeStatus | undefined
      switch (command) {
        case 'pause':
          newStatus = 'PAUSED'
          break
        case 'resume':
          newStatus = 'ONLINE'
          break
        case 'shutdown':
          newStatus = 'OFFLINE'
          break
      }

      const updatedNode = await fastify.prisma.node.update({
        where: { id },
        data: {
          status: newStatus,
          lastCommandAt: new Date(),
        },
      })

      // Emit command to connected agent via WebSocket
      fastify.io?.to(`node:${id}`).emit('agent:command', {
        command,
        params,
        timestamp: new Date().toISOString(),
      })

      // Also emit status change event
      if (newStatus) {
        fastify.io?.emit('node:status', {
          id: updatedNode.id,
          status: updatedNode.status,
          command,
          timestamp: new Date().toISOString(),
        })
      }

      reply.send({
        id: updatedNode.id,
        command,
        status: updatedNode.status,
        sent: true,
        lastCommandAt: updatedNode.lastCommandAt?.toISOString(),
      })
    }
  )

  /**
   * GET /v1/nodes/:id/config
   * Get remote configuration for node agent
   */
  fastify.get(
    '/v1/nodes/:id/config',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const node = await fastify.prisma.node.findUnique({ where: { id } })

      if (!node) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Node not found',
        })
      }

      // Get yield floor for this GPU tier
      const yieldFloor = await fastify.prisma.yieldFloor.findUnique({
        where: { gpuTier: node.gpuTier },
      })

      // Get market config
      const marketConfigs = await fastify.prisma.marketConfig.findMany()

      // Get general config values
      const configEntries = await fastify.prisma.config.findMany({
        where: {
          key: {
            in: ['heartbeat_interval', 'job_timeout', 'max_concurrent_jobs', 'log_level'],
          },
        },
      })

      const config: Record<string, string | number | boolean> = {}
      for (const entry of configEntries) {
        config[entry.key] = entry.value
      }

      reply.send({
        nodeId: id,
        gpuTier: node.gpuTier,
        nodeType: node.nodeType,
        status: node.status,
        config: {
          heartbeatIntervalSeconds: parseInt(config['heartbeat_interval'] as string) || 30,
          jobTimeoutSeconds: parseInt(config['job_timeout'] as string) || 3600,
          maxConcurrentJobs: parseInt(config['max_concurrent_jobs'] as string) || 1,
          logLevel: (config['log_level'] as string) || 'info',
        },
        yieldFloor: yieldFloor
          ? {
              ratePerHour: yieldFloor.ratePerHour,
              ratePerDay: yieldFloor.ratePerDay,
            }
          : null,
        markets: marketConfigs.map((m) => ({
          market: m.market,
          enabled: m.enabled,
          priority: m.priority,
        })),
        updatedAt: new Date().toISOString(),
      })
    }
  )

  // -------------------------------------------------------------------------
  // M3 / Checkpoint API — agent reports checkpoint state transitions
  // -------------------------------------------------------------------------
  // Single endpoint covers all agent-side state changes:
  //   - status=UPLOADING when agent starts packaging
  //   - status=READY    when S3 upload complete (sets bucketUrl + checkpointId)
  //   - status=FAILED   on error (sets error message)
  //
  // Agent discovers pending checkpoints via the existing job poll
  // (extended to also return any ComputeRequest assigned to this node
  // with checkpointStatus=REQUESTED — Project 2 work).

  const checkpointReportSchema = z.object({
    computeRequestId: z.string().min(1),
    status: z.enum(['UPLOADING', 'READY', 'FAILED']),
    bucketUrl: z.string().optional(),  // S3 URL, required when status=READY
    checkpointId: z.string().optional(), // unique id, required when status=READY
    error: z.string().max(2000).optional(), // required when status=FAILED
  })

  // SECURITY (N-3, 2026-06-13): all four checkpoint routes now
  // require authentication AND ownership scoping. Previously they
  // were unauthenticated, which meant any caller could (a) report
  // checkpoint status for any rental, (b) presign an upload URL for
  // any rental's S3 path, (c) presign a download URL for any
  // checkpoint id by guessing or scraping, (d) mark a restore
  // applied for any rental. Today most of this is gated because
  // checkpoint S3 is not configured (503), but the auth gap would
  // become CRITICAL cross-tenant model/dataset exfiltration the
  // moment S3 is enabled. Ownership = the authenticated node id (or
  // its operator's userId) matches the rental's allocated head node.
  fastify.post('/v1/agent/checkpoints', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const parsed = checkpointReportSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: parsed.error.errors.map((e) => e.message).join(', '),
      })
    }
    const { computeRequestId, status, bucketUrl, checkpointId, error } = parsed.data

    if (status === 'READY' && (!bucketUrl || !checkpointId)) {
      return reply.code(400).send({
        error: 'bucketUrl and checkpointId required when status=READY',
      })
    }
    if (status === 'FAILED' && !error) {
      return reply.code(400).send({ error: 'error required when status=FAILED' })
    }

    const cr = await fastify.prisma.computeRequest.findUnique({
      where: { id: computeRequestId },
      select: { id: true, userId: true, checkpointStatus: true, allocatedNodeIds: true },
    })
    if (!cr) return reply.code(404).send({ error: 'ComputeRequest not found' })

    // Ownership check: the caller must be (a) an admin, (b) the
    // buyer (the rental's userId), or (c) one of the rental's
    // allocated nodes' agents. Anything else returns 404 (not 403)
    // to avoid leaking the rental's existence to enumerators.
    const callerNodeId = request.authType === 'node' ? request.authNodeId : null
    const callerUserId = request.authType === 'user' ? request.user?.userId : null
    const isAdmin = request.authType === 'admin'
    const isBuyer = callerUserId && callerUserId === cr.userId
    const isOwningNode = callerNodeId && cr.allocatedNodeIds.includes(callerNodeId)
    if (!isAdmin && !isBuyer && !isOwningNode) {
      return reply.code(404).send({ error: 'ComputeRequest not found' })
    }

    // Idempotent updates: agent retry of UPLOADING when already UPLOADING
    // is a no-op; READY/FAILED can transition from any state because the
    // agent is the source of truth.
    const data: Record<string, unknown> = { checkpointStatus: status }
    if (status === 'READY') {
      data.checkpointBucketUrl = bucketUrl
      data.lastCheckpointId = checkpointId
      data.checkpointReadyAt = new Date()
      data.checkpointError = null
    } else if (status === 'FAILED') {
      data.checkpointError = error
    }

    await fastify.prisma.computeRequest.update({
      where: { id: computeRequestId },
      data,
    })

    fastify.io?.emit('checkpoint:status', {
      requestId: computeRequestId,
      userId: cr.userId,
      status,
      checkpointId: status === 'READY' ? checkpointId : null,
      timestamp: new Date().toISOString(),
    })

    return reply.send({ ok: true, status })
  })

  // -------------------------------------------------------------------------
  // M3-T6: Agent requests a presigned PUT URL to upload a fresh
  // checkpoint snapshot. The agent generates the checkpointId
  // client-side (uuid) so the same id can be reported back to
  // /v1/agent/checkpoints once the upload completes.
  // -------------------------------------------------------------------------

  const uploadUrlSchema = z.object({
    computeRequestId: z.string().min(1),
    checkpointId: z.string().min(8).max(64).optional(), // server generates if omitted
  })

  fastify.post('/v1/agent/checkpoints/upload-url', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    if (!isCheckpointS3Configured()) {
      return reply.code(503).send({
        error: 'Service Unavailable',
        message: 'Workspace checkpoint S3 not configured. See RUNBOOK_ADMIN.md → Workspace checkpoints.',
      })
    }
    const parsed = uploadUrlSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: parsed.error.errors[0]?.message ?? 'Invalid input',
      })
    }
    const { computeRequestId } = parsed.data
    const checkpointId = parsed.data.checkpointId ?? `chk_${crypto.randomBytes(12).toString('hex')}`

    const cr = await fastify.prisma.computeRequest.findUnique({
      where: { id: computeRequestId },
      select: { id: true, userId: true, status: true, allocatedNodeIds: true },
    })
    if (!cr) return reply.code(404).send({ error: 'ComputeRequest not found' })

    // Ownership check (N-3). Only the rental's allocated node agent,
    // its owning buyer, or an admin can presign an S3 upload URL for
    // this rental's checkpoint slot.
    const callerNodeId = request.authType === 'node' ? request.authNodeId : null
    const callerUserId = request.authType === 'user' ? request.user?.userId : null
    const isAdmin = request.authType === 'admin'
    const isBuyer = callerUserId && callerUserId === cr.userId
    const isOwningNode = callerNodeId && cr.allocatedNodeIds.includes(callerNodeId)
    if (!isAdmin && !isBuyer && !isOwningNode) {
      return reply.code(404).send({ error: 'ComputeRequest not found' })
    }
    if (cr.status !== 'ACTIVE') {
      return reply.code(409).send({ error: `Rental must be ACTIVE (got ${cr.status})` })
    }
    const headNodeId = cr.allocatedNodeIds[0]
    if (!headNodeId) {
      return reply.code(409).send({ error: 'Rental has no allocated node' })
    }
    const node = await fastify.prisma.node.findUnique({
      where: { id: headNodeId },
      select: { nodeRunnerId: true },
    })
    if (!node?.nodeRunnerId) {
      return reply.code(409).send({ error: 'Allocated node has no operator' })
    }

    try {
      const presign = await presignCheckpointUpload(node.nodeRunnerId, computeRequestId, checkpointId)
      return reply.send({
        checkpointId,
        uploadUrl: presign.uploadUrl,
        bucketUrl: presign.bucketUrl,
        objectKey: presign.objectKey,
        expiresAt: presign.expiresAt,
      })
    } catch (err) {
      request.log.error({ err, computeRequestId }, 'Failed to presign checkpoint upload')
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: err instanceof Error ? err.message : 'Presign failed',
      })
    }
  })

  // -------------------------------------------------------------------------
  // M3-T6: Agent requests a presigned GET URL to download an existing
  // checkpoint during rental restore. Looks up the bucketUrl on the
  // source rental (referenced by checkpointId) and returns a one-shot
  // signed URL.
  // -------------------------------------------------------------------------

  fastify.post<{ Params: { checkpointId: string } }>(
    '/v1/agent/checkpoints/:checkpointId/download-url',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      if (!isCheckpointS3Configured()) {
        return reply.code(503).send({
          error: 'Service Unavailable',
          message: 'Workspace checkpoint S3 not configured.',
        })
      }
      const { checkpointId } = request.params

      // Find the source rental that owns this checkpointId. Single
      // index lookup on the unique lastCheckpointId field.
      const source = await fastify.prisma.computeRequest.findFirst({
        where: { lastCheckpointId: checkpointId },
        select: {
          id: true,
          userId: true,
          allocatedNodeIds: true,
          checkpointBucketUrl: true,
          checkpointStatus: true,
        },
      })
      if (!source) {
        return reply.code(404).send({ error: 'Checkpoint not found' })
      }

      // Ownership check (N-3). Without this, anyone with a valid
      // checkpoint id could presign a GET URL for model weights /
      // datasets / secrets belonging to a different tenant.
      const callerNodeId = request.authType === 'node' ? request.authNodeId : null
      const callerUserId = request.authType === 'user' ? request.user?.userId : null
      const isAdmin = request.authType === 'admin'
      const isBuyer = callerUserId && callerUserId === source.userId
      const isOwningNode = callerNodeId && source.allocatedNodeIds.includes(callerNodeId)
      if (!isAdmin && !isBuyer && !isOwningNode) {
        return reply.code(404).send({ error: 'Checkpoint not found' })
      }

      if (source.checkpointStatus !== 'READY' || !source.checkpointBucketUrl) {
        return reply.code(409).send({
          error: 'Checkpoint not ready',
          status: source.checkpointStatus,
        })
      }

      try {
        const presign = await presignCheckpointDownload(source.checkpointBucketUrl)
        return reply.send({
          checkpointId,
          downloadUrl: presign.downloadUrl,
          expiresAt: presign.expiresAt,
        })
      } catch (err) {
        request.log.error({ err, checkpointId }, 'Failed to presign checkpoint download')
        // S3 HEAD failure usually means the object is missing — treat
        // as 404 so the agent reports a clean restore failure to the
        // buyer.
        const msg = err instanceof Error ? err.message : 'Presign failed'
        if (msg.toLowerCase().includes('notfound') || msg.toLowerCase().includes('404')) {
          return reply.code(404).send({ error: 'Checkpoint object missing in S3' })
        }
        return reply.code(500).send({ error: msg })
      }
    },
  )

  // -------------------------------------------------------------------------
  // M3-T6: Agent reports that a restore-on-launch has been applied
  // to the buyer's workspace. After this, the heartbeat-response
  // stops surfacing the restore action for this rental (avoids
  // re-applying the same checkpoint twice).
  // -------------------------------------------------------------------------

  const restoreAppliedSchema = z.object({
    computeRequestId: z.string().min(1),
    error: z.string().max(2000).optional(), // populated if restore failed
  })

  fastify.post('/v1/agent/checkpoints/restore-applied', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const parsed = restoreAppliedSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: parsed.error.errors[0]?.message ?? 'Invalid input',
      })
    }
    const { computeRequestId, error } = parsed.data

    const cr = await fastify.prisma.computeRequest.findUnique({
      where: { id: computeRequestId },
      select: { id: true, userId: true, restoreCheckpointId: true, allocatedNodeIds: true },
    })
    if (!cr) return reply.code(404).send({ error: 'ComputeRequest not found' })

    // Ownership check (N-3).
    const callerNodeId = request.authType === 'node' ? request.authNodeId : null
    const callerUserId = request.authType === 'user' ? request.user?.userId : null
    const isAdmin = request.authType === 'admin'
    const isBuyer = callerUserId && callerUserId === cr.userId
    const isOwningNode = callerNodeId && cr.allocatedNodeIds.includes(callerNodeId)
    if (!isAdmin && !isBuyer && !isOwningNode) {
      return reply.code(404).send({ error: 'ComputeRequest not found' })
    }

    if (!cr.restoreCheckpointId) {
      return reply.code(409).send({ error: 'Rental has no restoreCheckpointId set' })
    }

    await fastify.prisma.computeRequest.update({
      where: { id: computeRequestId },
      data: {
        restoreAppliedAt: new Date(),
        // Propagate any restore failure into the checkpoint error field
        // so it surfaces in the buyer UI alongside upload errors.
        ...(error ? { checkpointError: `Restore failed: ${error}` } : {}),
      },
    })

    fastify.io?.emit('checkpoint:restore-applied', {
      requestId: computeRequestId,
      userId: cr.userId,
      checkpointId: cr.restoreCheckpointId,
      error: error ?? null,
      timestamp: new Date().toISOString(),
    })

    return reply.send({ ok: true })
  })
}
