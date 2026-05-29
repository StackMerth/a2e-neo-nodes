/**
 * Track 5 / M0.2 — 3-way revenue split.
 *
 * Single atomic helper that takes (grossUsd, costUsd, referenceId)
 * and:
 *
 *   1. Computes net = max(0, gross - cost).
 *   2. Computes operator total = cost + 0.5 * net,
 *               staking share  = 0.25 * net,
 *               treasury share = 0.25 * net.
 *   3. Credits STAKING_POOL_SHARE and TREASURY_SHARE BalanceTransaction
 *      entries to the two virtual system users.
 *   4. Writes one RevenueShareEntry audit row.
 *   5. Returns the split so the caller (M0.3 rental meter, M0.4
 *      deployment debit, M1.1 inference meter) can write
 *      operatorTotalUsd into the operator's existing earnings flow
 *      (Earning table for rentals, etc.) instead of the gross.
 *
 * Kill switch: REVENUE_SPLIT_ENABLED env var, default false. When OFF,
 * the function short-circuits without touching the ledger and returns
 * operatorTotalUsd = grossUsd (legacy behavior — operator gets 100%).
 * The audit row is still written so reconciliation has a complete
 * history showing the kill switch state at every revenue event.
 *
 * Idempotency: RevenueShareEntry has unique(referenceId). Retrying a
 * split with the same referenceId returns the existing audit row
 * without re-crediting staking / treasury. The (type, referenceId)
 * unique on BalanceTransaction is the belt-and-braces second check.
 *
 * Atomicity: all four writes (two BalanceTransaction credits, two
 * BuyerBalance increments, one RevenueShareEntry) happen inside a
 * single prisma.$transaction so a crash mid-call leaves the ledger
 * either fully split or fully untouched. Staking gets credited
 * before treasury so if we ever see a half-applied state during
 * forensics, the order is deterministic.
 */

import type { PrismaClient, Prisma } from '@a2e/database'

const STAKING_POOL_USER_ID_ENV = 'STAKING_POOL_USER_ID'
const TREASURY_USER_ID_ENV = 'TREASURY_USER_ID'

const STAKING_SHARE_PCT = 0.25
const TREASURY_SHARE_PCT = 0.25
const OPERATOR_PROFIT_PCT = 0.50

export function isRevenueSplitEnabled(): boolean {
  return process.env.REVENUE_SPLIT_ENABLED === 'true'
}

export type RevenueSourceTxType =
  | 'SPEND_RENTAL'
  | 'SPEND_DEPLOYMENT'
  | 'SPEND_INFERENCE'

export interface SplitRevenueArgs {
  /** Buyer-debit source type. Stored on the audit row for reconciliation. */
  sourceTxType: RevenueSourceTxType
  /** Same id as the buyer's BalanceTransaction.referenceId. */
  referenceId: string
  /** Total dollars the buyer paid for this event. */
  grossUsd: number
  /** Cost-of-service reimbursed to operator first. From computeCostOfService(). */
  costUsd: number
  /** The operator's User.id (so the audit row + reconciliation can join). */
  operatorUserId: string
  /** Free-form for the ledger entry descriptions. */
  description: string
}

export interface SplitRevenueResult {
  /** True when the kill switch was ON for this split. */
  splitEnabled: boolean
  /** Resolved cost (unchanged from input). */
  costUsd: number
  /** Gross - cost, floored at 0. */
  netUsd: number
  /** What the operator should receive (cost + 0.5 * net when ON, full gross when OFF). */
  operatorTotalUsd: number
  /** 0.25 * net when ON, 0 when OFF. */
  stakingShareUsd: number
  /** 0.25 * net when ON, 0 when OFF. */
  treasuryShareUsd: number
  /** RevenueShareEntry.id of the audit row. */
  auditEntryId: string
  /** True iff this call landed a NEW audit row (false on idempotent retry). */
  firstWrite: boolean
}

export class RevenueSplitConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RevenueSplitConfigError'
  }
}

/**
 * Perform the 3-way split for a single revenue event.
 *
 * Throws RevenueSplitConfigError if the staking / treasury system
 * users haven't been seeded (run pnpm --filter @a2e/api seed:system-accounts).
 *
 * Safe to retry: a second call with the same referenceId returns the
 * existing audit row, never double-credits staking or treasury.
 */
export async function splitRevenue(
  prisma: PrismaClient,
  args: SplitRevenueArgs,
): Promise<SplitRevenueResult> {
  if (args.grossUsd < 0) {
    throw new Error(`splitRevenue: grossUsd must be >= 0, got ${args.grossUsd}`)
  }
  if (args.costUsd < 0) {
    throw new Error(`splitRevenue: costUsd must be >= 0, got ${args.costUsd}`)
  }

  // Idempotency check first — if we already split this referenceId,
  // return the existing record so a retry is a true no-op.
  const existing = await prisma.revenueShareEntry.findUnique({
    where: { referenceId: args.referenceId },
  })
  if (existing) {
    return {
      splitEnabled: existing.splitEnabled,
      costUsd: existing.costUsd,
      netUsd: existing.netUsd,
      operatorTotalUsd: existing.operatorTotalUsd,
      stakingShareUsd: existing.stakingShareUsd,
      treasuryShareUsd: existing.treasuryShareUsd,
      auditEntryId: existing.id,
      firstWrite: false,
    }
  }

  const enabled = isRevenueSplitEnabled()
  const netUsd = enabled ? Math.max(0, args.grossUsd - args.costUsd) : args.grossUsd
  const stakingShareUsd = enabled ? round4(netUsd * STAKING_SHARE_PCT) : 0
  const treasuryShareUsd = enabled ? round4(netUsd * TREASURY_SHARE_PCT) : 0
  const operatorTotalUsd = enabled
    ? round4(args.costUsd + netUsd * OPERATOR_PROFIT_PCT)
    : args.grossUsd

  // When OFF: only the audit row gets written, no ledger movement.
  // Operator caller (M0.3+) sees operatorTotalUsd = grossUsd and the
  // legacy single-credit behavior is preserved.
  if (!enabled) {
    const audit = await prisma.revenueShareEntry.create({
      data: {
        sourceTxType: args.sourceTxType,
        referenceId: args.referenceId,
        grossUsd: args.grossUsd,
        costUsd: args.costUsd,
        netUsd: enabled ? Math.max(0, args.grossUsd - args.costUsd) : 0,
        operatorTotalUsd,
        stakingShareUsd: 0,
        treasuryShareUsd: 0,
        operatorUserId: args.operatorUserId,
        splitEnabled: false,
      },
    })
    return {
      splitEnabled: false,
      costUsd: args.costUsd,
      netUsd: 0,
      operatorTotalUsd,
      stakingShareUsd: 0,
      treasuryShareUsd: 0,
      auditEntryId: audit.id,
      firstWrite: true,
    }
  }

  // Kill switch ON. Resolve the two virtual user IDs from env.
  const stakingUserId = process.env[STAKING_POOL_USER_ID_ENV]
  const treasuryUserId = process.env[TREASURY_USER_ID_ENV]
  if (!stakingUserId || !treasuryUserId) {
    throw new RevenueSplitConfigError(
      `Missing ${STAKING_POOL_USER_ID_ENV} or ${TREASURY_USER_ID_ENV} env. Run pnpm --filter @a2e/api seed:system-accounts to provision the virtual users and copy the printed IDs into Render env.`,
    )
  }

  const auditId = await prisma.$transaction(async (tx) => {
    if (stakingShareUsd > 0) {
      await creditSystemAccount(
        tx,
        stakingUserId,
        stakingShareUsd,
        'STAKING_POOL_SHARE',
        `${args.sourceTxType} 25% of net | ${args.description}`,
        args.referenceId,
      )
    }
    if (treasuryShareUsd > 0) {
      await creditSystemAccount(
        tx,
        treasuryUserId,
        treasuryShareUsd,
        'TREASURY_SHARE',
        `${args.sourceTxType} 25% of net | ${args.description}`,
        args.referenceId,
      )
    }
    const audit = await tx.revenueShareEntry.create({
      data: {
        sourceTxType: args.sourceTxType,
        referenceId: args.referenceId,
        grossUsd: args.grossUsd,
        costUsd: args.costUsd,
        netUsd,
        operatorTotalUsd,
        stakingShareUsd,
        treasuryShareUsd,
        operatorUserId: args.operatorUserId,
        splitEnabled: true,
      },
    })
    return audit.id
  })

  return {
    splitEnabled: true,
    costUsd: args.costUsd,
    netUsd,
    operatorTotalUsd,
    stakingShareUsd,
    treasuryShareUsd,
    auditEntryId: auditId,
    firstWrite: true,
  }
}

// Internal: credit a system account (staking / treasury) inside an
// existing prisma transaction. Mirrors creditBalance's body but
// without the standalone $transaction so the parent split call stays
// atomic across all four writes.
async function creditSystemAccount(
  tx: Prisma.TransactionClient,
  userId: string,
  amountUsd: number,
  type: 'STAKING_POOL_SHARE' | 'TREASURY_SHARE',
  description: string,
  referenceId: string,
): Promise<void> {
  await tx.buyerBalance.upsert({
    where: { userId },
    create: { userId },
    update: {},
  })
  const updated = await tx.buyerBalance.update({
    where: { userId },
    data: { balanceUsd: { increment: amountUsd } },
    select: { id: true, balanceUsd: true },
  })
  await tx.balanceTransaction.create({
    data: {
      balanceId: updated.id,
      type,
      amountUsd,
      description,
      referenceId,
      balanceAfter: updated.balanceUsd,
    },
  })
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}
