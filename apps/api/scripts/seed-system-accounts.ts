/**
 * Track 5 / M0.2 — seed the staking pool and treasury virtual users.
 *
 * splitRevenue() credits these two users via BalanceTransaction. They
 * are regular User rows with sentinel roles (SYSTEM_STAKING_POOL,
 * SYSTEM_TREASURY) and sentinel emails so they're easy to spot in any
 * admin query but can't be confused with real users:
 *
 *   staking-pool@system.tokenos.internal
 *   treasury@system.tokenos.internal
 *
 * They have no password, never authenticate, never appear in
 * user-facing lists. Their BuyerBalance row IS the staking pool / treasury
 * balance — sum of unallocated 25% net slices, growing every time a
 * revenue event splits.
 *
 * Idempotent: re-running is a no-op. Always prints the resolved IDs
 * so you can copy them into Render env (STAKING_POOL_USER_ID,
 * TREASURY_USER_ID) which splitRevenue reads at credit time.
 *
 * Run:   pnpm --filter @a2e/api seed:system-accounts
 */
import { prisma } from '@a2e/database'

interface SystemAccountSpec {
  email: string
  role: 'SYSTEM_STAKING_POOL' | 'SYSTEM_TREASURY'
  label: string
  envVar: string
}

const SPECS: SystemAccountSpec[] = [
  {
    email: 'staking-pool@system.tokenos.internal',
    role: 'SYSTEM_STAKING_POOL',
    label: 'Staking Pool',
    envVar: 'STAKING_POOL_USER_ID',
  },
  {
    email: 'treasury@system.tokenos.internal',
    role: 'SYSTEM_TREASURY',
    label: 'Treasury',
    envVar: 'TREASURY_USER_ID',
  },
]

async function main(): Promise<void> {
  const resolved: Array<{ label: string; envVar: string; userId: string; balance: number }> = []

  for (const spec of SPECS) {
    const user = await prisma.user.upsert({
      where: { email: spec.email },
      create: {
        email: spec.email,
        role: spec.role,
        emailVerified: false,
      },
      update: {
        role: spec.role,
      },
    })
    const balance = await prisma.buyerBalance.upsert({
      where: { userId: user.id },
      create: { userId: user.id },
      update: {},
      select: { balanceUsd: true },
    })
    resolved.push({
      label: spec.label,
      envVar: spec.envVar,
      userId: user.id,
      balance: balance.balanceUsd,
    })
  }

  console.log('System accounts ready:')
  console.log('')
  for (const r of resolved) {
    console.log(`  ${r.label.padEnd(14)} userId=${r.userId}`)
    console.log(`  ${''.padEnd(14)} balance=$${r.balance.toFixed(2)}`)
    console.log('')
  }
  console.log('Add to Render API env (Environment tab) to enable splitRevenue when kill switch is ON:')
  console.log('')
  for (const r of resolved) {
    console.log(`  ${r.envVar}=${r.userId}`)
  }
  console.log('')
  console.log('Until REVENUE_SPLIT_ENABLED=true in the same env, these IDs are not consumed by any code path.')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
