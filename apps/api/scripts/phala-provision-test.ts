/**
 * T5f / Milestone 1.6 — Phala provision / poll / terminate test harness.
 *
 * Mirror of runpod-provision-test.ts. Exercises the provisioning
 * orchestrator end-to-end against the real Phala Cloud API.
 *
 * IMPORTANT: the first --rent or --type attempt is expected to fail
 * with a 422 from Phala because phala-adapter.ts createCvm() body
 * shape is best-guess (Milestone 1.4). The error message will name
 * the actual required fields; copy them into createCvm and re-run.
 *
 * Modes (default = inspect / read-only):
 *
 *   pnpm --filter @a2e/api phala-provision:test
 *     -> list ExternalRental rows on PHALA provider + capacity
 *        summary for our tier-mapped Phala SKUs. No writes.
 *
 *   pnpm --filter @a2e/api phala-provision:test --rent <GpuTier> [count]
 *     -> create a synthetic ComputeRequest with the given tier,
 *        provision a Phala CVM. WARNING: spins up real CVM billing.
 *        Currently only H200 supported (default count=1; pass 8 for
 *        the 8x SKU). Phala has no H100/B200/L40S yet.
 *
 *   pnpm --filter @a2e/api phala-provision:test --type <instance_type_id>
 *     -> bypass tier mapping and use a Phala instance id directly.
 *        e.g.: --type h200.small or --type h200.8x.large
 *
 *   pnpm --filter @a2e/api phala-provision:test --poll <externalRentalId>
 *     -> single poll. Updates status + sshHost + sshPort + region in DB.
 *
 *   pnpm --filter @a2e/api phala-provision:test --terminate <externalRentalId>
 *     -> stop billing. Idempotent.
 */

import { prisma } from '@a2e/database'
import type { GpuTier } from '@a2e/database'
import {
  provisionPhalaRental,
  pollPhalaRentalStatus,
  terminatePhalaRental,
} from '../src/services/inbound/phala-provision.js'
import { PhalaClient, isPhalaConfigured } from '../src/services/inbound/phala-adapter.js'
import { isKeyEncryptionConfigured } from '../src/services/inbound/key-encryption.js'
import { phalaTypeForTier } from '../src/services/inbound/phala-tier-mapping.js'

const TEST_USER_EMAIL = 'phala-provision-test@system.tokenos.internal'

async function main(): Promise<void> {
  if (!isPhalaConfigured()) {
    console.log('PHALA_API_KEY is not set. Run phala:inspect for setup instructions.')
    process.exit(1)
  }
  if (!isKeyEncryptionConfigured()) {
    console.log('SSH_KEY_ENCRYPTION_KEY is not set. Generate one with:')
    console.log('  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"')
    console.log('and add it to Render API service Environment, then re-run.')
    process.exit(1)
  }

  const args = process.argv.slice(2)
  const flag = args[0]

  if (flag === '--rent') {
    const tier = args[1]
    if (!tier) {
      console.log('--rent requires a GpuTier (e.g. H200).')
      console.log('Currently Phala only carries H200. Other tiers will error.')
      process.exit(1)
    }
    const count = args[2] ? parseInt(args[2], 10) : 1
    if (!Number.isFinite(count) || count < 1) {
      console.log('GPU count must be a positive integer.')
      process.exit(1)
    }
    await runRent(tier as GpuTier, count)
    return
  }
  if (flag === '--type') {
    const sku = args[1]
    if (!sku) {
      console.log('--type requires a Phala instance id (e.g. "h200.small" or "h200.8x.large").')
      console.log('Run `phala:inspect` to see every valid id.')
      process.exit(1)
    }
    await runRentByType(sku)
    return
  }
  if (flag === '--poll') {
    const id = args[1]
    if (!id) {
      console.log('--poll requires an ExternalRental id.')
      process.exit(1)
    }
    await runPoll(id)
    return
  }
  if (flag === '--terminate') {
    const id = args[1]
    if (!id) {
      console.log('--terminate requires an ExternalRental id.')
      process.exit(1)
    }
    await runTerminate(id, args[2] ?? 'manual test terminate')
    return
  }

  await runInspect()
}

async function runInspect(): Promise<void> {
  console.log('Tier mappings (internal GpuTier -> Phala instance_type_id):')
  for (const tier of ['H100', 'H200', 'B200', 'L40S', 'RTX_4090', 'RTX_3090'] as GpuTier[]) {
    for (const count of [1, 8]) {
      const m = phalaTypeForTier(tier, count)
      if (m) {
        console.log(`  ${tier.padEnd(10)} x${count} -> ${m.instanceTypeId.padEnd(20)} (${m.label})`)
      }
    }
  }
  console.log('  (other tiers/counts: Phala has no matching SKU; allocator skips.)')
  console.log()

  const client = new PhalaClient()
  const types = await client.listGpuTypes()
  console.log('Live Phala catalog:')
  for (const t of types) {
    console.log(`  ${t.id.padEnd(20)} ${t.gpuModel.padEnd(6)} ${String(t.memoryInGb).padStart(4)}GB  $${t.pricePerHourUsd.toFixed(2)}/h  ${t.teeSupport.join('+')}`)
  }
  console.log()

  const rentals = await prisma.externalRental.findMany({
    where: { provider: 'PHALA' },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })
  console.log(`PHALA ExternalRental rows in DB: ${rentals.length}`)
  for (const r of rentals) {
    console.log(`  ${r.id.padEnd(28)} ${r.status.padEnd(8)} ${r.providerInstanceType.padEnd(20)} ${(r.providerRegion ?? '(no region)').padEnd(12)} ${r.sshHost ?? '(no ip)'}  $${r.providerPricePerHourUsd.toFixed(2)}/h`)
  }
}

async function runRent(tier: GpuTier, gpuCount: number): Promise<void> {
  const m = phalaTypeForTier(tier, gpuCount)
  if (!m) {
    console.log(`No Phala mapping for tier ${tier} x${gpuCount}.`)
    console.log('Phala currently only carries H200 (1x via h200.small, 8x via h200.8x.large).')
    process.exit(1)
  }

  const user = await prisma.user.upsert({
    where: { email: TEST_USER_EMAIL },
    create: { email: TEST_USER_EMAIL, role: 'COMPUTE_BUYER', isBuyer: true },
    update: {},
    select: { id: true },
  })

  const cr = await prisma.computeRequest.create({
    data: {
      userId: user.id,
      gpuTier: tier,
      gpuCount,
      durationDays: 1,
      ratePerDay: 0,
      totalCost: 0,
      txHash: `T5F_TEST_${Date.now()}`,
      txConfirmed: true,
      status: 'PENDING',
      paymentSource: 'BUYER_BALANCE',
    },
    select: { id: true },
  })
  console.log(`Created synthetic ComputeRequest ${cr.id}`)

  console.log(`Provisioning Phala CVM for ${tier} x${gpuCount} (${m.instanceTypeId})...`)
  console.log('  WARNING: this starts real billing on your Phala account.')
  console.log('  NOTE: TEE boot is slower than standard pods; expect 90-180s to RUNNING.')
  const result = await provisionPhalaRental(prisma, cr.id)

  console.log()
  console.log('Provisioned:')
  console.log(`  externalRentalId:     ${result.externalRentalId}`)
  console.log(`  providerInstanceId:   ${result.providerInstanceId}`)
  console.log(`  providerInstanceType: ${result.providerInstanceType}`)
  console.log(`  providerRegion:       ${result.providerRegion}`)
  console.log(`  providerPrice:        $${result.providerPricePerHourUsd.toFixed(2)}/h`)
  console.log()
  console.log('Poll status with:')
  console.log(`  pnpm --filter @a2e/api phala-provision:test --poll ${result.externalRentalId}`)
  console.log('Terminate (stops billing) with:')
  console.log(`  pnpm --filter @a2e/api phala-provision:test --terminate ${result.externalRentalId}`)
}

async function runRentByType(input: string): Promise<void> {
  const client = new PhalaClient()
  const types = await client.listGpuTypes()
  let match = types.find((t) => t.id === input)
  if (!match) {
    const lower = input.toLowerCase()
    match = types.find((t) => t.id.toLowerCase() === lower)
  }
  if (!match) {
    console.log(`Phala has no instance type named "${input}".`)
    console.log()
    console.log('Available types:')
    for (const t of types) {
      console.log(`  ${t.id}  ($${t.pricePerHourUsd.toFixed(2)}/h)`)
    }
    process.exit(1)
  }
  const instanceTypeId = match.id
  console.log(`Phala SKU ${instanceTypeId}: $${match.pricePerHourUsd.toFixed(2)}/h  TEE=${match.teeSupport.join('+')}`)
  console.log()

  const user = await prisma.user.upsert({
    where: { email: TEST_USER_EMAIL },
    create: { email: TEST_USER_EMAIL, role: 'COMPUTE_BUYER', isBuyer: true },
    update: {},
    select: { id: true },
  })

  // Use H200 as placeholder tier for the synthetic ComputeRequest;
  // the --type override bypasses tier mapping entirely.
  const cr = await prisma.computeRequest.create({
    data: {
      userId: user.id,
      gpuTier: 'H200',
      gpuCount: 1,
      durationDays: 1,
      ratePerDay: 0,
      totalCost: 0,
      txHash: `T5F_TEST_TYPE_${Date.now()}`,
      txConfirmed: true,
      status: 'PENDING',
      paymentSource: 'BUYER_BALANCE',
    },
    select: { id: true },
  })
  console.log(`Created synthetic ComputeRequest ${cr.id}`)

  console.log(`Provisioning Phala CVM ${instanceTypeId} (bypassing tier mapping)...`)
  console.log('  WARNING: this starts real billing on your Phala account.')
  const result = await provisionPhalaRental(prisma, cr.id, {
    instanceTypeOverride: instanceTypeId,
  })

  console.log()
  console.log('Provisioned:')
  console.log(`  externalRentalId:     ${result.externalRentalId}`)
  console.log(`  providerInstanceId:   ${result.providerInstanceId}`)
  console.log(`  providerInstanceType: ${result.providerInstanceType}`)
  console.log(`  providerRegion:       ${result.providerRegion}`)
  console.log(`  providerPrice:        $${result.providerPricePerHourUsd.toFixed(2)}/h`)
  console.log()
  console.log('Poll status with:')
  console.log(`  pnpm --filter @a2e/api phala-provision:test --poll ${result.externalRentalId}`)
  console.log('Terminate (stops billing) with:')
  console.log(`  pnpm --filter @a2e/api phala-provision:test --terminate ${result.externalRentalId}`)
}

async function runPoll(externalRentalId: string): Promise<void> {
  const cvm = await pollPhalaRentalStatus(prisma, externalRentalId)
  const row = await prisma.externalRental.findUnique({ where: { id: externalRentalId } })
  if (!row) {
    console.log('ExternalRental not found after poll.')
    return
  }
  console.log(`ExternalRental ${row.id}`)
  console.log(`  internal status:  ${row.status}`)
  console.log(`  provider status:  ${cvm?.status ?? '(closed / 404)'}`)
  console.log(`  sshHost:          ${row.sshHost ?? '(no ip yet)'}`)
  console.log(`  sshPort:          ${row.sshPort}`)
  console.log(`  sshUsername:      ${row.sshUsername}`)
  console.log(`  region:           ${row.providerRegion}`)
  console.log(`  launchedAt:       ${row.launchedAt?.toISOString() ?? '(not yet)'}`)
  console.log(`  lastNote:         ${row.lastNote ?? '(none)'}`)
  console.log(`  lastError:        ${row.lastError ?? '(none)'}`)
  console.log()
  if (cvm) {
    console.log('Provider snapshot:')
    console.log(`  id:           ${cvm.id}`)
    console.log(`  status:       ${cvm.status}`)
    console.log(`  gpuType:      ${cvm.gpuTypeId}`)
    console.log(`  gpuCount:     ${cvm.gpuCount}`)
    console.log(`  publicIp:     ${cvm.publicIp ?? '(not yet)'}`)
    console.log(`  sshPort:      ${cvm.sshPort ?? '(not yet)'}`)
    console.log(`  attestation:  ${cvm.attestationReportUrl ?? '(not surfaced)'}`)
  }
}

async function runTerminate(externalRentalId: string, reason: string): Promise<void> {
  console.log(`Terminating ${externalRentalId}: ${reason}`)
  await terminatePhalaRental(prisma, externalRentalId, reason)
  const row = await prisma.externalRental.findUnique({ where: { id: externalRentalId } })
  if (!row) {
    console.log('ExternalRental not found after terminate.')
    return
  }
  console.log(`  status:                 ${row.status}`)
  console.log(`  terminationRequestedAt: ${row.terminationRequestedAt?.toISOString() ?? '(n/a)'}`)
  console.log(`  terminatedAt:           ${row.terminatedAt?.toISOString() ?? '(n/a)'}`)
  console.log(`  lastNote:               ${row.lastNote ?? '(none)'}`)
  console.log(`  lastError:              ${row.lastError ?? '(none)'}`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
