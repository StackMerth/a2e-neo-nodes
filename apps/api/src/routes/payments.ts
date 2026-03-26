import type { FastifyInstance } from 'fastify'
import {
  getSolanaConfig,
  processPayment,
  verifyTransaction,
  isValidSolanaAddress,
  getPaymentModeInfo,
} from '../services/payment/solana'
import {
  markSettlementProcessing,
  markSettlementCompleted,
  markSettlementFailed,
} from '../services/settlement/engine'

export async function paymentsRoutes(fastify: FastifyInstance) {
  // GET /v1/payments/mode - Get current payment mode (dev/live)
  fastify.get(
    '/v1/payments/mode',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const modeInfo = getPaymentModeInfo()
      const config = await getSolanaConfig(fastify.prisma)

      reply.send({
        ...modeInfo,
        devMode: config.devMode,
        rpcConfigured: !!config.rpcUrl && config.rpcUrl !== 'https://api.devnet.solana.com',
        payerConfigured: !!config.payerPrivateKey,
      })
    }
  )

  // POST /v1/payments/process/:settlementId - Process a settlement payment
  fastify.post(
    '/v1/payments/process/:settlementId',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { settlementId } = request.params as { settlementId: string }
      const { currency = 'USDC' } = request.body as { currency?: 'SOL' | 'USDC' }

      // Get settlement
      const settlement = await fastify.prisma.settlement.findUnique({
        where: { id: settlementId },
        include: { node: true },
      })

      if (!settlement) {
        return reply.code(404).send({ error: 'Settlement not found' })
      }

      if (settlement.status === 'COMPLETED') {
        return reply.code(400).send({
          error: 'Already Completed',
          message: 'Settlement has already been paid',
          txHash: settlement.txHash,
        })
      }

      if (settlement.status === 'PROCESSING') {
        return reply.code(400).send({
          error: 'Already Processing',
          message: 'Settlement is currently being processed',
        })
      }

      // Validate recipient address
      if (!isValidSolanaAddress(settlement.walletAddress)) {
        return reply.code(400).send({
          error: 'Invalid Address',
          message: 'Settlement wallet address is not a valid Solana address',
        })
      }

      // Mark as processing
      await markSettlementProcessing(fastify.prisma, settlementId)

      // Create payment record
      const payment = await fastify.prisma.payment.create({
        data: {
          settlementId,
          amount: settlement.amount,
          currency,
          recipientAddress: settlement.walletAddress,
          status: 'PROCESSING',
          isDevMode: false, // Will be updated after processing
        },
      })

      // Process payment
      const config = await getSolanaConfig(fastify.prisma)
      const result = await processPayment(
        config,
        settlement.walletAddress,
        settlement.amount,
        currency
      )

      if (result.success && result.txHash) {
        // Update payment record
        await fastify.prisma.payment.update({
          where: { id: payment.id },
          data: {
            status: result.isDevMode ? 'CONFIRMED' : 'SENT',
            txHash: result.txHash,
            isDevMode: result.isDevMode,
            processedAt: new Date(),
            txConfirmed: result.isDevMode,
            confirmations: result.isDevMode ? 32 : 0,
            confirmedAt: result.isDevMode ? new Date() : undefined,
          },
        })

        // Mark settlement as completed
        await markSettlementCompleted(fastify.prisma, settlementId, result.txHash)

        reply.send({
          success: true,
          paymentId: payment.id,
          settlementId,
          txHash: result.txHash,
          amount: settlement.amount,
          currency,
          recipientAddress: settlement.walletAddress,
          isDevMode: result.isDevMode,
          status: result.isDevMode ? 'CONFIRMED' : 'SENT',
          message: result.isDevMode
            ? 'DEV MODE: Payment simulated successfully - no real funds transferred'
            : 'Payment sent, awaiting confirmation',
        })
      } else {
        // Payment failed
        const retryCount = payment.retryCount + 1

        await fastify.prisma.payment.update({
          where: { id: payment.id },
          data: {
            status: 'FAILED',
            errorMessage: result.error,
            retryCount,
            isDevMode: result.isDevMode,
          },
        })

        // Mark settlement as failed if max retries exceeded
        if (retryCount >= payment.maxRetries) {
          await markSettlementFailed(fastify.prisma, settlementId, result.error ?? 'Payment failed')
        } else {
          // Reset to pending for retry
          await fastify.prisma.settlement.update({
            where: { id: settlementId },
            data: { status: 'PENDING' },
          })
        }

        reply.code(500).send({
          success: false,
          paymentId: payment.id,
          settlementId,
          error: result.error,
          retryCount,
          maxRetries: payment.maxRetries,
          canRetry: retryCount < payment.maxRetries,
        })
      }
    }
  )

  // GET /v1/payments/:id - Get payment details
  fastify.get(
    '/v1/payments/:id',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const payment = await fastify.prisma.payment.findUnique({
        where: { id },
      })

      if (!payment) {
        return reply.code(404).send({ error: 'Payment not found' })
      }

      reply.send({
        id: payment.id,
        settlementId: payment.settlementId,
        amount: payment.amount,
        currency: payment.currency,
        recipientAddress: payment.recipientAddress,
        status: payment.status,
        txHash: payment.txHash,
        txConfirmed: payment.txConfirmed,
        confirmations: payment.confirmations,
        isDevMode: payment.isDevMode,
        errorMessage: payment.errorMessage,
        retryCount: payment.retryCount,
        maxRetries: payment.maxRetries,
        createdAt: payment.createdAt.toISOString(),
        processedAt: payment.processedAt?.toISOString() ?? null,
        confirmedAt: payment.confirmedAt?.toISOString() ?? null,
      })
    }
  )

  // GET /v1/payments - List payments
  fastify.get(
    '/v1/payments',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { settlementId, status, limit = '50', offset = '0' } = request.query as {
        settlementId?: string
        status?: string
        limit?: string
        offset?: string
      }

      const where: Record<string, unknown> = {}
      if (settlementId) where.settlementId = settlementId
      if (status) where.status = status

      const [payments, total] = await Promise.all([
        fastify.prisma.payment.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: parseInt(limit, 10),
          skip: parseInt(offset, 10),
        }),
        fastify.prisma.payment.count({ where }),
      ])

      reply.send({
        payments: payments.map((p) => ({
          id: p.id,
          settlementId: p.settlementId,
          amount: p.amount,
          currency: p.currency,
          recipientAddress: p.recipientAddress,
          status: p.status,
          txHash: p.txHash,
          txConfirmed: p.txConfirmed,
          isDevMode: p.isDevMode,
          createdAt: p.createdAt.toISOString(),
          processedAt: p.processedAt?.toISOString() ?? null,
        })),
        total,
        limit: parseInt(limit, 10),
        offset: parseInt(offset, 10),
      })
    }
  )

  // POST /v1/payments/verify/:txHash - Verify payment on-chain
  fastify.post(
    '/v1/payments/verify/:txHash',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { txHash } = request.params as { txHash: string }

      // Find payment by txHash
      const payment = await fastify.prisma.payment.findFirst({
        where: { txHash },
      })

      // Verify on chain
      const config = await getSolanaConfig(fastify.prisma)
      const result = await verifyTransaction(config, txHash)

      if (payment && result.verified) {
        // Update payment record
        await fastify.prisma.payment.update({
          where: { id: payment.id },
          data: {
            txConfirmed: true,
            confirmations: result.confirmations,
            status: 'CONFIRMED',
            confirmedAt: new Date(),
          },
        })

        // Also update settlement
        await fastify.prisma.settlement.updateMany({
          where: { txHash },
          data: { txConfirmed: true },
        })
      }

      reply.send({
        txHash,
        verified: result.verified,
        confirmations: result.confirmations,
        isDevMode: result.isDevMode,
        error: result.error,
        paymentId: payment?.id ?? null,
      })
    }
  )

  // POST /v1/payments/batch - Process multiple settlements at once
  fastify.post(
    '/v1/payments/batch',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { settlementIds, currency = 'USDC' } = request.body as {
        settlementIds: string[]
        currency?: 'SOL' | 'USDC'
      }

      if (!settlementIds || !Array.isArray(settlementIds) || settlementIds.length === 0) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: 'settlementIds must be a non-empty array',
        })
      }

      if (settlementIds.length > 20) {
        return reply.code(400).send({
          error: 'Batch Too Large',
          message: 'Maximum 20 settlements per batch',
        })
      }

      const results: {
        settlementId: string
        success: boolean
        paymentId?: string
        txHash?: string
        error?: string
      }[] = []

      const config = await getSolanaConfig(fastify.prisma)

      for (const settlementId of settlementIds) {
        const settlement = await fastify.prisma.settlement.findUnique({
          where: { id: settlementId },
        })

        if (!settlement) {
          results.push({ settlementId, success: false, error: 'Settlement not found' })
          continue
        }

        if (settlement.status !== 'PENDING') {
          results.push({
            settlementId,
            success: false,
            error: `Settlement is ${settlement.status}`,
          })
          continue
        }

        if (!isValidSolanaAddress(settlement.walletAddress)) {
          results.push({
            settlementId,
            success: false,
            error: 'Invalid Solana address',
          })
          continue
        }

        // Mark as processing
        await markSettlementProcessing(fastify.prisma, settlementId)

        // Create payment record
        const payment = await fastify.prisma.payment.create({
          data: {
            settlementId,
            amount: settlement.amount,
            currency,
            recipientAddress: settlement.walletAddress,
            status: 'PROCESSING',
          },
        })

        // Process payment
        const result = await processPayment(
          config,
          settlement.walletAddress,
          settlement.amount,
          currency
        )

        if (result.success && result.txHash) {
          await fastify.prisma.payment.update({
            where: { id: payment.id },
            data: {
              status: result.isDevMode ? 'CONFIRMED' : 'SENT',
              txHash: result.txHash,
              isDevMode: result.isDevMode,
              processedAt: new Date(),
              txConfirmed: result.isDevMode,
              confirmedAt: result.isDevMode ? new Date() : undefined,
            },
          })

          await markSettlementCompleted(fastify.prisma, settlementId, result.txHash)
          results.push({
            settlementId,
            success: true,
            paymentId: payment.id,
            txHash: result.txHash,
          })
        } else {
          await fastify.prisma.payment.update({
            where: { id: payment.id },
            data: {
              status: 'FAILED',
              errorMessage: result.error,
            },
          })

          await markSettlementFailed(fastify.prisma, settlementId, result.error ?? 'Payment failed')
          results.push({ settlementId, success: false, paymentId: payment.id, error: result.error })
        }
      }

      const successful = results.filter((r) => r.success).length
      const failed = results.filter((r) => !r.success).length

      reply.send({
        processed: results.length,
        successful,
        failed,
        isDevMode: config.devMode,
        message: config.devMode
          ? 'DEV MODE: Payments simulated - no real funds transferred'
          : `Processed ${successful} of ${results.length} settlements`,
        results,
      })
    }
  )

  // GET /v1/payments/stats - Payment statistics
  fastify.get(
    '/v1/payments/stats',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const [totalPayments, confirmedPayments, failedPayments, devModePayments, totalAmount] =
        await Promise.all([
          fastify.prisma.payment.count(),
          fastify.prisma.payment.count({ where: { status: 'CONFIRMED' } }),
          fastify.prisma.payment.count({ where: { status: 'FAILED' } }),
          fastify.prisma.payment.count({ where: { isDevMode: true } }),
          fastify.prisma.payment.aggregate({
            where: { status: 'CONFIRMED' },
            _sum: { amount: true },
          }),
        ])

      const modeInfo = getPaymentModeInfo()

      reply.send({
        currentMode: modeInfo.mode,
        modeDescription: modeInfo.description,
        stats: {
          total: totalPayments,
          confirmed: confirmedPayments,
          failed: failedPayments,
          devModePayments,
          totalAmountPaid: totalAmount._sum.amount ?? 0,
        },
      })
    }
  )
}
