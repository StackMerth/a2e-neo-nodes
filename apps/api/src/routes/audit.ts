import type { FastifyInstance } from 'fastify'
import { getAuditLog } from '../services/audit/logger'
import {
  runReconciliation,
  getReconciliationStatus,
  findOrphanedPayments,
} from '../services/reconciliation/reconciler'

export async function auditRoutes(fastify: FastifyInstance) {
  // GET /v1/audit/:entityType/:entityId - Get audit log for an entity
  fastify.get(
    '/v1/audit/:entityType/:entityId',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { entityType, entityId } = request.params as {
        entityType: string
        entityId: string
      }
      const { limit = '50' } = request.query as { limit?: string }

      const logs = await getAuditLog(
        fastify.prisma,
        entityType,
        entityId,
        parseInt(limit, 10)
      )

      reply.send({
        entityType,
        entityId,
        logs,
        total: logs.length,
      })
    }
  )

  // GET /v1/audit - List recent audit logs
  fastify.get(
    '/v1/audit',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { entityType, action, limit = '50', offset = '0' } = request.query as {
        entityType?: string
        action?: string
        limit?: string
        offset?: string
      }

      const where: Record<string, unknown> = {}
      if (entityType) where.entityType = entityType
      if (action) where.action = action

      const [logs, total] = await Promise.all([
        fastify.prisma.auditLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: parseInt(limit, 10),
          skip: parseInt(offset, 10),
        }),
        fastify.prisma.auditLog.count({ where }),
      ])

      reply.send({
        logs: logs.map((log) => ({
          id: log.id,
          entityType: log.entityType,
          entityId: log.entityId,
          action: log.action,
          previousValue: log.previousValue ? JSON.parse(log.previousValue) : null,
          newValue: log.newValue ? JSON.parse(log.newValue) : null,
          actor: log.actor,
          actorType: log.actorType,
          reason: log.reason,
          createdAt: log.createdAt.toISOString(),
        })),
        total,
        limit: parseInt(limit, 10),
        offset: parseInt(offset, 10),
      })
    }
  )

  // GET /v1/reconciliation/status - Get reconciliation status
  fastify.get(
    '/v1/reconciliation/status',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const status = await getReconciliationStatus(fastify.prisma)
      reply.send(status)
    }
  )

  // POST /v1/reconciliation/run - Manually trigger reconciliation
  fastify.post(
    '/v1/reconciliation/run',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const result = await runReconciliation(fastify.prisma)
      const status = await getReconciliationStatus(fastify.prisma)

      reply.send({
        message: 'Reconciliation completed',
        result,
        status,
      })
    }
  )

  // GET /v1/reconciliation/orphaned - List orphaned payments
  fastify.get(
    '/v1/reconciliation/orphaned',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { staleMinutes = '30' } = request.query as { staleMinutes?: string }

      const orphaned = await findOrphanedPayments(
        fastify.prisma,
        parseInt(staleMinutes, 10)
      )

      reply.send({
        count: orphaned.length,
        staleMinutes: parseInt(staleMinutes, 10),
        payments: orphaned.map((p) => ({
          id: p.id,
          settlementId: p.settlementId,
          txHash: p.txHash,
          amount: p.amount,
          recipientAddress: p.recipientAddress,
          createdAt: p.createdAt.toISOString(),
        })),
      })
    }
  )

  // GET /v1/reconciliation/pending - List pending reconciliations
  fastify.get(
    '/v1/reconciliation/pending',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { status = 'PENDING', limit = '50' } = request.query as {
        status?: string
        limit?: string
      }

      const pending = await fastify.prisma.pendingReconciliation.findMany({
        where: { status: status as 'PENDING' | 'VERIFIED' | 'FAILED' | 'NOT_FOUND' | 'MANUAL' },
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit, 10),
      })

      reply.send({
        count: pending.length,
        status,
        records: pending.map((r) => ({
          id: r.id,
          txHash: r.txHash,
          settlementId: r.settlementId,
          paymentId: r.paymentId,
          expectedAmount: r.expectedAmount,
          recipientAddress: r.recipientAddress,
          status: r.status,
          attempts: r.attempts,
          lastAttemptAt: r.lastAttemptAt?.toISOString() ?? null,
          errorMessage: r.errorMessage,
          createdAt: r.createdAt.toISOString(),
          resolvedAt: r.resolvedAt?.toISOString() ?? null,
        })),
      })
    }
  )
}
