/**
 * C3 wave 2 test helper — seed N days of Earning rows for an operator
 * so the dashboard forecast card has enough history (>=5 active days)
 * to render the mature "X projected" view instead of the cold-start
 * placeholder.
 *
 * Usage (Render API service Shell):
 *
 *   cd /opt/render/project/src
 *   pnpm --filter @a2e/api c3:seed-forecast <operator-email> [days] [perDay]
 *
 * Examples:
 *   pnpm --filter @a2e/api c3:seed-forecast asad@m.com
 *   pnpm --filter @a2e/api c3:seed-forecast asad@m.com 7 50
 *
 * Defaults: days=7, perDay=$50. Rows are backdated 1..days days ago and
 * marked with walletAddress=TEST_WALLET_C3_FORECAST so the cleanup script
 * can drop them later.
 *
 * If the operator has no node, the script creates a throwaway test node
 * to attach the earnings to (Earning.nodeId is required and references
 * a real Node row).
 */

import { PrismaClient } from '@a2e/database'

const prisma = new PrismaClient()

async function main() {
  const email = process.argv[2]
  const days = parseInt(process.argv[3] ?? '7', 10)
  const perDay = parseFloat(process.argv[4] ?? '50')

  if (!email) {
    console.error('Usage: pnpm --filter @a2e/api c3:seed-forecast <operator-email> [days] [perDay]')
    process.exit(1)
  }
  if (!Number.isFinite(days) || days < 1 || days > 30) {
    console.error('days must be an integer between 1 and 30')
    process.exit(1)
  }
  if (!Number.isFinite(perDay) || perDay <= 0) {
    console.error('perDay must be a positive number')
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

  // Earning.nodeId is required. Reuse an existing node when one exists;
  // otherwise create a throwaway test node so the FK is satisfied.
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
    console.log(`Created throwaway test node ${node.id} to attach earnings to.`)
  } else {
    console.log(`Using existing node ${node.id} (tier=${node.gpuTier}).`)
  }

  let inserted = 0
  for (let i = 1; i <= days; i++) {
    const date = new Date()
    date.setUTCHours(0, 0, 0, 0)
    date.setUTCDate(date.getUTCDate() - i)

    try {
      await prisma.earning.create({
        data: {
          nodeId: node.id,
          walletAddress: `TEST_WALLET_C3_FORECAST`,
          gpuTier: node.gpuTier,
          date,
          market: 'INTERNAL',
          earnings: perDay,
          gpuSeconds: 86_400,
          jobCount: 1,
        },
      })
      inserted++
    } catch (e) {
      // @@unique([nodeId, date, market]) — skip if a row already exists
      // for that day, otherwise re-running the script doubles up.
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('Unique constraint')) {
        console.log(`Day -${i}: row already exists, skipped`)
      } else {
        throw e
      }
    }
  }

  console.log('')
  console.log(`Seeded ${inserted} day(s) of earnings at $${perDay}/day for ${user.nodeRunner.name}.`)
  console.log(`Total fake earnings on the books: $${(inserted * perDay).toFixed(2)}`)
  console.log('')
  console.log('Now load https://user.tokenos.ai/dashboard as this operator.')
  console.log('The forecast card should render "$X projected" with a range,')
  console.log(`approximately $${(perDay * 30).toFixed(0)} (perDay * 30) +/- 15%.`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
