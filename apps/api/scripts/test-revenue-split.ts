/**
 * Track 5 / M0.2 — splitRevenue self-test.
 *
 * Exercises both kill-switch modes against a real Postgres connection
 * and prints the result. Idempotent: each test uses a unique
 * referenceId derived from `Date.now()` so re-runs don't collide.
 *
 * Run:
 *   pnpm --filter @a2e/api test:revenue-split
 *     -> kill switch OFF (default), single test
 *   REVENUE_SPLIT_ENABLED=true pnpm --filter @a2e/api test:revenue-split
 *     -> kill switch ON, runs $9560 / $5240 worked example end to end
 *        and asserts the resulting BalanceTransaction rows match
 *        50/25/25 of net within rounding
 *
 * Worked example (Model C decision, 2026-05-29):
 *   gross  = $9560
 *   cost   = $5240
 *   net    = $4320
 *   operator total = $5240 + 0.5 * $4320 = $7400
 *   staking share  = 0.25 * $4320        = $1080
 *   treasury share = 0.25 * $4320        = $1080
 *   sum = $9560 ✓
 *
 * Cleanup: deletes the BalanceTransaction credits and the
 * RevenueShareEntry it created after asserting, so the test doesn't
 * pollute the staking / treasury balances. Test uses a synthetic
 * referenceId prefix `revenue-split-test-` so cleanup is precise.
 */
import { prisma } from '@a2e/database'
import {
  splitRevenue,
  isRevenueSplitEnabled,
} from '../src/services/revenue/split.js'

const TEST_REF_PREFIX = 'revenue-split-test-'

async function findOperatorUserId(): Promise<string> {
  // Use the first NodeRunner's userId so the audit row points at a
  // real operator. Falls back to the first user if no NodeRunner
  // exists, which is fine for a unit-style smoke test on an empty DB.
  const nr = await prisma.nodeRunner.findFirst({
    select: { userId: true },
  })
  if (nr?.userId) return nr.userId
  const u = await prisma.user.findFirst({
    where: { role: { in: ['NODE_RUNNER', 'COMPUTE_BUYER', 'CUSTOMER'] } },
    select: { id: true },
  })
  if (!u) throw new Error('No User found to act as test operator. Seed one first.')
  return u.id
}

async function getSystemBalances(): Promise<{ staking: number; treasury: number }> {
  const stakingId = process.env.STAKING_POOL_USER_ID
  const treasuryId = process.env.TREASURY_USER_ID
  if (!stakingId || !treasuryId) {
    return { staking: 0, treasury: 0 }
  }
  const [staking, treasury] = await Promise.all([
    prisma.buyerBalance.findUnique({
      where: { userId: stakingId },
      select: { balanceUsd: true },
    }),
    prisma.buyerBalance.findUnique({
      where: { userId: treasuryId },
      select: { balanceUsd: true },
    }),
  ])
  return {
    staking: staking?.balanceUsd ?? 0,
    treasury: treasury?.balanceUsd ?? 0,
  }
}

async function cleanup(referenceId: string): Promise<void> {
  await prisma.balanceTransaction.deleteMany({
    where: {
      referenceId,
      type: { in: ['STAKING_POOL_SHARE', 'TREASURY_SHARE'] },
    },
  })
  await prisma.revenueShareEntry.deleteMany({ where: { referenceId } })
}

async function main(): Promise<void> {
  const enabled = isRevenueSplitEnabled()
  const referenceId = `${TEST_REF_PREFIX}${Date.now()}`
  const operatorUserId = await findOperatorUserId()

  console.log(`splitRevenue test`)
  console.log(`  REVENUE_SPLIT_ENABLED = ${enabled}`)
  console.log(`  referenceId           = ${referenceId}`)
  console.log(`  operator user id      = ${operatorUserId}`)
  console.log()

  const before = await getSystemBalances()
  console.log(`Before: staking=$${before.staking.toFixed(4)}  treasury=$${before.treasury.toFixed(4)}`)

  const result = await splitRevenue(prisma, {
    sourceTxType: 'SPEND_RENTAL',
    referenceId,
    grossUsd: 9560,
    costUsd: 5240,
    operatorUserId,
    description: 'M0.2 self-test ($9560 / $5240 worked example)',
  })

  console.log()
  console.log('Result:')
  console.log(`  splitEnabled      = ${result.splitEnabled}`)
  console.log(`  costUsd           = $${result.costUsd.toFixed(2)}`)
  console.log(`  netUsd            = $${result.netUsd.toFixed(2)}`)
  console.log(`  operatorTotalUsd  = $${result.operatorTotalUsd.toFixed(2)}`)
  console.log(`  stakingShareUsd   = $${result.stakingShareUsd.toFixed(2)}`)
  console.log(`  treasuryShareUsd  = $${result.treasuryShareUsd.toFixed(2)}`)
  console.log(`  auditEntryId      = ${result.auditEntryId}`)
  console.log(`  firstWrite        = ${result.firstWrite}`)

  const after = await getSystemBalances()
  console.log()
  console.log(`After:  staking=$${after.staking.toFixed(4)}  treasury=$${after.treasury.toFixed(4)}`)
  console.log(`Delta:  staking=$${(after.staking - before.staking).toFixed(4)}  treasury=$${(after.treasury - before.treasury).toFixed(4)}`)

  console.log()
  console.log('Assertions:')
  if (enabled) {
    assert('operatorTotalUsd === 7400', result.operatorTotalUsd === 7400)
    assert('stakingShareUsd === 1080', result.stakingShareUsd === 1080)
    assert('treasuryShareUsd === 1080', result.treasuryShareUsd === 1080)
    assert('netUsd === 4320', result.netUsd === 4320)
    assert('staking balance delta === 1080', Math.abs((after.staking - before.staking) - 1080) < 0.01)
    assert('treasury balance delta === 1080', Math.abs((after.treasury - before.treasury) - 1080) < 0.01)
    assert('sum of shares === gross', Math.abs(result.operatorTotalUsd + result.stakingShareUsd + result.treasuryShareUsd - 9560) < 0.01)
  } else {
    assert('operatorTotalUsd === 9560 (legacy passthrough)', result.operatorTotalUsd === 9560)
    assert('stakingShareUsd === 0', result.stakingShareUsd === 0)
    assert('treasuryShareUsd === 0', result.treasuryShareUsd === 0)
    assert('staking balance unchanged', Math.abs(after.staking - before.staking) < 0.01)
    assert('treasury balance unchanged', Math.abs(after.treasury - before.treasury) < 0.01)
  }

  // Idempotency: re-run with the same referenceId, verify second
  // call returns existing record with firstWrite=false and does NOT
  // re-credit the system accounts.
  const balancesAfterFirst = await getSystemBalances()
  const replay = await splitRevenue(prisma, {
    sourceTxType: 'SPEND_RENTAL',
    referenceId,
    grossUsd: 9560,
    costUsd: 5240,
    operatorUserId,
    description: 'replay should be a no-op',
  })
  const balancesAfterSecond = await getSystemBalances()
  assert('replay firstWrite === false', replay.firstWrite === false)
  assert('replay operatorTotalUsd matches', replay.operatorTotalUsd === result.operatorTotalUsd)
  assert('replay did not double-credit staking', Math.abs(balancesAfterSecond.staking - balancesAfterFirst.staking) < 0.01)
  assert('replay did not double-credit treasury', Math.abs(balancesAfterSecond.treasury - balancesAfterFirst.treasury) < 0.01)

  console.log()
  console.log('Cleaning up test entries...')
  await cleanup(referenceId)
  console.log('Done.')
}

function assert(label: string, ok: boolean): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) {
    process.exitCode = 1
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
