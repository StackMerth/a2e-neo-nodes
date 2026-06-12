import type { PrismaClient, Node } from '@a2e/database'
import { calculateUptimeEarnings } from '../earnings/uptime-calculator'
import { roundUsd } from '@a2e/shared'

export interface SettlementCalculation {
  nodeId: string
  walletAddress: string
  amount: number
  uptimeHours: number
  periodStart: Date
  periodEnd: Date
  // Set when this calculation comes from a NodeRunner whose payoutMode
  // is SCHEDULED and whose scheduled date has passed. After the
  // settlement completes, the scheduler resets that operator back to
  // AUTO (see clearScheduledPayout below) so SCHEDULED is one-shot.
  nodeRunnerId?: string
  isScheduledFire?: boolean
  // Diagnostic — when set, the settlement was fired despite the
  // operator's hold preference (MANUAL/SCHEDULED) because a safety
  // net kicked in. Surfaced in the Settlement.adminNote for audit.
  forceReason?: 'BALANCE_CAP' | 'INACTIVITY'
}

// Safety nets enforced regardless of payoutMode. The cap protects the
// platform from holding unbounded operator balances; the inactivity
// sweep makes sure dormant accounts can't leave money rotting in the
// system forever. Both are env-tunable for ops flexibility.
const PLATFORM_BALANCE_CAP_USD = Number(process.env.PAYOUT_BALANCE_CAP_USD ?? 50000)
const INACTIVITY_SWEEP_DAYS = Number(process.env.PAYOUT_INACTIVITY_DAYS ?? 180)

// Cooling-off period — earnings sit in "pending" state for this many
// hours after they accrue, then become withdrawable. Gives the
// platform a short buyer-dispute window without making us legally
// custodial for long stretches. Default 2h balances "fast enough to
// feel snappy for operators" against "long enough to catch obvious
// dispute / fraud cases before funds leave the platform". Set
// PAYOUT_COOLDOWN_HOURS env to override (e.g. 12 for stricter holds,
// 0.01 for QA shortcuts).
const COOLDOWN_HOURS = Number(process.env.PAYOUT_COOLDOWN_HOURS ?? 2)

/** Returns the boundary timestamp: heartbeats older than this are "available". */
function cooldownBoundary(now: Date = new Date()): Date {
  return new Date(now.getTime() - COOLDOWN_HOURS * 60 * 60 * 1000)
}

/**
 * Calculate pending settlements based on UPTIME (not jobs).
 * Earnings = uptime hours × hourly rate for GPU tier
 *
 * Per-NodeRunner payoutMode drives whether each settlement fires now
 * or stays accumulating on the platform:
 *   - AUTO       — fire on every tick when above minimumPayout
 *   - MANUAL     — never fire on its own (operator clicks "Withdraw
 *                  now" to trigger an immediate settlement via the
 *                  portal)
 *   - SCHEDULED  — fire on/after payoutScheduledAt, then reset the
 *                  operator back to AUTO (one-shot)
 * Two safety nets bypass these gates: a $50K cap on platform-held
 * balance and 180-day inactivity since the last settlement. Both
 * force a payout regardless of mode and are tagged with forceReason
 * for the audit trail.
 */
export async function calculatePendingSettlements(
  prisma: PrismaClient,
  periodEnd: Date
): Promise<SettlementCalculation[]> {
  const config = await prisma.settlementConfig.findUnique({
    where: { id: 'default' },
  })

  const minimumPayout = config?.minimumPayout ?? 10

  // Cooling-off: never settle earnings still inside the dispute
  // window. Clamp the period end to (now - COOLDOWN_HOURS) so the
  // worker only acts on funds that have already crossed the boundary.
  const boundary = cooldownBoundary(periodEnd)
  const effectivePeriodEnd = boundary < periodEnd ? boundary : periodEnd

  const nodes = await prisma.node.findMany({
    select: {
      id: true,
      walletAddress: true,
      nodeRunnerId: true,
      nodeRunner: {
        select: {
          id: true,
          walletAddress: true,
          payoutMode: true,
          payoutScheduledAt: true,
          payoutLockUntil: true,
        },
      },
    },
  })

  const settlements: SettlementCalculation[] = []
  const inactivityMs = INACTIVITY_SWEEP_DAYS * 24 * 60 * 60 * 1000
  const now = periodEnd

  for (const node of nodes) {
    // Admin hard-hold. Skip outright while the lock is in the future,
    // regardless of mode or safety nets. Support team uses this during
    // buyer disputes / fraud investigations.
    if (node.nodeRunner?.payoutLockUntil && node.nodeRunner.payoutLockUntil > now) {
      continue
    }
    // Find last COMPLETED settlement to determine period start
    // NOTE: Only use COMPLETED to prevent stuck PENDING settlements from blocking new ones
    const lastSettlement = await prisma.settlement.findFirst({
      where: { nodeId: node.id, status: 'COMPLETED' },
      orderBy: { periodEnd: 'desc' },
    })

    // Period starts from last settlement end, or node creation, or 30 days ago
    let periodStart: Date
    if (lastSettlement?.periodEnd) {
      periodStart = lastSettlement.periodEnd
    } else {
      // For new nodes, start from 30 days ago or node creation
      const thirtyDaysAgo = new Date()
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
      periodStart = thirtyDaysAgo
    }

    // Skip if period is too short (less than 1 hour)
    if (effectivePeriodEnd.getTime() - periodStart.getTime() < 3600000) {
      continue
    }

    // Calculate uptime-based earnings — only up to the cooldown boundary
    const uptimeEarnings = await calculateUptimeEarnings(prisma, node.id, periodStart, effectivePeriodEnd)

    if (!uptimeEarnings || uptimeEarnings.earnings < minimumPayout) {
      continue
    }

    // SECURITY (B1, 2026-06-11 fifth-round): orphan nodes (nodes with
    // no NodeRunner relation) DEFAULT TO DENY now, not AUTO. Previous
    // behavior was the structural primitive of the B1 fake-node uptime
    // drain: register a node with an attacker-controlled walletAddress
    // and no NodeRunner -> orphan auto-pays uptime earnings on-chain
    // to the attacker. With deny-by-default, an orphan node accrues
    // earnings on the ledger but the scheduler never disburses them;
    // an admin must explicitly link the node to a NodeRunner (proving
    // operator identity / wallet ownership) before payout can fire.
    const runner = node.nodeRunner
    if (!runner) {
      // Skip orphan nodes entirely. They never get a settlement row
      // until an admin links them. This is the structural close to
      // B1: register-fake-node -> auto-payout is no longer a chain
      // because step 4 (auto-payout) never fires for orphans.
      continue
    }
    const mode = runner.payoutMode ?? 'MANUAL'
    const scheduledAt = runner.payoutScheduledAt ?? null

    const isOverCap = uptimeEarnings.earnings >= PLATFORM_BALANCE_CAP_USD
    const isInactive = effectivePeriodEnd.getTime() - periodStart.getTime() > inactivityMs
    const forceReason: SettlementCalculation['forceReason'] = isOverCap
      ? 'BALANCE_CAP'
      : isInactive
        ? 'INACTIVITY'
        : undefined

    let isScheduledFire = false
    if (!forceReason) {
      if (mode === 'MANUAL') {
        // Operator is holding the balance on purpose. Skip this tick.
        continue
      }
      if (mode === 'SCHEDULED') {
        // SCHEDULED with no date is treated like MANUAL — operator may
        // be midway through configuring it. Don't fire until they pick.
        if (!scheduledAt) continue
        if (effectivePeriodEnd.getTime() < scheduledAt.getTime()) continue
        isScheduledFire = true
      }
    }

    // SECURITY (audit follow-up to B1 layer 2, 2026-06-12 sixth-round
    // post-commit audit): use the operator's CURRENT NodeRunner.
    // walletAddress as the payout destination, NOT node.walletAddress.
    // The old behavior paid whatever wallet was stamped on the Node at
    // registration time, which meant:
    //   (a) An operator who changed their payout wallet in /settings
    //       expecting future payouts to redirect would silently
    //       continue to receive at the OLD wallet (fund-misdirection
    //       bug visible to the operator).
    //   (b) The B1 layer 2 wallet-ownership signature gate on
    //       NodeRunner.walletAddress was security-theater for payout
    //       redirection because the actual destination wasn't that
    //       field. Now it is, so the sig gate prevents payout hijack
    //       as the threat model intends.
    // We branch B1 L1 orphan-skip already; this code path always has
    // a non-null runner. node.walletAddress retained as fallback for
    // historical rows where the join might be missing.
    const payoutWallet = runner.walletAddress || node.walletAddress
    settlements.push({
      nodeId: node.id,
      walletAddress: payoutWallet,
      amount: uptimeEarnings.earnings,
      uptimeHours: uptimeEarnings.uptimeHours,
      periodStart,
      periodEnd: effectivePeriodEnd,
      nodeRunnerId: runner.id,
      isScheduledFire,
      forceReason,
    })
  }

  return settlements
}

/**
 * Called by the scheduler after a SCHEDULED-mode settlement completes
 * successfully. Resets the operator back to AUTO and clears the
 * scheduled date so the mode is a one-shot — operators have to
 * explicitly opt back into SCHEDULED for the next cycle.
 */
export async function clearScheduledPayout(
  prisma: PrismaClient,
  nodeRunnerId: string
): Promise<void> {
  await prisma.nodeRunner.update({
    where: { id: nodeRunnerId },
    data: {
      payoutMode: 'AUTO',
      payoutScheduledAt: null,
    },
  })
}

export interface OperatorBalanceBreakdown {
  /** Sum of earnings already past the cooling-off window, minus internal spend. Withdrawable. */
  available: number
  /** Sum of earnings still within the cooling-off window. Visible but locked. */
  pending: number
  /** When the earliest pending dollar unlocks. Null if no pending balance. */
  nextUnlockAt: string | null
  /** Configured cool-down so the UI can show the window length. */
  cooldownHours: number
  /** Lifetime sum of InternalSpend rows for this operator. Already subtracted from `available`. */
  spent: number
}

/**
 * Returns the split of available vs pending balance for an operator,
 * plus the next unlock timestamp. The dashboard renders this directly.
 */
export async function getOperatorBalanceBreakdown(
  prisma: PrismaClient,
  nodeRunnerId: string
): Promise<OperatorBalanceBreakdown> {
  const now = new Date()
  const boundary = cooldownBoundary(now)

  const [nodes, spendAgg] = await Promise.all([
    prisma.node.findMany({
      where: { nodeRunnerId },
      select: { id: true },
    }),
    prisma.internalSpend.aggregate({
      where: { nodeRunnerId },
      _sum: { amount: true },
    }),
  ])
  const spent = spendAgg._sum.amount ?? 0
  if (nodes.length === 0) {
    // Even with no nodes, an operator can carry a positive spend
    // ledger from a prior life. Surface it so the UI is consistent.
    return { available: 0, pending: 0, nextUnlockAt: null, cooldownHours: COOLDOWN_HOURS, spent }
  }

  let available = 0
  let pending = 0
  let earliestUnlock: Date | null = null

  for (const node of nodes) {
    const lastSettlement = await prisma.settlement.findFirst({
      where: { nodeId: node.id, status: 'COMPLETED' },
      orderBy: { periodEnd: 'desc' },
    })
    const periodStart =
      lastSettlement?.periodEnd ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

    // Available portion: any uptime that happened before the cooldown
    // boundary. Only compute if there's at least an hour of available
    // window to avoid noise.
    if (boundary.getTime() > periodStart.getTime() + 3600000) {
      const availableUptime = await calculateUptimeEarnings(prisma, node.id, periodStart, boundary)
      if (availableUptime?.earnings) available += availableUptime.earnings
    }

    // Pending portion: uptime since the cooldown boundary. The next
    // unlock is the earliest heartbeat in that window + COOLDOWN_HOURS.
    const pendingStart = boundary.getTime() > periodStart.getTime() ? boundary : periodStart
    if (now.getTime() > pendingStart.getTime() + 60_000) {
      const pendingUptime = await calculateUptimeEarnings(prisma, node.id, pendingStart, now)
      if (pendingUptime?.earnings) {
        pending += pendingUptime.earnings
        const firstHeartbeat = await prisma.heartbeat.findFirst({
          where: { nodeId: node.id, timestamp: { gte: pendingStart, lte: now } },
          orderBy: { timestamp: 'asc' },
          select: { timestamp: true },
        })
        if (firstHeartbeat) {
          const unlockAt = new Date(firstHeartbeat.timestamp.getTime() + COOLDOWN_HOURS * 60 * 60 * 1000)
          if (!earliestUnlock || unlockAt < earliestUnlock) earliestUnlock = unlockAt
        }
      }
    }
  }

  // Subtract lifetime internal-spend from the available pool. This
  // is the only line in the engine that distinguishes "earnings"
  // from "withdrawable balance" — everything else (settlements,
  // cooldown, payout-mode) treats the two as the same number. We
  // clamp at zero so a stale settlement that hasn't been clawed
  // back can't show a negative balance to the user.
  const withdrawable = Math.max(0, available - spent)

  return {
    available: withdrawable,
    pending,
    nextUnlockAt: earliestUnlock?.toISOString() ?? null,
    cooldownHours: COOLDOWN_HOURS,
    spent,
  }
}

/**
 * Compute the WITHDRAWABLE platform balance for an operator — sum of
 * earnings past the cooling-off window. Pending balance is excluded
 * by design; this is the amount "Withdraw now" can move.
 */
export async function getOperatorPlatformBalance(
  prisma: PrismaClient,
  nodeRunnerId: string
): Promise<number> {
  const breakdown = await getOperatorBalanceBreakdown(prisma, nodeRunnerId)
  return breakdown.available
}

/**
 * Build per-node settlement calculations for ONE operator regardless
 * of their payoutMode. This is the engine behind the "Withdraw now"
 * button: even if the operator is on MANUAL or SCHEDULED hold, they
 * can still force an immediate payout — BUT only against the portion
 * past the cooldown window. Pending earnings stay locked.
 */
export async function calculateOperatorSettlements(
  prisma: PrismaClient,
  nodeRunnerId: string,
  periodEnd: Date,
  minimumPayout: number = 0
): Promise<SettlementCalculation[]> {
  // Clamp periodEnd to the cooldown boundary so we never try to
  // settle earnings still inside the cooling-off window.
  const boundary = cooldownBoundary(periodEnd)
  const effectivePeriodEnd = boundary < periodEnd ? boundary : periodEnd

  // Pull the operator's current payout wallet alongside the node list
  // so the settlement targets the wallet the operator currently has
  // set in /settings, not whatever was stamped on each Node at
  // registration time (see settlement-engine-uses-runner-wallet audit
  // note in calculatePendingSettlements above).
  const runner = await prisma.nodeRunner.findUnique({
    where: { id: nodeRunnerId },
    select: { walletAddress: true },
  })
  if (!runner) return []

  const nodes = await prisma.node.findMany({
    where: { nodeRunnerId },
    select: { id: true, walletAddress: true },
  })

  const out: SettlementCalculation[] = []
  for (const node of nodes) {
    const lastSettlement = await prisma.settlement.findFirst({
      where: { nodeId: node.id, status: 'COMPLETED' },
      orderBy: { periodEnd: 'desc' },
    })
    const periodStart =
      lastSettlement?.periodEnd ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    if (effectivePeriodEnd.getTime() - periodStart.getTime() < 3600000) continue

    const uptime = await calculateUptimeEarnings(prisma, node.id, periodStart, effectivePeriodEnd)
    if (!uptime || uptime.earnings < minimumPayout) continue

    out.push({
      nodeId: node.id,
      walletAddress: runner.walletAddress || node.walletAddress,
      amount: uptime.earnings,
      uptimeHours: uptime.uptimeHours,
      periodStart,
      periodEnd: effectivePeriodEnd,
      nodeRunnerId,
    })
  }
  return out
}

export async function createSettlement(
  prisma: PrismaClient,
  calculation: SettlementCalculation
): Promise<string> {
  // SECURITY (pen-test 2026-06-09/10 finding B-5): round to cents so
  // every Settlement row's amount is exact-to-cent on persist. Combined
  // with roundUsd at credit/debit, the ledger trail stays free of
  // IEEE 754 drift through the full payout cycle.
  const settlement = await prisma.settlement.create({
    data: {
      nodeId: calculation.nodeId,
      walletAddress: calculation.walletAddress,
      amount: roundUsd(calculation.amount),
      jobCount: 0, // Uptime-based, not job-based
      periodStart: calculation.periodStart,
      periodEnd: calculation.periodEnd,
      status: 'PENDING',
    },
  })

  return settlement.id
}

/**
 * SECURITY (2026-06-11 fourth-round follow-up audit): switched from a
 * plain status update to an atomic claim. Previously this was used as
 * a "I'm taking over this settlement" marker but callers checked
 * status === 'PENDING' separately (non-atomic read). N concurrent
 * scheduler ticks / HTTP requests all passed the check and all
 * called processPayment for the same settlement, generating N
 * treasury transfers. Same TOCTOU shape that drained $65.50 via the
 * terminate route. Mirrors the cancel-route claim pattern.
 *
 * Returns true if the caller successfully claimed the settlement
 * (status flipped PENDING -> PROCESSING) and SHOULD proceed with
 * processPayment. Returns false if the settlement was already
 * claimed by someone else; caller MUST skip the payment.
 */
export async function markSettlementProcessing(
  prisma: PrismaClient,
  settlementId: string
): Promise<boolean> {
  const result = await prisma.settlement.updateMany({
    where: { id: settlementId, status: 'PENDING' },
    data: { status: 'PROCESSING' },
  })
  return result.count > 0
}

export async function markSettlementCompleted(
  prisma: PrismaClient,
  settlementId: string,
  txHash: string
): Promise<void> {
  // SECURITY (pen-test 2026-06-09 finding B-4): previously this update
  // ran in isolation, marking status=COMPLETED with txConfirmed=false
  // and never scheduling a follow-up verification. The reconciler only
  // operates on PendingReconciliation rows, so a completed settlement
  // with txConfirmed=false sat forever in a "trust me, the chain
  // confirmed" state. Combined with finding B-3 (no watchdog demotion)
  // this gave the auto-payout path a permanent unverified blob.
  //
  // Fix: do both writes in a single transaction so every "completed"
  // settlement gets a PendingReconciliation row that the reconciler
  // job will verify on-chain within the backoff window. If the chain
  // never confirms, the row eventually flips to NOT_FOUND/FAILED,
  // which the B-3 watchdog (settlement-reconciliation-watchdog.ts)
  // reads to demote the settlement back to FAILED.
  //
  // Settlement.amount is Decimal; convert to Number for the reconciler
  // row's expectedAmount comparison (consistent with other Decimal->
  // Number conversions elsewhere in this service).
  await prisma.$transaction(async (tx) => {
    const settlement = await tx.settlement.update({
      where: { id: settlementId },
      data: {
        status: 'COMPLETED',
        txHash,
        txConfirmed: false,
        processedAt: new Date(),
      },
      select: { amount: true, walletAddress: true },
    })

    await tx.pendingReconciliation.create({
      data: {
        txHash,
        settlementId,
        paymentId: null,
        expectedAmount: Number(settlement.amount),
        recipientAddress: settlement.walletAddress,
        status: 'PENDING',
      },
    }).catch(() => {
      // Tolerate unique-constraint races (same txHash retried by an
      // operator-manual /complete). The existing PendingReconciliation
      // row already covers verification, so swallowing the error here
      // is safe and idempotent.
    })
  })
}

export async function markSettlementFailed(
  prisma: PrismaClient,
  settlementId: string,
  errorMessage: string
): Promise<void> {
  await prisma.settlement.update({
    where: { id: settlementId },
    data: {
      status: 'FAILED',
      errorMessage,
      processedAt: new Date(),
    },
  })
}

export async function confirmSettlementTransaction(
  prisma: PrismaClient,
  settlementId: string
): Promise<void> {
  await prisma.settlement.update({
    where: { id: settlementId },
    data: { txConfirmed: true },
  })
}

export async function getSettlementConfig(prisma: PrismaClient) {
  let config = await prisma.settlementConfig.findUnique({
    where: { id: 'default' },
  })

  if (!config) {
    config = await prisma.settlementConfig.create({
      data: {
        id: 'default',
        period: 'WEEKLY',
        minimumPayout: 10,
        dayOfWeek: 1,
      },
    })
  }

  return config
}

export async function updateSettlementConfig(
  prisma: PrismaClient,
  updates: {
    period?: string
    minimumPayout?: number
    dayOfWeek?: number
    dayOfMonth?: number
    hour?: number
    autoSchedule?: boolean
    solanaRpcUrl?: string
    payerPrivateKey?: string
    usdcMint?: string
  }
): Promise<void> {
  await prisma.settlementConfig.upsert({
    where: { id: 'default' },
    update: updates,
    create: {
      id: 'default',
      ...updates,
    },
  })
}
