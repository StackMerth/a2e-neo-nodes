/**
 * C3 wave 2 test helper — seed N days of synthetic Heartbeat rows for
 * an operator so the dashboard forecast card crosses the 5-day cold-
 * start gate and renders the mature "$X projected" view.
 *
 * Why Heartbeats, not Earnings: the forecast helper
 * (services/earnings/forecast.ts) computes daily earnings via
 * getDailyUptimeBreakdown, which derives them from HEARTBEAT rows
 * (rate per hour × seconds-online). The Earning table is a separate
 * historical ledger that the forecast does not read. Seeding the
 * Earning table directly leaves daysAnalyzed unchanged.
 *
 * Heartbeats are spaced 60s apart (under the 90s offline threshold in
 * uptime-calculator.ts), so each day's 1440 rows count as continuous
 * 24h uptime. The forecast picks up daysAnalyzed = N once it sees N
 * full days of heartbeats.
 *
 * Usage (Render API service Shell):
 *
 *   cd /opt/render/project/src
 *   pnpm --filter @a2e/api c3:seed-forecast <operator-email> [days]
 *
 * Examples:
 *   pnpm --filter @a2e/api c3:seed-forecast asad@m.com
 *   pnpm --filter @a2e/api c3:seed-forecast asad@m.com 7
 *
 * Defaults: days=7. Each day gets 1440 heartbeats backdated to that
 * UTC day. Existing Heartbeat rows are NOT touched - we only insert
 * additional ones, so re-runs are safe.
 *
 * If the operator has no node, creates a throwaway test-c3-fnode-* node.
 * c2c3:cleanup will drop that node + cascade its heartbeats.
 */

import { PrismaClient } from '@a2e/database'

const prisma = new PrismaClient()

async function main() {
  const email = process.argv[2]
  const days = parseInt(process.argv[3] ?? '7', 10)

  if (!email) {
    console.error('Usage: pnpm --filter @a2e/api c3:seed-forecast <operator-email> [days]')
    process.exit(1)
  }
  if (!Number.isFinite(days) || days < 1 || days > 30) {
    console.error('days must be an integer between 1 and 30')
    process.exit(1)
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, nodeRunner: { select: { id: true, name: true } } },
  })

  if (!user) {
    console.error(`No User found with email "${email}".`)
    process.exit(1)
  }
  if (!user.nodeRunner) {
    console.error(`User ${email} has no NodeRunner profile. Run onboarding first.`)
    process.exit(1)
  }

  let node = await prisma.node.findFirst({
    where: { nodeRunnerId: user.nodeRunner.id },
    select: { id: true, gpuTier: true },
  })

  if (!node) {
    const suffix = Math.random().toString(36).slice(2, 8)
    const created = await prisma.node.create({
      data: {
        id: `test-c3-fnode-${suffix}`,
        walletAddress: `TEST_WALLET_C3_FORECAST_${suffix.toUpperCase()}`,
        gpuTier: 'H100',
        nodeType: 'BYOG',
        status: 'ONLINE',
        agentVersion: '1.0.0-test',
        lastHeartbeat: new Date(),
        nodeRunnerId: user.nodeRunner.id,
        region: 'US-EAST',
      },
      select: { id: true, gpuTier: true },
    })
    node = created
    console.log(`Created throwaway test node ${node.id} to attach heartbeats to.`)
  } else {
    console.log(`Using existing node ${node.id} (tier=${node.gpuTier}).`)
  }

  // 60-second cadence keeps gaps under the 90s offline threshold in
  // uptime-calculator.ts, so every minute of fake heartbeats counts as
  // a minute of real uptime. 1440 rows per day = 24h continuous.
  const HEARTBEAT_INTERVAL_SECONDS = 60
  const HEARTBEATS_PER_DAY = 24 * 60 // 1440
  let totalInserted = 0

  for (let i = 1; i <= days; i++) {
    const dayStart = new Date()
    dayStart.setUTCHours(0, 0, 0, 0)
    dayStart.setUTCDate(dayStart.getUTCDate() - i)

    const rows = []
    for (let m = 0; m < HEARTBEATS_PER_DAY; m++) {
      const ts = new Date(dayStart.getTime() + m * HEARTBEAT_INTERVAL_SECONDS * 1000)
      rows.push({
        nodeId: node.id,
        timestamp: ts,
        gpuUtilization: 65 + Math.floor(Math.random() * 20),
        gpuTemperature: 55 + Math.floor(Math.random() * 15),
      })
    }
    const result = await prisma.heartbeat.createMany({
      data: rows,
      skipDuplicates: true,
    })
    totalInserted += result.count
    console.log(`Day -${i} (${dayStart.toISOString().slice(0, 10)}): inserted ${result.count} heartbeats`)
  }

  console.log('')
  console.log(`Seeded ${totalInserted} heartbeat(s) across ${days} day(s) for ${user.nodeRunner.name}.`)
  console.log(`Node id used: ${node.id} (tier=${node.gpuTier}).`)
  console.log('')
  console.log('The forecast helper will now see daysAnalyzed = number of seeded days +')
  console.log('any prior real earning days. Refresh https://user.tokenos.ai/dashboard;')
  console.log('the forecast card should flip from cold-start to the mature view.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
