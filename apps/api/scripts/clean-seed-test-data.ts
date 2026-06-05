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

  // Discover seed nodes (by id prefix). Select only fields we know
  // exist on the Node model — see schema.prisma. The previous version
  // referenced a non-existent nodeName column and crashed at runtime.
  const seedNodes = await prisma.node.findMany({
    where: {
      OR: SEED_NODE_PREFIXES.map((p) => ({ id: { startsWith: p } })),
    },
    select: {
      id: true,
      gpuTier: true,
      status: true,
      customGpuModel: true,
    },
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
    const tier = n.gpuTier ?? '(no tier)'
    const status = n.status ?? '(no status)'
    const model = n.customGpuModel ?? ''
    console.log(`  ${n.id.padEnd(40)} ${tier.padEnd(8)} ${status.padEnd(10)} ${model}`)
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

  // Most User/Node relations in schema.prisma use `onDelete: Cascade`,
  // so deleting the parent row sweeps the related rows automatically.
  // We only need to explicitly delete things that DON'T cascade or
  // that exist independently of the seed users/nodes (fake-market
  // earnings on REAL nodes, e.g.).
  await prisma.$transaction(async (tx) => {
    // 1. Fake-market Earnings (delete by market enum value, not by
    //    node — covers stale rows on any node)
    const delFakeEarnings = await tx.earning.deleteMany({
      where: { market: { in: [...FAKE_MARKETS] } },
    })
    console.log(`Deleted ${delFakeEarnings.count} fake-market earnings rows (AKASH/VASTAI)`)

    // 2. Seed nodes by id prefix. Cascades to: ExternalDeployment
    //    (nodeId FK cascade), Earning (nodeId FK cascade), Heartbeats,
    //    Jobs, etc. Settled by schema cascade rules.
    const delNodes = await tx.node.deleteMany({
      where: { id: { in: nodeIds } },
    })
    console.log(`Deleted ${delNodes.count} seed node rows (cascades to related Earnings, ExternalDeployments, Jobs, Heartbeats)`)

    // 3. Seed users by email pattern. Cascades to: ComputeRequest,
    //    BalanceTransaction, BuyerBalance, NodeRunner, ApiKey,
    //    PushSubscription, Notification, RefreshToken, etc.
    //    InternalSpend gets nuked via ComputeRequest cascade or
    //    NodeRunner cascade (since InternalSpend has nodeRunnerId +
    //    computeRequestId FKs, both cascading).
    const delUsers = await tx.user.deleteMany({
      where: { id: { in: userIds } },
    })
    console.log(`Deleted ${delUsers.count} seed user rows (cascades to related ComputeRequests, BalanceTransactions, BuyerBalances, NodeRunners, ApiKeys, etc.)`)
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
