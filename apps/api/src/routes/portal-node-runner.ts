import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  calculateUptimeEarnings,
  getDailyUptimeBreakdown,
} from '../services/earnings/uptime-calculator.js'
import { createNotification } from '../services/notification/service.js'

/**
 * Helper: get the NodeRunner profile for the authenticated user, or 404
 */
async function getNodeRunnerForUser(fastify: FastifyInstance, userId: string) {
  const nodeRunner = await fastify.prisma.nodeRunner.findUnique({
    where: { userId },
  })
  return nodeRunner
}

/**
 * Helper: verify a node belongs to the authenticated user's NodeRunner
 */
async function verifyNodeOwnership(fastify: FastifyInstance, nodeId: string, nodeRunnerId: string) {
  const node = await fastify.prisma.node.findFirst({
    where: { id: nodeId, nodeRunnerId },
  })
  return node
}

export async function portalNodeRunnerRoutes(fastify: FastifyInstance) {
  // All routes require authentication + NODE_RUNNER or ADMIN role
  fastify.addHook('preHandler', fastify.authenticate)
  fastify.addHook('preHandler', fastify.requireRole('NODE_RUNNER', 'ADMIN'))

  // ===================================================================
  // PROFILE
  // ===================================================================

  /**
   * GET /v1/portal/node-runner/profile
   */
  fastify.get('/v1/portal/node-runner/profile', async (request, reply) => {
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) {
      return reply.code(404).send({ error: 'No node runner profile found. Complete onboarding first.' })
    }

    const nodeCount = await fastify.prisma.node.count({ where: { nodeRunnerId: nr.id } })
    const investmentCount = await fastify.prisma.investment.count({ where: { nodeRunnerId: nr.id } })

    reply.send({
      id: nr.id,
      name: nr.name,
      email: nr.email,
      walletAddress: nr.walletAddress,
      nodeCount,
      investmentCount,
      createdAt: nr.createdAt,
    })
  })

  // ===================================================================
  // DASHBOARD
  // ===================================================================

  /**
   * GET /v1/portal/node-runner/dashboard
   */
  fastify.get('/v1/portal/node-runner/dashboard', async (request, reply) => {
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) {
      return reply.code(404).send({ error: 'No node runner profile found' })
    }

    const nodes = await fastify.prisma.node.findMany({
      where: { nodeRunnerId: nr.id },
      select: {
        id: true, status: true, gpuTier: true, lastHeartbeat: true, currentJobId: true,
        assignedComputeRequestId: true,
      },
    })

    const nodeIds = nodes.map(n => n.id)
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const weekStart = new Date(todayStart.getTime() - 7 * 86400000)
    const monthStart = new Date(todayStart.getTime() - 30 * 86400000)

    // Earnings aggregations
    const [earningsToday, earningsWeek, earningsMonth, earningsAllTime] = await Promise.all([
      fastify.prisma.earning.aggregate({ where: { nodeId: { in: nodeIds }, date: { gte: todayStart } }, _sum: { earnings: true } }),
      fastify.prisma.earning.aggregate({ where: { nodeId: { in: nodeIds }, date: { gte: weekStart } }, _sum: { earnings: true } }),
      fastify.prisma.earning.aggregate({ where: { nodeId: { in: nodeIds }, date: { gte: monthStart } }, _sum: { earnings: true } }),
      fastify.prisma.earning.aggregate({ where: { nodeId: { in: nodeIds } }, _sum: { earnings: true } }),
    ])

    // Job stats
    const [jobsCompleted, jobsRunning] = await Promise.all([
      fastify.prisma.job.count({ where: { nodeId: { in: nodeIds }, status: 'COMPLETED' } }),
      fastify.prisma.job.count({ where: { nodeId: { in: nodeIds }, status: 'RUNNING' } }),
    ])

    // Settlements (payouts)
    const totalPaid = await fastify.prisma.settlement.aggregate({
      where: { nodeId: { in: nodeIds }, status: 'COMPLETED' },
      _sum: { amount: true },
    })

    const onlineCount = nodes.filter(n => n.status === 'ONLINE').length
    const uptimePercent = nodes.length > 0 ? Math.round((onlineCount / nodes.length) * 100) : 0

    const nodesInUse = nodes.filter(n => n.assignedComputeRequestId !== null).length

    reply.send({
      earnings: {
        today: earningsToday._sum.earnings ?? 0,
        week: earningsWeek._sum.earnings ?? 0,
        month: earningsMonth._sum.earnings ?? 0,
        allTime: earningsAllTime._sum.earnings ?? 0,
      },
      nodes: {
        total: nodes.length,
        online: onlineCount,
        offline: nodes.filter(n => n.status === 'OFFLINE').length,
        maintenance: nodes.filter(n => n.status === 'MAINTENANCE' || n.status === 'PAUSED').length,
        inUse: nodesInUse,
      },
      jobs: {
        completed: jobsCompleted,
        running: jobsRunning,
      },
      totalPaidOut: totalPaid._sum.amount ?? 0,
      uptimePercent,
    })
  })

  // ===================================================================
  // NODES
  // ===================================================================

  /**
   * GET /v1/portal/node-runner/nodes
   */
  fastify.get('/v1/portal/node-runner/nodes', async (request, reply) => {
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) {
      return reply.code(404).send({ error: 'No node runner profile found' })
    }

    const nodes = await fastify.prisma.node.findMany({
      where: { nodeRunnerId: nr.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, walletAddress: true, gpuTier: true, nodeType: true, status: true,
        region: true, agentVersion: true, currentJobId: true, lastHeartbeat: true,
        customGpuModel: true, customRatePerHour: true, createdAt: true,
        assignedComputeRequestId: true,
      },
    })

    const nodesWithUsage = nodes.map(node => ({
      ...node,
      isInUse: node.assignedComputeRequestId !== null,
    }))

    reply.send({ nodes: nodesWithUsage })
  })

  /**
   * GET /v1/portal/node-runner/nodes/:id
   */
  fastify.get('/v1/portal/node-runner/nodes/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    const node = await verifyNodeOwnership(fastify, id, nr.id)
    if (!node) return reply.code(404).send({ error: 'Node not found' })

    const fullNode = await fastify.prisma.node.findUnique({
      where: { id },
      include: {
        heartbeats: { orderBy: { timestamp: 'desc' }, take: 50 },
        jobs: { orderBy: { createdAt: 'desc' }, take: 20, select: {
          id: true, status: true, market: true, earnings: true, durationSeconds: true, createdAt: true, completedAt: true,
        }},
      },
    })

    // Calculate uptime earnings for this node (last 30 days)
    const now = new Date()
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000)
    const uptimeEarnings = await calculateUptimeEarnings(
      fastify.prisma, id, thirtyDaysAgo, now
    )

    reply.send({ node: fullNode, uptimeEarnings })
  })

  const updateNodeSchema = z.object({
    status: z.enum(['PAUSED', 'MAINTENANCE', 'ONLINE']).optional(),
  })

  /**
   * PATCH /v1/portal/node-runner/nodes/:id — pause/resume/maintenance
   */
  fastify.patch('/v1/portal/node-runner/nodes/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    const node = await verifyNodeOwnership(fastify, id, nr.id)
    if (!node) return reply.code(404).send({ error: 'Node not found' })

    const parsed = updateNodeSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', message: parsed.error.errors.map(e => e.message).join(', ') })
    }

    const updated = await fastify.prisma.node.update({
      where: { id },
      data: parsed.data,
    })

    reply.send({ node: updated })
  })

  /**
   * DELETE /v1/portal/node-runner/nodes/:id — deregister
   */
  fastify.delete('/v1/portal/node-runner/nodes/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    const node = await verifyNodeOwnership(fastify, id, nr.id)
    if (!node) return reply.code(404).send({ error: 'Node not found' })

    // Mark for deletion (agent will receive UNINSTALL on next heartbeat)
    await fastify.prisma.node.update({
      where: { id },
      data: { pendingDeletion: true, status: 'OFFLINE' },
    })

    reply.send({ success: true, message: 'Node marked for removal' })
  })

  // ===================================================================
  // EARNINGS
  // ===================================================================

  const earningsQuerySchema = z.object({
    period: z.enum(['day', 'week', 'month', 'all']).default('month'),
  })

  /**
   * GET /v1/portal/node-runner/earnings
   */
  fastify.get('/v1/portal/node-runner/earnings', async (request, reply) => {
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    const parsed = earningsQuerySchema.safeParse(request.query)
    const period = parsed.success ? parsed.data.period : 'month'

    const nodeIds = (await fastify.prisma.node.findMany({
      where: { nodeRunnerId: nr.id }, select: { id: true },
    })).map(n => n.id)

    if (nodeIds.length === 0) {
      return reply.send({ earnings: [], total: 0, byMarket: {}, byNode: {} })
    }

    const now = new Date()
    let since: Date
    switch (period) {
      case 'day': since = new Date(now.getTime() - 86400000); break
      case 'week': since = new Date(now.getTime() - 7 * 86400000); break
      case 'all': since = new Date(0); break
      default: since = new Date(now.getTime() - 30 * 86400000)
    }

    const earnings = await fastify.prisma.earning.findMany({
      where: { nodeId: { in: nodeIds }, date: { gte: since } },
      orderBy: { date: 'desc' },
    })

    const total = earnings.reduce((sum, e) => sum + e.earnings, 0)

    // Group by market
    const byMarket: Record<string, number> = {}
    for (const e of earnings) {
      byMarket[e.market] = (byMarket[e.market] ?? 0) + e.earnings
    }

    // Group by node
    const byNode: Record<string, number> = {}
    for (const e of earnings) {
      byNode[e.nodeId] = (byNode[e.nodeId] ?? 0) + e.earnings
    }

    reply.send({ earnings, total, byMarket, byNode })
  })

  const earningsHistorySchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(50),
    nodeId: z.string().optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })

  /**
   * GET /v1/portal/node-runner/earnings/history
   */
  fastify.get('/v1/portal/node-runner/earnings/history', async (request, reply) => {
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    const parsed = earningsHistorySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', message: parsed.error.errors.map(e => e.message).join(', ') })
    }
    const { page, limit, nodeId, from, to } = parsed.data

    const nodeIds = (await fastify.prisma.node.findMany({
      where: { nodeRunnerId: nr.id }, select: { id: true },
    })).map(n => n.id)

    const where: Record<string, unknown> = {
      nodeId: nodeId && nodeIds.includes(nodeId) ? nodeId : { in: nodeIds },
    }
    if (from || to) {
      where.date = {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(to) } : {}),
      }
    }

    const [earnings, total] = await Promise.all([
      fastify.prisma.earning.findMany({
        where, orderBy: { date: 'desc' }, skip: (page - 1) * limit, take: limit,
      }),
      fastify.prisma.earning.count({ where }),
    ])

    reply.send({ earnings, total, page, limit, pages: Math.ceil(total / limit) })
  })

  // ===================================================================
  // PAYOUTS
  // ===================================================================

  const payoutsQuerySchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(20),
    status: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED']).optional(),
  })

  /**
   * GET /v1/portal/node-runner/payouts
   */
  fastify.get('/v1/portal/node-runner/payouts', async (request, reply) => {
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    const parsed = payoutsQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error' })
    }
    const { page, limit, status } = parsed.data

    const nodeIds = (await fastify.prisma.node.findMany({
      where: { nodeRunnerId: nr.id }, select: { id: true },
    })).map(n => n.id)

    const where: Record<string, unknown> = { nodeId: { in: nodeIds } }
    if (status) where.status = status

    const [settlements, total] = await Promise.all([
      fastify.prisma.settlement.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit,
      }),
      fastify.prisma.settlement.count({ where }),
    ])

    reply.send({ payouts: settlements, total, page, limit, pages: Math.ceil(total / limit) })
  })

  // ===================================================================
  // SETTINGS
  // ===================================================================

  const settingsSchema = z.object({
    name: z.string().min(1).max(100).optional(),
    email: z.string().email().optional(),
    walletAddress: z.string().min(32).max(64).optional(),
  })

  /**
   * PATCH /v1/portal/node-runner/settings
   */
  fastify.patch('/v1/portal/node-runner/settings', async (request, reply) => {
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    const parsed = settingsSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', message: parsed.error.errors.map(e => e.message).join(', ') })
    }

    // Check wallet uniqueness if changing
    if (parsed.data.walletAddress && parsed.data.walletAddress !== nr.walletAddress) {
      const existing = await fastify.prisma.nodeRunner.findUnique({
        where: { walletAddress: parsed.data.walletAddress },
      })
      if (existing) {
        return reply.code(409).send({ error: 'Wallet address already in use' })
      }
    }

    const updated = await fastify.prisma.nodeRunner.update({
      where: { id: nr.id },
      data: parsed.data,
    })

    reply.send({ nodeRunner: updated })
  })

  // ===================================================================
  // JOBS
  // ===================================================================

  const jobsQuerySchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(20),
    status: z.enum(['PENDING', 'ROUTING', 'ASSIGNED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']).optional(),
    nodeId: z.string().optional(),
  })

  /**
   * GET /v1/portal/node-runner/jobs
   */
  fastify.get('/v1/portal/node-runner/jobs', async (request, reply) => {
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    const parsed = jobsQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error' })
    }
    const { page, limit, status, nodeId } = parsed.data

    const nodeIds = (await fastify.prisma.node.findMany({
      where: { nodeRunnerId: nr.id }, select: { id: true },
    })).map(n => n.id)

    const where: Record<string, unknown> = {
      nodeId: nodeId && nodeIds.includes(nodeId) ? nodeId : { in: nodeIds },
    }
    if (status) where.status = status

    const [jobs, total] = await Promise.all([
      fastify.prisma.job.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit,
        include: { routingLog: true },
      }),
      fastify.prisma.job.count({ where }),
    ])

    reply.send({ jobs, total, page, limit, pages: Math.ceil(total / limit) })
  })

  /**
   * GET /v1/portal/node-runner/jobs/:id
   */
  fastify.get('/v1/portal/node-runner/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    const nodeIds = (await fastify.prisma.node.findMany({
      where: { nodeRunnerId: nr.id }, select: { id: true },
    })).map(n => n.id)

    const job = await fastify.prisma.job.findFirst({
      where: { id, nodeId: { in: nodeIds } },
      include: { routingLog: true, node: { select: { id: true, gpuTier: true, walletAddress: true } } },
    })

    if (!job) return reply.code(404).send({ error: 'Job not found' })

    reply.send({ job })
  })

  // ===================================================================
  // INVESTMENTS
  // ===================================================================

  /**
   * GET /v1/portal/node-runner/investments
   */
  fastify.get('/v1/portal/node-runner/investments', async (request, reply) => {
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    const investments = await fastify.prisma.investment.findMany({
      where: { nodeRunnerId: nr.id },
      orderBy: { createdAt: 'desc' },
    })

    reply.send({ investments })
  })

  // ===================================================================
  // DEPLOYMENT REQUESTS
  // ===================================================================

  const GPU_PRICING: Record<string, number> = {
    H100: 2500, H200: 3125, B200: 5250, B300: 7500, GB300: 9000,
  }

  const deploySchema = z.object({
    gpuTier: z.enum(['H100', 'H200', 'B200', 'B300', 'GB300']),
    nodeCount: z.number().int().min(1).max(5).default(1),
    txHash: z.string().min(1, 'Transaction hash is required'),
    cryptoAmount: z.number().positive().optional(),
    cryptoCurrency: z.string().default('SOL'),
    deploymentNote: z.string().max(500).optional(),
  })

  /**
   * POST /v1/portal/node-runner/deploy — Request a new node deployment
   */
  fastify.post('/v1/portal/node-runner/deploy', async (request, reply) => {
    let nr = await getNodeRunnerForUser(fastify, request.user!.userId)

    // Auto-create NodeRunner profile if user doesn't have one
    if (!nr) {
      const user = await fastify.prisma.user.findUnique({ where: { id: request.user!.userId } })
      if (!user) return reply.code(404).send({ error: 'User not found' })

      nr = await fastify.prisma.nodeRunner.create({
        data: {
          name: user.email?.split('@')[0] ?? 'Node Runner',
          email: user.email,
          walletAddress: user.walletAddress ?? `pending-${user.id}`,
          userId: user.id,
        },
      })
    }

    const parsed = deploySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', message: parsed.error.errors.map(e => e.message).join(', ') })
    }

    const { gpuTier, nodeCount, txHash, cryptoAmount, cryptoCurrency, deploymentNote } = parsed.data
    const unitPrice = GPU_PRICING[gpuTier] ?? 2500
    const totalAmount = unitPrice * nodeCount

    // Test mode: any txHash starting with 'test_' bypasses payment verification
    const isTestTx = txHash.startsWith('test_')

    const investment = await fastify.prisma.investment.create({
      data: {
        nodeRunnerId: nr.id,
        amount: totalAmount,
        currency: 'USD',
        nodeCount,
        gpuTier: gpuTier as import('@a2e/database').GpuTier,
        txHash: isTestTx ? `TEST:${txHash}` : txHash,
        txConfirmed: true,
        cryptoAmount,
        cryptoCurrency,
        deploymentNote,
        status: 'DEPLOYMENT_REQUESTED',
        confirmedAt: new Date(),
        deploymentRequestedAt: new Date(),
      },
    })

    // Notify all admin users about the new deployment request
    const adminUsers = await fastify.prisma.user.findMany({
      where: { role: 'ADMIN' },
      select: { id: true },
    })
    for (const admin of adminUsers) {
      void createNotification(
        admin.id,
        'DEPLOYMENT_REQUESTED',
        'New Deployment Request',
        `${nr.name} requested ${nodeCount}x ${gpuTier} node deployment ($${totalAmount}).`,
      )
    }

    reply.code(201).send({
      id: investment.id,
      gpuTier: investment.gpuTier,
      nodeCount: investment.nodeCount,
      amount: investment.amount,
      status: investment.status,
      txHash: investment.txHash,
      createdAt: investment.createdAt.toISOString(),
    })
  })

  /**
   * GET /v1/portal/node-runner/deployments — List deployment requests
   */
  fastify.get('/v1/portal/node-runner/deployments', async (request, reply) => {
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    const deployments = await fastify.prisma.investment.findMany({
      where: {
        nodeRunnerId: nr.id,
        status: { in: ['DEPLOYMENT_REQUESTED', 'DEPLOYING', 'PROVISIONED'] },
      },
      orderBy: { createdAt: 'desc' },
    })

    reply.send({ deployments })
  })

  /**
   * GET /v1/portal/node-runner/deployments/:id — Deployment detail
   */
  fastify.get('/v1/portal/node-runner/deployments/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    const deployment = await fastify.prisma.investment.findFirst({
      where: { id, nodeRunnerId: nr.id },
    })
    if (!deployment) return reply.code(404).send({ error: 'Deployment not found' })

    // If provisioning is in progress, get the ProvisionJob status
    let provisionStatus = null
    if (deployment.provisionJobId) {
      provisionStatus = await fastify.prisma.provisionJob.findUnique({
        where: { id: deployment.provisionJobId },
        select: { status: true, currentStep: true, totalSteps: true, currentAction: true, error: true },
      })
    }

    // If provisioned, get the node details
    let node = null
    if (deployment.nodeId) {
      node = await fastify.prisma.node.findUnique({
        where: { id: deployment.nodeId },
        select: { id: true, status: true, gpuTier: true, lastHeartbeat: true, agentVersion: true },
      })
    }

    reply.send({ deployment, provisionStatus, node })
  })
}
