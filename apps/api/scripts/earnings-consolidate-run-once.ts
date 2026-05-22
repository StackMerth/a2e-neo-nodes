/**
 * Manual earnings-consolidator trigger.
 *
 * Bypasses the BullMQ schedule and runs the consolidation tick
 * directly. Lets engineers backfill a missed day (deploy gap, BullMQ
 * outage) or sanity-check the consolidator before the next scheduled
 * tick.
 *
 * Usage:
 *   pnpm --filter @a2e/api earnings:consolidate                    # yesterday
 *   pnpm --filter @a2e/api earnings:consolidate 2026-05-21         # specific day
 *
 * The date arg, if provided, must be YYYY-MM-DD (UTC). Anything else
 * 400s out before any DB writes.
 */

import { prisma } from '@a2e/database'
import { runEarningsConsolidatorTick } from '../src/jobs/earnings-consolidator.js'

async function main() {
  const dateArg = process.argv[2]
  let targetDate: Date | undefined

  if (dateArg) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
      console.error(`Date must be YYYY-MM-DD (got "${dateArg}")`)
      process.exit(1)
    }
    // Parse as UTC midnight so the day window matches exactly what the
    // worker computes for a default 'yesterday' tick.
    targetDate = new Date(`${dateArg}T00:00:00.000Z`)
    if (Number.isNaN(targetDate.getTime())) {
      console.error(`Invalid date: ${dateArg}`)
      process.exit(1)
    }
    console.log(`[earnings:consolidate] backfilling for date ${dateArg}`)
  } else {
    console.log('[earnings:consolidate] consolidating yesterday (UTC)')
  }

  const summary = await runEarningsConsolidatorTick(prisma, targetDate)

  console.log('')
  console.log('=== Consolidation summary ===')
  console.log(`  date             : ${summary.date}`)
  console.log(`  nodes scanned    : ${summary.nodesScanned}`)
  console.log(`  rows upserted    : ${summary.rowsUpserted}`)
  console.log(`  zero earnings    : ${summary.zeroEarnings} (had heartbeats but $0)`)
  console.log(`  failures         : ${summary.failures.length}`)
  console.log(`  total written    : $${summary.totalUsd.toFixed(2)}`)

  if (summary.failures.length > 0) {
    console.log('')
    console.log('Per-node failures:')
    for (const f of summary.failures) {
      console.log(`  ${f.nodeId}: ${f.reason}`)
    }
    process.exit(1)
  }
}

main()
  .catch((err) => {
    console.error('[earnings:consolidate] FAILED:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
