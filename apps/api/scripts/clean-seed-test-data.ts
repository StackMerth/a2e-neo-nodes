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
// Provision-test scripts (phala-provision-test.ts, voltagegpu-provision-
// test.ts, lambda-provision-test.ts, runpod-provision-test.ts, ionet-
// provision-test.ts, gcp-provision-test.ts) all create users with this
// email domain. They leave WAITLISTED ComputeRequests behind that clog
// the admin Compute queue. Sweep them by domain in one shot.
const TEST_EMAIL_DOMAIN = '@system.tokenos.internal'
const SEED_NODE_PREFIXES = ['seed-node-', 'test-c2-', 'test-']
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

  // Discover seed users (by email pattern). Three matchers:
  //   1. explicit buyer1@/buyer2@ test accounts
  //   2. anything starting with seed- prefix (M2 seed-test-data.ts)
  //   3. anything ending in @system.tokenos.internal (provision-test
  //      scripts auto-create these and they leave WAITLISTED
  //      ComputeRequests in the admin queue)
  const seedUsers = await prisma.user.findMany({
    where: {
      OR: [
        { email: { in: [...SEED_EMAIL_PATTERNS] } },
        { email: { startsWith: SEED_EMAIL_PREFIX } },
        { email: { endsWith: TEST_EMAIL_DOMAIN } },
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
    select: { id: true, market: true, earnings: true },
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
    fakeTotal += e.earnings
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

    // 2. Pre-delete rows that reference seed nodes via FKs WITHOUT
    //    onDelete: Cascade in schema.prisma. Without these, the Node
    //    deleteMany below would fail with a P2003 FK violation. Audited
    //    relations: Settlement (1063), Job (799), InfrastructureCost
    //    (1116), NodeInstallation (1207) — all four have plain
    //    `@relation(fields: [nodeId], references: [id])` with no
    //    cascade clause. Settlement is the strictest (nodeId is
    //    NOT NULL); the other three are nullable but Prisma still
    //    blocks the parent delete on existence.
    const delSettlements = await tx.settlement.deleteMany({
      where: { nodeId: { in: nodeIds } },
    })
    console.log(`Deleted ${delSettlements.count} settlement rows (cascades to SettlementItems)`)

    const delJobs = await tx.job.deleteMany({
      where: { nodeId: { in: nodeIds } },
    })
    console.log(`Deleted ${delJobs.count} job rows`)

    const delInfraCosts = await tx.infrastructureCost.deleteMany({
      where: { nodeId: { in: nodeIds } },
    })
    console.log(`Deleted ${delInfraCosts.count} infrastructure cost rows`)

    const delProvisionJobs = await tx.provisionJob.deleteMany({
      where: { nodeId: { in: nodeIds } },
    })
    console.log(`Deleted ${delProvisionJobs.count} provision job rows`)

    // 3. Seed nodes by id prefix. Cascades to: ExternalDeployment
    //    (nodeId FK cascade), Earning (nodeId FK cascade), Heartbeats,
    //    NodeMetrics, ComputeRequest (via cascade chain), etc.
    const delNodes = await tx.node.deleteMany({
      where: { id: { in: nodeIds } },
    })
    console.log(`Deleted ${delNodes.count} seed node rows (cascades to related Earnings, ExternalDeployments, Heartbeats, NodeMetrics)`)

    // 4. Pre-delete rows that reference seed Users via FKs WITHOUT
    //    onDelete: Cascade. Full schema audit of User relations:
    //
    //      CASCADE (auto-handled by User delete):
    //        ApiKey (233), RefreshToken (252), BalanceTransaction (272),
    //        BuyerBalance (1741), PushSubscription (1923)
    //
    //      NO CASCADE (blocks User delete):
    //        NodeRunner.userId       (290, nullable + unique)
    //        ComputeRequest.userId   (1311, non-null)
    //        Rating.buyerId          (1612, non-null)
    //        ConfidentialInterest.userId (2334, nullable)
    //
    //    AND Rating itself blocks ComputeRequest AND NodeRunner
    //    (Rating has computeRequestId + nodeRunnerId FKs, neither
    //    cascading). So delete Rating first, then ComputeRequest +
    //    NodeRunner can go in any order, then User.
    //
    //    For NodeRunner, also need to clear its non-cascading
    //    children: Investment (565), WithdrawalRequest (1677),
    //    and Node.nodeRunnerId (632, nullable - just null it).

    // First: collect the user's compute requests and node runners
    // by id so we can scope the dependent deletes precisely (not
    // accidentally nuking another user's Ratings).
    const userComputeRequests = await tx.computeRequest.findMany({
      where: { userId: { in: userIds } },
      select: { id: true },
    })
    const userComputeRequestIds = userComputeRequests.map((c) => c.id)

    const userNodeRunners = await tx.nodeRunner.findMany({
      where: { userId: { in: userIds } },
      select: { id: true },
    })
    const userNodeRunnerIds = userNodeRunners.map((n) => n.id)

    // Rating: tied via buyerId OR computeRequestId OR nodeRunnerId.
    // Must die before any of those parents can be deleted.
    const delRatings = await tx.rating.deleteMany({
      where: {
        OR: [
          { buyerId: { in: userIds } },
          ...(userComputeRequestIds.length
            ? [{ computeRequestId: { in: userComputeRequestIds } }]
            : []),
          ...(userNodeRunnerIds.length
            ? [{ nodeRunnerId: { in: userNodeRunnerIds } }]
            : []),
        ],
      },
    })
    console.log(`Deleted ${delRatings.count} rating rows`)

    // NodeRunner-dependent rows: Investment + WithdrawalRequest
    // (both non-cascading FKs to NodeRunner). Skip if seed user
    // has no NodeRunner (the common case for a buyer-only seed).
    if (userNodeRunnerIds.length) {
      const delInvestments = await tx.investment.deleteMany({
        where: { nodeRunnerId: { in: userNodeRunnerIds } },
      })
      console.log(`Deleted ${delInvestments.count} investment rows`)

      const delWithdrawals = await tx.withdrawalRequest.deleteMany({
        where: { nodeRunnerId: { in: userNodeRunnerIds } },
      })
      console.log(`Deleted ${delWithdrawals.count} withdrawal request rows`)

      // Node.nodeRunnerId is nullable; null it instead of cascading
      // a real production node into deletion just because its owner
      // is a seed account (defensive).
      const orphanedNodes = await tx.node.updateMany({
        where: { nodeRunnerId: { in: userNodeRunnerIds } },
        data: { nodeRunnerId: null },
      })
      console.log(`Orphaned ${orphanedNodes.count} nodes (cleared nodeRunnerId)`)
    }

    // Now delete the User's direct non-cascading children.
    const delComputeRequests = await tx.computeRequest.deleteMany({
      where: { userId: { in: userIds } },
    })
    console.log(`Deleted ${delComputeRequests.count} compute request rows`)

    if (userNodeRunnerIds.length) {
      const delNodeRunners = await tx.nodeRunner.deleteMany({
        where: { userId: { in: userIds } },
      })
      console.log(`Deleted ${delNodeRunners.count} node runner rows`)
    }

    const delConfInterest = await tx.confidentialInterest.deleteMany({
      where: { userId: { in: userIds } },
    })
    console.log(`Deleted ${delConfInterest.count} confidential interest rows`)

    // 5. Finally the User itself. Cascades sweep ApiKey,
    //    RefreshToken, BalanceTransaction, BuyerBalance,
    //    PushSubscription, Notification, etc.
    const delUsers = await tx.user.deleteMany({
      where: { id: { in: userIds } },
    })
    console.log(`Deleted ${delUsers.count} seed user rows (cascades to ApiKeys, BalanceTransactions, BuyerBalances, RefreshTokens, etc.)`)
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
