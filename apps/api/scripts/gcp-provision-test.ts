/**
 * T5g — GCP A3 provision / poll / terminate test harness.
 *
 * Mirror of phala-provision-test.ts. Exercises the provisioning
 * orchestrator end-to-end against the real GCP Compute Engine REST API.
 *
 * IMPORTANT: the first --rent attempt is likely to surface a 403
 * PERMISSION_DENIED (quota not approved yet), a 503 ZONE_RESOURCE_
 * POOL_EXHAUSTED (no A3 capacity in that zone), or a 400 INVALID_
 * ARGUMENT on sourceImage if the confidential image family path
 * needs adjustment. These are iteration signals, not adapter bugs.
 *
 * Modes (default = inspect / read-only):
 *
 *   pnpm --filter @a2e/api gcp-provision:test
 *     -> list ExternalRental rows on GCP provider + zone candidates.
 *        No writes.
 *
 *   pnpm --filter @a2e/api gcp-provision:test --rent <GpuTier> [count]
 *     -> create a synthetic ComputeRequest with the given tier,
 *        provision a GCP A3 instance. WARNING: spins up real GCP
 *        billing (spot ~$3.69/h on a3-highgpu-1g). Currently only
 *        H100 x1 supported (Phase 1).
 *
 *   pnpm --filter @a2e/api gcp-provision:test --type <machineType> [zone]
 *     -> bypass tier mapping and provision an arbitrary GCP machine
 *        type. Default zone: first in GCP_A3_CONFIDENTIAL_ZONES.
 *
 *   pnpm --filter @a2e/api gcp-provision:test --poll <externalRentalId>
 *     -> single poll. Updates status + sshHost + launchedAt in DB.
 *
 *   pnpm --filter @a2e/api gcp-provision:test --terminate <externalRentalId>
 *     -> stop billing. Idempotent.
 *
 *   pnpm --filter @a2e/api gcp-provision:test --terminate-instance <zone> <name>
 *     -> direct DELETE on a GCP instance by zone + name. Used for
 *        orphan cleanup when no ExternalRental row exists.
 */

import { prisma } from '@a2e/database'
import type { GpuTier } from '@a2e/database'
import {
  provisionGcpRental,
  pollGcpRentalStatus,
  terminateGcpRental,
} from '../src/services/inbound/gcp-provision.js'
import { GcpClient, isGcpConfigured, GCP_A3_CONFIDENTIAL_ZONES } from '../src/services/inbound/gcp-adapter.js'
import { isKeyEncryptionConfigured } from '../src/services/inbound/key-encryption.js'
import { gcpMachineTypeForTier } from '../src/services/inbound/gcp-tier-mapping.js'

const TEST_USER_EMAIL = 'gcp-provision-test@system.tokenos.internal'

async function main(): Promise<void> {
  if (!isGcpConfigured()) {
    console.log('GCP_PROJECT_ID + GCP_SA_KEY_JSON not set. Run `gcp:inspect` for setup steps.')
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
      console.log('--rent requires a GpuTier (e.g. H100).')
      console.log('Currently GCP A3 confidential is single-GPU only (H100 x1).')
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
    const machineType = args[1]
    if (!machineType) {
      console.log('--type requires a GCP machine type (e.g. "a3-highgpu-1g").')
      process.exit(1)
    }
    const zone = args[2] ?? GCP_A3_CONFIDENTIAL_ZONES[0]
    await runRentByType(machineType, zone)
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
  if (flag === '--terminate-instance') {
    const zone = args[1]
    const name = args[2]
    if (!zone || !name) {
      console.log('--terminate-instance requires <zone> <name>.')
      process.exit(1)
    }
    await runTerminateInstance(zone, name)
    return
  }

  await runInspect()
}

async function runInspect(): Promise<void> {
  console.log('Tier mappings (GpuTier -> GCP machineType):')
  for (const tier of ['H100', 'H200', 'B200', 'L40S', 'RTX_4090', 'RTX_3090'] as GpuTier[]) {
    for (const count of [1, 4, 8]) {
      const m = gcpMachineTypeForTier(tier, count)
      if (m) {
        console.log(
          `  ${tier.padEnd(10)} x${count} -> ${m.machineType.padEnd(18)} spot $${m.spotPricePerHourUsd.toFixed(2)}/h  on-demand $${m.onDemandPricePerHourUsd.toFixed(2)}/h`,
        )
      }
    }
  }
  console.log('  (other tiers: GCP confidential A3 doesn\'t cover; allocator skips.)')
  console.log()

  console.log('Zones (rotation candidates):')
  for (const z of GCP_A3_CONFIDENTIAL_ZONES) {
    console.log(`  ${z}`)
  }
  console.log()

  const rentals = await prisma.externalRental.findMany({
    where: { provider: 'GCP' },
    orderBy: { launchRequestedAt: 'desc' },
    take: 20,
  })
  console.log(`GCP ExternalRental rows in DB: ${rentals.length}`)
  for (const r of rentals) {
    console.log(
      `  ${r.id.padEnd(28)} ${r.status.padEnd(8)} ${r.providerInstanceType.padEnd(20)} ${(r.providerRegion ?? '(no zone)').padEnd(16)} ${r.sshHost ?? '(no ip)'}  $${r.providerPricePerHourUsd.toFixed(2)}/h`,
    )
  }
}

async function runRent(tier: GpuTier, gpuCount: number): Promise<void> {
  const m = gcpMachineTypeForTier(tier, gpuCount)
  if (!m) {
    console.log(`No GCP mapping for tier ${tier} x${gpuCount}.`)
    console.log('GCP confidential A3 currently only carries H100 x1 (a3-highgpu-1g).')
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
      txHash: `T5G_TEST_${Date.now()}`,
      txConfirmed: true,
      status: 'PENDING',
      paymentSource: 'BUYER_BALANCE',
    },
    select: { id: true },
  })
  console.log(`Created synthetic ComputeRequest ${cr.id}`)

  console.log(`Provisioning GCP A3 ${m.machineType} for ${tier} x${gpuCount} (spot)...`)
  console.log('  WARNING: this starts real billing on your GCP account.')
  console.log('  NOTE: confidential boot includes TEE attestation; expect 60-180s to RUNNING.')
  const result = await provisionGcpRental(prisma, cr.id)

  console.log()
  console.log('Provisioned:')
  console.log(`  externalRentalId:     ${result.externalRentalId}`)
  console.log(`  providerInstanceId:   ${result.providerInstanceId}`)
  console.log(`  providerInstanceType: ${result.providerInstanceType}`)
  console.log(`  providerRegion:       ${result.providerRegion}`)
  console.log(`  providerPrice:        $${result.providerPricePerHourUsd.toFixed(2)}/h`)
  console.log()
  console.log('Poll status with:')
  console.log(`  pnpm --filter @a2e/api gcp-provision:test --poll ${result.externalRentalId}`)
  console.log('Terminate (stops billing) with:')
  console.log(`  pnpm --filter @a2e/api gcp-provision:test --terminate ${result.externalRentalId}`)
}

async function runRentByType(machineType: string, zone: string): Promise<void> {
  console.log(`GCP machine type ${machineType} in ${zone}`)
  console.log()

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
      gpuCount: 1,
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

  console.log(`Provisioning GCP ${machineType} in ${zone} (bypassing tier mapping)...`)
  console.log('  WARNING: this starts real billing on your GCP account.')
  const result = await provisionGcpRental(prisma, cr.id, {
    machineTypeOverride: machineType,
    zoneOverride: zone,
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
  console.log(`  pnpm --filter @a2e/api gcp-provision:test --poll ${result.externalRentalId}`)
  console.log('Terminate (stops billing) with:')
  console.log(`  pnpm --filter @a2e/api gcp-provision:test --terminate ${result.externalRentalId}`)
}

async function runPoll(externalRentalId: string): Promise<void> {
  const instance = await pollGcpRentalStatus(prisma, externalRentalId)
  const row = await prisma.externalRental.findUnique({ where: { id: externalRentalId } })
  if (!row) {
    console.log('ExternalRental not found after poll.')
    return
  }
  console.log(`ExternalRental ${row.id}`)
  console.log(`  internal status:  ${row.status}`)
  console.log(`  provider status:  ${instance?.status ?? '(closed / 404)'}`)
  console.log(`  sshHost:          ${row.sshHost ?? '(no ip yet)'}`)
  console.log(`  sshPort:          ${row.sshPort}`)
  console.log(`  sshUsername:      ${row.sshUsername}`)
  console.log(`  zone:             ${row.providerRegion}`)
  console.log(`  launchedAt:       ${row.launchedAt?.toISOString() ?? '(not yet)'}`)
  console.log(`  lastNote:         ${row.lastNote ?? '(none)'}`)
  console.log(`  lastError:        ${row.lastError ?? '(none)'}`)
  console.log()
  if (instance) {
    console.log('Provider snapshot:')
    console.log(`  name:         ${instance.name}`)
    console.log(`  status:       ${instance.status}`)
    console.log(`  machineType:  ${instance.machineType}`)
    console.log(`  spot:         ${instance.spot}`)
    console.log(`  publicIp:     ${instance.publicIp ?? '(not yet)'}`)
    console.log(`  privateIp:    ${instance.privateIp ?? '(not yet)'}`)
  }
}

async function runTerminate(externalRentalId: string, reason: string): Promise<void> {
  console.log(`Terminating ${externalRentalId}: ${reason}`)
  await terminateGcpRental(prisma, externalRentalId, reason)
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

async function runTerminateInstance(zone: string, name: string): Promise<void> {
  console.log(`DELETE GCP instance ${name} in ${zone} (orphan cleanup, bypasses ExternalRental)`)
  const client = new GcpClient()
  await client.deleteInstance(zone, name)
  console.log('Terminate request accepted (or 404 if already gone).')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
