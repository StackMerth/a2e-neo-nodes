/**
 * Admin / test helper — flip User.emailVerified=true for a given user
 * without requiring them to click a verification link. Useful for:
 *   - Test accounts with placeholder emails (asad@m.com etc.) that
 *     can't receive real mail
 *   - Production accounts where the operator legitimately can't
 *     receive verification email (corporate firewall, deliverability
 *     issue with their domain) and has provided proof of identity
 *     through another channel
 *
 * Usage (Render API service Shell):
 *   pnpm --filter @a2e/api auth:force-verify <user-email>
 *
 * Example:
 *   pnpm --filter @a2e/api auth:force-verify asad@m.com
 *
 * Also clears any outstanding verification token + expiry so a future
 * legitimate verification attempt 404s cleanly instead of pointing at
 * a stale row.
 */

import { PrismaClient } from '@a2e/database'

const prisma = new PrismaClient()

async function main() {
  const email = process.argv[2]
  if (!email) {
    console.error('Usage: pnpm --filter @a2e/api auth:force-verify <user-email>')
    process.exit(1)
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, emailVerified: true },
  })

  if (!user) {
    console.error(`No User found with email "${email}".`)
    process.exit(1)
  }

  if (user.emailVerified) {
    console.log(`User ${email} is already verified. Nothing to do.`)
    return
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerified: true,
      emailVerificationToken: null,
      emailVerificationExpiry: null,
    },
  })

  console.log(`✅ Force-verified ${email}.`)
  console.log('Next dashboard load will drop the "Verify your email" banner')
  console.log('and unlock withdrawals + the weekly compute report.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
