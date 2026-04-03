import type { PrismaClient } from '@a2e/database'
import { getSolanaConfig, verifyTransaction } from '../payment/solana'
import { logPaymentChange, logSettlementChange } from '../audit/logger'

const MAX_RECONCILIATION_ATTEMPTS = 5
const RECONCILIATION_BACKOFF_MINUTES = [1, 5, 15, 60, 240] // Exponential backoff

export interface ReconciliationResult {
  processed: number
  verified: number
  failed: number
  notFound: number
  errors: Array<{ id: string; error: string }>
}

/**
 * Create a pending reconciliation record when a TX is submitted but DB might not be updated
 */
export async function createPendingReconciliation(
  prisma: PrismaClient,
  txHash: string,
  settlementId: string | null,
  paymentId: string | null,
  expectedAmount: number,
  recipientAddress: string
): Promise<string> {
  const record = await prisma.pendingReconciliation.create({
    data: {
      txHash,
      settlementId,
      paymentId,
      expectedAmount,
      recipientAddress,
      status: 'PENDING',
    },
  })

  return record.id
}

/**
 * Run reconciliation for all pending transactions
 */
export async function runReconciliation(prisma: PrismaClient): Promise<ReconciliationResult> {
  const result: ReconciliationResult = {
    processed: 0,
    verified: 0,
    failed: 0,
    notFound: 0,
    errors: [],
  }

  // Find pending reconciliations that are due for retry
  const pending = await prisma.pendingReconciliation.findMany({
    where: {
      status: 'PENDING',
      attempts: { lt: MAX_RECONCILIATION_ATTEMPTS },
    },
    orderBy: { createdAt: 'asc' },
    take: 50, // Process in batches
  })

  if (pending.length === 0) {
    return result
  }

  const config = await getSolanaConfig(prisma)

  for (const record of pending) {
    result.processed++

    try {
      // Check if enough time has passed since last attempt (exponential backoff)
      if (record.lastAttemptAt) {
        const backoffMinutes = RECONCILIATION_BACKOFF_MINUTES[record.attempts - 1] ?? 240
        const nextAttemptTime = new Date(record.lastAttemptAt)
        nextAttemptTime.setMinutes(nextAttemptTime.getMinutes() + backoffMinutes)

        if (new Date() < nextAttemptTime) {
          continue // Skip, not yet time for retry
        }
      }

      // Verify transaction on-chain
      const verification = await verifyTransaction(config, record.txHash)

      // Update attempt count
      await prisma.pendingReconciliation.update({
        where: { id: record.id },
        data: {
          attempts: record.attempts + 1,
          lastAttemptAt: new Date(),
        },
      })

      if (verification.verified) {
        // TX confirmed on-chain - update DB records
        await reconcileVerifiedTransaction(prisma, record, verification.confirmations)
        result.verified++
      } else if (verification.error?.includes('not found')) {
        // TX not found - may still be propagating or failed
        if (record.attempts >= MAX_RECONCILIATION_ATTEMPTS) {
          await prisma.pendingReconciliation.update({
            where: { id: record.id },
            data: {
              status: 'NOT_FOUND',
              errorMessage: 'Transaction not found after maximum attempts',
            },
          })
          result.notFound++
        }
      } else if (verification.error) {
        // TX failed on-chain
        await prisma.pendingReconciliation.update({
          where: { id: record.id },
          data: {
            status: 'FAILED',
            errorMessage: verification.error,
            resolvedAt: new Date(),
          },
        })
        result.failed++
      }
    } catch (error) {
      result.errors.push({
        id: record.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }

  return result
}

/**
 * Reconcile a verified transaction - update payment and settlement records
 */
async function reconcileVerifiedTransaction(
  prisma: PrismaClient,
  record: {
    id: string
    txHash: string
    settlementId: string | null
    paymentId: string | null
    expectedAmount: unknown
  },
  confirmations: number
): Promise<void> {
  // Update payment record if exists
  if (record.paymentId) {
    const payment = await prisma.payment.findUnique({ where: { id: record.paymentId } })

    if (payment && payment.status !== 'CONFIRMED') {
      await prisma.payment.update({
        where: { id: record.paymentId },
        data: {
          status: 'CONFIRMED',
          txHash: record.txHash,
          txConfirmed: true,
          confirmations,
          confirmedAt: new Date(),
        },
      })

      await logPaymentChange(prisma, record.paymentId, 'RECONCILED', payment.status, 'CONFIRMED', {
        actorType: 'SYSTEM',
        reason: 'Reconciliation: TX verified on-chain',
        txHash: record.txHash,
      })
    }
  }

  // Update settlement record if exists
  if (record.settlementId) {
    const settlement = await prisma.settlement.findUnique({ where: { id: record.settlementId } })

    if (settlement && settlement.status !== 'COMPLETED') {
      await prisma.settlement.update({
        where: { id: record.settlementId },
        data: {
          status: 'COMPLETED',
          txHash: record.txHash,
          txConfirmed: true,
          processedAt: new Date(),
        },
      })

      await logSettlementChange(
        prisma,
        record.settlementId,
        'RECONCILED',
        settlement.status,
        'COMPLETED',
        {
          actorType: 'SYSTEM',
          reason: 'Reconciliation: TX verified on-chain',
          txHash: record.txHash,
        }
      )
    }
  }

  // Mark reconciliation as verified
  await prisma.pendingReconciliation.update({
    where: { id: record.id },
    data: {
      status: 'VERIFIED',
      resolvedAt: new Date(),
    },
  })
}

/**
 * Find orphaned payments (PROCESSING status for too long)
 */
export async function findOrphanedPayments(
  prisma: PrismaClient,
  staleMinutes = 30
): Promise<
  Array<{
    id: string
    settlementId: string
    txHash: string | null
    amount: unknown
    recipientAddress: string
    createdAt: Date
  }>
> {
  const cutoff = new Date()
  cutoff.setMinutes(cutoff.getMinutes() - staleMinutes)

  const orphaned = await prisma.payment.findMany({
    where: {
      status: 'PROCESSING',
      createdAt: { lt: cutoff },
    },
    select: {
      id: true,
      settlementId: true,
      txHash: true,
      amount: true,
      recipientAddress: true,
      createdAt: true,
    },
  })

  return orphaned
}

/**
 * Get reconciliation status summary
 */
export async function getReconciliationStatus(prisma: PrismaClient): Promise<{
  pending: number
  verified: number
  failed: number
  notFound: number
  manual: number
  orphanedPayments: number
}> {
  const [pending, verified, failed, notFound, manual, orphaned] = await Promise.all([
    prisma.pendingReconciliation.count({ where: { status: 'PENDING' } }),
    prisma.pendingReconciliation.count({ where: { status: 'VERIFIED' } }),
    prisma.pendingReconciliation.count({ where: { status: 'FAILED' } }),
    prisma.pendingReconciliation.count({ where: { status: 'NOT_FOUND' } }),
    prisma.pendingReconciliation.count({ where: { status: 'MANUAL' } }),
    findOrphanedPayments(prisma),
  ])

  return {
    pending,
    verified,
    failed,
    notFound,
    manual,
    orphanedPayments: orphaned.length,
  }
}
