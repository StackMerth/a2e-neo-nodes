/**
 * One-off backfill: credit buyers whose PENDING ComputeRequest was
 * cancelled before the cancel route learned to refund (commit 59848ba
 * shipped only the copy fix; refund wiring lands in the next commit).
 *
 * For every ComputeRequest with status=CANCELLED where there is NOT a
 * matching REFUND_RENTAL BalanceTransaction with referenceId
 * `cancel:<id>`, this script:
 *   - Credits the buyer's balance for the full totalCost
 *   - Tags the credit with referenceId=cancel:<id> so the new cancel
 *     route's idempotency guard sees it and doesn't double-credit
 *
 * Safe to run multiple times: the (type, referenceId) unique constraint
 * on BalanceTransaction is the deduplication primitive.
 *
 * Render API shell:
 *   pnpm --filter @a2e/api exec tsx scripts/backfill-cancel-refund.ts
 *
 * Add `--dry-run` to preview without writing anything.
 */

import { PrismaClient } from '@a2e/database'
import { creditBalance } from '../src/services/balance/balance-service.js'

async function main(): Promise<void> {
  const prisma = new PrismaClient()
  const dryRun = process.argv.includes('--dry-run')

  const cancelled = await prisma.computeRequest.findMany({
    where: { status: 'CANCELLED' },
    select: {
      id: true,
      userId: true,
      gpuTier: true,
      gpuCount: true,
      totalCost: true,
      paymentSource: true,
    },
  })

  console.log(`Found ${cancelled.length} CANCELLED ComputeRequest row(s).`)

  let credited = 0
  let skipped = 0
  let failed = 0

  for (const cr of cancelled) {
    if (cr.totalCost <= 0) {
      skipped++
      continue
    }
    if (cr.paymentSource === 'INTERNAL_BALANCE') {
      // Internal-balance path doesn't credit; it just unwinds the
      // InternalSpend row. Not in scope for this backfill.
      skipped++
      continue
    }
    const existing = await prisma.balanceTransaction.findFirst({
      where: { type: 'REFUND_RENTAL', referenceId: `cancel:${cr.id}` },
      select: { id: true },
    })
    if (existing) {
      console.log(`  ${cr.id} (${cr.gpuCount}x ${cr.gpuTier}, $${cr.totalCost}) already refunded — skip`)
      skipped++
      continue
    }

    if (dryRun) {
      console.log(`  WOULD CREDIT user ${cr.userId} $${cr.totalCost} for ${cr.id} (${cr.gpuCount}x ${cr.gpuTier})`)
      credited++
      continue
    }

    try {
      await creditBalance(prisma, {
        userId: cr.userId,
        amountUsd: cr.totalCost,
        type: 'REFUND_RENTAL',
        description: `Refund for cancelled ${cr.gpuCount}x ${cr.gpuTier} rental (backfill)`,
        referenceId: `cancel:${cr.id}`,
      })
      console.log(`  CREDITED user ${cr.userId} $${cr.totalCost} for ${cr.id}`)
      credited++
    } catch (err) {
      console.error(`  FAILED ${cr.id}:`, err instanceof Error ? err.message : err)
      failed++
    }
  }

  console.log()
  console.log(`Done. credited=${credited} skipped=${skipped} failed=${failed}${dryRun ? ' (dry-run)' : ''}`)
  await prisma.$disconnect()
}

main().catch((err) => {
  console.error('backfill failed:', err)
  process.exit(1)
})
