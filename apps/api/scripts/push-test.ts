/**
 * Phase 5 / wave-3: fire a manual Web Push to verify the VAPID +
 * service-worker pipeline end-to-end without waiting for a real
 * notification event.
 *
 * Usage (Render API service Shell):
 *
 *   pnpm --filter @a2e/api push:test <operator-email>
 *
 * Looks up the user by email, sends a test notification to every
 * push subscription they have, prints the result.
 */

import { PrismaClient } from '@a2e/database'
import { sendPushToUser, isPushConfigured } from '../src/services/notification/push.js'

const prisma = new PrismaClient()

async function main() {
  const email = process.argv[2]
  if (!email) {
    console.error('Usage: pnpm --filter @a2e/api push:test <operator-email>')
    process.exit(1)
  }

  if (!isPushConfigured()) {
    console.error(
      '[push-test] VAPID is not configured. Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT on the Render API service env vars first.',
    )
    process.exit(1)
  }

  const user = await prisma.user.findFirst({
    where: { email },
    select: { id: true, email: true },
  })
  if (!user) {
    console.error(`[push-test] No user found with email ${email}`)
    process.exit(1)
  }

  const subCount = await prisma.pushSubscription.count({
    where: { userId: user.id },
  })
  if (subCount === 0) {
    console.error(
      `[push-test] User ${email} has no push subscriptions. Open /settings on a browser that's signed in as this user, click Enable on the Browser Notifications card, then re-run this script.`,
    )
    process.exit(1)
  }

  console.log(`[push-test] User ${email} has ${subCount} subscription(s). Sending test push...`)

  const result = await sendPushToUser(user.id, {
    title: 'Test push from TokenOS_DeAI',
    body: 'If you see this OS-level notification, Web Push is working end-to-end.',
    url: '/dashboard',
    tag: 'push-test',
  })

  console.log(`[push-test] sent=${result.sent} pruned=${result.pruned}`)
  if (result.sent === 0) {
    console.warn('[push-test] No pushes delivered — likely all endpoints are stale (pruned above) or the browser/OS dropped the payload silently.')
  } else {
    console.log('[push-test] OK. Check your browser / OS notification tray.')
  }
}

main()
  .catch((err) => {
    console.error('[push-test] error:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
