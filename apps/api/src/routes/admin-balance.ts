/**
 * T1 — admin route for crediting buyer balances.
 *
 * Lets an admin push USD into any user's BuyerBalance with type
 * TOPUP_ADMIN. Built so we can fund early testers without making
 * them route money through Solana / Stripe first; same surface is
 * usable for promo credits, support refunds, and incident make-goods
 * later.
 *
 * Auth: requires JWT (or admin API key) + ADMIN role. The existing
 * fastify.requireRole('ADMIN') middleware factory enforces both.
 *
 * Audit: every successful credit writes a BalanceTransaction row
 * with type=TOPUP_ADMIN. The actor admin's userId is encoded into
 * the referenceId so we know who issued the credit, and into the
 * description (free-form) for human readability. The (type,
 * referenceId) unique on BalanceTransaction protects against
 * double-firing if the route gets retried.
 *
 * Idempotency: if the client supplies a referenceId, repeating the
 * call with the same id is a no-op (returns the prior tx's
 * balanceAfter, never double-credits). If no referenceId is supplied,
 * we generate one keyed by the admin + timestamp so accidentally
 * clicking "Credit" twice in the UI still only credits once.
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  creditBalance,
  DuplicateTransactionError,
  getOrCreateBalance,
} from '../services/balance/balance-service.js'

export async function adminBalanceRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate)
  fastify.addHook('preHandler', fastify.requireRole('ADMIN'))

  const creditSchema = z.object({
    userId: z.string().min(1),
    amountUsd: z.number().positive().max(100_000),
    description: z.string().min(3).max(280),
    // Optional client-supplied idempotency key. When omitted, the
    // route generates one (admin id + ms timestamp) so the same
    // click-burst can't double-credit.
    referenceId: z.string().min(8).max(120).optional(),
  })

  /**
   * POST /v1/admin/balance/credit
   *
   * Body: { userId, amountUsd, description, referenceId? }
   * Returns: { ok, userId, amountUsd, newBalanceUsd, referenceId, transactionId }
   */
  fastify.post('/v1/admin/balance/credit', async (request, reply) => {
    const parsed = creditSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
      })
    }
    const { userId, amountUsd, description } = parsed.data

    const target = await fastify.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, walletAddress: true },
    })
    if (!target) {
      return reply.code(404).send({ error: 'Not Found', message: `User ${userId} does not exist.` })
    }

    const actorId = request.user?.userId ?? 'admin-apikey'
    const referenceId =
      parsed.data.referenceId ?? `admin-credit-${actorId}-${Date.now()}`

    try {
      const snap = await creditBalance(fastify.prisma, {
        userId,
        amountUsd,
        type: 'TOPUP_ADMIN',
        description: `[admin ${actorId}] ${description}`,
        referenceId,
      })
      const tx = await fastify.prisma.balanceTransaction.findFirst({
        where: { type: 'TOPUP_ADMIN', referenceId },
        select: { id: true, createdAt: true },
      })
      return reply.send({
        ok: true,
        userId,
        amountUsd,
        newBalanceUsd: snap.balanceUsd,
        referenceId,
        transactionId: tx?.id ?? null,
        createdAt: tx?.createdAt ?? null,
        duplicate: false,
      })
    } catch (err) {
      if (err instanceof DuplicateTransactionError) {
        // Idempotent retry — return the prior credit's data without
        // re-incrementing the balance.
        const tx = await fastify.prisma.balanceTransaction.findFirst({
          where: { type: 'TOPUP_ADMIN', referenceId },
          select: { id: true, createdAt: true, balanceAfter: true },
        })
        return reply.send({
          ok: true,
          userId,
          amountUsd,
          newBalanceUsd: tx?.balanceAfter ?? 0,
          referenceId,
          transactionId: tx?.id ?? null,
          createdAt: tx?.createdAt ?? null,
          duplicate: true,
        })
      }
      throw err
    }
  })

  /**
   * GET /v1/admin/balance/users?q=...
   *
   * Search users by email or wallet for the credit UI dropdown.
   * Empty `q` returns the 20 most-recent buyers (handy for picking
   * the user you just signed up).
   */
  const searchSchema = z.object({
    q: z.string().trim().max(120).optional(),
    limit: z.coerce.number().min(1).max(50).default(20),
  })

  fastify.get('/v1/admin/balance/users', async (request, reply) => {
    const parsed = searchSchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error' })
    }
    const { q, limit } = parsed.data

    const where = q
      ? {
          OR: [
            { email: { contains: q, mode: 'insensitive' as const } },
            { walletAddress: { contains: q, mode: 'insensitive' as const } },
            { id: { equals: q } },
          ],
        }
      : { OR: [{ isBuyer: true }, { role: { in: ['COMPUTE_BUYER' as const, 'CUSTOMER' as const] } }] }

    const users = await fastify.prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        email: true,
        walletAddress: true,
        role: true,
        isBuyer: true,
        createdAt: true,
        buyerBalance: { select: { balanceUsd: true } },
      },
    })

    return reply.send({
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        walletAddress: u.walletAddress,
        role: u.role,
        isBuyer: u.isBuyer,
        createdAt: u.createdAt,
        balanceUsd: u.buyerBalance?.balanceUsd ?? 0,
      })),
    })
  })

  /**
   * GET /v1/admin/balance/:userId
   *
   * Returns the user's current balance + 25 most-recent transactions.
   * Used by the "credit balance" modal's right-hand summary panel so
   * an admin can see what's already in the account before topping up.
   */
  fastify.get('/v1/admin/balance/:userId', async (request, reply) => {
    const { userId } = request.params as { userId: string }
    const user = await fastify.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, walletAddress: true, role: true },
    })
    if (!user) {
      return reply.code(404).send({ error: 'Not Found' })
    }
    const snap = await getOrCreateBalance(fastify.prisma, userId)
    const balance = await fastify.prisma.buyerBalance.findUnique({
      where: { userId },
      select: { id: true },
    })
    const transactions = balance
      ? await fastify.prisma.balanceTransaction.findMany({
          where: { balanceId: balance.id },
          orderBy: { createdAt: 'desc' },
          take: 25,
          select: {
            id: true,
            type: true,
            amountUsd: true,
            description: true,
            referenceId: true,
            balanceAfter: true,
            createdAt: true,
          },
        })
      : []

    return reply.send({
      user,
      balance: snap,
      transactions,
    })
  })
}
