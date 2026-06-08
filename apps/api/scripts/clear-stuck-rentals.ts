/**
 * Force-cancel stuck PENDING ComputeRequests.
 *
 * The portal cancel button has been observed leaving requests in
 * PENDING when the cascade kept retrying them. This script bypasses
 * the portal flow and updates the DB row directly.
 *
 *   pnpm --filter @a2e/api exec tsx scripts/clear-stuck-rentals.ts
 *     -> list all PENDING ComputeRequests + ExternalRentals.
 *
 *   pnpm --filter @a2e/api exec tsx scripts/clear-stuck-rentals.ts --cancel-all
 *     -> cancel EVERY pending ComputeRequest (queue flush).
 *
 *   pnpm --filter @a2e/api exec tsx scripts/clear-stuck-rentals.ts --cancel <id>
 *     -> cancel one specific request id (full id or 12-char prefix).
 *
 * Also prints the script version so the operator can confirm which
 * build of the api this matches.
 */
import { PrismaClient } from '@a2e/database'

const SCRIPT_VERSION = '2026-06-08-47822e0-plus'

const prisma = new PrismaClient()

async function main(): Promise<void> {
  console.log(`clear-stuck-rentals v${SCRIPT_VERSION}`)
  console.log()

  const args = process.argv.slice(2)
  const cancelAll = args.includes('--cancel-all')
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

  if (cancelAll) {
    const result = await prisma.computeRequest.updateMany({
      where: { status: 'PENDING' },
      data: { status: 'CANCELLED' },
    })
    console.log(`CANCELLED ${result.count} PENDING rental(s).`)
    return
  }

  if (cancelArg) {
    // Accept either a full cuid or a 12-char prefix (matches what the
    // portal shows). Translate to a startsWith match.
    const target = cancelArg.toLowerCase()
    const match = pending.find((r) => r.id === target || r.id.startsWith(target))
    if (!match) {
      console.log(`No PENDING request matching "${cancelArg}". Nothing to cancel.`)
      return
    }
    const result = await prisma.computeRequest.update({
      where: { id: match.id },
      data: { status: 'CANCELLED' },
    })
    console.log(`CANCELLED ${result.id}.`)
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
