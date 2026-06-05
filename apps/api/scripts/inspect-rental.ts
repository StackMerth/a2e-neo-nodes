/**
 * Provider-agnostic rental inspector. Looks up the ExternalRental row
 * for any compute request (regardless of which provider won the
 * cascade) and prints:
 *   - Which provider was used
 *   - Persisted SSH host / port / username
 *   - Status
 *   - Any provider-side error
 *
 * Use this when the portal's SSH command times out and you do not yet
 * know which provider actually provisioned the rental. The cascade
 * picks cheapest-first per probe, but a provider that returned OK at
 * probe time can still fail at provision time, falling through to the
 * next cheaper one. The ExternalRental.provider column is the source
 * of truth.
 *
 * Render API shell:
 *   pnpm --filter @a2e/api exec tsx scripts/inspect-rental.ts <computeRequestId>
 */

import { PrismaClient } from '@a2e/database'

async function main(): Promise<void> {
  const reqIdOrPrefix = process.argv[2]
  if (!reqIdOrPrefix) {
    console.error('Usage: inspect-rental.ts <computeRequestId | id-prefix>')
    console.error('Tip: the .pem filename uses the first 12 chars of the request ID')
    console.error('     (cr.id.slice(0, 12)), not the full ID. Either works as the')
    console.error('     argument — startsWith lookup unambiguates.')
    process.exit(1)
  }

  const prisma = new PrismaClient()

  // Accept the full cuid OR the 12-char slug printed in the .pem
  // filename / rental page header. Cuids are unique on any 8+ char
  // prefix; this just stops the caller having to dig the full id out
  // of the URL bar.
  const candidates = await prisma.computeRequest.findMany({
    where: { id: { startsWith: reqIdOrPrefix } },
    select: {
      id: true,
      gpuTier: true,
      gpuCount: true,
      status: true,
      ratePerDay: true,
      totalCost: true,
      paymentSource: true,
      eligibilityFlags: true,
      adminNote: true,
      requestedAt: true,
      activatedAt: true,
    },
    take: 5,
  })
  if (candidates.length === 0) {
    console.error(`No ComputeRequest matching id prefix "${reqIdOrPrefix}"`)
    process.exit(1)
  }
  if (candidates.length > 1) {
    console.error(`Ambiguous prefix "${reqIdOrPrefix}" — matches:`)
    for (const c of candidates) console.error(`  ${c.id}  (${c.gpuCount}x ${c.gpuTier}, ${c.status})`)
    console.error('Re-run with a longer prefix.')
    process.exit(1)
  }
  const cr = candidates[0]!

  console.log('=== ComputeRequest ===')
  console.log(`  id:             ${cr.id}`)
  console.log(`  tier x count:   ${cr.gpuCount}x ${cr.gpuTier}`)
  console.log(`  status:         ${cr.status}`)
  console.log(`  ratePerDay:     $${cr.ratePerDay}`)
  console.log(`  totalCost:      $${cr.totalCost}`)
  console.log(`  paymentSource:  ${cr.paymentSource}`)
  console.log(`  flags:          ${(cr.eligibilityFlags ?? []).join(', ') || '(none)'}`)
  console.log(`  adminNote:      ${cr.adminNote ?? '(none)'}`)
  console.log(`  requestedAt:    ${cr.requestedAt.toISOString()}`)
  console.log(`  activatedAt:    ${cr.activatedAt?.toISOString() ?? '(null)'}`)
  console.log()

  const exts = await prisma.externalRental.findMany({
    where: { computeRequestId: cr.id },
    select: {
      id: true,
      provider: true,
      providerInstanceId: true,
      providerInstanceType: true,
      providerRegion: true,
      status: true,
      sshHost: true,
      sshPort: true,
      sshUsername: true,
      launchedAt: true,
      terminatedAt: true,
      lastError: true,
    },
  })
  if (exts.length === 0) {
    console.log('=== ExternalRental ===')
    console.log('  (none — rental was not provisioned by an external provider,')
    console.log('   or it was assigned to a BYOG internal node — check ComputeRequest.allocatedNodeIds)')
    await prisma.$disconnect()
    return
  }
  console.log(`=== ExternalRental(s) — ${exts.length} row(s) ===`)
  for (const e of exts) {
    console.log(`  provider:       ${e.provider}`)
    console.log(`  pod id:         ${e.providerInstanceId}`)
    console.log(`  instance type:  ${e.providerInstanceType}`)
    console.log(`  region:         ${e.providerRegion}`)
    console.log(`  status:         ${e.status}`)
    console.log(`  sshHost:        ${e.sshHost}`)
    console.log(`  sshPort:        ${e.sshPort}     <-- portal shows this`)
    console.log(`  sshUsername:    ${e.sshUsername}`)
    console.log(`  launchedAt:     ${e.launchedAt?.toISOString() ?? '(null)'}`)
    console.log(`  terminatedAt:   ${e.terminatedAt?.toISOString() ?? '(null)'}`)
    console.log(`  lastError:      ${e.lastError ?? '(none)'}`)
    console.log()
  }

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error('inspect-rental failed:', err)
  process.exit(1)
})
