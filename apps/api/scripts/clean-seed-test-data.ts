/**
 * Wipe seed/test data from production DB so admin dashboards (financial,
 * earnings, external markets, audit log) show ONLY real activity.
 *
 * What this targets:
 *   - Seed users: buyer1@/buyer2@/seed-*@tokenos.ai (created by seed-test-data.ts)
 *   - Seed nodes: id prefixed with 'seed-node-' or 'test-c2-'
 *   - Seed earnings: rows tied to seed nodes
 *   - Seed external deployments: rows tied to seed buyers
 *   - Seed compute requests + spend: rows tied to seed users
 *   - Stale "fake market" earnings: any Earning rows with market in
 *     ('AKASH', 'VASTAI') — these markets are not actually integrated;
 *     they were placeholders in seed-test-data.ts and skew the financial
 *     overview percentages.
 *
 * What this DOES NOT touch:
 *   - Real users (anything that doesn't match the seed naming pattern)
 *   - Real nodes (anything that doesn't start with seed-node-/test-c2-)
 *   - Real earnings on INTERNAL / IONET / LAMBDA / RUNPOD / PHALA markets
 *   - Cost baselines, templates, system accounts (intentionally seeded)
 *
 * Run from Render API shell:
 *   pnpm --filter @a2e/api exec tsx scripts/clean-seed-test-data.ts --dry
 *     -> dry-run. Prints what WOULD be deleted, no DB mutations.
 *
 *   pnpm --filter @a2e/api exec tsx scripts/clean-seed-test-data.ts --apply
 *     -> actually deletes. Wrapped in a transaction; if anything errors
 *     mid-way, the whole thing rolls back.
 *
 * After running with --apply, refresh /financial, /earnings, /external in
 * the admin dashboard. Numbers should reflect real production activity
 * only (which will likely be near-zero on a fresh production deploy).
 */

import { prisma } from '@a2e/database'

const SEED_EMAIL_PATTERNS = [
  'buyer1@tokenos.ai',
  'buyer2@tokenos.ai',
] as const

const SEED_EMAIL_PREFIX = 'seed-'
const SEED_NODE_PREFIXES = ['seed-node-', 'test-c2-']
const FAKE_MARKETS = ['AKASH', 'VASTAI'] as const

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry') || !args.includes('--apply')

  if (dryRun) {
    console.log('=== DRY RUN — no changes will be made ===')
    console.log('Run with --apply to actually delete.\n')
  } else {
    console.log('=== APPLY MODE — deleting seed data ===\n')
  }

  // Discover seed users (by email pattern)
  const seedUsers = await prisma.user.findMany({
    where: {
      OR: [
        { email: { in: [...SEED_EMAIL_PATTERNS] } },
        { email: { startsWith: SEED_EMAIL_PREFIX } },
      ],
    },
    select: { id: true, email: true },
  })

  // Discover seed nodes (by id prefix)
  const seedNodes = await prisma.node.findMany({
    where: {
      OR: SEED_NODE_PREFIXES.map((p) => ({ id: { startsWith: p } })),
    },
    select: { id: true, nodeName: true },
  })

  // Discover fake-market earnings (separate axis — may exist on real nodes
  // if a stale market enum value was used)
  const fakeMarketEarnings = await prisma.earning.findMany({
    where: { market: { in: [...FAKE_MARKETS] } },
    select: { id: true, market: true, amount: true },
  })

  console.log(`Found ${seedUsers.length} seed users:`)
  for (const u of seedUsers) {
    console.log(`  ${u.id.padEnd(30)} ${u.email}`)
  }
  console.log()

  console.log(`Found ${seedNodes.length} seed nodes:`)
  for (const n of seedNodes) {
    console.log(`  ${n.id.padEnd(40)} ${n.nodeName ?? '(no name)'}`)
  }
  console.log()

  console.log(`Found ${fakeMarketEarnings.length} fake-market earnings (AKASH/VASTAI):`)
  let fakeTotal = 0
  for (const e of fakeMarketEarnings) {
    fakeTotal += e.amount
  }
  console.log(`  Total fake earnings: $${fakeTotal.toFixed(2)}`)
  console.log()

  if (dryRun) {
    console.log('=== DRY RUN COMPLETE — pass --apply to actually delete ===')
    return
  }

  const userIds = seedUsers.map((u) => u.id)
  const nodeIds = seedNodes.map((n) => n.id)

  // Tx so partial deletes don't leave the DB inconsistent
  await prisma.$transaction(async (tx) => {
    // Earnings tied to seed nodes OR to fake markets
    const delEarnings = await tx.earning.deleteMany({
      where: {
        OR: [
          { nodeId: { in: nodeIds } },
          { market: { in: [...FAKE_MARKETS] } },
        ],
      },
    })
    console.log(`Deleted ${delEarnings.count} earnings rows`)

    // External deployments tied to seed buyers
    const delExternal = await tx.externalDeployment.deleteMany({
      where: { userId: { in: userIds } },
    })
    console.log(`Deleted ${delExternal.count} external deployment rows`)

    // Internal spend tied to seed buyers
    const delSpend = await tx.internalSpend.deleteMany({
      where: { userId: { in: userIds } },
    })
    console.log(`Deleted ${delSpend.count} internal spend rows`)

    // Compute requests tied to seed buyers
    const delRequests = await tx.computeRequest.deleteMany({
      where: { userId: { in: userIds } },
    })
    console.log(`Deleted ${delRequests.count} compute request rows`)

    // Balance transactions tied to seed buyers
    const delBalanceTx = await tx.balanceTransaction.deleteMany({
      where: { userId: { in: userIds } },
    })
    console.log(`Deleted ${delBalanceTx.count} balance transaction rows`)

    // Buyer balances tied to seed buyers
    const delBuyerBalances = await tx.buyerBalance.deleteMany({
      where: { userId: { in: userIds } },
    })
    console.log(`Deleted ${delBuyerBalances.count} buyer balance rows`)

    // Nodes
    const delNodes = await tx.node.deleteMany({
      where: { id: { in: nodeIds } },
    })
    console.log(`Deleted ${delNodes.count} node rows`)

    // Seed users (after all their referencing data is gone)
    const delUsers = await tx.user.deleteMany({
      where: { id: { in: userIds } },
    })
    console.log(`Deleted ${delUsers.count} user rows`)
  })

  console.log()
  console.log('=== APPLY COMPLETE ===')
  console.log('Refresh /financial, /earnings, /external in the admin dashboard.')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
