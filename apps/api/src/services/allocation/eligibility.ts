/**
 * M2 / B1: Auto-allocator eligibility rules.
 *
 * Decides whether a buyer's PENDING ComputeRequest can be auto-approved
 * and shipped to allocation, or whether it should be held in WAITLISTED
 * for an admin to look at first.
 *
 * Design intent: rules are intentionally simple, transparent, and
 * config-driven so the operator (Stack Merth) can tune thresholds without
 * code changes. The output is a list of flags; the worker uses the
 * presence of any HOLD flag to set status=WAITLISTED. The flags are also
 * persisted on ComputeRequest.eligibilityFlags so admins reading the
 * Needs Review queue see exactly why something was held.
 *
 * Rule taxonomy (current):
 *   - PASS_FAST_TRACK            : trusted buyer, request well within ceiling
 *   - PASS_NORMAL                : eligible, no special signals
 *   - HOLD_FIRST_TIME_OVER_CEILING : new buyer asking for a large request
 *   - HOLD_DAILY_SPEND_EXCEEDED  : would push buyer over per-day cap
 *   - HOLD_CONCURRENT_LIMIT       : already at maxConcurrentRentals
 *   - HOLD_UNVERIFIED_EMAIL       : email not verified yet
 *
 * The thresholds are env-tunable so we can dial them without redeploys
 * during the M2 ramp.
 */

import type { PrismaClient, ComputeRequest, User } from '@a2e/database'

// First-time buyer ceiling: any request with totalCost above this
// auto-holds for admin review if the buyer has zero successful rentals.
// Default $500 — high enough that 99% of test/sample workloads breeze
// through, low enough that "rent 16 H100s for 30 days" is gated.
const FIRST_TIME_CEILING_USD = parseFloat(process.env.ALLOCATOR_FIRST_TIME_CEILING_USD ?? '500')

// Buyers with this many successful rentals are considered "trusted" and
// skip the first-time ceiling check entirely.
const TRUSTED_RENTAL_COUNT = parseInt(process.env.ALLOCATOR_TRUSTED_RENTAL_COUNT ?? '3', 10)

export type EligibilityFlag =
  | 'PASS_FAST_TRACK'
  | 'PASS_NORMAL'
  | 'PASS_MANUAL_REVIEW' // admin released the hold; allocator bypasses HOLD_ rules
  | 'MANUAL_REVIEW_PASSED' // marker carried on the row so subsequent ticks see the bypass
  | 'HOLD_FIRST_TIME_OVER_CEILING'
  | 'HOLD_DAILY_SPEND_EXCEEDED'
  | 'HOLD_CONCURRENT_LIMIT'
  | 'HOLD_UNVERIFIED_EMAIL'
  // SECURITY (2026-06-11 third-round): the three forged-buyer rounds
  // (cpk-buyer2, cpk-b4, cpk-b4r) all shared two attributes: emailVerified
  // was false and successfulRentalCount was 0. Re-enabling these gates
  // is the verifiable backstop that doesn't depend on the payment
  // verifier (Solana mainnet keys are still pending) or on predicting
  // every new fake-domain pattern.
  | 'HOLD_UNVERIFIED_EMAIL_FIRST_RENTALS' // unverified email + < 3 successful rentals
  | 'HOLD_FIRST_RENTAL_NEEDS_ADMIN' // successfulRentalCount === 0; human reviews
  // Informational flags. The request is paid and approved; the
  // allocator is searching for capacity. NOT a hold — no admin
  // action is required. The next allocator tick re-probes 10s later.
  // SEARCHING_CAPACITY replaces the old WAITING_ON_CAPACITY (which
  // implied "admin needs to release this" but was never actually a
  // hold). Old rows may still carry WAITING_ON_CAPACITY; treat as
  // synonyms in any UI that renders these.
  | 'SEARCHING_CAPACITY'
  | 'WAITING_ON_CAPACITY' // legacy, kept for backward compat on historical rows
  | 'NO_REGION_CAPACITY'

export interface EligibilityVerdict {
  approved: boolean
  flags: EligibilityFlag[]
  reason: string
}

// Marker flag set by the admin Release Hold action. When present on the
// row's eligibilityFlags, evaluateEligibility short-circuits to approved
// so the allocator doesn't immediately re-hold the same request.
export const MANUAL_REVIEW_FLAG = 'MANUAL_REVIEW_PASSED' as const

/**
 * Evaluate a ComputeRequest against the buyer's profile.
 *
 * Returns a verdict the worker can act on. If approved=false, the worker
 * sets status=WAITLISTED with the flags persisted; admins approve from
 * the Needs Review queue.
 */
// Threshold below which the unverified-email gate fires. Env-tunable so
// we can dial back once we see false-positives on real buyers.
const UNVERIFIED_EMAIL_HOLD_BELOW_RENTAL_COUNT = parseInt(
  process.env.ALLOCATOR_UNVERIFIED_EMAIL_HOLD_BELOW ?? '3',
  10,
)

export async function evaluateEligibility(
  prisma: PrismaClient,
  request: Pick<ComputeRequest, 'id' | 'userId' | 'totalCost' | 'gpuCount' | 'gpuTier' | 'eligibilityFlags'>,
  user: Pick<User, 'id' | 'emailVerified' | 'maxConcurrentRentals' | 'maxDailySpendUsd' | 'successfulRentalCount'>,
): Promise<EligibilityVerdict> {
  // Short-circuit: admin already reviewed and released this from a hold.
  // Re-running the rules would just re-fire the same HOLD_ flags and
  // bounce the request back to WAITLISTED on the next tick. Admin
  // override wins; we still record the bypass in flags for audit.
  if (request.eligibilityFlags?.includes(MANUAL_REVIEW_FLAG)) {
    // Preserve the marker so subsequent ticks (including a capacity-
    // wait tick that overwrites flags) continue to recognize the
    // bypass. Without this, the marker would be lost next tick and
    // the request would re-hold.
    return {
      approved: true,
      flags: ['PASS_MANUAL_REVIEW', MANUAL_REVIEW_FLAG],
      reason: 'Bypassed: admin manually approved',
    }
  }

  const flags: EligibilityFlag[] = []

  // SECURITY (2026-06-11 third-round): re-enabling email-verification
  // as a gate, but scoped narrowly so it doesn't dead-end real buyers
  // the way the 2026-06-05 version did. Three forged-buyer rounds
  // (cpk-buyer2 06-10, cpk-b4 06-11 morning, cpk-b4r 06-11 afternoon)
  // ALL shared emailVerified=false + successfulRentalCount=0 + USDC
  // with auto-passed verification. The payment verifier can't be
  // trusted until Solana mainnet config lands (M1 deferred); these
  // identity gates are the verifiable backstop.

  // HOLD_FIRST_RENTAL_NEEDS_ADMIN: every brand-new buyer's first
  // rental goes to admin review. After they complete one, the flag
  // never fires again. Total friction for a real buyer = one admin
  // click on first rental, typically minutes. For an attacker = a
  // human looks at "cpk-b4r-1781190806@cpk-redteam.io" and rejects.
  if (user.successfulRentalCount === 0) {
    flags.push('HOLD_FIRST_RENTAL_NEEDS_ADMIN')
  }

  // HOLD_UNVERIFIED_EMAIL_FIRST_RENTALS: until the buyer has
  // completed N rentals (default 3), email must be verified. Catches
  // bots that bypass admin first-rental review somehow (compromised
  // admin, support social-engineering, etc.) by requiring inbox
  // control. Doesn't fire after N successful completions so trusted
  // buyers never re-hit the gate.
  if (
    !user.emailVerified &&
    user.successfulRentalCount < UNVERIFIED_EMAIL_HOLD_BELOW_RENTAL_COUNT
  ) {
    flags.push('HOLD_UNVERIFIED_EMAIL_FIRST_RENTALS')
  }

  // HOLD_UNVERIFIED_EMAIL (the original 2026-06-05 flag) is preserved
  // in the enum for audit-record compatibility but is no longer
  // pushed. Use HOLD_UNVERIFIED_EMAIL_FIRST_RENTALS for the new
  // narrower gate above.

  // Concurrent rentals: count active+allocated rentals already in flight
  // for this user. We exclude the request being evaluated so a re-check
  // on a held row doesn't count itself.
  const activeCount = await prisma.computeRequest.count({
    where: {
      userId: user.id,
      id: { not: request.id },
      status: { in: ['ALLOCATED', 'ACTIVE'] },
    },
  })
  if (activeCount >= user.maxConcurrentRentals) {
    flags.push('HOLD_CONCURRENT_LIMIT')
  }

  // Daily spend: sum totalCost of rentals started in the last 24h.
  // We take totalCost as a worst-case upper bound (rather than accruedCost)
  // because the buyer has committed that money even if they cancel early.
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const recent = await prisma.computeRequest.aggregate({
    where: {
      userId: user.id,
      id: { not: request.id },
      requestedAt: { gte: dayAgo },
      status: { in: ['ALLOCATED', 'ACTIVE', 'COMPLETED', 'WAITLISTED', 'PENDING'] },
    },
    _sum: { totalCost: true },
  })
  const recentSpend = recent._sum.totalCost ?? 0
  if (recentSpend + request.totalCost > user.maxDailySpendUsd) {
    flags.push('HOLD_DAILY_SPEND_EXCEEDED')
  }

  // First-time over ceiling: if the user has never completed a rental and
  // this request exceeds the ceiling, hold for admin review.
  const isTrusted = user.successfulRentalCount >= TRUSTED_RENTAL_COUNT
  if (!isTrusted && request.totalCost > FIRST_TIME_CEILING_USD) {
    flags.push('HOLD_FIRST_TIME_OVER_CEILING')
  }

  const holds = flags.filter(f => f.startsWith('HOLD_'))
  if (holds.length > 0) {
    return {
      approved: false,
      flags,
      reason: `Held: ${holds.join(', ')}`,
    }
  }

  // Approved. Tag fast-track if buyer is trusted, else normal.
  flags.push(isTrusted ? 'PASS_FAST_TRACK' : 'PASS_NORMAL')
  return {
    approved: true,
    flags,
    reason: isTrusted ? 'Fast-tracked: trusted buyer' : 'Approved: passed all eligibility checks',
  }
}
