/**
 * C3 wave 2: manual weekly-digest trigger.
 *
 * Usage:
 *   pnpm --filter @a2e/api digest:run-once                 # every operator
 *   pnpm --filter @a2e/api digest:run-once user@host.com   # one operator
 *
 * Bypasses the BullMQ schedule and invokes runWeeklyDigestTick directly
 * so engineers can verify the digest pipeline (template, forecast,
 * uptime warnings, SMTP delivery) without waiting a week. Requires the
 * same env vars the API needs (DATABASE_URL, SMTP_*) — easiest to run
 * inside `pnpm --filter @a2e/api dev` shell or on the Render API service.
 */

import { prisma } from '@a2e/database'
import { runWeeklyDigestTick } from '../src/jobs/weekly-digest.js'

async function main() {
  const targetEmail = process.argv[2]
  if (targetEmail) {
    console.log(`[digest:run-once] firing digest for operator: ${targetEmail}`)
  } else {
    console.log('[digest:run-once] firing digest for ALL eligible operators')
  }

  const result = await runWeeklyDigestTick(prisma, { targetEmail })
  console.log(`[digest:run-once] done. sent=${result.sent} skipped=${result.skipped}`)
  console.log('[digest:run-once] skip reasons:', JSON.stringify(result.reasonsSkipped, null, 2))
}

main()
  .catch((err) => {
    console.error('[digest:run-once] FAILED:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
