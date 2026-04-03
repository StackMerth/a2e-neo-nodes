import type { PrismaClient, Prisma } from '@a2e/database'

export interface AuditContext {
  actor?: string
  actorType?: 'API_KEY' | 'USER' | 'SYSTEM' | 'SCHEDULER'
  ipAddress?: string
  reason?: string
  metadata?: Prisma.InputJsonValue
}

export interface AuditEntry {
  entityType: string
  entityId: string
  action: string
  previousValue?: unknown
  newValue?: unknown
  context?: AuditContext
}

/**
 * Log an audit entry for financial state changes
 */
export async function logAudit(
  prisma: PrismaClient,
  entry: AuditEntry
): Promise<string> {
  const record = await prisma.auditLog.create({
    data: {
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      previousValue: entry.previousValue ? JSON.stringify(entry.previousValue) : null,
      newValue: entry.newValue ? JSON.stringify(entry.newValue) : null,
      actor: entry.context?.actor ?? 'SYSTEM',
      actorType: entry.context?.actorType ?? 'SYSTEM',
      ipAddress: entry.context?.ipAddress,
      reason: entry.context?.reason,
      metadata: entry.context?.metadata ?? undefined,
    },
  })

  return record.id
}

/**
 * Log investment status change
 */
export async function logInvestmentChange(
  prisma: PrismaClient,
  investmentId: string,
  action: string,
  previousStatus: string | null,
  newStatus: string,
  context?: AuditContext
): Promise<void> {
  await logAudit(prisma, {
    entityType: 'Investment',
    entityId: investmentId,
    action,
    previousValue: previousStatus ? { status: previousStatus } : null,
    newValue: { status: newStatus },
    context,
  })
}

/**
 * Log settlement status change
 */
export async function logSettlementChange(
  prisma: PrismaClient,
  settlementId: string,
  action: string,
  previousStatus: string | null,
  newStatus: string,
  context?: AuditContext & { txHash?: string; amount?: number }
): Promise<void> {
  await logAudit(prisma, {
    entityType: 'Settlement',
    entityId: settlementId,
    action,
    previousValue: previousStatus ? { status: previousStatus } : null,
    newValue: {
      status: newStatus,
      txHash: context?.txHash,
      amount: context?.amount,
    },
    context,
  })
}

/**
 * Log payment status change
 */
export async function logPaymentChange(
  prisma: PrismaClient,
  paymentId: string,
  action: string,
  previousStatus: string | null,
  newStatus: string,
  context?: AuditContext & { txHash?: string; amount?: number }
): Promise<void> {
  await logAudit(prisma, {
    entityType: 'Payment',
    entityId: paymentId,
    action,
    previousValue: previousStatus ? { status: previousStatus } : null,
    newValue: {
      status: newStatus,
      txHash: context?.txHash,
      amount: context?.amount,
    },
    context,
  })
}

/**
 * Get audit log for an entity
 */
export async function getAuditLog(
  prisma: PrismaClient,
  entityType: string,
  entityId: string,
  limit = 50
): Promise<Array<{
  id: string
  action: string
  previousValue: unknown
  newValue: unknown
  actor: string | null
  actorType: string
  reason: string | null
  createdAt: Date
}>> {
  const logs = await prisma.auditLog.findMany({
    where: { entityType, entityId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })

  return logs.map((log) => ({
    id: log.id,
    action: log.action,
    previousValue: log.previousValue ? JSON.parse(log.previousValue) : null,
    newValue: log.newValue ? JSON.parse(log.newValue) : null,
    actor: log.actor,
    actorType: log.actorType,
    reason: log.reason,
    createdAt: log.createdAt,
  }))
}
