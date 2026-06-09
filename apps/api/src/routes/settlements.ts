import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  calculatePendingSettlements,
  createSettlement,
  getSettlementConfig,
  updateSettlementConfig,
  markSettlementProcessing,
  markSettlementCompleted,
  markSettlementFailed,
} from '../services/settlement/engine'
import { notifyPayoutSent } from '../services/notification/service.js'

const updateConfigSchema = z.object({
  period: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']).optional(),
  minimumPayout: z.number().min(0).optional(),
  dayOfWeek: z.number().min(0).max(6).optional(),
  dayOfMonth: z.number().min(1).max(28).optional(),
  hour: z.number().min(0).max(23).optional(),
  autoSchedule: z.boolean().optional(),
  solanaRpcUrl: z.string().url().optional(),
  usdcMint: z.string().optional(),
})

export async function settlementsRoutes(fastify: FastifyInstance) {
  // SECURITY (pen-test 2026-06-09 A2E_AUTOPAYOUT_DRAIN): /v1/settlements/*
  // drives the actual operator-payout machinery (trigger, process,
  // complete). Previously per-route preHandler was only authenticate;
  // any authed user could call /trigger or /process. Lock to ADMIN.
  fastify.addHook('preHandler', fastify.authenticate)
  fastify.addHook('preHandler', fastify.requireRole('ADMIN'))

  // GET /v1/settlements - List settlements
  fastify.get(
    '/v1/settlements',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { nodeId, status, limit = '50', offset = '0' } = request.query as {
        nodeId?: string
        status?: string
        limit?: string
        offset?: string
      }

      const where: Record<string, unknown> = {}
      if (nodeId) where.nodeId = nodeId
      if (status) where.status = status

      const [settlements, total] = await Promise.all([
        fastify.prisma.settlement.findMany({
          where,
          include: {
            node: { select: { walletAddress: true, gpuTier: true } },
            _count: { select: { items: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: parseInt(limit, 10),
          skip: parseInt(offset, 10),
        }),
        fastify.prisma.settlement.count({ where }),
      ])

      reply.send({
        settlements: settlements.map((s) => ({
          id: s.id,
          nodeId: s.nodeId,
          walletAddress: s.walletAddress,
          gpuTier: s.node.gpuTier,
          amount: s.amount,
          currency: s.currency,
          status: s.status,
          jobCount: s.jobCount,
          periodStart: s.periodStart.toISOString(),
          periodEnd: s.periodEnd.toISOString(),
          txHash: s.txHash,
          txConfirmed: s.txConfirmed,
          errorMessage: s.errorMessage,
          createdAt: s.createdAt.toISOString(),
          processedAt: s.processedAt?.toISOString() ?? null,
        })),
        total,
        limit: parseInt(limit, 10),
        offset: parseInt(offset, 10),
      })
    }
  )

  // GET /v1/settlements/:id - Settlement details
  fastify.get(
    '/v1/settlements/:id',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const settlement = await fastify.prisma.settlement.findUnique({
        where: { id },
        include: {
          node: { select: { walletAddress: true, gpuTier: true } },
          items: true,
        },
      })

      if (!settlement) {
        return reply.code(404).send({ error: 'Settlement not found' })
      }

      reply.send({
        id: settlement.id,
        nodeId: settlement.nodeId,
        walletAddress: settlement.walletAddress,
        gpuTier: settlement.node.gpuTier,
        amount: settlement.amount,
        currency: settlement.currency,
        status: settlement.status,
        jobCount: settlement.jobCount,
        periodStart: settlement.periodStart.toISOString(),
        periodEnd: settlement.periodEnd.toISOString(),
        txHash: settlement.txHash,
        txConfirmed: settlement.txConfirmed,
        errorMessage: settlement.errorMessage,
        createdAt: settlement.createdAt.toISOString(),
        processedAt: settlement.processedAt?.toISOString() ?? null,
        items: settlement.items.map((item) => ({
          id: item.id,
          jobId: item.jobId,
          amount: item.amount,
        })),
      })
    }
  )

  // POST /v1/settlements/trigger - Manually trigger settlement calculation
  fastify.post(
    '/v1/settlements/trigger',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { nodeId } = request.body as { nodeId?: string }

      const periodEnd = new Date()
      const calculations = await calculatePendingSettlements(fastify.prisma, periodEnd)

      const filtered = nodeId
        ? calculations.filter((c) => c.nodeId === nodeId)
        : calculations

      const created: string[] = []
      for (const calc of filtered) {
        const id = await createSettlement(fastify.prisma, calc)
        created.push(id)
      }

      reply.send({
        message: `Created ${created.length} settlement(s)`,
        settlementIds: created,
        calculations: filtered.map((c) => ({
          nodeId: c.nodeId,
          walletAddress: c.walletAddress,
          amount: c.amount,
          uptimeHours: c.uptimeHours,
        })),
      })
    }
  )

  // GET /v1/settlements/pending - Pending settlements (calculated but not yet created)
  fastify.get(
    '/v1/settlements/pending',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const periodEnd = new Date()
      const calculations = await calculatePendingSettlements(fastify.prisma, periodEnd)

      reply.send({
        pendingCount: calculations.length,
        totalAmount: calculations.reduce((sum, c) => sum + c.amount, 0),
        pending: calculations.map((c) => ({
          nodeId: c.nodeId,
          walletAddress: c.walletAddress,
          amount: c.amount,
          uptimeHours: c.uptimeHours,
          periodStart: c.periodStart.toISOString(),
          periodEnd: c.periodEnd.toISOString(),
        })),
      })
    }
  )

  // GET /v1/settlements/config - Settlement configuration
  fastify.get(
    '/v1/settlements/config',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const config = await getSettlementConfig(fastify.prisma)

      reply.send({
        period: config.period,
        minimumPayout: config.minimumPayout,
        dayOfWeek: config.dayOfWeek,
        dayOfMonth: config.dayOfMonth,
        hour: config.hour,
        autoSchedule: config.autoSchedule,
        lastScheduledAt: config.lastScheduledAt?.toISOString() ?? null,
        solanaRpcUrl: config.solanaRpcUrl ? '***configured***' : null,
        usdcMint: config.usdcMint,
        updatedAt: config.updatedAt.toISOString(),
      })
    }
  )

  // PATCH /v1/settlements/config - Update settlement config
  fastify.patch(
    '/v1/settlements/config',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const parseResult = updateConfigSchema.safeParse(request.body)

      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: parseResult.error.errors[0]?.message ?? 'Invalid input',
        })
      }

      await updateSettlementConfig(fastify.prisma, parseResult.data)
      const config = await getSettlementConfig(fastify.prisma)

      reply.send({
        period: config.period,
        minimumPayout: config.minimumPayout,
        dayOfWeek: config.dayOfWeek,
        dayOfMonth: config.dayOfMonth,
        hour: config.hour,
        autoSchedule: config.autoSchedule,
        lastScheduledAt: config.lastScheduledAt?.toISOString() ?? null,
        solanaRpcUrl: config.solanaRpcUrl ? '***configured***' : null,
        usdcMint: config.usdcMint,
        updatedAt: config.updatedAt.toISOString(),
      })
    }
  )

  // POST /v1/settlements/:id/process - Process a settlement (trigger payment)
  fastify.post(
    '/v1/settlements/:id/process',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const settlement = await fastify.prisma.settlement.findUnique({
        where: { id },
      })

      if (!settlement) {
        return reply.code(404).send({ error: 'Settlement not found' })
      }

      if (settlement.status !== 'PENDING') {
        return reply.code(400).send({
          error: 'Invalid Status',
          message: `Settlement is ${settlement.status}, cannot process`,
        })
      }

      await markSettlementProcessing(fastify.prisma, id)

      reply.send({
        message: 'Settlement marked for processing',
        id: settlement.id,
        status: 'PROCESSING',
        note: 'Payment integration pending - use manual confirmation for now',
      })
    }
  )

  // POST /v1/settlements/:id/complete - Manually mark settlement as completed
  fastify.post(
    '/v1/settlements/:id/complete',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const { txHash } = request.body as { txHash: string }

      if (!txHash) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: 'txHash is required',
        })
      }

      const settlement = await fastify.prisma.settlement.findUnique({
        where: { id },
      })

      if (!settlement) {
        return reply.code(404).send({ error: 'Settlement not found' })
      }

      if (settlement.status === 'COMPLETED') {
        return reply.code(400).send({
          error: 'Already Completed',
          message: 'Settlement is already completed',
        })
      }

      await markSettlementCompleted(fastify.prisma, id, txHash)

      // Notify node runner about the payout
      if (settlement.nodeId) {
        const node = await fastify.prisma.node.findUnique({
          where: { id: settlement.nodeId },
          select: { nodeRunnerId: true },
        })
        if (node?.nodeRunnerId) {
          void notifyPayoutSent(node.nodeRunnerId, settlement.amount, txHash)
        }
      }

      reply.send({
        message: 'Settlement marked as completed',
        id: settlement.id,
        txHash,
        status: 'COMPLETED',
      })
    }
  )

  // POST /v1/settlements/:id/fail - Manually mark settlement as failed
  fastify.post(
    '/v1/settlements/:id/fail',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const { errorMessage } = request.body as { errorMessage: string }

      const settlement = await fastify.prisma.settlement.findUnique({
        where: { id },
      })

      if (!settlement) {
        return reply.code(404).send({ error: 'Settlement not found' })
      }

      await markSettlementFailed(fastify.prisma, id, errorMessage ?? 'Manually marked as failed')

      reply.send({
        message: 'Settlement marked as failed',
        id: settlement.id,
        status: 'FAILED',
      })
    }
  )

  // POST /v1/settlements/:id/retry - Retry a failed settlement
  fastify.post(
    '/v1/settlements/:id/retry',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const settlement = await fastify.prisma.settlement.findUnique({
        where: { id },
      })

      if (!settlement) {
        return reply.code(404).send({ error: 'Settlement not found' })
      }

      if (settlement.status !== 'FAILED') {
        return reply.code(400).send({
          error: 'Invalid Status',
          message: `Settlement is ${settlement.status}, can only retry FAILED settlements`,
        })
      }

      if (settlement.retryCount >= settlement.maxRetries) {
        return reply.code(400).send({
          error: 'Max Retries Exceeded',
          message: `Settlement has exceeded maximum retry attempts (${settlement.maxRetries})`,
        })
      }

      // Reset to PENDING for retry
      await fastify.prisma.settlement.update({
        where: { id },
        data: {
          status: 'PENDING',
          errorMessage: null,
          nextRetryAt: null,
        },
      })

      reply.send({
        message: 'Settlement queued for retry',
        id: settlement.id,
        status: 'PENDING',
        retryCount: settlement.retryCount,
        maxRetries: settlement.maxRetries,
      })
    }
  )

  // GET /v1/settlements/failed - List failed settlements that can be retried
  fastify.get(
    '/v1/settlements/failed',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const failedSettlements = await fastify.prisma.settlement.findMany({
        where: {
          status: 'FAILED',
        },
        include: {
          node: { select: { walletAddress: true, gpuTier: true } },
        },
        orderBy: { createdAt: 'desc' },
      })

      const retriable = failedSettlements.filter(s => s.retryCount < s.maxRetries)
      const exhausted = failedSettlements.filter(s => s.retryCount >= s.maxRetries)

      reply.send({
        total: failedSettlements.length,
        retriable: {
          count: retriable.length,
          settlements: retriable.map(s => ({
            id: s.id,
            nodeId: s.nodeId,
            walletAddress: s.walletAddress,
            amount: s.amount,
            retryCount: s.retryCount,
            maxRetries: s.maxRetries,
            errorMessage: s.errorMessage,
            lastRetryAt: s.lastRetryAt?.toISOString() ?? null,
            nextRetryAt: s.nextRetryAt?.toISOString() ?? null,
          })),
        },
        exhausted: {
          count: exhausted.length,
          settlements: exhausted.map(s => ({
            id: s.id,
            nodeId: s.nodeId,
            walletAddress: s.walletAddress,
            amount: s.amount,
            retryCount: s.retryCount,
            maxRetries: s.maxRetries,
            errorMessage: s.errorMessage,
          })),
        },
      })
    }
  )
}
