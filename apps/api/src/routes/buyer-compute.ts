import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createNotification } from '../services/notification/service.js'
import { GPU_TIER_CONFIG, dailyToHourly } from '@a2e/shared'

const GPU_DAILY_RATES: Record<string, number> = {
  H100: 140.15, H200: 179.85, B200: 321.10, B300: 431.75, GB300: 499.35,
}

const requestSchema = z.object({
  gpuTier: z.enum(['H100', 'H200', 'B200', 'B300', 'GB300']),
  gpuCount: z.number().int().min(1).max(10).default(1),
  durationDays: z.number().int().min(7).max(365).default(30),
  purpose: z.string().max(500).optional(),
  txHash: z.string().min(1, 'Transaction hash is required'),
})

const listSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(20),
  status: z.string().optional(),
})

export async function buyerComputeRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate)
  fastify.addHook('preHandler', fastify.requireRole('COMPUTE_BUYER', 'ADMIN'))

  /**
   * GET /v1/buyer/dashboard
   */
  fastify.get('/v1/buyer/dashboard', async (request, reply) => {
    const userId = request.user!.userId

    const [active, pending, totalSpent, allRequests] = await Promise.all([
      fastify.prisma.computeRequest.count({ where: { userId, status: 'ACTIVE' } }),
      fastify.prisma.computeRequest.count({ where: { userId, status: { in: ['PENDING', 'APPROVED', 'ALLOCATED'] } } }),
      fastify.prisma.computeRequest.aggregate({ where: { userId, status: { in: ['ACTIVE', 'COMPLETED'] } }, _sum: { totalCost: true } }),
      fastify.prisma.computeRequest.count({ where: { userId } }),
    ])

    // Find nearest expiry
    const nearestExpiry = await fastify.prisma.computeRequest.findFirst({
      where: { userId, status: 'ACTIVE', expiresAt: { not: null } },
      orderBy: { expiresAt: 'asc' },
      select: { expiresAt: true },
    })

    const daysRemaining = nearestExpiry?.expiresAt
      ? Math.max(0, Math.ceil((nearestExpiry.expiresAt.getTime() - Date.now()) / 86400000))
      : null

    // Fetch active allocations and recent requests for dashboard display
    const [activeAllocations, recentRequests] = await Promise.all([
      fastify.prisma.computeRequest.findMany({
        where: { userId, status: 'ACTIVE' },
        orderBy: { activatedAt: 'desc' },
        take: 5,
        select: { id: true, gpuTier: true, gpuCount: true, sshHost: true, sshPort: true, sshUsername: true, sshPassword: true, expiresAt: true, activatedAt: true },
      }),
      fastify.prisma.computeRequest.findMany({
        where: { userId },
        orderBy: { requestedAt: 'desc' },
        take: 5,
        select: { id: true, gpuTier: true, gpuCount: true, durationDays: true, totalCost: true, status: true, requestedAt: true },
      }),
    ])

    reply.send({
      activeCompute: active,
      pendingRequests: pending,
      totalSpent: totalSpent._sum.totalCost ?? 0,
      totalRequests: allRequests,
      daysRemaining,
      activeAllocations,
      recentRequests,
    })
  })

  /**
   * POST /v1/buyer/compute/request — Submit compute request
   */
  fastify.post('/v1/buyer/compute/request', async (request, reply) => {
    const parsed = requestSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', message: parsed.error.errors.map(e => e.message).join(', ') })
    }

    const { gpuTier, gpuCount, durationDays, purpose, txHash } = parsed.data
    const ratePerDay = GPU_DAILY_RATES[gpuTier] ?? 140.15
    const totalCost = ratePerDay * gpuCount * durationDays
    const isTestTx = txHash.startsWith('test_')

    const computeRequest = await fastify.prisma.computeRequest.create({
      data: {
        userId: request.user!.userId,
        gpuTier: gpuTier as import('@a2e/database').GpuTier,
        gpuCount,
        durationDays,
        purpose,
        ratePerDay,
        totalCost,
        txHash: isTestTx ? `TEST:${txHash}` : txHash,
        txConfirmed: true,
        status: 'PENDING',
      },
    })

    // Notify admins
    const admins = await fastify.prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } })
    for (const admin of admins) {
      void createNotification(admin.id, 'COMPUTE_REQUEST_NEW', 'New Compute Request',
        `${gpuCount}x ${gpuTier} for ${durationDays} days ($${totalCost.toFixed(2)})`)
    }

    reply.code(201).send({
      id: computeRequest.id,
      gpuTier, gpuCount, durationDays,
      ratePerDay, totalCost,
      status: computeRequest.status,
    })
  })

  /**
   * GET /v1/buyer/compute/requests — List buyer's requests
   */
  fastify.get('/v1/buyer/compute/requests', async (request, reply) => {
    const parsed = listSchema.safeParse(request.query)
    const { page, limit, status } = parsed.success ? parsed.data : { page: 1, limit: 20, status: undefined }

    const where: Record<string, unknown> = { userId: request.user!.userId }
    if (status) where.status = status

    const [requests, total] = await Promise.all([
      fastify.prisma.computeRequest.findMany({
        where, orderBy: { requestedAt: 'desc' }, skip: (page - 1) * limit, take: limit,
      }),
      fastify.prisma.computeRequest.count({ where }),
    ])

    reply.send({ requests, total, page, limit, pages: Math.ceil(total / limit) })
  })

  /**
   * GET /v1/buyer/compute/requests/:id — Request detail (includes SSH when ACTIVE)
   */
  fastify.get('/v1/buyer/compute/requests/:id', async (request, reply) => {
    const { id } = request.params as { id: string }

    const cr = await fastify.prisma.computeRequest.findFirst({
      where: { id, userId: request.user!.userId },
    })
    if (!cr) return reply.code(404).send({ error: 'Request not found' })

    // Only expose SSH details when ACTIVE
    const result: Record<string, unknown> = { ...cr }
    if (cr.status !== 'ACTIVE') {
      result.sshHost = null
      result.sshPort = null
      result.sshUsername = null
      result.sshPassword = null
    }

    reply.send({ request: result })
  })

  /**
   * GET /v1/buyer/compute/active — Active allocations with SSH
   */
  fastify.get('/v1/buyer/compute/active', async (request, reply) => {
    const active = await fastify.prisma.computeRequest.findMany({
      where: { userId: request.user!.userId, status: 'ACTIVE' },
      orderBy: { activatedAt: 'desc' },
    })

    reply.send({ allocations: active })
  })

  /**
   * PATCH /v1/buyer/compute/requests/:id/cancel
   */
  fastify.patch('/v1/buyer/compute/requests/:id/cancel', async (request, reply) => {
    const { id } = request.params as { id: string }

    const cr = await fastify.prisma.computeRequest.findFirst({
      where: { id, userId: request.user!.userId },
    })
    if (!cr) return reply.code(404).send({ error: 'Request not found' })
    if (cr.status !== 'PENDING') {
      return reply.code(400).send({ error: 'Can only cancel PENDING requests' })
    }

    await fastify.prisma.computeRequest.update({
      where: { id }, data: { status: 'CANCELLED' },
    })

    reply.send({ id, status: 'CANCELLED' })
  })

  /**
   * PATCH /v1/buyer/settings
   */
  fastify.patch('/v1/buyer/settings', async (request, reply) => {
    const { email, walletAddress } = request.body as { email?: string; walletAddress?: string }

    const updated = await fastify.prisma.user.update({
      where: { id: request.user!.userId },
      data: {
        ...(email ? { email } : {}),
        ...(walletAddress ? { walletAddress } : {}),
      },
    })

    reply.send({ id: updated.id, email: updated.email, walletAddress: updated.walletAddress })
  })
}
