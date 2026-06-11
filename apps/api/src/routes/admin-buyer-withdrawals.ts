/**
 * Admin endpoints for processing buyer USDC withdrawals.
 *
 * SECURITY (pen-test A5 2026-06-10):
 * The buyer-facing POST /v1/buyer/balance/withdraw used to auto-broadcast
 * USDC on-chain to the buyer's wallet the instant the request was
 * submitted. No human approval, no email confirm, no velocity limit.
 * That made it a 1-step withdrawal drain in combination with ANY
 * balance-inflation bug. Per [[architecture_custodial_payouts]] the
 * platform is a custodial money transmitter; withdrawals must be
 * human-reviewed before fund movement.
 *
 * After the A5 fix, the buyer's withdrawal request creates a
 * BuyerWithdrawal row at status=PENDING and debits their balance, but
 * NO on-chain send happens. This file is the admin side of that flow:
 * an admin sees PENDING rows, reviews wallet + amount + buyer history,
 * and either APPROVES (triggers the on-chain send) or REJECTS (refunds
 * the balance).
 *
 * Endpoints (all gated behind requireRole('ADMIN')):
 *   GET    /v1/admin/buyer-withdrawals              list (paged, filtered by status)
 *   POST   /v1/admin/buyer-withdrawals/:id/approve  trigger on-chain send
 *   POST   /v1/admin/buyer-withdrawals/:id/reject   refund balance, mark REJECTED
 *
 * Idempotency: approve/reject are status-guarded UPDATEs so two admins
 * clicking simultaneously can't double-process. The losing click sees
 * a 409.
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getSolanaConfig, processPayment } from '../services/payment/solana.js'
import { creditBalance } from '../services/balance/balance-service.js'
import { createNotification } from '../services/notification/service.js'

export async function adminBuyerWithdrawalRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate)
  fastify.addHook('preHandler', fastify.requireRole('ADMIN'))

  const listSchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: z
      .enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REJECTED'])
      .optional(),
  })

  /**
   * GET /v1/admin/buyer-withdrawals — list withdrawals for admin review
   *
   * Default filter shows everything, but the admin UI is expected to
   * filter on status=PENDING for the action queue.
   */
  fastify.get('/v1/admin/buyer-withdrawals', async (request, reply) => {
    const parsed = listSchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: parsed.error.errors.map((e) => e.message).join(', '),
      })
    }
    const { page, limit, status } = parsed.data
    const where = status ? { status } : {}

    const [rows, total] = await Promise.all([
      fastify.prisma.buyerWithdrawal.findMany({
        where,
        include: {
          user: { select: { id: true, email: true, walletAddress: true } },
        },
        orderBy: { requestedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      fastify.prisma.buyerWithdrawal.count({ where }),
    ])

    reply.send({
      withdrawals: rows,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    })
  })

  /**
   * POST /v1/admin/buyer-withdrawals/:id/approve
   *
   * Trigger the on-chain USDC send. Status walks PENDING -> PROCESSING
   * -> COMPLETED on success. On send failure, we mark FAILED and refund
   * the buyer's balance via REFUND_FAILED (same pattern the auto-send
   * used to do; we kept the refund path because send can still fail
   * even when an admin approved).
   */
  fastify.post<{ Params: { id: string } }>(
    '/v1/admin/buyer-withdrawals/:id/approve',
    async (request, reply) => {
      const { id } = request.params

      // Status-guarded transition to PROCESSING. Two admins clicking
      // simultaneously: one wins (count=1), one gets count=0 -> 409.
      const claim = await fastify.prisma.buyerWithdrawal.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'PROCESSING' },
      })
      if (claim.count === 0) {
        const existing = await fastify.prisma.buyerWithdrawal.findUnique({
          where: { id },
        })
        if (!existing) return reply.code(404).send({ error: 'Withdrawal not found' })
        return reply.code(409).send({
          error: 'Already processed',
          message: `Withdrawal is in ${existing.status} state; cannot approve.`,
        })
      }

      const w = await fastify.prisma.buyerWithdrawal.findUnique({ where: { id } })
      if (!w) {
        // Shouldn't happen after a successful updateMany, but guard anyway.
        return reply.code(404).send({ error: 'Withdrawal not found' })
      }

      try {
        const solanaConfig = await getSolanaConfig(fastify.prisma)
        const result = await processPayment(
          solanaConfig,
          w.walletAddress,
          w.amountUsd,
          'USDC',
        )

        if (result.success && result.txHash) {
          await fastify.prisma.buyerWithdrawal.update({
            where: { id },
            data: {
              status: 'COMPLETED',
              txHash: result.txHash,
              processedAt: new Date(),
            },
          })
          void createNotification(
            w.userId,
            'BALANCE_TOPUP',
            'Withdrawal sent',
            `$${w.amountUsd.toFixed(2)} sent to your wallet. Tx: ${result.txHash.slice(0, 12)}…`,
            `/buyer/balance`,
          )
          return reply.send({
            id: w.id,
            status: 'COMPLETED',
            txHash: result.txHash,
            amountUsd: w.amountUsd,
          })
        }

        // processPayment returned success: false
        const errMsg = result.error ?? 'On-chain send failed'
        await fastify.prisma.buyerWithdrawal.update({
          where: { id },
          data: { status: 'FAILED', error: errMsg, processedAt: new Date() },
        })
        await creditBalance(fastify.prisma, {
          userId: w.userId,
          amountUsd: w.amountUsd,
          type: 'REFUND_FAILED',
          description: `Refund: admin-approved withdrawal ${id.slice(0, 8)} failed (${errMsg})`,
          referenceId: `withdraw-fail:${id}`,
        })
        return reply.code(502).send({
          error: 'send_failed',
          message: `On-chain send failed: ${errMsg}. Buyer balance refunded.`,
        })
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Unknown send error'
        fastify.log.error({ err, withdrawalId: id }, 'Admin approve threw on send')
        await fastify.prisma.buyerWithdrawal
          .update({
            where: { id },
            data: { status: 'FAILED', error: errMsg, processedAt: new Date() },
          })
          .catch(() => undefined)
        await creditBalance(fastify.prisma, {
          userId: w.userId,
          amountUsd: w.amountUsd,
          type: 'REFUND_FAILED',
          description: `Refund: admin-approved withdrawal ${id.slice(0, 8)} threw (${errMsg})`,
          referenceId: `withdraw-fail:${id}`,
        }).catch(() => undefined)
        return reply.code(502).send({
          error: 'send_failed',
          message: `On-chain send error: ${errMsg}. Buyer balance refunded.`,
        })
      }
    },
  )

  /**
   * POST /v1/admin/buyer-withdrawals/:id/reject
   *
   * Reject the withdrawal: mark REJECTED + credit the buyer's balance
   * back via REFUND_FAILED. Status-guarded so two admins racing can't
   * double-refund.
   */
  const rejectSchema = z.object({
    reason: z.string().min(1).max(500),
  })

  fastify.post<{ Params: { id: string } }>(
    '/v1/admin/buyer-withdrawals/:id/reject',
    async (request, reply) => {
      const { id } = request.params
      const parsed = rejectSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: 'Provide a non-empty reason for the rejection.',
        })
      }
      const { reason } = parsed.data

      // Status-guarded reject of PENDING rows only. PROCESSING is
      // mid-send; an admin shouldn't be able to yank it.
      const claim = await fastify.prisma.buyerWithdrawal.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'REJECTED', error: reason, processedAt: new Date() },
      })
      if (claim.count === 0) {
        const existing = await fastify.prisma.buyerWithdrawal.findUnique({
          where: { id },
        })
        if (!existing) return reply.code(404).send({ error: 'Withdrawal not found' })
        return reply.code(409).send({
          error: 'Cannot reject',
          message: `Withdrawal is in ${existing.status} state; only PENDING rows can be rejected.`,
        })
      }

      const w = await fastify.prisma.buyerWithdrawal.findUnique({ where: { id } })
      if (!w) return reply.code(404).send({ error: 'Withdrawal not found' })

      // Refund the debited balance so the buyer is whole. Same
      // referenceId namespace as the auto-fail path so reconciliation
      // can pair them.
      await creditBalance(fastify.prisma, {
        userId: w.userId,
        amountUsd: w.amountUsd,
        type: 'REFUND_FAILED',
        description: `Refund: withdrawal ${id.slice(0, 8)} rejected (${reason})`,
        referenceId: `withdraw-reject:${id}`,
      })

      void createNotification(
        w.userId,
        'BALANCE_TOPUP',
        'Withdrawal rejected',
        `Your $${w.amountUsd.toFixed(2)} withdrawal was rejected: ${reason}. Your balance has been restored.`,
        `/buyer/balance`,
      )

      reply.send({ id: w.id, status: 'REJECTED', reason })
    },
  )
}
