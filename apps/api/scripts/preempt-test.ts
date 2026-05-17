/**
 * QA helper — end-to-end SPOT preemption test against any environment.
 *
 * Creates a fake ACTIVE SPOT rental owned by the given buyer email,
 * marks it for immediate preemption, triggers the worker tick directly
 * (no 30s wait), and reports the refund outcome. Exercises both
 * payment paths the worker has to handle:
 *
 *   pnpm preempt:test <buyer-email>             # USDC SPOT rental (Solana refund)
 *   pnpm preempt:test <buyer-email> --internal  # INTERNAL_BALANCE SPOT rental (ledger rebate)
 *
 * The script skips the buyer-compute payment flow and the allocator
 * because both add 30+ seconds of latency that's not relevant to what
 * we're verifying (the refund branching in spot-preemption.ts). For a
 * real end-to-end test through the UI, use /buyer/request to create a
 * SPOT rental, wait for ACTIVE, then run this script with the rental's
 * id INSTEAD of an email (auto-detected by length).
 *
 * Leaves the COMPLETED rental in the DB for inspection. Clean up:
 *
 *   DELETE FROM "ComputeRequest" WHERE "txHash" LIKE 'TEST:preempt-%';
 */

import { PrismaClient } from '@a2e/database'
import { runSpotPreemptionTick } from '../src/jobs/spot-preemption.js'

const prisma = new PrismaClient()

interface MockIo {
  emit: (event: string, payload: Record<string, unknown>) => void
}

async function main() {
  const arg = process.argv[2]
  const useInternal = process.argv.includes('--internal')

  if (!arg) {
    console.error('Usage: pnpm preempt:test <buyer-email> [--internal]')
    console.error('   or: pnpm preempt:test <computeRequestId>')
    process.exit(1)
  }

  // cuid format: 25 chars, starts with c. If arg looks like a cuid, treat
  // it as an existing rental id; otherwise treat it as a buyer email.
  const isExistingId = arg.length >= 24 && arg.length <= 30 && /^c[a-z0-9]+$/i.test(arg)

  if (isExistingId) {
    await preemptExisting(arg)
  } else {
    await createAndPreempt(arg, useInternal)
  }
}

async function createAndPreempt(email: string, useInternal: boolean) {
  console.log(`\n=== Setting up test SPOT rental ===`)
  console.log(`  buyer email:    ${email}`)
  console.log(`  paymentSource:  ${useInternal ? 'INTERNAL_BALANCE' : 'USDC'}`)

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, walletAddress: true, isBuyer: true, isNodeRunner: true },
  })

  if (!user) {
    console.error(`\n  ERROR: User ${email} not found`)
    process.exit(1)
  }

  console.log(`  user.id:        ${user.id}`)
  console.log(`  user.wallet:    ${user.walletAddress ?? '(none)'}`)
  console.log(`  isBuyer/Runner: ${user.isBuyer} / ${user.isNodeRunner}`)

  let nodeRunnerId: string | null = null
  if (useInternal) {
    const nr = await prisma.nodeRunner.findUnique({
      where: { userId: user.id },
      select: { id: true },
    })
    if (!nr) {
      console.error(`\n  ERROR: --internal requires a NodeRunner linked via userId`)
      console.error(`  (Run: pnpm seed:earnings ${email} first, or update NodeRunner.userId)`)
      process.exit(1)
    }
    nodeRunnerId = nr.id
  }

  // Find any ONLINE node to populate allocatedNodeIds. The preemption
  // worker uses allocatedNodeIds to release node assignments on
  // termination; needs at least one ONLINE node to look realistic.
  const node = await prisma.node.findFirst({
    where: { status: 'ONLINE' },
    select: { id: true, walletAddress: true },
  })

  if (!node) {
    console.error(`\n  ERROR: No ONLINE node available — needed for allocatedNodeIds`)
    console.error(`  Enable seed-keep-alive (SEED_KEEP_ALIVE_ENABLED=1) or wait for a real node`)
    process.exit(1)
  }

  // Synthetic ACTIVE SPOT rental:
  //   - 1d H100 SPOT (40% off baseline)
  //   - Activated 30 min ago so finalAccrued > 0 but well under totalCost
  //   - Refund pool is roughly totalCost * (23.5h / 24h) = ~$96 worth
  //
  // SPOT discount is 40% by default per buyer-compute.ts
  const baseDailyH100 = 140.15
  const totalCost = baseDailyH100 * 0.6 // 40% SPOT discount
  const durationDays = 1
  const ratePerMinute = totalCost / durationDays / 24 / 60
  const activatedAt = new Date(Date.now() - 30 * 60 * 1000)
  const minutesUsed = 30
  const accruedCost = Number((minutesUsed * ratePerMinute).toFixed(4))
  const txHash = `TEST:preempt-${Date.now()}`

  const cr = await prisma.computeRequest.create({
    data: {
      userId: user.id,
      gpuTier: 'H100',
      gpuCount: 1,
      durationDays,
      tier: 'SPOT',
      paymentSource: useInternal ? 'INTERNAL_BALANCE' : 'USDC',
      ratePerDay: totalCost / durationDays,
      totalCost,
      ratePerMinute,
      minutesUsed,
      accruedCost,
      txHash,
      txConfirmed: true,
      status: 'ACTIVE',
      activatedAt,
      allocatedNodeIds: [node.id],
    },
  })

  console.log(`\n  Created rental ${cr.id}`)
  console.log(`    totalCost:   $${totalCost.toFixed(2)}`)
  console.log(`    accruedCost: $${accruedCost.toFixed(2)} (after ${minutesUsed} min)`)
  console.log(`    expected refund: $${(totalCost - accruedCost).toFixed(2)}`)

  if (useInternal && nodeRunnerId) {
    await prisma.internalSpend.create({
      data: { nodeRunnerId, computeRequestId: cr.id, amount: totalCost },
    })
    console.log(`    InternalSpend row: amount $${totalCost.toFixed(2)}`)
  }

  await triggerAndReport(cr.id, totalCost, useInternal)
}

async function preemptExisting(id: string) {
  const cr = await prisma.computeRequest.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      tier: true,
      paymentSource: true,
      totalCost: true,
    },
  })

  if (!cr) {
    console.error(`\n  ERROR: ComputeRequest ${id} not found`)
    process.exit(1)
  }
  if (cr.status !== 'ACTIVE') {
    console.error(`\n  ERROR: rental must be ACTIVE (got ${cr.status})`)
    process.exit(1)
  }
  if (cr.tier !== 'SPOT') {
    console.error(`\n  ERROR: rental must be tier=SPOT (got ${cr.tier})`)
    process.exit(1)
  }

  console.log(`\n=== Preempting existing rental ${id} ===`)
  console.log(`  tier:           ${cr.tier}`)
  console.log(`  paymentSource:  ${cr.paymentSource}`)
  console.log(`  totalCost:      $${cr.totalCost.toFixed(2)}`)

  await triggerAndReport(id, cr.totalCost, cr.paymentSource === 'INTERNAL_BALANCE')
}

async function triggerAndReport(id: string, originalTotal: number, isInternal: boolean) {
  const pastTime = new Date(Date.now() - 1000).toISOString()
  await prisma.computeRequest.update({
    where: { id },
    data: { adminNote: `PREEMPT_AT:${pastTime}|reason=QA_TEST` },
  })

  console.log(`\n=== Triggering worker tick directly (no 30s wait) ===`)

  const mockIo: MockIo = {
    emit: (event, payload) => {
      console.log(`  [WS] ${event}: ${JSON.stringify(payload)}`)
    },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await runSpotPreemptionTick(prisma, mockIo as any)

  const after = await prisma.computeRequest.findUnique({
    where: { id },
    select: {
      status: true,
      completedAt: true,
      adminNote: true,
      minutesUsed: true,
      accruedCost: true,
    },
  })

  console.log(`\n=== After preemption ===`)
  console.log(`  status:      ${after?.status}`)
  console.log(`  completedAt: ${after?.completedAt?.toISOString() ?? '(null)'}`)
  console.log(`  minutesUsed: ${after?.minutesUsed}`)
  console.log(`  accruedCost: $${after?.accruedCost?.toFixed(2)}`)
  console.log(`  adminNote:   ${after?.adminNote}`)

  if (isInternal) {
    const spend = await prisma.internalSpend.findUnique({
      where: { computeRequestId: id },
      select: { amount: true, updatedAt: true },
    })
    console.log(`\n=== InternalSpend rebate ===`)
    console.log(`  ledger amount:  $${spend?.amount.toFixed(2)} (was $${originalTotal.toFixed(2)})`)
    console.log(`  rebated by:     $${(originalTotal - (spend?.amount ?? 0)).toFixed(2)}`)
    console.log(`  ledger updated: ${spend?.updatedAt.toISOString()}`)
    console.log(`\n  PASS criteria: ledger amount = accruedCost (the actual final spend)`)
  } else {
    console.log(`\n=== USDC refund ===`)
    console.log(`  Look at the WS event line above for refundStatus + refundTxHash.`)
    console.log(`  Expected refundStatus values:`)
    console.log(`    PREEMPTED          — refund sent (txHash starts DEV_ in dev mode)`)
    console.log(`    PREEMPTED_SKIPPED_NO_WALLET — buyer has no walletAddress saved`)
    console.log(`    PREEMPTED_FAILED   — Solana hop blew up (error in adminNote)`)
    console.log(`  Also check adminNote above for "TX: DEV_..." or "Error: ..." lines.`)
  }

  console.log(`\nCleanup: this test rental stays in COMPLETED state for inspection.`)
  console.log(`  DELETE FROM "ComputeRequest" WHERE id = '${id}';`)
}

main()
  .catch((err) => {
    console.error('\nScript failed:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
