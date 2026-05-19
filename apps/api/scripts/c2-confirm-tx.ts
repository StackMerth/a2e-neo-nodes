/**
 * C2 wave 2 test helper — flip txConfirmed=true on a ComputeRequest by
 * txHash. Lets you drive the allocator end-to-end with a throwaway tx
 * value without touching Postgres directly.
 *
 * Usage (Render API service Shell):
 *
 *   cd /opt/render/project/src
 *   pnpm --filter @a2e/api c2:confirm-tx <txHash>
 *
 * Example:
 *   pnpm --filter @a2e/api c2:confirm-tx TEST_TX_C2_INFERENCE_ASAD
 *
 * Prints the request id, current status, and what changed so you can
 * follow the allocator log lines.
 */

import { PrismaClient } from '@a2e/database'

const prisma = new PrismaClient()

async function main() {
  const txHash = process.argv[2]

  if (!txHash) {
    console.error('Usage: pnpm --filter @a2e/api c2:confirm-tx <txHash>')
    process.exit(1)
  }

  const request = await prisma.computeRequest.findFirst({
    where: { txHash },
    select: {
      id: true,
      status: true,
      gpuTier: true,
      workloadType: true,
      txConfirmed: true,
      createdAt: true,
    },
  })

  if (!request) {
    console.error(`No ComputeRequest found with txHash "${txHash}".`)
    process.exit(1)
  }

  console.log('Found ComputeRequest:')
  console.log(`  id           : ${request.id}`)
  console.log(`  gpuTier      : ${request.gpuTier}`)
  console.log(`  workloadType : ${request.workloadType}`)
  console.log(`  status       : ${request.status}`)
  console.log(`  txConfirmed  : ${request.txConfirmed} (before)`)
  console.log('')

  if (request.txConfirmed) {
    console.log('Already confirmed. No update needed.')
    return
  }

  await prisma.computeRequest.update({
    where: { id: request.id },
    data: { txConfirmed: true },
  })

  console.log(`Updated. txConfirmed = true.`)
  console.log('')
  console.log('Within ~10 seconds the compute-allocator should pick this up.')
  console.log('Tail the API logs for "[compute-allocator]" to watch the transition.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
