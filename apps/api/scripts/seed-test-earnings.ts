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

  // Insert 24h of heartbeats, one every 5 min = 289 rows total.
  // gpuUtilization=50.0 is the marker that lets us identify + delete
  // these later if we want to clean up.
  const now = Date.now()
  const FIVE_MIN_MS = 5 * 60 * 1000
  const COUNT = 24 * 12 + 1 // 289 heartbeats over 24h

  const rows = Array.from({ length: COUNT }, (_, i) => ({
    nodeId: node!.id,
    timestamp: new Date(now - i * FIVE_MIN_MS),
    gpuUtilization: 50.0,
  }))

  const result = await prisma.heartbeat.createMany({ data: rows })
  console.log(`Inserted ${result.count} heartbeats across the last 24h on node ${node.id}.`)

  console.log('\nNext steps:')
  console.log('  1. Log in to user.tokenos.ai as this operator')
  console.log('  2. Go to /payouts/settings')
  console.log('  3. Available tile should show ~$140 (H100 rate for 24h, minus 12h cool-down)')
  console.log('  4. Click "Withdraw $X.XX" to test the dev-mode payout flow')
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
