/**
 * Reissue refunds that previously SKIPPED_NO_WALLET.
 *
 * When a buyer terminates a rental before their wallet address is
 * linked, buyer-compute.ts records the termination as COMPLETED with
 * adminNote like "Buyer terminated. Refund status: SKIPPED_NO_WALLET"
 * but never moves the money — the refundable portion sits with the
 * platform.
 *
 * This script finds those orphaned refunds and re-issues them as
 * buyer-balance credits (REFUND_RENTAL ledger type). Credit over
 * on-chain send because:
 *   - no gas / no second Solana hop
 *   - the buyer typically tops up their balance to rent more compute
 *     anyway, so a balance credit is what they'd convert to next
 *   - on-chain failures still possible if the wallet address is
 *     malformed; balance credit is purely DB-internal and atomic
 *
 * Usage on Render API shell:
 *   pnpm --filter @a2e/api exec tsx scripts/reissue-skipped-refunds.ts --email upsumeguy@gmail.com --dry
 *     -> list candidates only, show what would be refunded
 *
 *   pnpm --filter @a2e/api exec tsx scripts/reissue-skipped-refunds.ts --email upsumeguy@gmail.com --apply
 *     -> actually credit. Idempotent via REFUND_RENTAL referenceId
 *        = ComputeRequest.id, so re-running is safe.
 *
 * If --email is omitted, the script processes ALL users with at
 * least one SKIPPED_NO_WALLET rental.
 */

import { prisma } from '@a2e/database'
import { creditBalance } from '../src/services/balance/balance-service'

const SKIPPED_MARKER = 'SKIPPED_NO_WALLET'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry') || !args.includes('--apply')
  const emailFlagIdx = args.indexOf('--email')
  const email =
    emailFlagIdx >= 0 && args[emailFlagIdx + 1]
      ? args[emailFlagIdx + 1]
      : null

  if (dryRun) {
    console.log('=== DRY RUN — no balance credits will be issued ===')
    console.log('Run with --apply to actually credit.\n')
  } else {
    console.log('=== APPLY MODE — issuing balance credits ===\n')
  }

  // Find candidate ComputeRequests. Filter to COMPLETED + adminNote
  // contains SKIPPED_NO_WALLET. Scope to one user if --email was set.
  const where = {
    status: 'COMPLETED' as const,
    adminNote: { contains: SKIPPED_MARKER },
    ...(email ? { user: { email } } : {}),
  }

  const candidates = await prisma.computeRequest.findMany({
    where,
    select: {
      id: true,
      userId: true,
      totalCost: true,
      accruedCost: true,
      minutesUsed: true,
      tier: true,
      paymentSource: true,
      completedAt: true,
      adminNote: true,
      user: {
        select: {
          email: true,
          walletAddress: true,
        },
      },
    },
    orderBy: { completedAt: 'desc' },
  })

  if (candidates.length === 0) {
    console.log(
      email
        ? `No SKIPPED_NO_WALLET rentals found for ${email}.`
        : 'No SKIPPED_NO_WALLET rentals found across all users.',
    )
    return
  }

  console.log(`Found ${candidates.length} SKIPPED_NO_WALLET rentals:`)
  console.log()

  let totalRefundable = 0
  const toCredit: Array<{
    requestId: string
    userId: string
    email: string | null
    refundAmount: number
  }> = []

  for (const cr of candidates) {
    const refundAmount = Math.max(
      0,
      Number((cr.totalCost - cr.accruedCost).toFixed(4)),
    )
    const completedAtIso = cr.completedAt?.toISOString().slice(0, 10) ?? 'n/a'
    console.log(
      `  ${cr.id.slice(0, 18).padEnd(20)} ${(cr.user.email ?? '(no email)').padEnd(30)} ` +
      `total=$${cr.totalCost.toFixed(2)} accrued=$${cr.accruedCost.toFixed(2)} ` +
      `refund=$${refundAmount.toFixed(2)} (${completedAtIso})`,
    )

    if (refundAmount <= 0) continue
    totalRefundable += refundAmount
    toCredit.push({
      requestId: cr.id,
      userId: cr.userId,
      email: cr.user.email,
      refundAmount,
    })
  }

  console.log()
  console.log(`Total refundable: $${totalRefundable.toFixed(2)} across ${toCredit.length} rentals`)
  console.log()

  if (dryRun) {
    console.log('=== DRY RUN COMPLETE — pass --apply to issue credits ===')
    return
  }

  if (toCredit.length === 0) {
    console.log('Nothing to credit (all candidates had refund=$0).')
    return
  }

  let succeeded = 0
  let alreadyCredited = 0
  let failed = 0

  for (const item of toCredit) {
    try {
      // Idempotent: creditBalance throws DuplicateTransactionError if
      // (type=REFUND_RENTAL, referenceId=ComputeRequest.id) already
      // exists in the ledger. Safe to re-run the script.
      await creditBalance(prisma, {
        userId: item.userId,
        amountUsd: item.refundAmount,
        type: 'REFUND_RENTAL',
        description: `Refund for terminated rental ${item.requestId.slice(0, 8)} (reissued via script — original SKIPPED_NO_WALLET)`,
        referenceId: item.requestId,
      })

      // Update adminNote so the rental's audit trail records the
      // reissue. Read-modify-write but the field is plain text so we
      // can append safely.
      const existing = await prisma.computeRequest.findUnique({
        where: { id: item.requestId },
        select: { adminNote: true },
      })
      const ts = new Date().toISOString()
      const appended = `${existing?.adminNote ?? ''} | Refund $${item.refundAmount.toFixed(2)} reissued as REFUND_RENTAL balance credit at ${ts}.`
      await prisma.computeRequest.update({
        where: { id: item.requestId },
        data: { adminNote: appended.trim() },
      })

      console.log(
        `  ✓ Credited $${item.refundAmount.toFixed(2)} to ${item.email ?? item.userId} for ${item.requestId.slice(0, 12)}`,
      )
      succeeded++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('duplicate') || msg.includes('Duplicate')) {
        console.log(
          `  ⚠ Already credited for ${item.requestId.slice(0, 12)} (skipping)`,
        )
        alreadyCredited++
      } else {
        console.log(
          `  ✗ FAILED for ${item.requestId.slice(0, 12)}: ${msg}`,
        )
        failed++
      }
    }
  }

  console.log()
  console.log('=== APPLY COMPLETE ===')
  console.log(`  succeeded:        ${succeeded}`)
  console.log(`  already credited: ${alreadyCredited}`)
  console.log(`  failed:           ${failed}`)
  console.log()
  console.log('Affected buyers can refresh /buyer/balance to see the credited amount.')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
