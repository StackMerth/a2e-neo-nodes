/*
 * Backfill script for the dual-identity flags added to User.
 * Run once after `prisma db push` adds the isBuyer / isNodeRunner /
 * isAdmin columns. New columns default to false; this script
 * derives values from each user's existing role:
 *
 *   role=COMPUTE_BUYER  -> isBuyer=true
 *   role=NODE_RUNNER    -> isNodeRunner=true
 *   role=CUSTOMER       -> isBuyer=true   (legacy alias)
 *   role=ADMIN          -> isAdmin=true   (admins can act in any
 *                          mode; UI grants buyer + runner views too)
 *
 * Usage:
 *   pnpm --filter @a2e/database tsx scripts/backfill-dual-role-flags.ts
 *   or
 *   cd packages/database && npx tsx scripts/backfill-dual-role-flags.ts
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('Backfilling dual-role flags for existing users...')

  const buyers = await prisma.user.updateMany({
    where: { role: { in: ['COMPUTE_BUYER', 'CUSTOMER'] } },
    data: { isBuyer: true },
  })
  console.log(`  isBuyer=true on ${buyers.count} buyer/legacy-customer rows`)

  const runners = await prisma.user.updateMany({
    where: { role: 'NODE_RUNNER' },
    data: { isNodeRunner: true },
  })
  console.log(`  isNodeRunner=true on ${runners.count} node-runner rows`)

  const admins = await prisma.user.updateMany({
    where: { role: 'ADMIN' },
    data: { isAdmin: true, isBuyer: true, isNodeRunner: true },
  })
  console.log(`  isAdmin+all-flags=true on ${admins.count} admin rows`)

  console.log('Backfill complete.')
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
