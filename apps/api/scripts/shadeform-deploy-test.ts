/**
 * Shadeform direct deploy probe. Bypasses the allocator and ComputeRequest
 * flow; hits /instances/types + /sshkeys/add + /instances/create once with
 * EXACTLY the body the cascade would send, polls status until active or
 * timeout, then auto-deletes after 30s of run-time.
 *
 *   pnpm --filter @a2e/api exec tsx scripts/shadeform-deploy-test.ts
 *     -> picks cheapest available instance type (default L40S tier), deploys
 *
 *   pnpm --filter @a2e/api exec tsx scripts/shadeform-deploy-test.ts --gpu A100
 *     -> filter by GPU type substring
 *
 *   pnpm --filter @a2e/api exec tsx scripts/shadeform-deploy-test.ts --cloud crusoe
 *     -> pin underlying cloud (lambdalabs, crusoe, hyperstack, latitude, verda,
 *        massedcompute, nebius, vultr, paperspace, scaleway, digitalocean, etc.)
 *
 *   pnpm --filter @a2e/api exec tsx scripts/shadeform-deploy-test.ts --list-only
 *     -> dump cheapest 20 instance types, don't deploy
 *
 *   pnpm --filter @a2e/api exec tsx scripts/shadeform-deploy-test.ts --keep
 *     -> skip auto-delete on success
 *
 *   pnpm --filter @a2e/api exec tsx scripts/shadeform-deploy-test.ts --timeout 600
 *     -> custom poll timeout in seconds (default 300 = 5 min)
 *
 * Estimated cost per test (auto-delete after instance becomes active):
 *   L40S latitude $0.74/h × ~10 min = ~$0.12
 *   A100 hyperstack $1.35/h × ~10 min = ~$0.23
 *   Adjust expectations per cloud's boot time + your --timeout.
 *
 * Env vars:
 *   SHADEFORM_API_KEY    required
 *   SHADEFORM_API_BASE   optional override (default api.shadeform.ai/v1)
 */

import { randomBytes } from 'node:crypto'
import {
  ShadeFormClient,
  ShadeFormApiError,
  centsToDollars,
  isShadeFormConfigured,
  type ShadeFormInstanceType,
  type ShadeFormInstanceStatus,
} from '../src/services/inbound/shadeform-adapter.js'
import { generateRentalKeypair } from '../src/services/inbound/ssh-keygen.js'

const SCRIPT_VERSION = '2026-06-08-shadeform-deploy-test-heartbeat'

interface Args {
  gpu?: string
  cloud?: string
  listOnly: boolean
  keep: boolean
  timeoutSec: number
}

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  // Default 600s (10 min) — massedcompute, hyperstack, latitude can
  // take 5-10 minutes from create -> active.
  const out: Args = { listOnly: false, keep: false, timeoutSec: 600 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--gpu') out.gpu = argv[++i]
    else if (a === '--cloud') out.cloud = argv[++i]
    else if (a === '--list-only') out.listOnly = true
    else if (a === '--keep') out.keep = true
    else if (a === '--timeout') out.timeoutSec = parseInt(argv[++i]!, 10)
  }
  return out
}

function isPriorityType(t: ShadeFormInstanceType): boolean {
  const haystack = (t.configuration?.gpu_type ?? t.shade_instance_type ?? '').toUpperCase()
  return ['H100', 'H200', 'A100', 'L40S', 'B200'].some((tok) => haystack.includes(tok))
}

function pickFirstAvailableRegion(
  availability: Array<{ region?: string; available?: boolean }> | undefined,
): string | null {
  if (!availability) return null
  for (const a of availability) {
    if (a.available !== false && a.region) return a.region
  }
  return null
}

async function main(): Promise<void> {
  console.log(`shadeform-deploy-test v${SCRIPT_VERSION}`)
  console.log()

  if (!isShadeFormConfigured()) {
    console.log('SHADEFORM_API_KEY is not set. Add it to Render API env and re-run.')
    process.exit(1)
  }

  const args = parseArgs()
  console.log(`Args: gpu=${args.gpu ?? '(any priority tier)'} cloud=${args.cloud ?? '(any)'} list-only=${args.listOnly} keep=${args.keep} timeout=${args.timeoutSec}s`)
  console.log()

  const client = new ShadeFormClient()

  // Step 1: list available instance types.
  console.log('Fetching /instances/types (filtered to available) ...')
  let allTypes: ShadeFormInstanceType[]
  try {
    allTypes = await client.listInstanceTypes({ available: true })
  } catch (err) {
    console.log(`listInstanceTypes failed: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }
  console.log(`  -> ${allTypes.length} available instance types.`)

  // Filter by --cloud and --gpu (or default to priority datacenter tiers).
  let candidates = allTypes
  if (args.cloud) {
    candidates = candidates.filter((t) => t.cloud === args.cloud)
  }
  if (args.gpu) {
    const tok = args.gpu.toUpperCase()
    candidates = candidates.filter((t) => {
      const label = (t.configuration?.gpu_type ?? t.shade_instance_type ?? '').toUpperCase()
      return label.includes(tok)
    })
  } else {
    candidates = candidates.filter(isPriorityType)
  }

  // Sort cheapest first; types without a price sink to the bottom.
  candidates.sort((a, b) => {
    const ap = a.hourly_price ?? Number.POSITIVE_INFINITY
    const bp = b.hourly_price ?? Number.POSITIVE_INFINITY
    return ap - bp
  })

  if (candidates.length === 0) {
    console.log('No matching instance types. Try without --gpu or --cloud filters.')
    process.exit(1)
  }

  if (args.listOnly) {
    console.log()
    console.log(`Cheapest 20 of ${candidates.length} candidates:`)
    console.log()
    for (const t of candidates.slice(0, 20)) {
      const usd = centsToDollars(t.hourly_price)
      const regions = (t.availability ?? [])
        .filter((a) => a.available !== false && a.region)
        .map((a) => a.region)
        .slice(0, 3)
        .join(',')
      console.log(
        `  ${(t.cloud ?? '').padEnd(14)} ${t.shade_instance_type.padEnd(32)} ${(t.configuration?.gpu_type ?? '?').padEnd(10)} ${String(t.configuration?.num_gpus ?? 0).padStart(2)}x  $${usd.toFixed(2).padStart(5)}/h  regions=${regions}`,
      )
    }
    process.exit(0)
  }

  const chosen = candidates[0]!
  const chosenUsd = centsToDollars(chosen.hourly_price)
  const region = pickFirstAvailableRegion(chosen.availability)
  if (!region) {
    console.log(`Chosen type ${chosen.cloud}/${chosen.shade_instance_type} has no available region right now.`)
    process.exit(1)
  }
  console.log()
  console.log(`Chose: ${chosen.cloud} ${chosen.shade_instance_type} (${chosen.configuration?.gpu_type ?? '?'} x${chosen.configuration?.num_gpus ?? 1}) @ $${chosenUsd.toFixed(2)}/h in ${region}`)
  console.log()

  // Step 2: mint SSH keypair and register with Shadeform.
  const keypair = generateRentalKeypair(`shadeform-probe-${Date.now()}`)
  const keyName = `a2e-probe-${randomBytes(4).toString('hex')}`
  console.log(`Registering SSH key '${keyName}' via /sshkeys/add ...`)
  let sshKeyId: string
  try {
    const keyResp = await client.addSshKey({
      name: keyName,
      public_key: keypair.publicKeyOpenssh.trim(),
    })
    sshKeyId = keyResp.id
  } catch (err) {
    if (err instanceof ShadeFormApiError) {
      console.log(`addSshKey failed: HTTP ${err.statusCode}: ${JSON.stringify(err.body).slice(0, 300)}`)
    } else {
      console.log(`addSshKey failed: ${err instanceof Error ? err.message : err}`)
    }
    process.exit(1)
  }
  console.log(`  -> ssh_key_id=${sshKeyId}`)
  console.log()

  // Step 3: create the instance.
  const vmName = `a2e-probe-${randomBytes(4).toString('hex')}`
  console.log(`POST /instances/create body:`)
  const createBody = {
    cloud: chosen.cloud,
    region,
    shade_instance_type: chosen.shade_instance_type,
    shade_cloud: true,
    name: vmName,
    ssh_key_id: sshKeyId,
  }
  console.log(JSON.stringify(createBody, null, 2))
  console.log()

  const start = Date.now()
  let createResp
  try {
    createResp = await client.createInstance(createBody)
  } catch (err) {
    // Try to clean up the SSH key we registered.
    await client.deleteSshKey(sshKeyId).catch(() => undefined)
    if (err instanceof ShadeFormApiError) {
      console.log(`createInstance failed: HTTP ${err.statusCode}: ${JSON.stringify(err.body).slice(0, 500)}`)
    } else {
      console.log(`createInstance failed: ${err instanceof Error ? err.message : err}`)
    }
    process.exit(1)
  }
  const elapsed = Date.now() - start
  console.log(`Create OK in ${elapsed}ms. id=${createResp.id} status=${createResp.status}`)
  console.log()

  // Step 4: poll until active or timeout.
  const deadline = Date.now() + args.timeoutSec * 1000
  const pollInterval = 10_000
  let lastStatus: ShadeFormInstanceStatus | undefined = createResp.status
  let info
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollInterval))
    try {
      info = await client.getInstance(createResp.id)
    } catch (err) {
      console.log(`getInstance threw: ${err instanceof Error ? err.message : err}`)
      continue
    }
    const dt = Math.round((Date.now() - start) / 1000)
    if (info.status !== lastStatus) {
      console.log(`  ${dt}s: status=${info.status}${info.ip ? ` ip=${info.ip}` : ''}${info.ssh_port ? ` ssh_port=${info.ssh_port}` : ''}`)
      lastStatus = info.status
    } else {
      // Heartbeat: confirm the script is still polling even when status
      // hasn't changed. Massedcompute can sit in pending_provider for
      // 5-10 minutes; a silent loop looks frozen to the operator.
      console.log(`  ${dt}s: still ${info.status}${info.ip ? ` ip=${info.ip}` : ''}`)
    }
    if (info.status === 'active') break
    if (info.status === 'error' || info.status === 'deleted') {
      console.log(`Instance ended in status=${info.status}. Aborting poll.`)
      break
    }
  }

  if (!info || info.status !== 'active') {
    console.log()
    console.log(`Instance did not reach 'active' within ${args.timeoutSec}s. Final status=${info?.status ?? '(unknown)'}.`)
    // Clean up regardless so we don't bill while debugging.
    console.log(`Cleaning up: DELETE /instances/${createResp.id} + /sshkeys/${sshKeyId}`)
    await client.deleteInstance(createResp.id).catch(() => undefined)
    await client.deleteSshKey(sshKeyId).catch(() => undefined)
    process.exit(1)
  }

  console.log()
  console.log(`SUCCESS: instance is active at ${info.ip ?? '?'}:${info.ssh_port ?? 22}`)
  console.log(`Try: ssh -p ${info.ssh_port ?? 22} root@${info.ip ?? '?'}`)
  console.log()

  if (args.keep) {
    console.log('--keep set: NOT auto-deleting. Clean up via dashboard or:')
    console.log(`  curl -X POST https://api.shadeform.ai/v1/instances/${createResp.id}/delete -H "X-API-KEY: $SHADEFORM_API_KEY"`)
    console.log(`  curl -X POST https://api.shadeform.ai/v1/sshkeys/${sshKeyId}/delete -H "X-API-KEY: $SHADEFORM_API_KEY"`)
    return
  }

  console.log('Sleeping 30s before auto-delete ...')
  await new Promise((r) => setTimeout(r, 30_000))

  console.log(`Deleting instance ${createResp.id} ...`)
  try {
    await client.deleteInstance(createResp.id)
    console.log('  instance delete OK')
  } catch (err) {
    console.log(`  instance delete failed: ${err instanceof Error ? err.message : err}`)
  }

  console.log(`Deleting ssh key ${sshKeyId} ...`)
  try {
    await client.deleteSshKey(sshKeyId)
    console.log('  ssh key delete OK')
  } catch (err) {
    console.log(`  ssh key delete failed: ${err instanceof Error ? err.message : err}`)
  }
}

main().catch((err) => {
  console.error('shadeform-deploy-test failed:', err)
  process.exit(1)
})
