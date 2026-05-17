import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createNotification } from '../services/notification/service.js'

export async function adminWithdrawalRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate)

  // ===================================================================
  // LIST ALL WITHDRAWALS
  // ===================================================================

  const listSchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(20),
    status: z.enum(['PENDING', 'APPROVED', 'PROCESSING', 'COMPLETED', 'REJECTED']).optional(),
  })

  /**
   * GET /v1/admin/withdrawals — list all withdrawal requests
   */
  fastify.get('/v1/admin/withdrawals', async (request, reply) => {
    const parsed = listSchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', message: parsed.error.errors.map(e => e.message).join(', ') })
    }
    const { page, limit, status } = parsed.data

    const where: Record<string, unknown> = {}
    if (status) where.status = status

    const [withdrawals, total] = await Promise.all([
      fastify.prisma.withdrawalRequest.findMany({
        where,
        include: {
          nodeRunner: { select: { id: true, name: true, email: true, walletAddress: true } },
        },
        orderBy: { requestedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      fastify.prisma.withdrawalRequest.count({ where }),
    ])

    reply.send({ withdrawals, total, page, limit, pages: Math.ceil(total / limit) })
  })

  // ===================================================================
  // WITHDRAWAL DETAIL
  // ===================================================================

  /**
   * GET /v1/admin/withdrawals/:id — withdrawal detail
   */
  fastify.get('/v1/admin/withdrawals/:id', async (request, reply) => {
    const { id } = request.params as { id: string }

    const withdrawal = await fastify.prisma.withdrawalRequest.findUnique({
      where: { id },
      include: {
        nodeRunner: { select: { id: true, name: true, email: true, walletAddress: true, userId: true } },
      },
    })

    if (!withdrawal) {
      return reply.code(404).send({ error: 'Withdrawal request not found' })
    }

    reply.send({ withdrawal })
  })

  // ===================================================================
  // APPROVE
  // ===================================================================

  /**
   * PATCH /v1/admin/withdrawals/:id/approve — approve a withdrawal
   */
  fastify.patch('/v1/admin/withdrawals/:id/approve', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { note } = (request.body as { note?: string }) || {}

    const withdrawal = await fastify.prisma.withdrawalRequest.findUnique({
      where: { id },
      include: { nodeRunner: { select: { userId: true } } },
    })
    if (!withdrawal) return reply.code(404).send({ error: 'Withdrawal request not found' })
    if (withdrawal.status !== 'PENDING') {
      return reply.code(400).send({ error: `Cannot approve: status is ${withdrawal.status}` })
    }

    await fastify.prisma.withdrawalRequest.update({
      where: { id },
      data: {
        status: 'APPROVED',
        approvedAt: new Date(),
        adminNote: note,
      },
    })

    if (withdrawal.nodeRunner?.userId) {
      void createNotification(
        withdrawal.nodeRunner.userId,
        'WITHDRAWAL_APPROVED',
        'Withdrawal Approved',
        `Your withdrawal request for $${withdrawal.amount.toFixed(2)} has been approved.`,
        '/withdrawals',
      )
    }

    reply.send({ id, status: 'APPROVED' })
  })

  // ===================================================================
  // PROCESS
  // ===================================================================

  /**
   * PATCH /v1/admin/withdrawals/:id/process — mark as processing
   */
  fastify.patch('/v1/admin/withdrawals/:id/process', async (request, reply) => {
    const { id } = request.params as { id: string }

    const withdrawal = await fastify.prisma.withdrawalRequest.findUnique({
      where: { id },
      include: { nodeRunner: { select: { userId: true } } },
    })
    if (!withdrawal) return reply.code(404).send({ error: 'Withdrawal request not found' })
    if (withdrawal.status !== 'APPROVED') {
      return reply.code(400).send({ error: `Cannot process: status is ${withdrawal.status}` })
    }

    await fastify.prisma.withdrawalRequest.update({
      where: { id },
      data: { status: 'PROCESSING' },
    })

    if (withdrawal.nodeRunner?.userId) {
      void createNotification(
        withdrawal.nodeRunner.userId,
        'WITHDRAWAL_PROCESSING',
        'Withdrawal Processing',
        `Your withdrawal of $${withdrawal.amount.toFixed(2)} is being processed.`,
        '/withdrawals',
      )
    }

    reply.send({ id, status: 'PROCESSING' })
  })

  // ===================================================================
  // COMPLETE
  // ===================================================================

  const completeSchema = z.object({
    txHash: z.string().min(1, 'Transaction hash is required'),
  })

  /**
   * PATCH /v1/admin/withdrawals/:id/complete — complete with txHash
   */
  fastify.patch('/v1/admin/withdrawals/:id/complete', async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = completeSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', message: parsed.error.errors.map(e => e.message).join(', ') })
    }

    const withdrawal = await fastify.prisma.withdrawalRequest.findUnique({
      where: { id },
      include: { nodeRunner: { select: { userId: true } } },
    })
    if (!withdrawal) return reply.code(404).send({ error: 'Withdrawal request not found' })
    if (!['APPROVED', 'PROCESSING'].includes(withdrawal.status)) {
      return reply.code(400).send({ error: `Cannot complete: status is ${withdrawal.status}` })
    }

    await fastify.prisma.withdrawalRequest.update({
      where: { id },
      data: {
        status: 'COMPLETED',
        txHash: parsed.data.txHash,
        processedAt: new Date(),
        processedBy: request.user?.userId ?? null,
      },
    })

    if (withdrawal.nodeRunner?.userId) {
      void createNotification(
        withdrawal.nodeRunner.userId,
        'WITHDRAWAL_COMPLETED',
        'Withdrawal Completed',
        `Your withdrawal of $${withdrawal.amount.toFixed(2)} has been completed. TX: ${parsed.data.txHash.slice(0, 16)}...`,
        '/withdrawals',
      )
    }

    reply.send({ id, status: 'COMPLETED', txHash: parsed.data.txHash })
  })

  // ===================================================================
  // REJECT
  // ===================================================================

  const rejectSchema = z.object({
    reason: z.string().min(1, 'Reason is required').max(500),
  })

  /**
   * PATCH /v1/admin/withdrawals/:id/reject — reject with reason
   */
  fastify.patch('/v1/admin/withdrawals/:id/reject', async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = rejectSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', message: parsed.error.errors.map(e => e.message).join(', ') })
    }

    const withdrawal = await fastify.prisma.withdrawalRequest.findUnique({
      where: { id },
      include: { nodeRunner: { select: { userId: true } } },
    })
    if (!withdrawal) return reply.code(404).send({ error: 'Withdrawal request not found' })
    if (!['PENDING', 'APPROVED'].includes(withdrawal.status)) {
      return reply.code(400).send({ error: `Cannot reject: status is ${withdrawal.status}` })
    }

    await fastify.prisma.withdrawalRequest.update({
      where: { id },
      data: {
        status: 'REJECTED',
        adminNote: parsed.data.reason,
        rejectedAt: new Date(),
        processedBy: request.user?.userId ?? null,
      },
    })

    if (withdrawal.nodeRunner?.userId) {
      void createNotification(
        withdrawal.nodeRunner.userId,
        'WITHDRAWAL_REJECTED',
        'Withdrawal Rejected',
        `Your withdrawal request for $${withdrawal.amount.toFixed(2)} was rejected: ${parsed.data.reason}`,
        '/withdrawals',
      )
    }

    reply.send({ id, status: 'REJECTED' })
  })
}
