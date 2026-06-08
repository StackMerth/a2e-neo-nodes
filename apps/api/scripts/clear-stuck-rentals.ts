/**
 * Force-cancel stuck PENDING ComputeRequests, with refund.
 *
 * The portal cancel button has been observed leaving requests in
 * PENDING when the cascade kept retrying them. This script bypasses
 * the portal flow and updates the DB row directly. Critically, it ALSO
 * issues a REFUND_RENTAL credit so the buyer doesn't lose the
 * pre-debited rental cost (which the portal cancel route normally
 * handles inline).
 *
 *   pnpm --filter @a2e/api exec tsx scripts/clear-stuck-rentals.ts
 *     -> list all PENDING ComputeRequests + ExternalRentals.
 *
 *   pnpm --filter @a2e/api exec tsx scripts/clear-stuck-rentals.ts --cancel-all
 *     -> cancel + refund EVERY pending ComputeRequest (queue flush).
 *
 *   pnpm --filter @a2e/api exec tsx scripts/clear-stuck-rentals.ts --cancel <id>
 *     -> cancel + refund one (full id or 12-char prefix).
 *
 *   pnpm --filter @a2e/api exec tsx scripts/clear-stuck-rentals.ts --cancel-all --no-refund
 *     -> skip refund (rare; e.g. when totalCost was never debited).
 *
 * Refunds are idempotent via the (type, referenceId) BalanceTransaction
 * unique constraint with referenceId='cancel:<crId>', matching the
 * portal cancel route's contract.
 */
import { PrismaClient } from '@a2e/database'
import { creditBalance } from '../src/services/balance/balance-service.js'

const SCRIPT_VERSION = '2026-06-08-e0c8214-plus'

const prisma = new PrismaClient()

async function main(): Promise<void> {
  console.log(`clear-stuck-rentals v${SCRIPT_VERSION}`)
  console.log()

  const args = process.argv.slice(2)
  const cancelAll = args.includes('--cancel-all')
  const noRefund = args.includes('--no-refund')
  const cancelIdx = args.indexOf('--cancel')
  const cancelArg = cancelIdx >= 0 ? args[cancelIdx + 1] : undefined

  const pending = await prisma.computeRequest.findMany({
    where: { status: 'PENDING' },
    orderBy: { requestedAt: 'asc' },
    select: {
      id: true,
      gpuTier: true,
      gpuCount: true,
      requestedAt: true,
      userId: true,
      workloadType: true,
      totalCost: true,
      paymentSource: true,
    },
  })

  console.log(`${pending.length} PENDING ComputeRequest(s):`)
  for (const r of pending) {
    console.log(
      `  ${r.id.padEnd(36)} ${String(r.workloadType ?? '').padEnd(12)} ${r.gpuTier.padEnd(10)} x${r.gpuCount}   created ${r.requestedAt.toISOString()}`,
    )
  }
  console.log()

  // Also show any ExternalRental rows that may be lingering in
  // non-CLOSED status so the operator sees the full picture.
  const externals = await prisma.externalRental.findMany({
    where: { status: { notIn: ['CLOSED', 'FAILED'] } },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      provider: true,
      providerInstanceId: true,
      status: true,
      createdAt: true,
      computeRequestId: true,
    },
  })
  console.log(`${externals.length} non-CLOSED ExternalRental(s):`)
  for (const e of externals) {
    console.log(
      `  ${e.id.padEnd(28)} ${e.provider.padEnd(12)} ${(e.providerInstanceId ?? '-').padEnd(40)} ${e.status.padEnd(20)} (cr=${e.computeRequestId})`,
    )
  }
  console.log()

  async function cancelOne(cr: typeof pending[number]): Promise<void> {
    await prisma.computeRequest.update({
      where: { id: cr.id },
      data: { status: 'CANCELLED' },
    })
    console.log(`  CANCELLED ${cr.id}`)
    if (noRefund) {
      console.log(`    (--no-refund: skipping refund)`)
      return
    }
    if (cr.totalCost <= 0) {
      console.log(`    (totalCost=0: nothing to refund)`)
      return
    }
    if (cr.paymentSource === 'INTERNAL_BALANCE') {
      // Internal-balance path doesn't credit; unwinds InternalSpend instead.
      // Out of scope for this script; recommend the portal cancel route.
      console.log(`    (paymentSource=INTERNAL_BALANCE: refund handled differently; skip)`)
      return
    }
    try {
      await creditBalance(prisma, {
        userId: cr.userId,
        amountUsd: cr.totalCost,
        type: 'REFUND_RENTAL',
        description: `Refund for cancelled ${cr.gpuCount}x ${cr.gpuTier} rental (clear-stuck-rentals)`,
        referenceId: `cancel:${cr.id}`,
      })
      console.log(`    REFUNDED $${cr.totalCost.toFixed(2)} to user ${cr.userId}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('Unique constraint') || msg.includes('already exists')) {
        console.log(`    (already refunded, idempotent skip)`)
      } else {
        console.log(`    REFUND FAILED: ${msg}`)
      }
    }
  }

  if (cancelAll) {
    console.log(`Cancelling ${pending.length} pending rental(s):`)
    for (const cr of pending) {
      await cancelOne(cr)
    }
    return
  }

  if (cancelArg) {
    const target = cancelArg.toLowerCase()
    const match = pending.find((r) => r.id === target || r.id.startsWith(target))
    if (!match) {
      console.log(`No PENDING request matching "${cancelArg}". Nothing to cancel.`)
      return
    }
    await cancelOne(match)
    return
  }

  if (pending.length > 0) {
    console.log('Re-run with --cancel-all to wipe the queue, or --cancel <id> for one.')
  }
}

main()
  .catch((err) => {
    console.error('clear-stuck-rentals failed:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
