import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

/**
 * Helper: get the NodeRunner profile for the authenticated user
 */
async function getNodeRunnerForUser(fastify: FastifyInstance, userId: string) {
  return fastify.prisma.nodeRunner.findUnique({ where: { userId } })
}

export async function portalWithdrawalRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate)
  fastify.addHook('preHandler', fastify.requireRole('NODE_RUNNER', 'ADMIN'))

  // ===================================================================
  // LIST WITHDRAWALS
  // ===================================================================

  const listSchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(20),
    status: z.enum(['PENDING', 'APPROVED', 'PROCESSING', 'COMPLETED', 'REJECTED']).optional(),
  })

  /**
   * GET /v1/portal/node-runner/withdrawals — list withdrawal requests
   */
  fastify.get('/v1/portal/node-runner/withdrawals', async (request, reply) => {
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) {
      return reply.code(404).send({ error: 'No node runner profile found' })
    }

    const parsed = listSchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', message: parsed.error.errors.map(e => e.message).join(', ') })
    }
    const { page, limit, status } = parsed.data

    const where: Record<string, unknown> = { nodeRunnerId: nr.id }
    if (status) where.status = status

    const [withdrawals, total] = await Promise.all([
      fastify.prisma.withdrawalRequest.findMany({
        where,
        orderBy: { requestedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      fastify.prisma.withdrawalRequest.count({ where }),
    ])

    reply.send({ withdrawals, total, page, limit, pages: Math.ceil(total / limit) })
  })

  // ===================================================================
  // BALANCE
  // ===================================================================

  /**
   * GET /v1/portal/node-runner/withdrawals/balance — calculate available balance
   */
  fastify.get('/v1/portal/node-runner/withdrawals/balance', async (request, reply) => {
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) {
      return reply.code(404).send({ error: 'No node runner profile found' })
    }

    const nodeIds = (await fastify.prisma.node.findMany({
      where: { nodeRunnerId: nr.id },
      select: { id: true },
    })).map(n => n.id)

    // Total earnings from the Earning table for all runner's nodes
    const earningsAgg = await fastify.prisma.earning.aggregate({
      where: { nodeId: { in: nodeIds } },
      _sum: { earnings: true },
    })
    const totalEarnings = earningsAgg._sum.earnings ?? 0

    // Completed withdrawals (already paid out)
    const completedAgg = await fastify.prisma.withdrawalRequest.aggregate({
      where: { nodeRunnerId: nr.id, status: 'COMPLETED' },
      _sum: { amount: true },
    })
    const totalWithdrawn = completedAgg._sum.amount ?? 0

    // Pending withdrawals (PENDING + APPROVED + PROCESSING — funds reserved)
    const pendingAgg = await fastify.prisma.withdrawalRequest.aggregate({
      where: {
        nodeRunnerId: nr.id,
        status: { in: ['PENDING', 'APPROVED', 'PROCESSING'] },
      },
      _sum: { amount: true },
    })
    const pendingAmount = pendingAgg._sum.amount ?? 0

    const available = Math.max(0, totalEarnings - totalWithdrawn - pendingAmount)

    reply.send({
      totalEarnings,
      totalWithdrawn,
      pendingAmount,
      available,
    })
  })

  // ===================================================================
  // REQUEST WITHDRAWAL
  // ===================================================================

  const requestSchema = z.object({
    amount: z.number().positive('Amount must be positive'),
    walletAddress: z.string().min(32, 'Invalid wallet address').max(64, 'Invalid wallet address'),
  })

  /**
   * POST /v1/portal/node-runner/withdrawals/request — submit withdrawal request
   */
  fastify.post('/v1/portal/node-runner/withdrawals/request', async (request, reply) => {
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) {
      return reply.code(404).send({ error: 'No node runner profile found' })
    }

    const parsed = requestSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', message: parsed.error.errors.map(e => e.message).join(', ') })
    }

    const { amount, walletAddress } = parsed.data

    // Calculate available balance to validate requested amount
    const nodeIds = (await fastify.prisma.node.findMany({
      where: { nodeRunnerId: nr.id },
      select: { id: true },
    })).map(n => n.id)

    const earningsAgg = await fastify.prisma.earning.aggregate({
      where: { nodeId: { in: nodeIds } },
      _sum: { earnings: true },
    })
    const totalEarnings = earningsAgg._sum.earnings ?? 0

    const completedAgg = await fastify.prisma.withdrawalRequest.aggregate({
      where: { nodeRunnerId: nr.id, status: 'COMPLETED' },
      _sum: { amount: true },
    })
    const totalWithdrawn = completedAgg._sum.amount ?? 0

    const pendingAgg = await fastify.prisma.withdrawalRequest.aggregate({
      where: {
        nodeRunnerId: nr.id,
        status: { in: ['PENDING', 'APPROVED', 'PROCESSING'] },
      },
      _sum: { amount: true },
    })
    const pendingAmount = pendingAgg._sum.amount ?? 0

    const available = Math.max(0, totalEarnings - totalWithdrawn - pendingAmount)

    if (amount > available) {
      return reply.code(400).send({
        error: 'Insufficient Balance',
        message: `Requested $${amount.toFixed(2)} but only $${available.toFixed(2)} is available`,
        available,
      })
    }

    const withdrawal = await fastify.prisma.withdrawalRequest.create({
      data: {
        nodeRunnerId: nr.id,
        amount,
        walletAddress,
      },
    })

    reply.code(201).send({ withdrawal })
  })

  // ===================================================================
  // WITHDRAWAL DETAIL
  // ===================================================================

  /**
   * GET /v1/portal/node-runner/withdrawals/:id — withdrawal detail
   */
  fastify.get('/v1/portal/node-runner/withdrawals/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) {
      return reply.code(404).send({ error: 'No node runner profile found' })
    }

    const withdrawal = await fastify.prisma.withdrawalRequest.findFirst({
      where: { id, nodeRunnerId: nr.id },
    })

    if (!withdrawal) {
      return reply.code(404).send({ error: 'Withdrawal request not found' })
    }

    reply.send({ withdrawal })
  })
}
