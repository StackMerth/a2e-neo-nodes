/**
 * Print every Earning row for an operator's nodes in the last 60 days
 * so we can verify what the consolidator has written vs what the
 * dashboard chart should be showing.
 *
 * Usage:
 *   pnpm --filter @a2e/api earnings:inspect <operator-email>
 *
 * Example:
 *   pnpm --filter @a2e/api earnings:inspect asad@m.com
 */

import { PrismaClient } from '@a2e/database'

const prisma = new PrismaClient()

async function main() {
  const email = process.argv[2]
  if (!email) {
    console.error('Usage: pnpm --filter @a2e/api earnings:inspect <operator-email>')
    process.exit(1)
  }

  const nr = await prisma.nodeRunner.findFirst({
    where: { email },
    select: { id: true, name: true },
  })
  if (!nr) {
    console.error(`No NodeRunner with email "${email}"`)
    process.exit(1)
  }

  const nodes = await prisma.node.findMany({
    where: { nodeRunnerId: nr.id },
    select: { id: true, gpuTier: true, walletAddress: true, status: true },
  })
  const nodeIds = nodes.map((n) => n.id)

  console.log(`=== ${nr.name} (${email}) ===`)
  console.log(`Nodes owned: ${nodes.length}`)
  for (const n of nodes) {
    console.log(`  ${n.id}  tier=${n.gpuTier}  status=${n.status}`)
  }
  console.log('')

  if (nodes.length === 0) {
    console.log('No nodes -> chart can never have data. Done.')
    return
  }

  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
  const earnings = await prisma.earning.findMany({
    where: { nodeId: { in: nodeIds }, date: { gte: sixtyDaysAgo } },
    orderBy: [{ date: 'desc' }, { nodeId: 'asc' }],
    select: { nodeId: true, date: true, market: true, earnings: true, gpuSeconds: true, jobCount: true },
  })

  console.log(`=== Earning rows in last 60 days: ${earnings.length} ===`)
  if (earnings.length === 0) {
    console.log('No rows. The dashboard chart will be empty.')
    console.log('Run: pnpm --filter @a2e/api earnings:consolidate <YYYY-MM-DD>')
    console.log('for each day you want to backfill, OR wait for the nightly tick.')
    return
  }

  let total = 0
  for (const e of earnings) {
    const dateStr = e.date.toISOString().slice(0, 10)
    console.log(
      `  ${dateStr}  ${e.nodeId.slice(0, 12)}  ${e.market.padEnd(8)}  $${e.earnings.toFixed(2).padStart(8)}  uptime=${(e.gpuSeconds / 3600).toFixed(1)}h  jobs=${e.jobCount}`,
    )
    total += e.earnings
  }
  console.log('')
  console.log(`Total earnings logged: $${total.toFixed(2)}`)

  // Also report what the dashboard endpoint sees: rows in the last 30
  // days, since that's the chart's actual window.
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const chart30d = earnings.filter((e) => e.date >= thirtyDaysAgo)
  const distinctDays = new Set(chart30d.map((e) => e.date.toISOString().slice(0, 10))).size
  console.log('')
  console.log(`Last 30 days (what chart shows): ${chart30d.length} rows across ${distinctDays} distinct day(s)`)

  // Also: what does the Heartbeat table say for the same nodes?
  const heartbeats = await prisma.heartbeat.groupBy({
    by: ['nodeId'],
    where: { nodeId: { in: nodeIds }, timestamp: { gte: sixtyDaysAgo } },
    _count: true,
    _min: { timestamp: true },
    _max: { timestamp: true },
  })
  console.log('')
  console.log(`=== Heartbeat coverage per node (last 60d) ===`)
  for (const hb of heartbeats) {
    const minDay = hb._min.timestamp?.toISOString().slice(0, 10) ?? '?'
    const maxDay = hb._max.timestamp?.toISOString().slice(0, 10) ?? '?'
    console.log(`  ${hb.nodeId.slice(0, 12)}  rows=${hb._count}  range=${minDay} -> ${maxDay}`)
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
