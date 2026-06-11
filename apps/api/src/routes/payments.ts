import type { FastifyInstance } from 'fastify'
import {
  getSolanaConfig,
  processPayment,
  processBatchPayment,
  verifyTransaction,
  isValidSolanaAddress,
  getPaymentModeInfo,
  getPayerBalance,
} from '../services/payment/solana'
import {
  markSettlementProcessing,
  markSettlementCompleted,
  markSettlementFailed,
} from '../services/settlement/engine'
import { checkIdempotencyKey, storeIdempotencyResponse } from '../services/idempotency/keys'
import { logPaymentChange, logSettlementChange } from '../services/audit/logger'
import { createPendingReconciliation } from '../services/reconciliation/reconciler'

export async function paymentsRoutes(fastify: FastifyInstance) {
  // SECURITY (pen-test 2026-06-09 A2E_AUTOPAYOUT_DRAIN): all /v1/payments
  // routes operate on the treasury and must be ADMIN-only. Previously
  // each route had only `preHandler: [fastify.authenticate]`, which
  // accepted any authed user. Hooks below ENFORCE the role gate at
  // the file level; the per-route authenticate preHandlers remain in
  // place (idempotent — kept for legibility).
  fastify.addHook('preHandler', fastify.authenticate)
  fastify.addHook('preHandler', fastify.requireRole('ADMIN'))

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

      // Check idempotency key if provided
      const idempotencyKey = request.headers['idempotency-key'] as string | undefined
      if (idempotencyKey) {
        const idempotencyResult = await checkIdempotencyKey(
          fastify.prisma,
          idempotencyKey,
          `/v1/payments/process/${settlementId}`,
          request.body
        )

        if (!idempotencyResult.isNew && idempotencyResult.cachedResponse) {
          // Return cached response
          return reply
            .code(idempotencyResult.cachedResponse.statusCode)
            .header('X-Idempotency-Replay', 'true')
            .send(idempotencyResult.cachedResponse.body)
        }
      }

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

      // Atomic claim: only the request that flips PENDING -> PROCESSING
      // proceeds. Parallel requests for the same settlement see false
      // and bail before any treasury USDC is signed.
      const claimed = await markSettlementProcessing(fastify.prisma, settlementId)
      if (!claimed) {
        return reply.code(409).send({
          error: 'Already Processing',
          message: 'Settlement was claimed by another request',
        })
      }
      await logSettlementChange(
        fastify.prisma,
        settlementId,
        'STATUS_CHANGED',
        settlement.status,
        'PROCESSING',
        {
          actor: request.headers['x-api-key'] as string,
          actorType: 'API_KEY',
          ipAddress: request.ip,
        }
      )

      // Create payment record
      const payment = await fastify.prisma.payment.create({
        data: {
          settlementId,
          amount: settlement.amount,
          currency,
          recipientAddress: settlement.walletAddress,
          status: 'PROCESSING',
          isDevMode: false,
        },
      })

      await logPaymentChange(fastify.prisma, payment.id, 'CREATED', null, 'PROCESSING', {
        actor: request.headers['x-api-key'] as string,
        actorType: 'API_KEY',
        ipAddress: request.ip,
        amount: Number(settlement.amount),
      })

      // Process payment
      const config = await getSolanaConfig(fastify.prisma)
      const result = await processPayment(
        config,
        settlement.walletAddress,
        Number(settlement.amount),
        currency
      )

      let responseBody: Record<string, unknown>
      let statusCode: number

      if (result.success && result.txHash) {
        // Create pending reconciliation record BEFORE updating DB (crash recovery)
        if (!result.isDevMode) {
          await createPendingReconciliation(
            fastify.prisma,
            result.txHash,
            settlementId,
            payment.id,
            Number(settlement.amount),
            settlement.walletAddress
          )
        }

        // Update payment record
        const newStatus = result.isDevMode ? 'CONFIRMED' : 'SENT'
        await fastify.prisma.payment.update({
          where: { id: payment.id },
          data: {
            status: newStatus,
            txHash: result.txHash,
            isDevMode: result.isDevMode,
            processedAt: new Date(),
            txConfirmed: result.isDevMode,
            confirmations: result.isDevMode ? 32 : 0,
            confirmedAt: result.isDevMode ? new Date() : undefined,
          },
        })

        await logPaymentChange(fastify.prisma, payment.id, 'PROCESSED', 'PROCESSING', newStatus, {
          actorType: 'SYSTEM',
          txHash: result.txHash,
          amount: Number(settlement.amount),
        })

        // Mark settlement as completed
        await markSettlementCompleted(fastify.prisma, settlementId, result.txHash)
        await logSettlementChange(
          fastify.prisma,
          settlementId,
          'COMPLETED',
          'PROCESSING',
          'COMPLETED',
          {
            actorType: 'SYSTEM',
            txHash: result.txHash,
            amount: Number(settlement.amount),
          }
        )

        statusCode = 200
        responseBody = {
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
        }
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

        await logPaymentChange(fastify.prisma, payment.id, 'FAILED', 'PROCESSING', 'FAILED', {
          actorType: 'SYSTEM',
          reason: result.error,
        })

        // Mark settlement as failed if max retries exceeded
        if (retryCount >= payment.maxRetries) {
          await markSettlementFailed(fastify.prisma, settlementId, result.error ?? 'Payment failed')
          await logSettlementChange(
            fastify.prisma,
            settlementId,
            'FAILED',
            'PROCESSING',
            'FAILED',
            {
              actorType: 'SYSTEM',
              reason: result.error ?? 'Max retries exceeded',
            }
          )
        } else {
          // Reset to pending for retry
          await fastify.prisma.settlement.update({
            where: { id: settlementId },
            data: { status: 'PENDING' },
          })
        }

        statusCode = 500
        responseBody = {
          success: false,
          paymentId: payment.id,
          settlementId,
          error: result.error,
          retryCount,
          maxRetries: payment.maxRetries,
          canRetry: retryCount < payment.maxRetries,
        }
      }

      // Store idempotency response if key was provided
      if (idempotencyKey) {
        await storeIdempotencyResponse(
          fastify.prisma,
          idempotencyKey,
          `/v1/payments/process/${settlementId}`,
          request.body,
          statusCode,
          responseBody
        )
      }

      return reply.code(statusCode).send(responseBody)
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

        // Atomic claim: only the iteration that flips PENDING -> PROCESSING
        // proceeds. Concurrent batch requests for the same settlement
        // see false and skip without signing treasury USDC.
        const claimed = await markSettlementProcessing(fastify.prisma, settlementId)
        if (!claimed) {
          results.push({
            settlementId,
            success: false,
            error: 'Already claimed by another request',
          })
          continue
        }

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

  // GET /v1/payments/balance - Get payer wallet balance
  fastify.get(
    '/v1/payments/balance',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const config = await getSolanaConfig(fastify.prisma)
      const balance = await getPayerBalance(config)

      reply.send({
        isDevMode: balance.isDevMode,
        balances: {
          sol: balance.sol,
          usdc: balance.usdc,
        },
        error: balance.error,
        message: balance.isDevMode
          ? 'DEV MODE: Showing simulated balances'
          : balance.error
            ? `Error fetching balance: ${balance.error}`
            : 'Live wallet balances',
      })
    }
  )

  // POST /v1/payments/batch-onchain - Process multiple settlements in a single on-chain transaction
  fastify.post(
    '/v1/payments/batch-onchain',
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

      // Solana transaction size limits mean we can batch ~10-15 transfers per tx
      if (settlementIds.length > 15) {
        return reply.code(400).send({
          error: 'Batch Too Large',
          message: 'Maximum 15 settlements per on-chain batch (Solana tx size limit)',
        })
      }

      // Collect valid settlements
      const recipients: Array<{ address: string; amount: number; settlementId: string }> = []
      const errors: Array<{ settlementId: string; error: string }> = []

      for (const settlementId of settlementIds) {
        const settlement = await fastify.prisma.settlement.findUnique({
          where: { id: settlementId },
        })

        if (!settlement) {
          errors.push({ settlementId, error: 'Settlement not found' })
          continue
        }

        if (settlement.status !== 'PENDING') {
          errors.push({ settlementId, error: `Settlement is ${settlement.status}` })
          continue
        }

        if (!isValidSolanaAddress(settlement.walletAddress)) {
          errors.push({ settlementId, error: 'Invalid Solana address' })
          continue
        }

        recipients.push({
          address: settlement.walletAddress,
          amount: settlement.amount,
          settlementId,
        })
      }

      if (recipients.length === 0) {
        return reply.code(400).send({
          error: 'No Valid Settlements',
          message: 'No settlements could be processed',
          errors,
        })
      }

      // Mark all as processing
      for (const r of recipients) {
        await markSettlementProcessing(fastify.prisma, r.settlementId)
      }

      // Process batch payment (single on-chain transaction)
      const config = await getSolanaConfig(fastify.prisma)
      const result = await processBatchPayment(
        config,
        recipients.map((r) => ({ address: r.address, amount: r.amount })),
        currency
      )

      const paymentIds: string[] = []

      if (result.success && result.txHash) {
        // Create payment records and mark settlements as completed
        for (const r of recipients) {
          const payment = await fastify.prisma.payment.create({
            data: {
              settlementId: r.settlementId,
              amount: r.amount,
              currency,
              recipientAddress: r.address,
              status: result.isDevMode ? 'CONFIRMED' : 'SENT',
              txHash: result.txHash,
              isDevMode: result.isDevMode,
              processedAt: new Date(),
              txConfirmed: result.isDevMode,
              confirmations: result.isDevMode ? 32 : 0,
              confirmedAt: result.isDevMode ? new Date() : undefined,
            },
          })
          paymentIds.push(payment.id)
          await markSettlementCompleted(fastify.prisma, r.settlementId, result.txHash)
        }

        reply.send({
          success: true,
          txHash: result.txHash,
          processed: recipients.length,
          totalAmount: recipients.reduce((sum, r) => sum + r.amount, 0),
          currency,
          isDevMode: result.isDevMode,
          isBatched: true,
          paymentIds,
          errors: errors.length > 0 ? errors : undefined,
          message: result.isDevMode
            ? `DEV MODE: Batch payment of ${recipients.length} recipients simulated`
            : `Batch payment sent: ${recipients.length} recipients in single transaction`,
        })
      } else {
        // Batch failed - mark all as failed
        for (const r of recipients) {
          await fastify.prisma.payment.create({
            data: {
              settlementId: r.settlementId,
              amount: r.amount,
              currency,
              recipientAddress: r.address,
              status: 'FAILED',
              errorMessage: result.error,
              isDevMode: result.isDevMode,
            },
          })
          await markSettlementFailed(fastify.prisma, r.settlementId, result.error ?? 'Batch payment failed')
        }

        reply.code(500).send({
          success: false,
          error: result.error,
          processed: 0,
          attempted: recipients.length,
          isDevMode: result.isDevMode,
          errors: errors.length > 0 ? errors : undefined,
        })
      }
    }
  )
}
