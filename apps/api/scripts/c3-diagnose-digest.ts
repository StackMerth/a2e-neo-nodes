/**
 * C3 wave 2 diagnostic — show why a given NodeRunner is or isn't a
 * digest candidate. Prints every field the weekly-digest tick filters
 * on, then runs the same eligibility check and reports which clauses
 * passed and which failed.
 *
 * Usage (Render API service Shell):
 *
 *   cd /opt/render/project/src
 *   pnpm --filter @a2e/api c3:diagnose-digest <operator-email>
 *
 * Example:
 *   pnpm --filter @a2e/api c3:diagnose-digest asad@m.com
 */

import { PrismaClient } from '@a2e/database'

const prisma = new PrismaClient()

async function main() {
  const email = process.argv[2]
  if (!email) {
    console.error('Usage: pnpm --filter @a2e/api c3:diagnose-digest <operator-email>')
    process.exit(1)
  }

  const nr = await prisma.nodeRunner.findFirst({
    where: { email },
    select: {
      id: true,
      name: true,
      email: true,
      digestOptedOut: true,
      firstHeartbeatAt: true,
      createdAt: true,
      user: { select: { emailVerified: true } },
    },
  })

  if (!nr) {
    console.error(`No NodeRunner found with email "${email}".`)
    process.exit(1)
  }

  console.log('=== NodeRunner state ===')
  console.log(`  id               : ${nr.id}`)
  console.log(`  name             : ${nr.name}`)
  console.log(`  email            : ${nr.email}`)
  console.log(`  emailVerified    : ${nr.user?.emailVerified ?? 'null (no linked User)'}`)
  console.log(`  digestOptedOut   : ${nr.digestOptedOut}`)
  console.log(`  firstHeartbeatAt : ${nr.firstHeartbeatAt?.toISOString() ?? 'null'}`)
  console.log(`  createdAt        : ${nr.createdAt.toISOString()}`)

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const recentHeartbeats = await prisma.node.count({
    where: { nodeRunnerId: nr.id, lastHeartbeat: { gte: thirtyDaysAgo } },
  })

  console.log('')
  console.log('=== Eligibility check (weekly-digest where clause) ===')
  const emailOk = nr.email != null
  const verifiedOk = nr.user?.emailVerified === true
  const firstHbOk = nr.firstHeartbeatAt != null
  const optInOk = nr.digestOptedOut === false
  const activeOk = recentHeartbeats > 0

  const fmt = (ok: boolean) => (ok ? '✅' : '❌')
  console.log(`  ${fmt(emailOk)}  email not null              : ${emailOk}`)
  console.log(`  ${fmt(verifiedOk)}  user.emailVerified == true  : ${verifiedOk}`)
  console.log(`  ${fmt(firstHbOk)}  firstHeartbeatAt not null   : ${firstHbOk}`)
  console.log(`  ${fmt(optInOk)}  digestOptedOut == false     : ${optInOk}`)
  console.log(`  ${fmt(activeOk)}  >=1 node hb in last 30 days : ${activeOk} (count=${recentHeartbeats})`)

  const eligible = emailOk && verifiedOk && firstHbOk && optInOk && activeOk
  console.log('')
  console.log(`Result: ${eligible ? '✅ eligible — digest would fire' : '❌ excluded — digest skips this operator'}`)
  if (!eligible) {
    console.log('')
    console.log('Suggested fixes for failed clauses:')
    if (!verifiedOk) {
      console.log('  - Email is not verified. The operator needs to click the link in')
      console.log('    the verification email (auto-sent at signup). Resend via:')
      console.log('    POST /v1/portal/auth/send-verification (authenticated)')
      console.log('    OR for tests: update User.emailVerified=true directly.')
    }
    if (!firstHbOk) {
      console.log('  - firstHeartbeatAt is null. Run:')
      console.log(`    UPDATE "NodeRunner" SET "firstHeartbeatAt" = NOW() WHERE id = '${nr.id}';`)
      console.log('    ...or use the c3:backfill-first-heartbeat script.')
    }
    if (!optInOk) {
      console.log('  - digestOptedOut is true. Sign in to user.tokenos.ai/payouts/settings')
      console.log('    and re-check the "Send me the weekly summary email" box.')
    }
    if (!activeOk) {
      console.log('  - No recent heartbeats. Run c3:seed-forecast to populate them.')
    }
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
