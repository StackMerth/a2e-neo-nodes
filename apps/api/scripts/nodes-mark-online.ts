/**
 * Generic test helper — mark specified nodes ONLINE with a fresh
 * heartbeat so the allocator + UI treat them as live capacity.
 *
 * Why: real agents heartbeat every 30s. Manually-seeded test nodes
 * have no agent, so within 2 min the allocator's freshness filter
 * skips them and the operator portal shows them as Offline. Run
 * this script to bring them back to ONLINE for testing.
 *
 * Usage (Render API service Shell):
 *
 *   cd /opt/render/project/src
 *
 *   # Mark all nodes belonging to a node-runner ONLINE
 *   pnpm --filter @a2e/api nodes:mark-online -- --all
 *
 *   # Mark specific node IDs ONLINE (space- or comma-separated, prefix match)
 *   pnpm --filter @a2e/api nodes:mark-online -- byog-w 6c93 test-n
 *
 * Idempotent. Does not change wallet, tier, or any other state —
 * only lastHeartbeat=now() + status=ONLINE.
 */

import { PrismaClient } from '@a2e/database'

const prisma = new PrismaClient()

async function main() {
  const args = process.argv.slice(2).flatMap(a => a.split(','))
  const all = args.includes('--all')
  const idPatterns = args.filter(a => a !== '--all' && a.trim().length > 0)

  if (!all && idPatterns.length === 0) {
    console.error('Usage:')
    console.error('  pnpm --filter @a2e/api nodes:mark-online -- --all')
    console.error('  pnpm --filter @a2e/api nodes:mark-online -- <id-prefix-1> <id-prefix-2> ...')
    process.exit(1)
  }

  const now = new Date()
  const where = all
    ? {}
    : { OR: idPatterns.map(p => ({ id: { contains: p } })) }

  const result = await prisma.node.updateMany({
    where,
    data: { lastHeartbeat: now, status: 'ONLINE' as const },
  })

  if (result.count === 0) {
    console.log('No nodes matched. Patterns tried:', all ? ['(all)'] : idPatterns)
    process.exit(0)
  }

  const refreshed = await prisma.node.findMany({
    where,
    select: { id: true, gpuTier: true, status: true, lastHeartbeat: true, walletAddress: true },
  })

  console.log(`Marked ${result.count} node(s) ONLINE:`)
  for (const n of refreshed) {
    console.log(`  ${n.id.padEnd(28)}  tier=${n.gpuTier.padEnd(8)}  wallet=${n.walletAddress.slice(0, 12)}...  status=${n.status}  hb=${n.lastHeartbeat.toISOString()}`)
  }
  console.log('')
  console.log('Allocator 2-minute freshness window resets now. UI will show ONLINE on next refresh.')
  console.log('NOTE: status will revert to OFFLINE within ~2 min unless an agent heartbeats. Re-run as needed.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
