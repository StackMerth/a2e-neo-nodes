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
 *   - ComputeRequest rows with txHash starting with 'TEST_TX_' (so the
 *     negative test rows go too)
 *   - Node rows with id starting with 'test-c2-' or 'test-c3-'
 *
 * Earnings, Heartbeats, and Jobs that hang off a deleted Node cascade
 * automatically (onDelete=Cascade on the relation), so no separate
 * Earning delete is needed — and Earning doesn't carry a walletAddress
 * field anyway, so an explicit delete would 400.
 *
 * Prints counts so you know nothing real got touched.
 */

import { PrismaClient } from '@a2e/database'

const prisma = new PrismaClient()

async function main() {
  const requestsCleanup = await prisma.computeRequest.deleteMany({
    where: { txHash: { startsWith: 'TEST_TX_' } },
  })

  const nodesCleanup = await prisma.node.deleteMany({
    where: {
      OR: [
        { id: { startsWith: 'test-c2-' } },
        { id: { startsWith: 'test-c3-' } },
      ],
    },
  })

  console.log('Cleanup summary:')
  console.log(`  ComputeRequests dropped (TEST_TX_*):           ${requestsCleanup.count}`)
  console.log(`  Nodes dropped           (test-c2-* / test-c3-*): ${nodesCleanup.count}`)
  console.log('  Earnings / Heartbeats / Jobs cascade with their parent Node.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
