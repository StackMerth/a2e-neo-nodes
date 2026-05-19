/**
 * C2 wave 2 test helper — seed a consumer-tier node attached to an
 * operator account so the allocator + marketplace badge tests can run
 * without touching Postgres directly.
 *
 * Usage (Render API service Shell):
 *
 *   cd /opt/render/project/src
 *   pnpm --filter @a2e/api c2:seed-node <operator-email> [tier]
 *
 * Examples:
 *   pnpm --filter @a2e/api c2:seed-node asad@m.com
 *   pnpm --filter @a2e/api c2:seed-node asad@m.com RTX_3090
 *
 * Defaults: tier=RTX_4090, isResidential=true. Every seeded node uses
 * an id prefix of 'test-c2-' so the cleanup script can find them.
 */

import { PrismaClient, type GpuTier } from '@a2e/database'

const prisma = new PrismaClient()

async function main() {
  const email = process.argv[2]
  const tierArg = (process.argv[3] ?? 'RTX_4090').toUpperCase() as GpuTier

  if (!email) {
    console.error('Usage: pnpm --filter @a2e/api c2:seed-node <operator-email> [tier]')
    process.exit(1)
  }

  const validTiers: GpuTier[] = ['CONSUMER', 'RTX_4090', 'RTX_3090']
  if (!validTiers.includes(tierArg)) {
    console.error(`Invalid tier "${tierArg}". Expected one of: ${validTiers.join(', ')}`)
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
    console.error(`User ${email} has no NodeRunner profile yet. Sign in and complete operator onboarding first.`)
    process.exit(1)
  }

  const suffix = Math.random().toString(36).slice(2, 8)
  const nodeId = `test-c2-${tierArg.toLowerCase()}-${suffix}`
  const walletAddress = `TEST_WALLET_${nodeId.toUpperCase()}`

  const node = await prisma.node.create({
    data: {
      id: nodeId,
      walletAddress,
      gpuTier: tierArg,
      nodeType: 'BYOG',
      status: 'ONLINE',
      agentVersion: '1.0.0-test',
      lastHeartbeat: new Date(),
      pendingDeletion: false,
      isResidential: true,
      nodeRunnerId: user.nodeRunner.id,
      region: 'US-EAST',
    },
  })

  console.log('Seeded test node:')
  console.log(`  id            : ${node.id}`)
  console.log(`  operator      : ${user.nodeRunner.name} (${email})`)
  console.log(`  gpuTier       : ${node.gpuTier}`)
  console.log(`  isResidential : ${node.isResidential}`)
  console.log(`  status        : ${node.status}`)
  console.log('')
  console.log('Next: submit an INFERENCE rental for this tier from the portal,')
  console.log('      then run "pnpm --filter @a2e/api c2:confirm-tx <txHash>"')
  console.log('      to flip the request to confirmed so the allocator picks it up.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
