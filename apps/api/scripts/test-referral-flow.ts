/**
 * One-shot referral round-trip test helper.
 *
 * Wires the full M5.7 flow for a single referrer in 5 seconds:
 *   1. Find the referrer's NodeRunner via their email
 *   2. Pick `seed-bronze-runner` as the referee (it has plenty of
 *      completed jobs, so the math is interesting)
 *   3. Create a Referral row from referrer -> referee (if one doesn't
 *      exist; idempotent on re-run)
 *   4. Seed a synthetic Earning row for the referee dated 1 minute
 *      AFTER the Referral.createdAt so the worker sees it as
 *      in-window earnings
 *   5. Run runReferralCommissionTick to accrue the 10% commission
 *   6. Print the resulting Referral row so you can confirm the math
 *
 * Usage:
 *   pnpm --filter @a2e/api referrals:test-flow <referrer-email>
 *
 * Example:
 *   pnpm --filter @a2e/api referrals:test-flow asad@m.com
 *
 * Output (success):
 *   Created Referral for <referrer> -> seed-bronze-runner
 *   Seeded $100.00 earning for seed-bronze-runner
 *   Ran commission worker.
 *   Commission accrued: $10.00
 *
 * Safe to re-run; uses upserts and skips creating duplicate rows.
 */
import { prisma } from '@a2e/database'
import { runReferralCommissionTick } from '../src/jobs/referral-commission'
import { ensureReferralCode } from '../src/services/referral/code'

const SYNTHETIC_EARNING_USD = 100.0
const REFEREE_SLUG = 'seed-bronze-runner'

async function main() {
  const referrerEmail = process.argv[2]
  if (!referrerEmail) {
    console.error('Usage: pnpm --filter @a2e/api referrals:test-flow <referrer-email>')
    process.exit(1)
  }

  // 1. Find or create the referrer's NodeRunner via the User row.
  const user = await prisma.user.findUnique({ where: { email: referrerEmail } })
  if (!user) {
    console.error(`No user found with email ${referrerEmail}`)
    process.exit(1)
  }
  let referrer = await prisma.nodeRunner.findUnique({ where: { userId: user.id } })
  if (!referrer) {
    referrer = await prisma.nodeRunner.create({
      data: {
        name: user.email?.split('@')[0] ?? 'Node Runner',
        email: user.email,
        walletAddress: user.walletAddress ?? `pending-${user.id}`,
        userId: user.id,
      },
    })
    console.log(`Auto-created NodeRunner for ${referrerEmail}`)
  }
  const referrerCode = await ensureReferralCode(prisma, referrer.id)
  console.log(`Referrer: ${referrer.name} (${referrer.id}), code ${referrerCode}`)

  // 2. Find the referee.
  const referee = await prisma.nodeRunner.findUnique({ where: { slug: REFEREE_SLUG } })
  if (!referee) {
    console.error(`Referee NodeRunner with slug "${REFEREE_SLUG}" not found. Seed data missing.`)
    process.exit(1)
  }
  if (referee.id === referrer.id) {
    console.error('Referrer and referee are the same NodeRunner; pick a different referrer email.')
    process.exit(1)
  }
  console.log(`Referee:  ${referee.name} (${referee.id})`)

  // 3. Create or fetch the Referral row.
  const existing = await prisma.referral.findUnique({
    where: { refereeNodeRunnerId: referee.id },
  })
  let referral = existing
  if (!referral) {
    referral = await prisma.referral.create({
      data: {
        code: referrerCode,
        referrerNodeRunnerId: referrer.id,
        refereeNodeRunnerId: referee.id,
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 365 * 86400000),
      },
    })
    console.log(`Created Referral ${referral.id}`)
  } else if (existing && existing.referrerNodeRunnerId !== referrer.id) {
    console.error(
      `Referee ${REFEREE_SLUG} is already attributed to a different referrer (${existing.referrerNodeRunnerId}). Aborting to avoid corrupting test data.`,
    )
    process.exit(1)
  } else {
    console.log(`Existing Referral ${referral.id} reused`)
  }

  // 4. Seed a synthetic earning for the referee dated AFTER the
  //    Referral's lastSettledAt (or createdAt if never settled). We
  //    pick the referee's first node and book $SYNTHETIC_EARNING_USD
  //    against it. The worker sums earnings whose `date` is in the
  //    open window since the last settle.
  const refereeNode = await prisma.node.findFirst({
    where: { nodeRunnerId: referee.id },
  })
  if (!refereeNode) {
    console.error(`Referee ${REFEREE_SLUG} has no nodes; cannot seed an Earning row.`)
    process.exit(1)
  }
  const earningDate = new Date(
    (referral.lastSettledAt ?? referral.createdAt).getTime() + 60_000,
  )
  await prisma.earning.upsert({
    where: {
      nodeId_date_market: {
        nodeId: refereeNode.id,
        date: earningDate,
        market: 'INTERNAL',
      },
    },
    create: {
      nodeId: refereeNode.id,
      date: earningDate,
      market: 'INTERNAL',
      gpuSeconds: 3600,
      earnings: SYNTHETIC_EARNING_USD,
      jobCount: 1,
    },
    update: {
      earnings: SYNTHETIC_EARNING_USD,
    },
  })
  console.log(`Seeded $${SYNTHETIC_EARNING_USD.toFixed(2)} earning for ${REFEREE_SLUG} dated ${earningDate.toISOString()}`)

  // 5. Run the worker.
  console.log('\nRunning commission worker...')
  await runReferralCommissionTick(prisma)

  // 6. Print resulting commission.
  const after = await prisma.referral.findUnique({ where: { id: referral.id } })
  console.log(`\nFinal totalCommissionAccrued: $${(after?.totalCommissionAccrued ?? 0).toFixed(2)}`)
  console.log(`Expected: $${(SYNTHETIC_EARNING_USD * 0.10).toFixed(2)} (10% of $${SYNTHETIC_EARNING_USD.toFixed(2)})`)
}

main()
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
