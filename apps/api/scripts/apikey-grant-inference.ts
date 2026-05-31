/**
 * E2.2 — one-shot backfill that grants 'inference:write' to every
 * existing ApiKey row that doesn't already have it. Run once on
 * Render after deploying E2.2 so all in-the-wild buyer keys can hit
 * /v1/chat/completions without a rotation.
 *
 * Idempotent. Re-running it does nothing on already-updated rows.
 *
 *   pnpm --filter @a2e/api apikey:grant-inference
 *
 * For a single user:
 *   pnpm --filter @a2e/api apikey:grant-inference <email>
 */
import { prisma } from '@a2e/database'

async function main(): Promise<void> {
  const targetEmail = process.argv[2]

  let targetUserId: string | undefined
  if (targetEmail) {
    const user = await prisma.user.findUnique({
      where: { email: targetEmail },
      select: { id: true },
    })
    if (!user) {
      console.log(`No user found with email ${targetEmail}`)
      process.exit(1)
    }
    targetUserId = user.id
  }

  const keys = await prisma.apiKey.findMany({
    where: {
      revokedAt: null,
      ...(targetUserId ? { userId: targetUserId } : {}),
    },
    select: { id: true, userId: true, name: true, permissions: true },
  })

  if (keys.length === 0) {
    console.log('No active API keys found.')
    return
  }

  let updated = 0
  let skipped = 0
  for (const k of keys) {
    if (k.permissions.includes('inference:write')) {
      skipped += 1
      continue
    }
    await prisma.apiKey.update({
      where: { id: k.id },
      data: { permissions: [...k.permissions, 'inference:write'] },
    })
    updated += 1
    console.log(`  + granted inference:write to "${k.name}" (user ${k.userId})`)
  }

  console.log()
  console.log(`Done. ${updated} key(s) updated, ${skipped} already had it.`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
