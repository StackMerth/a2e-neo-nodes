import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { submitProvisionJob } from '../jobs/provision-processor'
import { createNotification } from '../services/notification/service.js'

const sshSchema = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).max(64),
  authMethod: z.enum(['password', 'privateKey']),
  password: z.string().max(256).optional(),
  privateKey: z.string().max(16384).optional(),
  passphrase: z.string().max(256).optional(),
  testMode: z.boolean().default(false),
}).refine(
  (data) => data.authMethod === 'password' ? !!data.password : !!data.privateKey,
  { message: 'Password required for password auth, privateKey required for key auth' }
)

export async function adminDeploymentRoutes(fastify: FastifyInstance) {
  // All routes require admin auth
  fastify.addHook('preHandler', fastify.authenticate)

  /**
   * GET /v1/admin/deployments — List deployment requests
   */
  fastify.get('/v1/admin/deployments', async (request, reply) => {
    const statusFilter = (request.query as { status?: string }).status

    const where: Record<string, unknown> = {}
    if (statusFilter) {
      where.status = statusFilter
    } else {
      where.status = { in: ['DEPLOYMENT_REQUESTED', 'DEPLOYING', 'PROVISIONED'] }
    }

    const deployments = await fastify.prisma.investment.findMany({
      where,
      include: {
        nodeRunner: { select: { id: true, name: true, email: true, walletAddress: true } },
      },
      orderBy: { createdAt: 'desc' },
    })

    // Get pending count for badge
    const pendingCount = await fastify.prisma.investment.count({
      where: { status: 'DEPLOYMENT_REQUESTED' },
    })

    reply.send({ deployments, pendingCount })
  })

  /**
   * GET /v1/admin/deployments/:id — Deployment detail
   */
  fastify.get('/v1/admin/deployments/:id', async (request, reply) => {
    const { id } = request.params as { id: string }

    const deployment = await fastify.prisma.investment.findUnique({
      where: { id },
      include: {
        nodeRunner: { select: { id: true, name: true, email: true, walletAddress: true, userId: true } },
      },
    })
    if (!deployment) return reply.code(404).send({ error: 'Deployment not found' })

    let provisionJob = null
    if (deployment.provisionJobId) {
      provisionJob = await fastify.prisma.provisionJob.findUnique({
        where: { id: deployment.provisionJobId },
      })
    }

    let node = null
    if (deployment.nodeId) {
      node = await fastify.prisma.node.findUnique({
        where: { id: deployment.nodeId },
      })
    }

    reply.send({ deployment, provisionJob, node })
  })

  /**
   * PATCH /v1/admin/deployments/:id/ssh — Admin submits SSH details, triggers provisioning
   */
  fastify.patch('/v1/admin/deployments/:id/ssh', async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = sshSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', message: parsed.error.errors.map(e => e.message).join(', ') })
    }

    const deployment = await fastify.prisma.investment.findUnique({
      where: { id },
      include: { nodeRunner: { select: { name: true, userId: true } } },
    })
    if (!deployment) return reply.code(404).send({ error: 'Deployment not found' })

    if (deployment.status !== 'DEPLOYMENT_REQUESTED') {
      return reply.code(400).send({
        error: 'Invalid Status',
        message: `Deployment is ${deployment.status}, expected DEPLOYMENT_REQUESTED`,
      })
    }

    if (!fastify.provisionQueue) {
      return reply.code(503).send({ error: 'Provisioning queue not available' })
    }

    const { host, port, username, authMethod, password, privateKey, passphrase, testMode } = parsed.data

    // Submit the provisioning job
    const provisionJobId = await submitProvisionJob(
      fastify.provisionQueue,
      fastify.prisma,
      {
        host,
        port,
        username,
        authMethod,
        password: authMethod === 'password' ? password : undefined,
        privateKey: authMethod === 'privateKey' ? privateKey : undefined,
        passphrase,
        gpuTier: deployment.gpuTier,
        nodeName: `${deployment.nodeRunner?.name ?? 'Node'} - ${deployment.gpuTier}`,
        testMode: testMode || false,
      }
    )

    // Update investment with SSH details and status
    await fastify.prisma.investment.update({
      where: { id },
      data: {
        status: 'DEPLOYING',
        sshHost: host,
        sshPort: port,
        sshUsername: username,
        provisionJobId,
      },
    })

    // Notify node runner that deployment has started
    if (deployment.nodeRunner?.userId) {
      void createNotification(
        deployment.nodeRunner.userId,
        'DEPLOYMENT_STARTED',
        'Deployment Started',
        `Your ${deployment.gpuTier} node is being set up. This usually takes 5-10 minutes.`,
      )
    }

    // Emit WebSocket event for real-time UI updates
    fastify.io?.emit('deployment:statusChange', {
      investmentId: id,
      oldStatus: 'DEPLOYMENT_REQUESTED',
      newStatus: 'DEPLOYING',
      nodeRunnerId: deployment.nodeRunnerId,
      timestamp: new Date().toISOString(),
    })

    reply.send({
      id: deployment.id,
      status: 'DEPLOYING',
      provisionJobId,
      message: 'Provisioning started',
    })
  })

  /**
   * PATCH /v1/admin/deployments/:id/cancel — Cancel a deployment request
   */
  fastify.patch('/v1/admin/deployments/:id/cancel', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { reason } = (request.body as { reason?: string }) || {}

    const deployment = await fastify.prisma.investment.findUnique({
      where: { id },
      include: { nodeRunner: { select: { userId: true } } },
    })
    if (!deployment) return reply.code(404).send({ error: 'Deployment not found' })

    if (!['DEPLOYMENT_REQUESTED', 'DEPLOYING'].includes(deployment.status)) {
      return reply.code(400).send({ error: 'Cannot cancel', message: `Status is ${deployment.status}` })
    }

    await fastify.prisma.investment.update({
      where: { id },
      data: { status: 'CANCELLED' },
    })

    // Notify node runner
    if (deployment.nodeRunner?.userId) {
      void createNotification(
        deployment.nodeRunner.userId,
        'INVESTMENT_CONFIRMED', // Reusing for cancellation notification
        'Deployment Cancelled',
        reason ? `Your deployment request was cancelled: ${reason}` : 'Your deployment request was cancelled by the admin.',
      )
    }

    reply.send({ id, status: 'CANCELLED' })
  })

  /**
   * POST /v1/admin/deployments/:id/complete — Link a provisioned node to the deployment
   * Called after ProvisionJob completes successfully (can be automated or manual)
   */
  fastify.post('/v1/admin/deployments/:id/complete', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { nodeId } = request.body as { nodeId: string }

    if (!nodeId) return reply.code(400).send({ error: 'nodeId is required' })

    const deployment = await fastify.prisma.investment.findUnique({
      where: { id },
      include: { nodeRunner: { select: { id: true, userId: true, name: true } } },
    })
    if (!deployment) return reply.code(404).send({ error: 'Deployment not found' })

    // Link node to node runner and update investment
    await fastify.prisma.$transaction([
      fastify.prisma.node.update({
        where: { id: nodeId },
        data: { nodeRunnerId: deployment.nodeRunnerId },
      }),
      fastify.prisma.investment.update({
        where: { id },
        data: {
          status: 'PROVISIONED',
          nodeId,
          provisionedAt: new Date(),
        },
      }),
    ])

    // Notify node runner
    if (deployment.nodeRunner?.userId) {
      void createNotification(
        deployment.nodeRunner.userId,
        'DEPLOYMENT_COMPLETED',
        'Node Deployed!',
        `Your ${deployment.gpuTier} node is now live and earning. Check your dashboard for real-time status.`,
      )
    }

    // Emit WebSocket event
    fastify.io?.emit('deployment:statusChange', {
      investmentId: id,
      oldStatus: 'DEPLOYING',
      newStatus: 'PROVISIONED',
      nodeRunnerId: deployment.nodeRunnerId,
      timestamp: new Date().toISOString(),
    })

    reply.send({
      id,
      status: 'PROVISIONED',
      nodeId,
      message: 'Node linked to deployment',
    })
  })
}
