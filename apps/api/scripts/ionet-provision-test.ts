/**
 * T5g — io.net provision / poll / terminate test harness.
 *
 * Mirror of runpod-provision-test.ts / phala-provision-test.ts.
 * Exercises the orchestrator end-to-end against the real io.net API.
 *
 * Modes (default = inspect / read-only):
 *
 *   pnpm --filter @a2e/api ionet-provision:test
 *     -> list ExternalRental rows on IONET provider + capacity
 *        summary for our tier-mapped io.net hardware. No writes.
 *
 *   pnpm --filter @a2e/api ionet-provision:test --rent <GpuTier>
 *     -> create a synthetic ComputeRequest, provision an io.net VM.
 *        WARNING: spins up real billing (min 1h non-refundable).
 *
 *   pnpm --filter @a2e/api ionet-provision:test --type <hardware_id>
 *     -> bypass tier mapping and use an io.net deploy_id directly.
 *        WARNING: same billing implication.
 *
 *   pnpm --filter @a2e/api ionet-provision:test --poll <externalRentalId>
 *     -> single poll. Updates status + sshHost + sshPort + region in DB.
 *
 *   pnpm --filter @a2e/api ionet-provision:test --terminate <externalRentalId>
 *     -> stop billing. Idempotent (404 = no-op).
 */

import { prisma } from '@a2e/database'
import type { GpuTier } from '@a2e/database'
import {
  provisionIoNetRental,
  pollIoNetRentalStatus,
  terminateIoNetRental,
} from '../src/services/inbound/ionet-provision.js'
import { IoNetClient, isIoNetConfigured } from '../src/services/inbound/ionet-adapter.js'
import { isKeyEncryptionConfigured } from '../src/services/inbound/key-encryption.js'
import { ioNetTypeForTier } from '../src/services/inbound/ionet-tier-mapping.js'

const TEST_USER_EMAIL = 'ionet-provision-test@system.tokenos.internal'

async function main(): Promise<void> {
  if (!isIoNetConfigured()) {
    console.log('IONET_API_KEY is not set. Run ionet:inspect for setup instructions.')
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
      console.log('--rent requires a GpuTier (e.g. H100, H200, L40S, RTX_4090).')
      process.exit(1)
    }
    await runRent(tier as GpuTier)
    return
  }
  if (flag === '--type') {
    const sku = args[1]
    if (!sku) {
      console.log('--type requires an io.net deploy_id (string, e.g. "8B300.240V").')
      console.log('Run `ionet:inspect --raw` to see every valid id.')
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
  console.log('Tier mappings (internal GpuTier -> io.net deploy_id):')
  for (const tier of ['H100', 'H200', 'B200', 'L40S', 'RTX_4090', 'RTX_3090'] as GpuTier[]) {
    const m = ioNetTypeForTier(tier)
    if (m) {
      console.log(`  ${tier.padEnd(10)} -> ${String(m.hardwareId).padEnd(8)} (${m.label}, max ${m.maxGpusPerVm} GPUs/VM)`)
    } else {
      console.log(`  ${tier.padEnd(10)} -> (no mapping; populate ionet-tier-mapping.ts)`)
    }
  }
  console.log()

  const client = new IoNetClient()
  const hardware = await client.listHardware()
  console.log(`io.net catalog: ${hardware.length} SKUs available right now.`)
  console.log('Capacity for our mapped tiers:')
  for (const tier of ['H100', 'H200', 'B200', 'L40S', 'RTX_4090', 'RTX_3090'] as GpuTier[]) {
    const m = ioNetTypeForTier(tier)
    if (!m) continue
    const match = hardware.find((h) => h.deployId === m.hardwareId)
    if (!match) {
      console.log(`  ${String(m.hardwareId).padEnd(8)} unknown to io.net (mapping needs update)`)
      continue
    }
    console.log(
      `  ${String(m.hardwareId).padEnd(8)} ${match.name.padEnd(36)} $${match.pricePerHourUsd.toFixed(2)}/h  ${match.location}`,
    )
  }
  console.log()

  const rentals = await prisma.externalRental.findMany({
    where: { provider: 'IONET' },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })
  console.log(`IONET ExternalRental rows in DB: ${rentals.length}`)
  for (const r of rentals) {
    console.log(
      `  ${r.id.padEnd(28)} ${r.status.padEnd(8)} hwid=${r.providerInstanceType.padEnd(6)} ${(r.providerRegion ?? '(no region)').padEnd(10)} ${r.sshHost ?? '(no ip)'}  $${r.providerPricePerHourUsd.toFixed(2)}/h`,
    )
  }
}

async function runRent(tier: GpuTier): Promise<void> {
  const m = ioNetTypeForTier(tier)
  if (!m) {
    console.log(`No io.net mapping for tier ${tier}. Populate ionet-tier-mapping.ts first.`)
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
      gpuCount: 1,
      durationDays: 1,
      ratePerDay: 0,
      totalCost: 0,
      txHash: `T5G_TEST_${Date.now()}`,
      txConfirmed: true,
      status: 'PENDING',
      paymentSource: 'BUYER_BALANCE',
    },
    select: { id: true },
  })
  console.log(`Created synthetic ComputeRequest ${cr.id}`)

  console.log(`Provisioning io.net VM for ${tier} (deploy_id=${m.hardwareId})...`)
  console.log('  WARNING: this starts real billing (1 hour minimum, non-refundable).')
  const result = await provisionIoNetRental(prisma, cr.id)

  console.log()
  console.log('Provisioned:')
  console.log(`  externalRentalId:     ${result.externalRentalId}`)
  console.log(`  providerInstanceId:   ${result.providerInstanceId}`)
  console.log(`  providerInstanceType: ${result.providerInstanceType}`)
  console.log(`  providerRegion:       ${result.providerRegion}`)
  console.log(`  providerPrice:        $${result.providerPricePerHourUsd.toFixed(2)}/h`)
  console.log()
  console.log('Poll status with:')
  console.log(`  pnpm --filter @a2e/api ionet-provision:test --poll ${result.externalRentalId}`)
  console.log('Terminate (stops billing) with:')
  console.log(`  pnpm --filter @a2e/api ionet-provision:test --terminate ${result.externalRentalId}`)
}

async function runRentByType(hardwareId: string): Promise<void> {
  const client = new IoNetClient()
  const hardware = await client.listHardware()
  const match = hardware.find((h) => h.deployId === hardwareId)
  if (!match) {
    console.log(`io.net has no hardware with deploy_id ${hardwareId}.`)
    console.log('Run `ionet:inspect --raw` to see every valid deploy_id.')
    process.exit(1)
  }
  console.log(`io.net SKU ${match.name} (deploy_id=${hardwareId}): $${match.pricePerHourUsd.toFixed(2)}/h ${match.location}`)
  console.log()

  const user = await prisma.user.upsert({
    where: { email: TEST_USER_EMAIL },
    create: { email: TEST_USER_EMAIL, role: 'COMPUTE_BUYER', isBuyer: true },
    update: {},
    select: { id: true },
  })

  // Placeholder tier for the synthetic request (--type override bypasses mapping).
  const cr = await prisma.computeRequest.create({
    data: {
      userId: user.id,
      gpuTier: 'H100',
      gpuCount: match.numCards,
      durationDays: 1,
      ratePerDay: 0,
      totalCost: 0,
      txHash: `T5G_TEST_TYPE_${Date.now()}`,
      txConfirmed: true,
      status: 'PENDING',
      paymentSource: 'BUYER_BALANCE',
    },
    select: { id: true },
  })
  console.log(`Created synthetic ComputeRequest ${cr.id}`)

  console.log(`Provisioning io.net VM ${match.name} (deploy_id=${hardwareId}, ${match.numCards} GPUs)...`)
  console.log('  WARNING: this starts real billing (1 hour minimum, non-refundable).')
  const result = await provisionIoNetRental(prisma, cr.id, {
    hardwareIdOverride: hardwareId,
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
  console.log(`  pnpm --filter @a2e/api ionet-provision:test --poll ${result.externalRentalId}`)
  console.log('Terminate (stops billing) with:')
  console.log(`  pnpm --filter @a2e/api ionet-provision:test --terminate ${result.externalRentalId}`)
}

async function runPoll(externalRentalId: string): Promise<void> {
  const dep = await pollIoNetRentalStatus(prisma, externalRentalId)
  const row = await prisma.externalRental.findUnique({ where: { id: externalRentalId } })
  if (!row) {
    console.log('ExternalRental not found after poll.')
    return
  }
  console.log(`ExternalRental ${row.id}`)
  console.log(`  internal status:  ${row.status}`)
  console.log(`  provider status:  ${dep?.status ?? '(closed / 404)'}`)
  console.log(`  sshHost:          ${row.sshHost ?? '(no ip yet)'}`)
  console.log(`  sshPort:          ${row.sshPort}`)
  console.log(`  sshUsername:      ${row.sshUsername}`)
  console.log(`  region:           ${row.providerRegion}`)
  console.log(`  launchedAt:       ${row.launchedAt?.toISOString() ?? '(not yet)'}`)
  console.log(`  lastError:        ${row.lastError ?? '(none)'}`)
  if (dep) {
    console.log()
    console.log('Provider snapshot:')
    console.log(`  id:                ${dep.id}`)
    console.log(`  status:            ${dep.status}`)
    console.log(`  hardware:          ${dep.hardwareName}`)
    console.log(`  total gpus:        ${dep.totalGpus}  (gpus/vm: ${dep.gpusPerVm})`)
    console.log(`  amount paid:       ${dep.amountPaidUsd !== null ? `$${dep.amountPaidUsd.toFixed(2)}` : '(n/a)'}`)
    console.log(`  minutes served:    ${dep.computeMinutesServed ?? '(n/a)'}`)
    console.log(`  minutes remaining: ${dep.computeMinutesRemaining ?? '(n/a)'}`)
  }
}

async function runTerminate(externalRentalId: string, reason: string): Promise<void> {
  console.log(`Terminating ${externalRentalId}: ${reason}`)
  await terminateIoNetRental(prisma, externalRentalId, reason)
  const row = await prisma.externalRental.findUnique({ where: { id: externalRentalId } })
  if (!row) {
    console.log('ExternalRental not found after terminate.')
    return
  }
  console.log(`  status:                 ${row.status}`)
  console.log(`  terminationRequestedAt: ${row.terminationRequestedAt?.toISOString() ?? '(n/a)'}`)
  console.log(`  terminatedAt:           ${row.terminatedAt?.toISOString() ?? '(n/a)'}`)
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
