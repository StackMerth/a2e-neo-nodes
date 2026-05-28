/**
 * One-shot data fix: lowercase every User.email row that has any
 * uppercase character. After 2026-05-20 the auth layer normalizes
 * on signup + login so new rows always land lowercase, but pre-fix
 * rows may still have mixed case. A user who signed up as
 * "Asad@m.com" and then tries to log in with "asad@m.com" hits an
 * email-not-found error.
 *
 * Why a script and not a SQL UPDATE:
 *   - Need to handle the unique-constraint collision case: two users
 *     with case-different emails ("Asad@m.com" + "asad@m.com") cannot
 *     both lowercase to the same value. Script detects + reports the
 *     conflict so you can merge / pick a winner manually.
 *   - Reports exactly which rows changed for an audit log.
 *
 * Usage (Render API service Shell):
 *
 *   cd /opt/render/project/src
 *
 *   # Dry run: list every row that would change without writing
 *   pnpm --filter @a2e/api users:lowercase-emails -- --dry-run
 *
 *   # Apply: actually write the lowercased emails
 *   pnpm --filter @a2e/api users:lowercase-emails -- --apply
 */

import { PrismaClient } from '@a2e/database'

const prisma = new PrismaClient()

async function main() {
  const args = process.argv.slice(2).filter(a => a !== '--')
  const dryRun = args.includes('--dry-run')
  const apply = args.includes('--apply')

  if (!dryRun && !apply) {
    console.error('Usage:')
    console.error('  pnpm --filter @a2e/api users:lowercase-emails -- --dry-run')
    console.error('  pnpm --filter @a2e/api users:lowercase-emails -- --apply')
    process.exit(1)
  }

  // Pull every User with a non-null email. Filter in JS to find rows
  // where the lowercased form differs from the stored form. (Postgres
  // could express this with `WHERE email <> LOWER(email)` but using
  // Prisma keeps the script portable across the test SQLite case too.)
  const users = await prisma.user.findMany({
    where: { email: { not: null } },
    select: { id: true, email: true, createdAt: true },
  })

  const mixedCase = users
    .filter(u => u.email && u.email !== u.email.toLowerCase())
    .map(u => ({
      id: u.id,
      original: u.email as string,
      lowered: (u.email as string).toLowerCase(),
      createdAt: u.createdAt,
    }))

  if (mixedCase.length === 0) {
    console.log('✅ No mixed-case email rows found. Nothing to fix.')
    return
  }

  console.log(`Found ${mixedCase.length} mixed-case email row(s):`)
  for (const m of mixedCase) {
    console.log(`  ${m.id}  "${m.original}"  ->  "${m.lowered}"  (created ${m.createdAt.toISOString().slice(0, 10)})`)
  }
  console.log('')

  // Detect collisions: two distinct users with the same lowercased
  // email. Lowercase-and-update for both would fail the unique
  // constraint on User.email.
  const byLowered = new Map<string, string[]>()
  for (const u of users) {
    if (!u.email) continue
    const key = u.email.toLowerCase()
    const arr = byLowered.get(key) ?? []
    arr.push(u.id)
    byLowered.set(key, arr)
  }
  const collisions = Array.from(byLowered.entries())
    .filter(([, ids]) => ids.length > 1)
  if (collisions.length > 0) {
    console.log('⚠️  Collisions detected (multiple users share the same lowercased email):')
    for (const [lowered, ids] of collisions) {
      console.log(`  "${lowered}" is held by ${ids.length} users: ${ids.join(', ')}`)
    }
    console.log('')
    console.log('Resolve these manually before applying (decide which user keeps the email, delete or rename the rest).')
    console.log('Skipping the affected rows in the --apply step.')
    console.log('')
  }

  if (dryRun) {
    console.log(`Dry run complete. Pass --apply to write ${mixedCase.length} row(s).`)
    return
  }

  // Apply mode. Skip any row whose lowered form is a collision target.
  const collidedLowered = new Set(collisions.map(([k]) => k))
  let updated = 0
  let skipped = 0
  for (const m of mixedCase) {
    if (collidedLowered.has(m.lowered)) {
      skipped++
      continue
    }
    await prisma.user.update({
      where: { id: m.id },
      data: { email: m.lowered },
    })
    updated++
  }

  console.log(`✅ Updated ${updated} row(s).`)
  if (skipped > 0) {
    console.log(`Skipped ${skipped} row(s) due to collisions — resolve those manually.`)
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
