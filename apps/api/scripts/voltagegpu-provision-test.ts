/**
 * T5h — VoltageGPU provision / poll / terminate test harness.
 *
 *   voltagegpu-provision:test                                 # inspect mode
 *   voltagegpu-provision:test --rent <Tier> [count]           # via tier map
 *   voltagegpu-provision:test --type <offerId>                # bypass mapping
 *   voltagegpu-provision:test --poll <externalRentalId>
 *   voltagegpu-provision:test --terminate <externalRentalId>
 */

import { prisma } from '@a2e/database'
import type { GpuTier } from '@a2e/database'
import {
  provisionVoltageGpuRental,
  pollVoltageGpuRentalStatus,
  terminateVoltageGpuRental,
} from '../src/services/inbound/voltagegpu-provision.js'
import {
  VoltageGpuClient,
  isVoltageGpuConfigured,
} from '../src/services/inbound/voltagegpu-adapter.js'
import { isKeyEncryptionConfigured } from '../src/services/inbound/key-encryption.js'
import { voltageGpuTypeForTier } from '../src/services/inbound/voltagegpu-tier-mapping.js'

const TEST_USER_EMAIL = 'voltagegpu-provision-test@system.tokenos.internal'

async function main(): Promise<void> {
  if (!isVoltageGpuConfigured()) {
    console.log('VOLTAGEGPU_API_KEY not set. Run voltagegpu:inspect for setup steps.')
    process.exit(1)
  }
  if (!isKeyEncryptionConfigured()) {
    console.log('SSH_KEY_ENCRYPTION_KEY not set.')
    process.exit(1)
  }

  const args = process.argv.slice(2)
  const flag = args[0]

  if (flag === '--rent') {
    const tier = args[1]
    if (!tier) {
      console.log('--rent requires a GpuTier (e.g. H100, H200, B200).')
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
      console.log('--type requires a VoltageGPU offer id.')
      console.log('Run `voltagegpu:inspect --raw` to see every offer.')
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
  console.log('Tier mappings (internal GpuTier x count -> VoltageGPU offer id):')
  for (const tier of ['H100', 'H200', 'B200'] as GpuTier[]) {
    for (const count of [1, 2, 4, 8]) {
      const m = voltageGpuTypeForTier(tier, count)
      if (m) {
        console.log(
          `  ${tier.padEnd(6)} x${count} -> ${m.hardwareId.padEnd(20)} (${m.label}, ${m.defaultRegion}, ~$${m.approxPricePerHourUsd.toFixed(2)}/h)`,
        )
      }
    }
  }
  console.log()

  const client = new VoltageGpuClient()
  const offers = await client.listOffers()
  console.log(`Live VoltageGPU catalog: ${offers.length} offers`)
  for (const o of offers) {
    console.log(`  ${o.id.padEnd(26)} ${o.gpuModel} x${o.gpuCount}  $${o.pricePerHourUsd.toFixed(2)}/h  ${o.region}  cc=${o.confidential}`)
  }
  console.log()

  const rentals = await prisma.externalRental.findMany({
    where: { provider: 'VOLTAGE_GPU' },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })
  console.log(`VOLTAGE_GPU ExternalRental rows in DB: ${rentals.length}`)
  for (const r of rentals) {
    console.log(
      `  ${r.id.padEnd(28)} ${r.status.padEnd(8)} ${r.providerInstanceType.padEnd(16)} ${(r.providerRegion ?? '(no region)').padEnd(8)} ${r.sshHost ?? '(no ip)'}  $${r.providerPricePerHourUsd.toFixed(2)}/h`,
    )
  }
}

async function runRent(tier: GpuTier, gpuCount: number): Promise<void> {
  const m = voltageGpuTypeForTier(tier, gpuCount)
  if (!m) {
    console.log(`No VoltageGPU mapping for ${tier} x${gpuCount}.`)
    process.exit(1)
  }

  const user = await prisma.user.upsert({
    where: { email: TEST_USER_EMAIL },
    create: { email: TEST_USER_EMAIL, role: 'COMPUTE_BUYER', isBuyer: true },
    update: {},
    select: { id: true },
  })

  // 1-hour smoke-test duration; per-second billing so charge is
  // proportional to actual runtime once user terminates.
  const cr = await prisma.computeRequest.create({
    data: {
      userId: user.id,
      gpuTier: tier,
      gpuCount,
      durationDays: 1 / 24,
      ratePerDay: 0,
      totalCost: 0,
      txHash: `T5H_TEST_${Date.now()}`,
      txConfirmed: true,
      status: 'PENDING',
      paymentSource: 'BUYER_BALANCE',
    },
    select: { id: true },
  })
  console.log(`Created synthetic ComputeRequest ${cr.id} (1-hour smoke test)`)

  console.log(`Provisioning VoltageGPU pod for ${tier} x${gpuCount} (${m.hardwareId})...`)
  console.log(`  WARNING: real billing (~$${m.approxPricePerHourUsd.toFixed(2)}/h, per-second).`)
  const result = await provisionVoltageGpuRental(prisma, cr.id)

  console.log()
  console.log('Provisioned:')
  console.log(`  externalRentalId:     ${result.externalRentalId}`)
  console.log(`  providerInstanceId:   ${result.providerInstanceId}`)
  console.log(`  providerInstanceType: ${result.providerInstanceType}`)
  console.log(`  providerRegion:       ${result.providerRegion}`)
  console.log(`  providerPrice:        $${result.providerPricePerHourUsd.toFixed(2)}/h`)
  console.log()
  console.log(`Poll:      pnpm --filter @a2e/api voltagegpu-provision:test --poll ${result.externalRentalId}`)
  console.log(`Terminate: pnpm --filter @a2e/api voltagegpu-provision:test --terminate ${result.externalRentalId}`)
}

async function runRentByType(hardwareId: string): Promise<void> {
  const client = new VoltageGpuClient()
  const offers = await client.listOffers()
  const match = offers.find((o) => o.id === hardwareId)
  if (!match) {
    console.log(`VoltageGPU has no offer with id "${hardwareId}".`)
    console.log('Available:')
    for (const o of offers) console.log(`  ${o.id}  ${o.gpuModel} x${o.gpuCount}  $${o.pricePerHourUsd.toFixed(2)}/h`)
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
      gpuTier: 'H100',
      gpuCount: match.gpuCount,
      durationDays: 1 / 24,
      ratePerDay: 0,
      totalCost: 0,
      txHash: `T5H_TEST_TYPE_${Date.now()}`,
      txConfirmed: true,
      status: 'PENDING',
      paymentSource: 'BUYER_BALANCE',
    },
    select: { id: true },
  })
  console.log(`Created synthetic ComputeRequest ${cr.id}`)

  const result = await provisionVoltageGpuRental(prisma, cr.id, {
    hardwareIdOverride: hardwareId,
  })

  console.log()
  console.log('Provisioned:')
  console.log(`  externalRentalId:     ${result.externalRentalId}`)
  console.log(`  providerInstanceId:   ${result.providerInstanceId}`)
  console.log(`  providerInstanceType: ${result.providerInstanceType}`)
  console.log(`  providerRegion:       ${result.providerRegion}`)
  console.log(`  providerPrice:        $${result.providerPricePerHourUsd.toFixed(2)}/h`)
}

async function runPoll(externalRentalId: string): Promise<void> {
  const pod = await pollVoltageGpuRentalStatus(prisma, externalRentalId)
  const row = await prisma.externalRental.findUnique({ where: { id: externalRentalId } })
  if (!row) {
    console.log('ExternalRental not found.')
    return
  }
  console.log(`ExternalRental ${row.id}`)
  console.log(`  internal status:  ${row.status}`)
  console.log(`  provider status:  ${pod?.status ?? '(closed / 404)'}`)
  console.log(`  sshHost:          ${row.sshHost ?? '(no ip yet)'}`)
  console.log(`  sshPort:          ${row.sshPort}`)
  console.log(`  sshUsername:      ${row.sshUsername}`)
  console.log(`  region:           ${row.providerRegion}`)
  console.log(`  launchedAt:       ${row.launchedAt?.toISOString() ?? '(not yet)'}`)
  console.log(`  lastNote:         ${row.lastNote ?? '(none)'}`)
  console.log(`  lastError:        ${row.lastError ?? '(none)'}`)
  if (pod) {
    console.log()
    console.log('Provider snapshot:')
    console.log(`  id:           ${pod.id}`)
    console.log(`  status:       ${pod.status}`)
    console.log(`  publicIp:     ${pod.publicIp ?? '(not yet)'}`)
    console.log(`  sshPort:      ${pod.sshPort ?? '(not yet)'}`)
    console.log(`  sshUser:      ${pod.sshUser ?? '(not yet)'}`)
    console.log(`  attestation:  ${pod.attestationReportUrl ?? '(not exposed)'}`)
  }
}

async function runTerminate(externalRentalId: string, reason: string): Promise<void> {
  console.log(`Terminating ${externalRentalId}: ${reason}`)
  await terminateVoltageGpuRental(prisma, externalRentalId, reason)
  const row = await prisma.externalRental.findUnique({ where: { id: externalRentalId } })
  if (!row) {
    console.log('ExternalRental not found.')
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
