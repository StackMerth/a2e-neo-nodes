/**
 * Wipe seed/test data from production DB so admin dashboards (financial,
 * earnings, external markets, audit log) show ONLY real activity.
 *
 * TWO MODES:
 *
 * 1) Default seed-targeted mode (--apply):
 *    Wipes only the rows matching seed/test naming patterns. Preserves
 *    any "real" rows that don't match the pattern. Use this if you
 *    have real users alongside the test data.
 *
 *    Targets:
 *      - Seed users: buyer1@/buyer2@/seed-*@tokenos.ai
 *      - Provision-test users: *@system.tokenos.internal (phala/voltagegpu/
 *        lambda/runpod/ionet/gcp scripts)
 *      - Seed nodes: id prefixed with 'seed-node-' / 'test-c2-' / 'test-'
 *      - Stale fake-market earnings: market in ('AKASH', 'VASTAI')
 *
 *    Does NOT touch:
 *      - Real users (anything not matching the seed pattern)
 *      - Real nodes
 *      - Real INTERNAL / IONET / LAMBDA / RUNPOD / PHALA earnings
 *      - System config (CostBaseline, SettlementConfig, templates)
 *
 * 2) Pre-launch clean-slate mode (--clean-slate --apply):
 *    Wipes EVERYTHING transactional regardless of pattern, preserving
 *    only:
 *      - ADMIN_USER_EMAIL user (env-driven; defaults to upsumeguy@gmail.com)
 *        and their ApiKeys / BuyerBalance / RefreshTokens
 *      - System config tables: GpuCostBaseline, SettlementConfig,
 *        ProductTemplate, NotificationTemplate, OverflowConfig
 *
 *    Nukes:
 *      - ALL ExternalDeployments, ExternalRentals, Earnings, Settlements,
 *        Jobs, InfrastructureCosts, ProvisionJobs
 *      - ALL ComputeRequests, Ratings, InternalSpend
 *      - ALL Investments, WithdrawalRequests
 *      - ALL non-admin BalanceTransactions, BuyerBalances
 *      - ALL Notifications, PushSubscriptions, TokenUsage, Invoices
 *      - ALL Nodes, NodeRunners
 *      - ALL non-admin Users (and their ApiKeys, RefreshTokens via cascade)
 *      - ALL ConfidentialInterest rows
 *
 *    Use this for a FRESH production launch where everything in the DB
 *    is leftover test data from the build phase. The system payer wallet
 *    on-chain is unaffected (this is just the DB ledger).
 *
 * Run from Render API shell:
 *   pnpm --filter @a2e/api exec tsx scripts/clean-seed-test-data.ts --dry
 *     -> seed-targeted dry-run
 *
 *   pnpm --filter @a2e/api exec tsx scripts/clean-seed-test-data.ts --apply
 *     -> seed-targeted apply
 *
 *   pnpm --filter @a2e/api exec tsx scripts/clean-seed-test-data.ts --clean-slate --dry
 *     -> full-wipe dry-run (shows row counts about to be nuked)
 *
 *   pnpm --filter @a2e/api exec tsx scripts/clean-seed-test-data.ts --clean-slate --apply
 *     -> full-wipe apply. Wrapped in a transaction; rollback on any error.
 *
 * Set ADMIN_USER_EMAIL in env if your admin account isn't upsumeguy@gmail.com.
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

// =============================================================
// CLEAN SLATE MODE
// =============================================================

const ADMIN_USER_EMAIL = process.env.ADMIN_USER_EMAIL ?? 'emmanuelakolade5@gmail.com'

async function runCleanSlate(dryRun: boolean): Promise<void> {
  if (dryRun) {
    console.log('=== CLEAN-SLATE DRY RUN — counts only, no changes ===')
    console.log(`Preserve admin: ${ADMIN_USER_EMAIL}\n`)
  } else {
    console.log('=== CLEAN-SLATE APPLY — nuking everything except admin ===')
    console.log(`Preserve admin: ${ADMIN_USER_EMAIL}\n`)
  }

  const adminUser = await prisma.user.findUnique({
    where: { email: ADMIN_USER_EMAIL },
    select: { id: true, email: true, role: true },
  })

  if (!adminUser) {
    console.error(
      `ERROR: admin user '${ADMIN_USER_EMAIL}' not found in DB.\n` +
      `Set ADMIN_USER_EMAIL env to the correct email and retry.\n` +
      `Without an admin to preserve, this script refuses to nuke ` +
      `everything (would leave you locked out of the dashboard).`,
    )
    process.exit(1)
  }

  console.log(`Admin preserved: ${adminUser.id} (${adminUser.email}, role=${adminUser.role})\n`)

  // Count what's about to be nuked.
  const counts = {
    earnings: await prisma.earning.count(),
    settlements: await prisma.settlement.count(),
    jobs: await prisma.job.count(),
    infraCosts: await prisma.infrastructureCost.count(),
    provisionJobs: await prisma.provisionJob.count(),
    externalDeployments: await prisma.externalDeployment.count(),
    externalRentals: await prisma.externalRental.count(),
    computeRequests: await prisma.computeRequest.count(),
    ratings: await prisma.rating.count(),
    internalSpend: await prisma.internalSpend.count(),
    investments: await prisma.investment.count(),
    withdrawals: await prisma.withdrawalRequest.count(),
    balanceTx: await prisma.balanceTransaction.count(),
    buyerBalances: await prisma.buyerBalance.count(),
    notifications: await prisma.notification.count(),
    pushSubs: await prisma.pushSubscription.count(),
    confInterest: await prisma.confidentialInterest.count(),
    nodes: await prisma.node.count(),
    nodeRunners: await prisma.nodeRunner.count(),
    nonAdminUsers: await prisma.user.count({ where: { id: { not: adminUser.id } } }),
  }

  console.log('Row counts to nuke:')
  for (const [k, v] of Object.entries(counts)) {
    console.log(`  ${k.padEnd(22)} ${v}`)
  }
  console.log()

  if (dryRun) {
    console.log('=== DRY RUN COMPLETE — pass --apply to actually nuke ===')
    return
  }

  // Atomic wipe in dependency order. Same FK constraints as the
  // seed-targeted path, just without the WHERE clauses.
  await prisma.$transaction(
    async (tx) => {
      // Layer 1: row-level test data with no further dependents.
      await tx.earning.deleteMany({})
      console.log(`Wiped ${counts.earnings} earnings`)

      await tx.settlement.deleteMany({})
      console.log(`Wiped ${counts.settlements} settlements (cascade -> SettlementItems)`)

      await tx.job.deleteMany({})
      console.log(`Wiped ${counts.jobs} jobs`)

      await tx.infrastructureCost.deleteMany({})
      console.log(`Wiped ${counts.infraCosts} infrastructure cost rows`)

      await tx.provisionJob.deleteMany({})
      console.log(`Wiped ${counts.provisionJobs} provision jobs`)

      await tx.externalDeployment.deleteMany({})
      console.log(`Wiped ${counts.externalDeployments} external deployments`)

      await tx.externalRental.deleteMany({})
      console.log(`Wiped ${counts.externalRentals} external rentals`)

      // Rating blocks ComputeRequest and NodeRunner.
      await tx.rating.deleteMany({})
      console.log(`Wiped ${counts.ratings} ratings`)

      await tx.internalSpend.deleteMany({})
      console.log(`Wiped ${counts.internalSpend} internal spend rows`)

      await tx.investment.deleteMany({})
      console.log(`Wiped ${counts.investments} investments`)

      await tx.withdrawalRequest.deleteMany({})
      console.log(`Wiped ${counts.withdrawals} withdrawal requests`)

      await tx.computeRequest.deleteMany({})
      console.log(`Wiped ${counts.computeRequests} compute requests`)

      // Balance ledger: rely on cascade.
      //   User -> BuyerBalance (onDelete: Cascade on userId)
      //   BuyerBalance -> BalanceTransaction (onDelete: Cascade on balanceId)
      // When we delete non-admin Users at the end of the transaction,
      // their BuyerBalance + BalanceTransaction rows sweep automatically.
      // Admin's stay because the admin User row stays.
      //
      // Previously this scoped BalanceTransaction by userId, which fails
      // because BalanceTransaction has no userId column — it has
      // balanceId pointing at BuyerBalance. Cascade is cleaner anyway.

      await tx.notification.deleteMany({})
      console.log(`Wiped ${counts.notifications} notifications`)

      await tx.pushSubscription.deleteMany({})
      console.log(`Wiped ${counts.pushSubs} push subscriptions`)

      await tx.confidentialInterest.deleteMany({})
      console.log(`Wiped ${counts.confInterest} confidential interest rows`)

      // Detach all Node.nodeRunnerId so the NodeRunner sweep below
      // doesn't block on FK. Then delete all nodes.
      await tx.node.updateMany({
        where: {},
        data: { nodeRunnerId: null },
      })
      await tx.node.deleteMany({})
      console.log(`Wiped ${counts.nodes} nodes`)

      await tx.nodeRunner.deleteMany({})
      console.log(`Wiped ${counts.nodeRunners} node runners`)

      // Finally non-admin Users. Their remaining cascade-children
      // (ApiKey, RefreshToken, PushSubscription, BuyerBalance, etc.)
      // get swept by the schema's onDelete: Cascade rules.
      await tx.user.deleteMany({
        where: { id: { not: adminUser.id } },
      })
      console.log(`Wiped ${counts.nonAdminUsers} non-admin users`)
    },
    {
      // Default Prisma tx timeout is 5s. A clean-slate wipe could
      // touch thousands of rows; give it a generous ceiling.
      timeout: 120_000,
      maxWait: 10_000,
    },
  )

  console.log()
  console.log('=== CLEAN-SLATE COMPLETE ===')
  console.log('Refresh /financial, /earnings, /external, /compute — all should be zero.')
  console.log(`Admin user ${adminUser.email} preserved with role=${adminUser.role}.`)
  console.log('System config (GpuCostBaseline, SettlementConfig, Templates) untouched.')
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry') || !args.includes('--apply')
  const cleanSlate = args.includes('--clean-slate')

  if (cleanSlate) {
    await runCleanSlate(dryRun)
    return
  }

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
