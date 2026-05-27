/**
 * Test helper for the Checkpoint Workspace restore UI. Lists a
 * buyer's recent ComputeRequests + their checkpoint state, and
 * (optionally) flips a specified rental to checkpointStatus=READY
 * with a synthetic checkpoint id so the Restore-from-checkpoint
 * picker shows up on /buyer/request.
 *
 * Why a script: prisma db execute runs SQL but never prints SELECT
 * results ("Script executed successfully"), making it useless for
 * inspecting state. This wraps a Prisma Client query that actually
 * returns rows.
 *
 * Usage (Render API service Shell):
 *
 *   cd /opt/render/project/src
 *
 *   # List the buyer's most recent 10 rentals + checkpoint state
 *   pnpm --filter @a2e/api checkpoint:fake-ready -- --user asad@m.com
 *
 *   # Flip a specific rental to READY (will print confirmation)
 *   pnpm --filter @a2e/api checkpoint:fake-ready -- --user asad@m.com --flip cmp...
 *
 *   # Flip the LATEST rental to READY (skips picking an ID)
 *   pnpm --filter @a2e/api checkpoint:fake-ready -- --user asad@m.com --flip-latest
 */

import { PrismaClient } from '@a2e/database'

const prisma = new PrismaClient()

function getArg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  if (i < 0) return undefined
  return args[i + 1]
}

async function main() {
  const args = process.argv.slice(2).filter(a => a !== '--')
  const email = getArg(args, 'user')
  const flipId = getArg(args, 'flip')
  const flipLatest = args.includes('--flip-latest')

  if (!email) {
    console.error('Usage: pnpm --filter @a2e/api checkpoint:fake-ready -- --user <email> [--flip <id> | --flip-latest]')
    process.exit(1)
  }

  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) {
    console.error(`No user with email ${email}`)
    process.exit(1)
  }

  const rentals = await prisma.computeRequest.findMany({
    where: { userId: user.id },
    orderBy: { requestedAt: 'desc' },
    take: 10,
    select: {
      id: true,
      gpuTier: true,
      status: true,
      checkpointStatus: true,
      lastCheckpointId: true,
      checkpointReadyAt: true,
      requestedAt: true,
    },
  })

  if (rentals.length === 0) {
    console.log(`No ComputeRequests found for ${email}.`)
    return
  }

  console.log(`=== Recent rentals for ${email} (${rentals.length}) ===`)
  for (const r of rentals) {
    const ageMin = Math.floor((Date.now() - r.requestedAt.getTime()) / 60000)
    console.log(`  ${r.id}  tier=${r.gpuTier}  status=${r.status.padEnd(10)}  cp=${(r.checkpointStatus ?? 'NONE').padEnd(8)}  lastCp=${r.lastCheckpointId ?? 'null'}  (${ageMin}m old)`)
  }

  if (!flipId && !flipLatest) {
    console.log('')
    console.log('Pass --flip <id> or --flip-latest to mark one as READY for testing.')
    return
  }

  const target = flipId ?? rentals[0]?.id
  if (!target) {
    console.error('Nothing to flip.')
    process.exit(1)
  }
  const owned = rentals.find(r => r.id === target)
  if (!owned) {
    console.error(`Rental ${target} not in the recent 10 for ${email}. Pass an exact id.`)
    process.exit(1)
  }

  const fakeCpId = `test-cp-${Date.now().toString(36)}`
  await prisma.computeRequest.update({
    where: { id: target },
    data: {
      checkpointStatus: 'READY',
      lastCheckpointId: fakeCpId,
      checkpointReadyAt: new Date(),
    },
  })
  console.log('')
  console.log(`✅ Flipped ${target} → checkpointStatus=READY, lastCheckpointId=${fakeCpId}`)
  console.log('   /buyer/request should now show "Restore from a previous workspace".')
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
