/**
 * Generic test helper — mark specified nodes ONLINE with a fresh
 * heartbeat so the allocator + UI treat them as live capacity.
 *
 * Why: real agents heartbeat every 30s. Manually-seeded test nodes
 * have no agent, so within 2 min the platform's node-health watchdog
 * flips status back to OFFLINE and the allocator's freshness filter
 * skips them. Run this script to bring them back online; use --watch
 * to keep them online for the duration of a test session.
 *
 * Side-effects:
 *   - lastHeartbeat = now()
 *   - status        = 'ONLINE'
 *   - agentVersion  = '0.0.0-test'  (only when previously null;
 *                                    the allocator's
 *                                    agentVersion: {not: null} filter
 *                                    would otherwise skip the node)
 *
 * Usage (Render API service Shell):
 *
 *   cd /opt/render/project/src
 *
 *   # One-shot: mark all your nodes ONLINE
 *   pnpm --filter @a2e/api nodes:mark-online -- --all
 *
 *   # One-shot by ID prefix (space- or comma-separated, contains match)
 *   pnpm --filter @a2e/api nodes:mark-online -- byog-w 6c93 test-n
 *
 *   # Watch mode: re-ping every 30s so nodes stay online for the
 *   # whole test session. Ctrl+C to stop.
 *   pnpm --filter @a2e/api nodes:mark-online -- --all --watch
 *
 * Idempotent. Does not change wallet, tier, region, or any other
 * state besides the three fields above.
 */

import { PrismaClient } from '@a2e/database'

const prisma = new PrismaClient()
const WATCH_INTERVAL_MS = 30_000

async function pingOnce(where: Record<string, unknown>, verbose: boolean): Promise<number> {
  const now = new Date()

  // Two-step: backfill agentVersion on any matching nodes that have it
  // null (allocator's `agentVersion: { not: null }` filter would skip
  // them otherwise), then bump status + heartbeat across the board.
  const versionFix = await prisma.node.updateMany({
    where: { ...where, agentVersion: null },
    data: { agentVersion: '0.0.0-test' },
  })
  if (verbose && versionFix.count > 0) {
    console.log(`  • backfilled agentVersion on ${versionFix.count} node(s)`)
  }

  const result = await prisma.node.updateMany({
    where,
    data: { lastHeartbeat: now, status: 'ONLINE' as const },
  })

  return result.count
}

async function main() {
  const args = process.argv.slice(2).flatMap(a => a.split(','))
  const all = args.includes('--all')
  const watch = args.includes('--watch')
  const idPatterns = args.filter(a => !a.startsWith('--') && a.trim().length > 0)

  if (!all && idPatterns.length === 0) {
    console.error('Usage:')
    console.error('  pnpm --filter @a2e/api nodes:mark-online -- --all')
    console.error('  pnpm --filter @a2e/api nodes:mark-online -- <id-prefix-1> <id-prefix-2> ...')
    console.error('  pnpm --filter @a2e/api nodes:mark-online -- --all --watch')
    process.exit(1)
  }

  const where = all
    ? {}
    : { OR: idPatterns.map(p => ({ id: { contains: p } })) }

  const firstCount = await pingOnce(where, true)
  if (firstCount === 0) {
    console.log('No nodes matched. Patterns tried:', all ? ['(all)'] : idPatterns)
    process.exit(0)
  }

  const refreshed = await prisma.node.findMany({
    where,
    select: { id: true, gpuTier: true, status: true, lastHeartbeat: true, walletAddress: true, agentVersion: true },
  })

  console.log(`Marked ${firstCount} node(s) ONLINE:`)
  for (const n of refreshed) {
    console.log(`  ${n.id.padEnd(28)}  tier=${n.gpuTier.padEnd(8)}  wallet=${n.walletAddress.slice(0, 12)}...  agent=${(n.agentVersion ?? 'null').padEnd(12)}  status=${n.status}`)
  }
  console.log('')

  if (!watch) {
    console.log('Allocator 2-minute freshness window resets now.')
    console.log('NOTE: nodes revert to OFFLINE within ~2 min. Re-run with --watch to keep them online.')
    return
  }

  console.log(`Watching: re-pinging every ${WATCH_INTERVAL_MS / 1000}s. Ctrl+C to stop.`)
  console.log('')

  let aborting = false
  process.on('SIGINT', () => {
    if (aborting) return
    aborting = true
    console.log('\nStopping watch. Nodes will revert to OFFLINE within ~2 min unless re-pinged.')
  })

  while (!aborting) {
    await new Promise(r => setTimeout(r, WATCH_INTERVAL_MS))
    if (aborting) break
    const count = await pingOnce(where, false)
    console.log(`[${new Date().toISOString()}] re-pinged ${count} node(s)`)
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
