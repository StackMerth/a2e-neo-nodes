/**
 * Buyer credit-balance service. Wraps every credit / debit in a Prisma
 * transaction so the BuyerBalance row and the BalanceTransaction
 * ledger entry move together — there is never a state where the
 * balance has moved but the ledger does not record why.
 *
 * Idempotency: the (type, referenceId) unique constraint on
 * BalanceTransaction prevents the same txHash from being credited
 * twice, and the same rental from being charged or refunded twice.
 * Callers can therefore safely retry on transient failure.
 */

import type { PrismaClient, Prisma } from '@a2e/database'

export type BalanceTxType =
  | 'TOPUP_SOLANA'
  | 'TOPUP_STRIPE'
  | 'TOPUP_ADMIN'
  | 'SPEND_RENTAL'
  | 'SPEND_DEPLOYMENT'
  | 'SPEND_INFERENCE'
  | 'REFUND_RENTAL'
  | 'REFUND_DEPLOYMENT'
  | 'REFUND_INFERENCE'
  | 'REFUND_FAILED'
  | 'WITHDRAW_USDC'
  // Track 5 / M0.2: 3-way revenue split destinations. STAKING_POOL_SHARE
  // and TREASURY_SHARE credit the virtual system users (UserRole values
  // SYSTEM_STAKING_POOL / SYSTEM_TREASURY) created by seed-system-accounts.
  // COST_REIMBURSEMENT + ROYALTY_PAYOUT are reserved for later milestones
  // (M0.3 reimburses the operator's cost when their earnings flow moves
  // to BalanceTransaction, and M3.3 pays trainer-operator royalties for
  // E4 fine-tuned models).
  | 'STAKING_POOL_SHARE'
  | 'TREASURY_SHARE'
  | 'COST_REIMBURSEMENT'
  | 'ROYALTY_PAYOUT'

export interface BalanceSnapshot {
  balanceUsd: number
  totalToppedUp: number
  totalSpent: number
  totalRefunded: number
}

/**
 * Find or create the buyer's balance row. Safe to call on every
 * request; the underlying upsert is a single round-trip.
 */
export async function getOrCreateBalance(
  prisma: PrismaClient,
  userId: string,
): Promise<BalanceSnapshot> {
  const row = await prisma.buyerBalance.upsert({
    where: { userId },
    create: { userId },
    update: {},
    select: {
      balanceUsd: true,
      totalToppedUp: true,
      totalSpent: true,
      totalRefunded: true,
    },
  })
  return row
}

interface CreditArgs {
  userId: string
  amountUsd: number
  type: Extract<
    BalanceTxType,
    | 'TOPUP_SOLANA'
    | 'TOPUP_STRIPE'
    | 'TOPUP_ADMIN'
    | 'REFUND_RENTAL'
    | 'REFUND_DEPLOYMENT'
    | 'REFUND_INFERENCE'
    | 'REFUND_FAILED'
    | 'STAKING_POOL_SHARE'
    | 'TREASURY_SHARE'
    | 'COST_REIMBURSEMENT'
    | 'ROYALTY_PAYOUT'
  >
  description: string
  referenceId: string | null
}

interface DebitArgs {
  userId: string
  amountUsd: number
  type: Extract<BalanceTxType, 'SPEND_RENTAL' | 'SPEND_DEPLOYMENT' | 'SPEND_INFERENCE'>
  description: string
  referenceId: string
}

export class InsufficientBalanceError extends Error {
  constructor(
    public currentBalance: number,
    public requestedAmount: number,
  ) {
    super(`Insufficient balance: $${currentBalance.toFixed(2)} available, $${requestedAmount.toFixed(2)} requested`)
    this.name = 'InsufficientBalanceError'
  }
}

export class DuplicateTransactionError extends Error {
  constructor(public type: BalanceTxType, public referenceId: string) {
    super(`Duplicate balance transaction: type=${type} referenceId=${referenceId}`)
    this.name = 'DuplicateTransactionError'
  }
}

/**
 * Credit the buyer's balance. Throws DuplicateTransactionError if the
 * (type, referenceId) tuple already exists in the ledger — caller
 * should treat this as "already processed, nothing to do".
 */
export async function creditBalance(
  prisma: PrismaClient,
  args: CreditArgs,
): Promise<BalanceSnapshot> {
  if (args.amountUsd <= 0) {
    throw new Error(`creditBalance requires positive amount, got ${args.amountUsd}`)
  }

  return prisma.$transaction(async (tx) => {
    // Make sure the balance row exists before we update it.
    await tx.buyerBalance.upsert({
      where: { userId: args.userId },
      create: { userId: args.userId },
      update: {},
    })

    const isTopup = args.type.startsWith('TOPUP_')
    const isRefund = args.type.startsWith('REFUND_')

    const updated = await tx.buyerBalance.update({
      where: { userId: args.userId },
      data: {
        balanceUsd: { increment: args.amountUsd },
        totalToppedUp: isTopup ? { increment: args.amountUsd } : undefined,
        totalRefunded: isRefund ? { increment: args.amountUsd } : undefined,
      },
      select: {
        id: true,
        balanceUsd: true,
        totalToppedUp: true,
        totalSpent: true,
        totalRefunded: true,
      },
    })

    try {
      await tx.balanceTransaction.create({
        data: {
          balanceId: updated.id,
          type: args.type,
          amountUsd: args.amountUsd,
          description: args.description,
          referenceId: args.referenceId,
          balanceAfter: updated.balanceUsd,
        },
      })
    } catch (err) {
      const prismaErr = err as Prisma.PrismaClientKnownRequestError
      if (prismaErr.code === 'P2002' && args.referenceId) {
        // Unique constraint hit on (type, referenceId) — the credit was
        // already processed in a prior call. Roll back the increment we
        // just applied so the balance stays consistent.
        throw new DuplicateTransactionError(args.type, args.referenceId)
      }
      throw err
    }

    return {
      balanceUsd: updated.balanceUsd,
      totalToppedUp: updated.totalToppedUp,
      totalSpent: updated.totalSpent,
      totalRefunded: updated.totalRefunded,
    }
  })
}

/**
 * Inner debit logic. Operates on a TransactionClient so it can be
 * called from inside an existing $transaction without triggering
 * Prisma's "nested transaction not supported" failure. The Public
 * debitBalance() wrapper below opens its own $transaction and calls
 * this.
 *
 * Pulled out 2026-06-01 to fix a real bug: the inference meter was
 * calling debitBalance(tx, ...) from inside its own $transaction,
 * which threw "$transaction is not a function" at runtime (the
 * TransactionClient type strips $transaction). Error was caught by
 * the route's try/catch, logged, but the InferenceRequest still got
 * marked COMPLETED — so TokenUsage + BalanceTransaction never landed
 * for the test inference calls.
 */
export async function debitBalanceInTx(
  tx: Prisma.TransactionClient,
  args: DebitArgs,
): Promise<BalanceSnapshot> {
  const existing = await tx.buyerBalance.upsert({
    where: { userId: args.userId },
    create: { userId: args.userId },
    update: {},
    select: { id: true, balanceUsd: true },
  })

  if (existing.balanceUsd < args.amountUsd) {
    throw new InsufficientBalanceError(existing.balanceUsd, args.amountUsd)
  }

  const updated = await tx.buyerBalance.update({
    where: { userId: args.userId },
    data: {
      balanceUsd: { decrement: args.amountUsd },
      totalSpent: { increment: args.amountUsd },
    },
    select: {
      id: true,
      balanceUsd: true,
      totalToppedUp: true,
      totalSpent: true,
      totalRefunded: true,
    },
  })

  try {
    await tx.balanceTransaction.create({
      data: {
        balanceId: updated.id,
        type: args.type,
        amountUsd: -args.amountUsd,  // signed: debits stored as negative
        description: args.description,
        referenceId: args.referenceId,
        balanceAfter: updated.balanceUsd,
      },
    })
  } catch (err) {
    const prismaErr = err as Prisma.PrismaClientKnownRequestError
    if (prismaErr.code === 'P2002') {
      throw new DuplicateTransactionError(args.type, args.referenceId)
    }
    throw err
  }

  return {
    balanceUsd: updated.balanceUsd,
    totalToppedUp: updated.totalToppedUp,
    totalSpent: updated.totalSpent,
    totalRefunded: updated.totalRefunded,
  }
}

/**
 * Debit the buyer's balance for a rental. Throws InsufficientBalance
 * if the balance is short. Throws DuplicateTransaction if the same
 * referenceId has already been charged.
 *
 * For callers ALREADY inside a $transaction (e.g. the inference
 * meter wrapping TokenUsage create + this debit atomically), use
 * debitBalanceInTx directly with the transaction client.
 */
export async function debitBalance(
  prisma: PrismaClient,
  args: DebitArgs,
): Promise<BalanceSnapshot> {
  if (args.amountUsd <= 0) {
    throw new Error(`debitBalance requires positive amount, got ${args.amountUsd}`)
  }

  return prisma.$transaction(async (tx) => debitBalanceInTx(tx, args))
}

/**
 * Paginated ledger view. Returns most-recent transactions first.
 */
export async function getTransactions(
  prisma: PrismaClient,
  userId: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<Array<{
  id: string
  type: BalanceTxType
  amountUsd: number
  description: string
  referenceId: string | null
  balanceAfter: number
  createdAt: Date
}>> {
  const balance = await prisma.buyerBalance.findUnique({
    where: { userId },
    select: { id: true },
  })
  if (!balance) return []

  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100)
  const cursor = options.cursor ? { id: options.cursor } : undefined
  const skip = cursor ? 1 : 0

  const rows = await prisma.balanceTransaction.findMany({
    where: { balanceId: balance.id },
    orderBy: { createdAt: 'desc' },
    take: limit,
    cursor,
    skip,
  })

  return rows.map((r) => ({
    id: r.id,
    type: r.type as BalanceTxType,
    amountUsd: r.amountUsd,
    description: r.description,
    referenceId: r.referenceId,
    balanceAfter: r.balanceAfter,
    createdAt: r.createdAt,
  }))
}
