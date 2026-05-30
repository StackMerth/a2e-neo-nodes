/**
 * T5a — Lambda Labs provision / poll / terminate test harness.
 *
 * Exercises the full provision -> poll -> terminate lifecycle
 * end-to-end against the real Lambda API. Use this once
 * LAMBDA_API_KEY + SSH_KEY_ENCRYPTION_KEY are both set in Render env
 * to prove T5a works before T5b wires the allocator.
 *
 * Modes (default = inspect / read-only):
 *
 *   pnpm --filter @a2e/api lambda-provision:test
 *     -> list every ExternalRental row + summary capacity for our
 *        tier-mapped Lambda types. No writes, no Lambda mutations.
 *
 *   pnpm --filter @a2e/api lambda-provision:test --rent <GpuTier>
 *     -> create a synthetic ComputeRequest with the given tier,
 *        provision a Lambda instance for it, print the ExternalRental
 *        id you can pass to --poll / --terminate. WARNING: this
 *        spins up a real Lambda instance and starts billing your
 *        Lambda account at the type's per-hour rate.
 *
 *   pnpm --filter @a2e/api lambda-provision:test --poll <externalRentalId>
 *     -> single poll of one ExternalRental. Updates status + sshHost
 *        in DB and prints the latest snapshot from Lambda.
 *
 *   pnpm --filter @a2e/api lambda-provision:test --terminate <externalRentalId>
 *     -> stop billing on the rental. Idempotent.
 *
 * The synthetic ComputeRequest path uses a test user with role
 * COMPUTE_BUYER (seeds one if none exists) so the foreign key on
 * ExternalRental.computeRequestId resolves cleanly.
 */

import { prisma } from '@a2e/database'
import type { GpuTier } from '@a2e/database'
import {
  provisionLambdaRental,
  pollLambdaRentalStatus,
  terminateLambdaRental,
} from '../src/services/inbound/lambda-provision.js'
import { LambdaClient, isLambdaConfigured } from '../src/services/inbound/lambda-adapter.js'
import { isKeyEncryptionConfigured } from '../src/services/inbound/key-encryption.js'
import { lambdaTypeForTier } from '../src/services/inbound/tier-mapping.js'

const TEST_USER_EMAIL = 'lambda-provision-test@system.tokenos.internal'

async function main(): Promise<void> {
  if (!isLambdaConfigured()) {
    console.log('LAMBDA_API_KEY is not set. Run lambda:inspect for setup instructions.')
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
      console.log('--rent requires a GpuTier (e.g. H100, B200, L40S).')
      process.exit(1)
    }
    await runRent(tier as GpuTier)
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
  console.log('Tier mappings (internal GpuTier -> Lambda instance type):')
  for (const tier of ['H100', 'H200', 'B200', 'B300', 'GB300', 'L40S'] as GpuTier[]) {
    const m = lambdaTypeForTier(tier)
    if (m) {
      console.log(`  ${tier.padEnd(7)} -> ${m.instanceTypeName.padEnd(28)} (${m.label})`)
    }
  }
  console.log()

  const client = new LambdaClient()
  const types = await client.listInstanceTypes()
  console.log('Capacity right now for our mapped types:')
  for (const tier of ['H100', 'H200', 'B200', 'B300', 'GB300', 'L40S'] as GpuTier[]) {
    const m = lambdaTypeForTier(tier)
    if (!m) continue
    const found = types.find((t) => t.name === m.instanceTypeName)
    if (!found) {
      console.log(`  ${m.instanceTypeName.padEnd(28)} unknown to Lambda (mapping needs update)`)
      continue
    }
    const regions = found.regionsAvailable.length === 0 ? '(no capacity)' : found.regionsAvailable.join(', ')
    console.log(`  ${m.instanceTypeName.padEnd(28)} $${found.pricePerHourUsd.toFixed(2)}/h in ${regions}`)
  }
  console.log()

  const rentals = await prisma.externalRental.findMany({
    orderBy: { createdAt: 'desc' },
    take: 20,
  })
  console.log(`ExternalRental rows in DB: ${rentals.length}`)
  for (const r of rentals) {
    console.log(`  ${r.id.padEnd(28)} ${r.status.padEnd(8)} ${r.provider} ${r.providerInstanceType.padEnd(28)} ${r.providerRegion.padEnd(14)} ${r.sshHost ?? '(no ip)'}  $${r.providerPricePerHourUsd.toFixed(2)}/h`)
  }
}

async function runRent(tier: GpuTier): Promise<void> {
  const m = lambdaTypeForTier(tier)
  if (!m) {
    console.log(`No Lambda mapping for tier ${tier}. Aborting (would not be able to provision).`)
    process.exit(1)
  }

  // Ensure a test user exists so the synthetic ComputeRequest's
  // userId foreign key resolves.
  const user = await prisma.user.upsert({
    where: { email: TEST_USER_EMAIL },
    create: {
      email: TEST_USER_EMAIL,
      role: 'COMPUTE_BUYER',
      isBuyer: true,
    },
    update: {},
    select: { id: true },
  })

  // Create the synthetic ComputeRequest. The fields we touch keep the
  // record valid for the schema's required columns; everything else
  // defaults / null. requestedAt now, durationDays 1 so it has an
  // expiresAt the meter can wind down against if T5b ever connects.
  const cr = await prisma.computeRequest.create({
    data: {
      userId: user.id,
      gpuTier: tier,
      gpuCount: 1,
      durationDays: 1,
      ratePerDay: 0,
      totalCost: 0,
      txHash: `T5A_TEST_${Date.now()}`,
      txConfirmed: true,
      status: 'PENDING',
      paymentSource: 'BUYER_BALANCE',
    },
    select: { id: true },
  })
  console.log(`Created synthetic ComputeRequest ${cr.id}`)

  console.log(`Provisioning Lambda instance for ${tier} (${m.instanceTypeName})...`)
  console.log('  WARNING: this starts real billing on your Lambda account.')
  const result = await provisionLambdaRental(prisma, cr.id)

  console.log()
  console.log('Provisioned:')
  console.log(`  externalRentalId:     ${result.externalRentalId}`)
  console.log(`  providerInstanceId:   ${result.providerInstanceId}`)
  console.log(`  providerInstanceType: ${result.providerInstanceType}`)
  console.log(`  providerRegion:       ${result.providerRegion}`)
  console.log(`  providerPrice:        $${result.providerPricePerHourUsd.toFixed(2)}/h`)
  console.log()
  console.log('Poll status with:')
  console.log(`  pnpm --filter @a2e/api lambda-provision:test --poll ${result.externalRentalId}`)
  console.log('Terminate (stops billing) with:')
  console.log(`  pnpm --filter @a2e/api lambda-provision:test --terminate ${result.externalRentalId}`)
}

async function runPoll(externalRentalId: string): Promise<void> {
  const inst = await pollLambdaRentalStatus(prisma, externalRentalId)
  const row = await prisma.externalRental.findUnique({ where: { id: externalRentalId } })
  if (!row) {
    console.log('ExternalRental not found after poll.')
    return
  }
  console.log(`ExternalRental ${row.id}`)
  console.log(`  internal status:  ${row.status}`)
  console.log(`  provider status:  ${inst?.status ?? '(closed / 404)'}`)
  console.log(`  sshHost:          ${row.sshHost ?? '(no ip yet)'}`)
  console.log(`  sshUsername:      ${row.sshUsername}`)
  console.log(`  launchedAt:       ${row.launchedAt?.toISOString() ?? '(not yet)'}`)
  console.log(`  lastError:        ${row.lastError ?? '(none)'}`)
  if (inst) {
    console.log()
    console.log('Provider snapshot:')
    console.log(`  id:           ${inst.id}`)
    console.log(`  status:       ${inst.status}`)
    console.log(`  region:       ${inst.region}`)
    console.log(`  ip:           ${inst.ip ?? '(none)'}`)
    console.log(`  ssh key names: ${inst.sshKeyNames.join(', ')}`)
  }
}

async function runTerminate(externalRentalId: string, reason: string): Promise<void> {
  console.log(`Terminating ${externalRentalId}: ${reason}`)
  await terminateLambdaRental(prisma, externalRentalId, reason)
  const row = await prisma.externalRental.findUnique({ where: { id: externalRentalId } })
  console.log(`  status:                  ${row?.status}`)
  console.log(`  terminationRequestedAt:  ${row?.terminationRequestedAt?.toISOString() ?? '(not set)'}`)
  console.log(`  terminatedAt:            ${row?.terminatedAt?.toISOString() ?? '(not set)'}`)
  console.log(`  lastError:               ${row?.lastError ?? '(none)'}`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
