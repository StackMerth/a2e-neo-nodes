/**
 * T5e — RunPod provision / poll / terminate test harness.
 *
 * Mirror of lambda-provision-test.ts. Exercises the provisioning
 * orchestrator end-to-end against the real RunPod API.
 *
 * Modes (default = inspect / read-only):
 *
 *   pnpm --filter @a2e/api runpod-provision:test
 *     -> list ExternalRental rows on RUNPOD provider + capacity
 *        summary for our tier-mapped RunPod types. No writes.
 *
 *   pnpm --filter @a2e/api runpod-provision:test --rent <GpuTier>
 *     -> create a synthetic ComputeRequest with the given tier,
 *        provision a RunPod pod. WARNING: spins up real GPU billing.
 *
 *   pnpm --filter @a2e/api runpod-provision:test --type <gpuTypeId>
 *     -> bypass tier mapping and use a RunPod gpu type id directly.
 *        Quote the value because it contains spaces, e.g.:
 *        --type 'NVIDIA RTX A6000'
 *
 *   pnpm --filter @a2e/api runpod-provision:test --poll <externalRentalId>
 *     -> single poll. Updates status + sshHost + sshPort + region in DB.
 *
 *   pnpm --filter @a2e/api runpod-provision:test --terminate <externalRentalId>
 *     -> stop billing. Idempotent.
 */

import { prisma } from '@a2e/database'
import type { GpuTier } from '@a2e/database'
import {
  provisionRunPodRental,
  pollRunPodRentalStatus,
  terminateRunPodRental,
} from '../src/services/inbound/runpod-provision.js'
import { RunPodClient, isRunPodConfigured } from '../src/services/inbound/runpod-adapter.js'
import { isKeyEncryptionConfigured } from '../src/services/inbound/key-encryption.js'
import { runPodTypeForTier } from '../src/services/inbound/runpod-tier-mapping.js'

const TEST_USER_EMAIL = 'runpod-provision-test@system.tokenos.internal'

async function main(): Promise<void> {
  if (!isRunPodConfigured()) {
    console.log('RUNPOD_API_KEY is not set. Run runpod:inspect for setup instructions.')
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
      console.log('--rent requires a GpuTier (e.g. H100, B200, L40S, RTX_4090).')
      process.exit(1)
    }
    await runRent(tier as GpuTier)
    return
  }
  if (flag === '--type') {
    const sku = args[1]
    if (!sku) {
      console.log('--type requires a RunPod gpu type id (e.g. "NVIDIA H100 80GB HBM3").')
      console.log('Run `runpod:inspect --raw` to see every valid id.')
      process.exit(1)
    }
    // Optional --secure flag right after the type arg. Default cloud
    // type is COMMUNITY (cheapest); --secure switches to RunPod's
    // datacenter tier which is more expensive but has reliable stock.
    const secure = args.includes('--secure')
    await runRentByType(sku, secure ? 'SECURE' : 'COMMUNITY')
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
  console.log('Tier mappings (internal GpuTier -> RunPod gpu type):')
  for (const tier of ['H100', 'H200', 'B200', 'L40S', 'RTX_4090', 'RTX_3090'] as GpuTier[]) {
    const m = runPodTypeForTier(tier)
    if (m) {
      console.log(`  ${tier.padEnd(10)} -> ${m.gpuTypeId.padEnd(40)} (${m.label})`)
    }
  }
  console.log()

  const client = new RunPodClient()
  const types = await client.listGpuTypes()
  console.log('Capacity right now for our mapped types:')
  for (const tier of ['H100', 'H200', 'B200', 'L40S', 'RTX_4090', 'RTX_3090'] as GpuTier[]) {
    const m = runPodTypeForTier(tier)
    if (!m) continue
    const found = types.find((t) => t.id === m.gpuTypeId)
    if (!found) {
      console.log(`  ${m.gpuTypeId.padEnd(40)} unknown to RunPod (mapping needs update)`)
      continue
    }
    const price = found.lowestPricePerHourUsd !== null ? `$${found.lowestPricePerHourUsd.toFixed(2)}/h` : 'no price'
    const stock = found.hasCurrentStock ? 'yes' : 'NO'
    console.log(`  ${m.gpuTypeId.padEnd(40)} ${price.padEnd(10)} stock=${stock}`)
  }
  console.log()

  const rentals = await prisma.externalRental.findMany({
    where: { provider: 'RUNPOD' },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })
  console.log(`RUNPOD ExternalRental rows in DB: ${rentals.length}`)
  for (const r of rentals) {
    console.log(`  ${r.id.padEnd(28)} ${r.status.padEnd(8)} ${r.providerInstanceType.padEnd(40)} ${(r.providerRegion ?? '(no region)').padEnd(20)} ${r.sshHost ?? '(no ip)'}  $${r.providerPricePerHourUsd.toFixed(2)}/h`)
  }
}

async function runRent(tier: GpuTier): Promise<void> {
  const m = runPodTypeForTier(tier)
  if (!m) {
    console.log(`No RunPod mapping for tier ${tier}. Aborting.`)
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
      txHash: `T5E_TEST_${Date.now()}`,
      txConfirmed: true,
      status: 'PENDING',
      paymentSource: 'BUYER_BALANCE',
    },
    select: { id: true },
  })
  console.log(`Created synthetic ComputeRequest ${cr.id}`)

  console.log(`Provisioning RunPod pod for ${tier} (${m.gpuTypeId})...`)
  console.log('  WARNING: this starts real billing on your RunPod account.')
  const result = await provisionRunPodRental(prisma, cr.id)

  console.log()
  console.log('Provisioned:')
  console.log(`  externalRentalId:     ${result.externalRentalId}`)
  console.log(`  providerInstanceId:   ${result.providerInstanceId}`)
  console.log(`  providerInstanceType: ${result.providerInstanceType}`)
  console.log(`  providerRegion:       ${result.providerRegion}`)
  console.log(`  providerPrice:        $${result.providerPricePerHourUsd.toFixed(2)}/h`)
  console.log()
  console.log('Poll status with:')
  console.log(`  pnpm --filter @a2e/api runpod-provision:test --poll ${result.externalRentalId}`)
  console.log('Terminate (stops billing) with:')
  console.log(`  pnpm --filter @a2e/api runpod-provision:test --terminate ${result.externalRentalId}`)
}

async function runRentByType(input: string, cloudType: 'SECURE' | 'COMMUNITY' = 'COMMUNITY'): Promise<void> {
  const client = new RunPodClient()
  const types = await client.listGpuTypes()
  // Accept either the canonical id or the displayName — users often
  // type what they see in the inspector output, which is the display
  // name. Exact match first, then case-insensitive substring match.
  let match = types.find((t) => t.id === input || t.displayName === input)
  if (!match) {
    const lower = input.toLowerCase()
    match = types.find(
      (t) => t.id.toLowerCase() === lower || t.displayName.toLowerCase() === lower,
    )
  }
  if (!match) {
    const lower = input.toLowerCase()
    const candidates = types
      .filter(
        (t) =>
          t.id.toLowerCase().includes(lower) || t.displayName.toLowerCase().includes(lower),
      )
      .slice(0, 8)
    console.log(`RunPod has no gpu type named "${input}".`)
    if (candidates.length > 0) {
      console.log()
      console.log('Did you mean one of these?')
      for (const c of candidates) {
        console.log(`  id="${c.id}"  display="${c.displayName}"`)
      }
    } else {
      console.log(`Run runpod:inspect --raw to see every valid id.`)
    }
    process.exit(1)
  }
  if (!match.hasCurrentStock) {
    console.log(`RunPod has no capacity for ${match.id} right now.`)
    process.exit(1)
  }
  const gpuTypeId = match.id
  console.log(`RunPod SKU ${gpuTypeId} (${match.displayName}): $${(match.lowestPricePerHourUsd ?? 0).toFixed(2)}/h`)
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
      gpuTier: 'L40S',
      gpuCount: 1,
      durationDays: 1,
      ratePerDay: 0,
      totalCost: 0,
      txHash: `T5E_TEST_TYPE_${Date.now()}`,
      txConfirmed: true,
      status: 'PENDING',
      paymentSource: 'BUYER_BALANCE',
    },
    select: { id: true },
  })
  console.log(`Created synthetic ComputeRequest ${cr.id}`)

  console.log(`Provisioning RunPod pod ${gpuTypeId} (bypassing tier mapping, cloudType=${cloudType})...`)
  console.log('  WARNING: this starts real billing on your RunPod account.')
  const result = await provisionRunPodRental(prisma, cr.id, {
    gpuTypeOverride: gpuTypeId,
    cloudType,
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
  console.log(`  pnpm --filter @a2e/api runpod-provision:test --poll ${result.externalRentalId}`)
  console.log('Terminate (stops billing) with:')
  console.log(`  pnpm --filter @a2e/api runpod-provision:test --terminate ${result.externalRentalId}`)
}

async function runPoll(externalRentalId: string): Promise<void> {
  const pod = await pollRunPodRentalStatus(prisma, externalRentalId)
  const row = await prisma.externalRental.findUnique({ where: { id: externalRentalId } })
  if (!row) {
    console.log('ExternalRental not found after poll.')
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
  console.log()
  if (pod) {
    console.log('Provider snapshot:')
    console.log(`  id:           ${pod.id}`)
    console.log(`  status:       ${pod.status}`)
    console.log(`  gpuType:      ${pod.gpuTypeId}`)
    console.log(`  gpuCount:     ${pod.gpuCount}`)
    console.log(`  publicIp:     ${pod.publicIp ?? '(not yet)'}`)
    console.log(`  sshPort:      ${pod.sshPort ?? '(not yet)'}`)
  }
}

async function runTerminate(externalRentalId: string, reason: string): Promise<void> {
  console.log(`Terminating ${externalRentalId}: ${reason}`)
  await terminateRunPodRental(prisma, externalRentalId, reason)
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
