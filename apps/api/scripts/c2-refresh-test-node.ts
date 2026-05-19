/**
 * C2 wave 2 test helper — bump lastHeartbeat=now() on every test-c2-*
 * node so the allocator's 2-minute heartbeat-freshness filter doesn't
 * exclude them. Real agents heartbeat every 30s; seed nodes have no
 * agent, so the timestamp goes stale within minutes and the allocator
 * silently skips them.
 *
 * Usage (Render API service Shell):
 *
 *   cd /opt/render/project/src
 *   pnpm --filter @a2e/api c2:refresh-node
 *
 * Run this:
 *   - Right before flipping txConfirmed on a test request.
 *   - Any time you've been away for >2 min and want to retest.
 *
 * Idempotent. Touches only nodes with id starting with 'test-c2-'.
 */

import { PrismaClient } from '@a2e/database'

const prisma = new PrismaClient()

async function main() {
  const now = new Date()

  const result = await prisma.node.updateMany({
    where: { id: { startsWith: 'test-c2-' } },
    data: { lastHeartbeat: now, status: 'ONLINE' },
  })

  if (result.count === 0) {
    console.log('No test-c2-* nodes found. Did you run c2:seed-node yet?')
    process.exit(0)
  }

  const refreshed = await prisma.node.findMany({
    where: { id: { startsWith: 'test-c2-' } },
    select: { id: true, gpuTier: true, status: true, lastHeartbeat: true },
  })

  console.log(`Refreshed ${result.count} test node(s):`)
  for (const n of refreshed) {
    console.log(`  ${n.id}  tier=${n.gpuTier}  status=${n.status}  hb=${n.lastHeartbeat.toISOString()}`)
  }
  console.log('')
  console.log('Allocator 2-minute window resets now. Next tick (~10s) should pick up')
  console.log('any matching PENDING + txConfirmed=true requests.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
