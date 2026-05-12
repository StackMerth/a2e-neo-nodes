/**
 * Manual trigger for the M5.7 referral commission worker.
 *
 * Runs the same logic the daily worker runs, but on-demand. Useful for:
 *
 *   - Verifying the full referral round trip during dev without
 *     waiting 24h for the next tick.
 *   - Testing referral attribution after seeding a fake referee.
 *   - Backfilling commission after editing REFERRAL_COMMISSION_PCT
 *     or REFERRAL_WINDOW_DAYS env vars.
 *
 * Usage:
 *   pnpm --filter @a2e/api referrals:recompute
 *
 * Prints the worker's own log line plus a short before/after summary so
 * you can confirm the totals moved without querying the DB.
 */
import { prisma } from '@a2e/database'
import { runReferralCommissionTick } from '../src/jobs/referral-commission'

async function main() {
  const before = await prisma.referral.aggregate({
    _count: { _all: true },
    _sum: { totalCommissionAccrued: true },
  })
  const beforeTotal = before._sum.totalCommissionAccrued ?? 0
  console.log(
    `Before: ${before._count._all} referral row(s), $${beforeTotal.toFixed(2)} total accrued\n`,
  )

  await runReferralCommissionTick(prisma)

  const after = await prisma.referral.aggregate({
    _count: { _all: true },
    _sum: { totalCommissionAccrued: true },
  })
  const afterTotal = after._sum.totalCommissionAccrued ?? 0
  const delta = afterTotal - beforeTotal
  console.log(
    `\nAfter:  ${after._count._all} referral row(s), $${afterTotal.toFixed(2)} total accrued ` +
      `(delta $${delta.toFixed(2)})`,
  )
}

main()
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
