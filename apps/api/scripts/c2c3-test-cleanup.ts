/**
 * C2 / C3 wave 2 test helper — remove all data the c2:seed-node,
 * c2:confirm-tx, and c3:seed-forecast scripts created. Idempotent.
 *
 * Usage (Render API service Shell):
 *
 *   cd /opt/render/project/src
 *   pnpm --filter @a2e/api c2c3:cleanup
 *
 * What it drops, by marker:
 *   - Node rows with id starting with 'test-c2-' or 'test-c3-'
 *   - Earning rows with walletAddress = 'TEST_WALLET_C3_FORECAST'
 *   - ComputeRequest rows with txHash starting with 'TEST_TX_' (so the
 *     negative test rows go too)
 *
 * Prints counts so you know nothing real got touched.
 */

import { PrismaClient } from '@a2e/database'

const prisma = new PrismaClient()

async function main() {
  const earningsCleanup = await prisma.earning.deleteMany({
    where: { walletAddress: 'TEST_WALLET_C3_FORECAST' },
  })

  const requestsCleanup = await prisma.computeRequest.deleteMany({
    where: { txHash: { startsWith: 'TEST_TX_' } },
  })

  // Heartbeats hang off nodes via Node onDelete=Cascade in the schema,
  // so dropping the test nodes drops their heartbeats / jobs too.
  const nodesCleanup = await prisma.node.deleteMany({
    where: {
      OR: [
        { id: { startsWith: 'test-c2-' } },
        { id: { startsWith: 'test-c3-' } },
      ],
    },
  })

  console.log('Cleanup summary:')
  console.log(`  ComputeRequests dropped (TEST_TX_*): ${requestsCleanup.count}`)
  console.log(`  Earnings dropped       (TEST_WALLET_C3_FORECAST): ${earningsCleanup.count}`)
  console.log(`  Nodes dropped          (test-c2-* / test-c3-*): ${nodesCleanup.count}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
