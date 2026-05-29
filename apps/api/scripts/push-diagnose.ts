/**
 * T2.1 — Web Push diagnostic.
 *
 * Reports:
 *   1) Whether VAPID env vars are present + valid
 *   2) How many PushSubscription rows are in the DB
 *   3) Per-user subscription breakdown (top 10 most-recent)
 *
 * Optional second-arg sends a real test push to a single user so you
 * can confirm end-to-end delivery (browser tray ping):
 *   pnpm --filter @a2e/api push-diagnose <userId>
 *
 * Run:   pnpm --filter @a2e/api push-diagnose
 */
import { prisma } from '@a2e/database'
import { isPushConfigured, sendPushToUser } from '../src/services/notification/push.js'

async function main(): Promise<void> {
  const arg = process.argv[2]

  // 1. Env check
  const hasPub = Boolean(process.env.VAPID_PUBLIC_KEY?.trim())
  const hasPriv = Boolean(process.env.VAPID_PRIVATE_KEY?.trim())
  const hasSubj = Boolean(process.env.VAPID_SUBJECT?.trim())
  const configured = isPushConfigured()

  console.log('VAPID env vars:')
  console.log(`  VAPID_PUBLIC_KEY:   ${hasPub ? 'set' : 'MISSING'}`)
  console.log(`  VAPID_PRIVATE_KEY:  ${hasPriv ? 'set' : 'MISSING'}`)
  console.log(`  VAPID_SUBJECT:      ${hasSubj ? 'set' : 'MISSING'}`)
  console.log(`  isPushConfigured:   ${configured}`)
  console.log()

  if (!configured) {
    console.log('Web push will be a no-op on this deploy. Generate VAPID keys and set the env vars.')
    console.log()
    console.log('To generate keys (run anywhere):')
    console.log('  pnpm --filter @a2e/api exec node -e "console.log(require(\'web-push\').generateVAPIDKeys())"')
    console.log()
    console.log('Then set in Render API service Environment tab:')
    console.log('  VAPID_PUBLIC_KEY=<publicKey from the output>')
    console.log('  VAPID_PRIVATE_KEY=<privateKey from the output>')
    console.log('  VAPID_SUBJECT=mailto:support@deaimarket.org')
    console.log()
  }

  // 2. Subscription count
  const total = await prisma.pushSubscription.count()
  const distinctUsers = await prisma.pushSubscription.findMany({
    distinct: ['userId'],
    select: { userId: true },
  })
  console.log(`PushSubscription rows in DB: ${total}`)
  console.log(`Distinct subscribed users:    ${distinctUsers.length}`)
  console.log()

  // 3. Per-user breakdown (10 most-recent)
  const recents = await prisma.pushSubscription.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
    include: {
      user: { select: { email: true, walletAddress: true, role: true } },
    },
  })
  if (recents.length > 0) {
    console.log('Most recent subscriptions:')
    for (const s of recents) {
      const who = s.user.email ?? s.user.walletAddress ?? s.userId
      const endpoint = s.endpoint.length > 60 ? s.endpoint.slice(0, 60) + '…' : s.endpoint
      console.log(`  ${s.userId.padEnd(28)} ${(s.user.role ?? '').padEnd(12)} ${who.padEnd(40)} ${s.userAgent ?? '(no ua)'}`)
      console.log(`    endpoint: ${endpoint}`)
      console.log(`    created:  ${s.createdAt.toISOString()}  lastSent: ${s.lastSentAt?.toISOString() ?? '(never)'}`)
    }
    console.log()
  }

  // 4. Optional: send a real test push
  if (arg) {
    console.log(`Sending test push to userId=${arg}...`)
    if (!configured) {
      console.log('Push is not configured; cannot send.')
      return
    }
    const result = await sendPushToUser(arg, {
      title: 'Test push',
      body: `Diagnostic push at ${new Date().toLocaleString()}. If you see this, web push is working.`,
      url: '/buyer/balance',
      tag: 'push-diagnostic',
    })
    console.log(`Result: sent=${result.sent}  pruned=${result.pruned}`)
    if (result.sent === 0) {
      console.log('No active subscriptions found for that userId. Has the user toggled push ON in this browser?')
    }
  } else {
    console.log('Tip: run with a userId arg to fire a real test push:')
    console.log('  pnpm --filter @a2e/api push-diagnose <userId>')
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
