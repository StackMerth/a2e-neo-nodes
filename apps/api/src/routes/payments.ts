import type { FastifyInstance } from 'fastify'
import {
  getSolanaConfig,
  processPayment,
  verifyTransaction,
  isValidSolanaAddress,
} from '../services/payment/solana'
import {
  markSettlementProcessing,
  markSettlementCompleted,
  markSettlementFailed,
} from '../services/settlement/engine'

export async function paymentsRoutes(fastify: FastifyInstance) {
  // POST /v1/payments/process/:settlementId - Process settlement payment
  fastify.post(
    '/v1/payments/process/:settlementId',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { settlementId } = request.params as { settlementId: string }
      const { currency = 'USDC' } = request.body as { currency?: 'SOL' | 'USDC' }

      const settlement = await fastify.prisma.settlement.findUnique({
        where: { id: settlementId },
      })

      if (!settlement) {
        return reply.code(404).send({ error: 'Settlement not found' })
      }

      if (settlement.status !== 'PENDING' && settlement.status !== 'FAILED') {
        return reply.code(400).send({
          error: 'Invalid Status',
          message: `Settlement is ${settlement.status}, cannot process`,
        })
      }

      if (!isValidSolanaAddress(settlement.walletAddress)) {
        return reply.code(400).send({
          error: 'Invalid Address',
          message: 'Settlement wallet address is not a valid Solana address',
        })
      }

      const config = await getSolanaConfig(fastify.prisma)
      if (!config) {
        return reply.code(503).send({
          error: 'Payment Not Configured',
          message: 'Solana payment configuration is missing. Configure in /v1/settlements/config',
        })
      }

      await markSettlementProcessing(fastify.prisma, settlementId)

      const result = await processPayment(
        config,
        settlement.walletAddress,
        settlement.amount,
        currency
      )

      if (result.success && result.txHash) {
        await markSettlementCompleted(fastify.prisma, settlementId, result.txHash)

        return reply.send({
          success: true,
          settlementId,
          txHash: result.txHash,
          amount: settlement.amount,
          currency,
          walletAddress: settlement.walletAddress,
        })
      } else {
        await markSettlementFailed(fastify.prisma, settlementId, result.error ?? 'Payment failed')

        return reply.code(500).send({
          success: false,
          settlementId,
          error: result.error,
          note: 'Use POST /v1/settlements/:id/complete with manual txHash to complete',
        })
      }
    }
  )

  // GET /v1/payments/:settlementId - Get payment details for a settlement
  fastify.get(
    '/v1/payments/:settlementId',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { settlementId } = request.params as { settlementId: string }

      const settlement = await fastify.prisma.settlement.findUnique({
        where: { id: settlementId },
        include: {
          node: { select: { walletAddress: true, gpuTier: true } },
        },
      })

      if (!settlement) {
        return reply.code(404).send({ error: 'Settlement not found' })
      }

      reply.send({
        settlementId: settlement.id,
        nodeId: settlement.nodeId,
        walletAddress: settlement.walletAddress,
        gpuTier: settlement.node.gpuTier,
        amount: settlement.amount,
        currency: settlement.currency,
        status: settlement.status,
        txHash: settlement.txHash,
        txConfirmed: settlement.txConfirmed,
        processedAt: settlement.processedAt?.toISOString() ?? null,
        errorMessage: settlement.errorMessage,
      })
    }
  )

  // GET /v1/payments/verify/:txHash - Verify payment on-chain
  fastify.get(
    '/v1/payments/verify/:txHash',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { txHash } = request.params as { txHash: string }

      const config = await getSolanaConfig(fastify.prisma)
      if (!config) {
        return reply.code(503).send({
          error: 'Payment Not Configured',
          message: 'Solana payment configuration is missing',
        })
      }

      const result = await verifyTransaction(config, txHash)

      if (result.verified) {
        const settlement = await fastify.prisma.settlement.findFirst({
          where: { txHash },
        })

        if (settlement && !settlement.txConfirmed) {
          await fastify.prisma.settlement.update({
            where: { id: settlement.id },
            data: { txConfirmed: true },
          })
        }
      }

      reply.send({
        txHash,
        verified: result.verified,
        confirmations: result.confirmations,
        error: result.error,
      })
    }
  )

  // GET /v1/payments/config - Get payment configuration status
  fastify.get(
    '/v1/payments/config',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const config = await getSolanaConfig(fastify.prisma)

      reply.send({
        configured: !!config,
        rpcUrl: config?.rpcUrl ? '***configured***' : null,
        usdcMint: config?.usdcMint ?? null,
        note: config
          ? 'Solana payment is configured'
          : 'Configure payment in PATCH /v1/settlements/config',
      })
    }
  )
}
