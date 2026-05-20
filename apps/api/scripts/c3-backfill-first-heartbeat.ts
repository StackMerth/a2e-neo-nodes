/**
 * C3 wave 2 helper — backfill NodeRunner.firstHeartbeatAt for an
 * operator whose row pre-dates the firstHeartbeatAt field (or whose
 * onboarding flow didn't set it).
 *
 * The weekly digest filters out any NodeRunner with firstHeartbeatAt=
 * null because those rows shouldn't receive a real operator email yet.
 * This script picks the earliest Heartbeat across all the operator's
 * nodes and uses that timestamp; if no heartbeats exist anywhere, it
 * falls back to NOW().
 *
 * Usage (Render API service Shell):
 *
 *   cd /opt/render/project/src
 *   pnpm --filter @a2e/api c3:backfill-first-heartbeat <operator-email>
 *
 * Example:
 *   pnpm --filter @a2e/api c3:backfill-first-heartbeat asad@m.com
 *
 * Idempotent. If firstHeartbeatAt is already set, the script reports
 * the existing value and exits without overwriting.
 */

import { PrismaClient } from '@a2e/database'

const prisma = new PrismaClient()

async function main() {
  const email = process.argv[2]
  if (!email) {
    console.error('Usage: pnpm --filter @a2e/api c3:backfill-first-heartbeat <operator-email>')
    process.exit(1)
  }

  const nr = await prisma.nodeRunner.findFirst({
    where: { email },
    select: { id: true, name: true, firstHeartbeatAt: true },
  })

  if (!nr) {
    console.error(`No NodeRunner found with email "${email}".`)
    process.exit(1)
  }

  if (nr.firstHeartbeatAt) {
    console.log(`firstHeartbeatAt already set: ${nr.firstHeartbeatAt.toISOString()}`)
    console.log('Nothing to do. Exiting.')
    return
  }

  const earliest = await prisma.heartbeat.findFirst({
    where: { node: { nodeRunnerId: nr.id } },
    orderBy: { timestamp: 'asc' },
    select: { timestamp: true },
  })

  const stamp = earliest?.timestamp ?? new Date()
  const source = earliest ? `earliest Heartbeat row (${earliest.timestamp.toISOString()})` : 'NOW() (no heartbeats exist yet)'

  const updated = await prisma.nodeRunner.update({
    where: { id: nr.id },
    data: { firstHeartbeatAt: stamp },
    select: { firstHeartbeatAt: true },
  })

  console.log(`Backfilled ${nr.name} (${email})`)
  console.log(`  Source              : ${source}`)
  console.log(`  firstHeartbeatAt now: ${updated.firstHeartbeatAt?.toISOString()}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
