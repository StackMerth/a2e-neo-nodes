/**
 * T4 — Lambda Labs inspector.
 *
 * Read-only sanity check that calls the live Lambda API with your
 * configured LAMBDA_API_KEY and prints what you can rent right now.
 * Designed for the very first call after dropping the API key into
 * Render env — if this works, the adapter is healthy and T5 can
 * proceed to wire it into the allocator.
 *
 * Run modes:
 *
 *   pnpm --filter @a2e/api lambda:inspect
 *     -> default: list available instance types with H100/H200/B200
 *        emphasized, plus current account state (running instances +
 *        registered SSH keys)
 *
 *   pnpm --filter @a2e/api lambda:inspect --raw
 *     -> dump the full instance-type catalog (every model, every
 *        region) with no filtering
 *
 *   pnpm --filter @a2e/api lambda:inspect --instance <lambdaInstanceId>
 *     -> poll one instance by id (useful during the boot window
 *        before T5's polling worker exists)
 *
 * Aborts cleanly if LAMBDA_API_KEY is not set, with a one-line
 * instruction.
 */
import { LambdaClient, isLambdaConfigured } from '../src/services/inbound/lambda-adapter.js'

const PRIORITY_GPU_TOKENS = ['H100', 'H200', 'B200']

async function main(): Promise<void> {
  if (!isLambdaConfigured()) {
    console.log('LAMBDA_API_KEY is not set. Add it to Render API env:')
    console.log('  1) Sign up at lambdalabs.com (if not done) and fund the account')
    console.log('  2) Cloud API -> Create API key')
    console.log('  3) Render -> tokenosdeai-api -> Environment -> add LAMBDA_API_KEY=<key>')
    console.log('  4) Save, wait for redeploy, re-run this script')
    process.exit(1)
  }

  const args = process.argv.slice(2)
  const wantRaw = args.includes('--raw')
  const instanceFlagIdx = args.indexOf('--instance')
  const instanceArg = instanceFlagIdx >= 0 ? args[instanceFlagIdx + 1] : null

  const client = new LambdaClient()

  if (instanceArg) {
    const inst = await client.getInstance(instanceArg)
    console.log(`Instance ${inst.id}`)
    console.log(`  status:       ${inst.status}`)
    console.log(`  name:         ${inst.name ?? '(unnamed)'}`)
    console.log(`  type:         ${inst.instanceTypeName}`)
    console.log(`  region:       ${inst.region}`)
    console.log(`  ip:           ${inst.ip ?? '(not yet assigned)'}`)
    console.log(`  ssh keys:     ${inst.sshKeyNames.join(', ') || '(none)'}`)
    console.log(`  price/hour:   ${inst.pricePerHourUsd !== null ? `$${inst.pricePerHourUsd.toFixed(2)}` : '(n/a)'}`)
    console.log(`  created:      ${inst.createdAt ?? '(unknown)'}`)
    return
  }

  console.log('Calling Lambda API...')
  console.log()

  const [types, instances, sshKeys] = await Promise.all([
    client.listInstanceTypes(),
    client.listInstances(),
    client.listSshKeys(),
  ])

  // Instance types (catalogue + availability)
  const sorted = types.slice().sort((a, b) => a.pricePerHourUsd - b.pricePerHourUsd)
  const priority = sorted.filter((t) =>
    PRIORITY_GPU_TOKENS.some((tok) =>
      `${t.name} ${t.description} ${t.gpuDescription}`.toUpperCase().includes(tok),
    ),
  )

  if (!wantRaw && priority.length > 0) {
    console.log(`Priority types (H100 / H200 / B200) — ${priority.length} found:`)
    console.log()
    console.log(`  ${'name'.padEnd(36)} ${'gpus'.padEnd(5)} ${'$/h'.padEnd(8)} regions`)
    for (const t of priority) {
      const regions = t.regionsAvailable.length === 0
        ? '(no capacity right now)'
        : t.regionsAvailable.join(', ')
      console.log(
        `  ${t.name.padEnd(36)} ${String(t.specs.gpus).padEnd(5)} $${t.pricePerHourUsd.toFixed(2).padEnd(7)} ${regions}`,
      )
    }
    console.log()
    console.log(`Full catalogue (${sorted.length} types) hidden — run with --raw to dump everything.`)
  } else {
    console.log(`Full instance-type catalogue (${sorted.length} types):`)
    console.log()
    console.log(`  ${'name'.padEnd(36)} ${'gpus'.padEnd(5)} ${'$/h'.padEnd(8)} regions`)
    for (const t of sorted) {
      const regions = t.regionsAvailable.length === 0
        ? '(no capacity)'
        : t.regionsAvailable.join(', ')
      console.log(
        `  ${t.name.padEnd(36)} ${String(t.specs.gpus).padEnd(5)} $${t.pricePerHourUsd.toFixed(2).padEnd(7)} ${regions}`,
      )
    }
  }
  console.log()

  // Running instances
  console.log(`Account: ${instances.length} running instance(s)`)
  if (instances.length > 0) {
    for (const inst of instances) {
      console.log(
        `  ${inst.id}  ${inst.status.padEnd(12)} ${inst.instanceTypeName.padEnd(28)} ${inst.region.padEnd(14)} ${inst.ip ?? '(no ip)'}  $${(inst.pricePerHourUsd ?? 0).toFixed(2)}/h`,
      )
    }
  }
  console.log()

  // SSH keys on the account
  console.log(`SSH keys registered: ${sshKeys.length}`)
  for (const k of sshKeys) {
    console.log(`  ${k.id.padEnd(28)} ${k.name}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
