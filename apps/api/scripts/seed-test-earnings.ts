/**
 * Test helper — seed 24 hours of heartbeats for a node-runner so the
 * portal Payouts page shows a non-zero Available balance and you can
 * exercise Withdraw Now end-to-end.
 *
 * Usage (from the Render API service web shell):
 *
 *   cd /opt/render/project/src/apps/api
 *   npx tsx scripts/seed-test-earnings.ts <operator-email-or-name>
 *
 * The script will:
 *   1. Find a NodeRunner by email or by name LIKE match
 *   2. If they have no nodes, create one (BYOG, H100, ONLINE)
 *   3. Insert ~290 Heartbeat rows backdated 5 min apart across 24h
 *
 * Cleanup later if you want:
 *   DELETE FROM "Heartbeat" WHERE "nodeId" = '<test-node-id>' AND "gpuUtilization" = 50.0;
 *   DELETE FROM "Node" WHERE id = '<test-node-id>';
 */

import { PrismaClient } from '@a2e/database'

const prisma = new PrismaClient()

async function main() {
  const arg = process.argv[2]
  if (!arg) {
    console.error('Usage: npx tsx scripts/seed-test-earnings.ts <operator-email-or-name>')
    process.exit(1)
  }

  const runner = await prisma.nodeRunner.findFirst({
    where: {
      OR: [
        { email: arg },
        { name: { contains: arg, mode: 'insensitive' } },
      ],
    },
  })

  if (!runner) {
    console.error(`No NodeRunner matches "${arg}" by email or name. Exiting.`)
    process.exit(1)
  }

  console.log(`Operator: ${runner.name} (id=${runner.id}, email=${runner.email ?? 'none'})`)

  let node = await prisma.node.findFirst({ where: { nodeRunnerId: runner.id } })

  if (!node) {
    const suffix = Math.random().toString(36).slice(2, 10)
    node = await prisma.node.create({
      data: {
        walletAddress: `test-node-${suffix}`,
        gpuTier: 'H100',
        nodeType: 'BYOG',
        status: 'ONLINE',
        nodeRunnerId: runner.id,
        lastHeartbeat: new Date(),
      },
    })
    console.log(`Created test Node ${node.id} (walletAddress=${node.walletAddress})`)
  } else {
    console.log(`Using existing Node ${node.id} (walletAddress=${node.walletAddress})`)
  }

  // Insert 24h of heartbeats spaced 60 seconds apart (= 1440 rows).
  // The uptime calculator considers a node "offline" when gaps between
  // heartbeats exceed 90s, so anything wider than that would only count
  // each heartbeat as a single 30s tick — wildly under-reporting uptime.
  // 60s gaps stay safely inside the window and yield the full 24h of
  // uptime in the earnings calculation.
  const now = Date.now()
  const ONE_MIN_MS = 60 * 1000
  const COUNT = 24 * 60 + 1 // 1441 heartbeats covering 24h

  const rows = Array.from({ length: COUNT }, (_, i) => ({
    nodeId: node!.id,
    timestamp: new Date(now - i * ONE_MIN_MS),
    gpuUtilization: 50.0,
  }))

  const result = await prisma.heartbeat.createMany({ data: rows })
  console.log(`Inserted ${result.count} heartbeats across the last 24h on node ${node.id}.`)

  // Also insert two Earning rollup rows (yesterday + today) so the
  // Dashboard "Earnings (30d)" + "Today" cards show non-zero. The
  // rollup worker normally does this once per day; we shortcut for
  // the test fixture. H100 rate ~$5.84/hr × 12h per row = ~$70.
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const yesterdayStart = new Date(todayStart.getTime() - 86_400_000)
  await prisma.earning.upsert({
    where: { nodeId_date_market: { nodeId: node.id, date: yesterdayStart, market: 'INTERNAL' } },
    update: { earnings: 70.08, gpuSeconds: 12 * 3600 },
    create: {
      nodeId: node.id,
      date: yesterdayStart,
      market: 'INTERNAL',
      earnings: 70.08,
      gpuSeconds: 12 * 3600,
    },
  })
  await prisma.earning.upsert({
    where: { nodeId_date_market: { nodeId: node.id, date: todayStart, market: 'INTERNAL' } },
    update: { earnings: 70.08, gpuSeconds: 12 * 3600 },
    create: {
      nodeId: node.id,
      date: todayStart,
      market: 'INTERNAL',
      earnings: 70.08,
      gpuSeconds: 12 * 3600,
    },
  })
  console.log('Upserted 2 Earning rollup rows (today + yesterday, $70.08 each).')

  // Immediately query the breakdown so the operator sees the expected
  // number without having to log in. If this shows $0, the seeding
  // didn't take or the engine has a stricter filter than expected.
  const { getOperatorBalanceBreakdown } = await import(
    '../src/services/settlement/engine.js'
  )
  const breakdown = await getOperatorBalanceBreakdown(prisma, runner.id)
  console.log('\nLive balance breakdown for this operator:')
  console.log(`  Available: $${breakdown.available.toFixed(2)}`)
  console.log(`  Pending:   $${breakdown.pending.toFixed(2)}`)
  console.log(`  Next unlock: ${breakdown.nextUnlockAt ?? 'n/a'}`)
  console.log(`  Cool-down:   ${breakdown.cooldownHours}h`)

  if (breakdown.available + breakdown.pending === 0) {
    console.log('\nWARNING: balance is still $0 after seeding. Something is off — paste this output back to debug.')
  } else {
    console.log('\nNext steps:')
    console.log('  1. Log in to user.tokenos.ai as this operator')
    console.log('  2. Go to /payouts/settings')
    console.log(`  3. Available tile should show $${breakdown.available.toFixed(2)}`)
    console.log('  4. Click "Withdraw $X.XX" to test the dev-mode payout flow')
  }

  console.log('\nCleanup later if needed:')
  console.log(`  DELETE FROM "Heartbeat" WHERE "nodeId" = '${node.id}' AND "gpuUtilization" = 50.0;`)
  console.log(`  DELETE FROM "Node" WHERE id = '${node.id}';`)
}

main()
  .catch((err) => {
    console.error('Script failed:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
