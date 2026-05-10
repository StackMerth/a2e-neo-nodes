import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createNotification } from '../services/notification/service.js'
import { GPU_TIER_CONFIG, dailyToHourly } from '@a2e/shared'
import { checkIdempotencyKey, storeIdempotencyResponse } from '../services/idempotency/keys.js'
import { getSolanaConfig, processPayment } from '../services/payment/solana.js'

const GPU_DAILY_RATES: Record<string, number> = {
  H100: 140.15, H200: 179.85, B200: 321.10, B300: 431.75, GB300: 499.35,
}

const requestSchema = z.object({
  gpuTier: z.enum(['H100', 'H200', 'B200', 'B300', 'GB300']),
  // gpuCount cap: 64 covers single-rack NVL72 / NVL36 cluster requests
  // with headroom. >64 requires an admin-side enterprise quote — keeps
  // a single self-serve buyer from accidentally requesting half the
  // available H100 inventory in one click. Bump again later if real
  // demand pushes against this ceiling.
  gpuCount: z.number().int().min(1).max(64).default(1),
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
   * POST /v1/buyer/compute/request — Submit compute request.
   *
   * Idempotency: two layers of protection against accidental double-submit.
   *   1. Standard `Idempotency-Key` header — if a buyer client sets one, we
   *      replay the cached response on retry (same as /v1/payments/process).
   *   2. txHash dedup — even without the header, a Solana payment tx hash
   *      is a one-shot financial event. If the same userId already has a
   *      compute request with this txHash we return that one instead of
   *      creating a duplicate. Defends against double-clicking submit.
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
    const userId = request.user!.userId

    // Layer 1: Idempotency-Key header replay.
    const idempotencyKey = request.headers['idempotency-key'] as string | undefined
    if (idempotencyKey) {
      try {
        const idempotencyResult = await checkIdempotencyKey(
          fastify.prisma,
          idempotencyKey,
          '/v1/buyer/compute/request',
          request.body,
        )
        if (!idempotencyResult.isNew && idempotencyResult.cachedResponse) {
          return reply
            .code(idempotencyResult.cachedResponse.statusCode)
            .header('X-Idempotency-Replay', 'true')
            .send(idempotencyResult.cachedResponse.body)
        }
      } catch (err) {
        return reply.code(409).send({
          error: 'Idempotency Conflict',
          message: err instanceof Error ? err.message : 'Idempotency key reused with different body',
        })
      }
    }

    // Layer 2: txHash dedup. If this user already submitted a compute
    // request with this txHash, return the existing one rather than
    // creating a duplicate. Solana tx hashes are one-shot financial
    // events; reusing one across two compute requests would always be a
    // bug regardless of idempotency-key handling.
    const storedTxHash = isTestTx ? `TEST:${txHash}` : txHash
    const existing = await fastify.prisma.computeRequest.findFirst({
      where: { userId, txHash: storedTxHash },
    })
    if (existing) {
      return reply.code(200).header('X-Idempotency-Replay', 'tx-hash').send({
        id: existing.id,
        gpuTier: existing.gpuTier,
        gpuCount: existing.gpuCount,
        durationDays: existing.durationDays,
        ratePerDay: existing.ratePerDay,
        totalCost: existing.totalCost,
        status: existing.status,
      })
    }

    const computeRequest = await fastify.prisma.computeRequest.create({
      data: {
        userId,
        gpuTier: gpuTier as import('@a2e/database').GpuTier,
        gpuCount,
        durationDays,
        purpose,
        ratePerDay,
        totalCost,
        txHash: storedTxHash,
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

    const responseBody = {
      id: computeRequest.id,
      gpuTier, gpuCount, durationDays,
      ratePerDay, totalCost,
      status: computeRequest.status,
    }

    // Cache for idempotency-key replay
    if (idempotencyKey) {
      await storeIdempotencyResponse(
        fastify.prisma,
        idempotencyKey,
        '/v1/buyer/compute/request',
        request.body,
        201,
        responseBody,
      )
    }

    reply.code(201).send(responseBody)
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
   * POST /v1/buyer/compute/requests/:id/terminate
   *
   * Buyer-initiated early termination for an ACTIVE rental. Computes
   * the prorated refund (totalCost - accruedCost), attempts to refund
   * via the configured Solana payer (dev mode returns a DEV_ tx hash;
   * live mode requires the payer key — see SOLANA_LIVE_SETUP.md), and
   * transitions the rental to COMPLETED. Releases the assigned nodes.
   *
   * Why a separate route from /cancel: cancel is for PENDING (no money
   * has moved yet); terminate is for ACTIVE rentals where minutes have
   * already accrued and a refund needs to flow back.
   */
  fastify.post('/v1/buyer/compute/requests/:id/terminate', async (request, reply) => {
    const { id } = request.params as { id: string }
    const userId = request.user!.userId

    const cr = await fastify.prisma.computeRequest.findFirst({
      where: { id, userId },
    })
    if (!cr) return reply.code(404).send({ error: 'Request not found' })
    if (cr.status !== 'ACTIVE') {
      return reply.code(400).send({ error: `Cannot terminate: status is ${cr.status}` })
    }

    // Final accrual snapshot. The meter (60s tick) may not have caught
    // up to wall-clock-now yet; recompute on the spot so the refund
    // reflects the exact second the buyer clicked terminate.
    const ratePerMinute = cr.ratePerMinute ?? (cr.ratePerDay * cr.gpuCount) / (24 * 60)
    const elapsedMs = cr.activatedAt ? Date.now() - cr.activatedAt.getTime() : 0
    const elapsedMinutes = Math.floor(elapsedMs / 60000)
    const maxMinutes = cr.durationDays * 24 * 60
    const finalMinutes = Math.min(elapsedMinutes, maxMinutes)
    const finalAccrued = Math.min(
      Number((finalMinutes * ratePerMinute).toFixed(4)),
      cr.totalCost,
    )
    const refundAmount = Math.max(0, Number((cr.totalCost - finalAccrued).toFixed(4)))

    // Refund flow: only attempt if the user has a payable wallet on file.
    // We pull from User.walletAddress; buyers can set this in /v1/buyer/settings.
    const user = await fastify.prisma.user.findUnique({
      where: { id: userId },
      select: { walletAddress: true },
    })

    let refundTxHash: string | null = null
    let refundStatus: 'SENT' | 'SKIPPED_NO_WALLET' | 'SKIPPED_ZERO' | 'FAILED' = 'SKIPPED_ZERO'
    let refundError: string | null = null

    if (refundAmount <= 0) {
      refundStatus = 'SKIPPED_ZERO'
    } else if (!user?.walletAddress) {
      refundStatus = 'SKIPPED_NO_WALLET'
    } else {
      try {
        const solanaConfig = await getSolanaConfig(fastify.prisma)
        const result = await processPayment(solanaConfig, user.walletAddress, refundAmount, 'USDC')
        if (result.success && result.txHash) {
          refundTxHash = result.txHash
          refundStatus = 'SENT'
        } else {
          refundStatus = 'FAILED'
          refundError = result.error ?? 'Unknown payment failure'
        }
      } catch (err) {
        refundStatus = 'FAILED'
        refundError = err instanceof Error ? err.message : 'Refund processing error'
        fastify.log.error({ err, requestId: id }, 'Refund failed during terminate')
      }
    }

    // Atomically: mark COMPLETED, freeze final accrual, release nodes,
    // bump trust signals so the eligibility engine learns this buyer
    // followed through. Refund tx hash recorded in adminNote so the
    // operator can audit later.
    const completedAt = new Date()
    await fastify.prisma.$transaction([
      fastify.prisma.computeRequest.update({
        where: { id },
        data: {
          status: 'COMPLETED',
          completedAt,
          minutesUsed: finalMinutes,
          accruedCost: finalAccrued,
          adminNote: refundTxHash
            ? `Buyer terminated. Refund $${refundAmount} sent: ${refundTxHash}`
            : `Buyer terminated. Refund status: ${refundStatus}${refundError ? ` (${refundError})` : ''}`,
          // Clear ephemeral SSH so leaked credentials become useless.
          sshSessionToken: null,
          sshSessionTokenExpiresAt: null,
        },
      }),
      fastify.prisma.node.updateMany({
        where: { assignedComputeRequestId: id },
        data: { assignedComputeRequestId: null },
      }),
      fastify.prisma.user.update({
        where: { id: userId },
        data: { successfulRentalCount: { increment: 1 }, lastRentalAt: completedAt },
      }),
    ])

    void createNotification(
      userId,
      'COMPUTE_COMPLETED',
      'Rental Ended',
      refundStatus === 'SENT'
        ? `Your rental ended. Refund of $${refundAmount.toFixed(2)} sent to your wallet.`
        : refundStatus === 'SKIPPED_NO_WALLET'
          ? `Your rental ended. Add a wallet address in settings to receive future refunds.`
          : `Your rental ended. ${refundStatus === 'SKIPPED_ZERO' ? 'No refund due.' : 'Refund failed — admin notified.'}`,
    )

    fastify.io?.emit('compute:terminated', {
      requestId: id,
      userId,
      finalMinutes,
      finalAccrued,
      refundAmount,
      refundStatus,
      refundTxHash,
      timestamp: completedAt.toISOString(),
    })

    reply.send({
      id,
      status: 'COMPLETED',
      finalMinutes,
      finalAccrued,
      refundAmount,
      refundStatus,
      refundTxHash,
      refundError,
    })
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
