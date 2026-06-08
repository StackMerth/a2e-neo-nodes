/**
 * TensorDock v2 deploy test (correct API at last).
 *
 * Real endpoint:
 *   Base: https://dashboard.tensordock.com/api/v2
 *   Auth: Bearer <TENSORDOCK_API_TOKEN>
 *   Deploy: POST /instances
 *     body: { data: { type:'virtualmachine', attributes: {
 *       name, image, type:'virtualmachine',
 *       resources: { vcpu_count, ram_gb, storage_gb, gpus: { <model>: { count } } },
 *       location_id, useDedicatedIp, ssh_key,
 *       cloud_init?: { ... } } } }
 *   List instances: GET /instances
 *   Get instance:  GET /instances/{id}
 *   Delete:        DELETE /instances/{id}
 *
 * Hostnode-based deploys (full control) use hostnode_id; location-based
 * (auto-select) uses location_id. This script defaults to location-based
 * since location_id is easier to discover.
 *
 *   pnpm --filter @a2e/api exec tsx scripts/tensordock-v2-deploy-test.ts
 *     -> discover first available location + cheapest GPU model,
 *        deploy, poll until running, then auto-delete after 30s.
 *
 *   --keep       skip auto-delete
 *   --location <id>  override location_id
 *   --gpu <model>    e.g. rtxa4000-pcie-16gb, geforcertx3090-pcie-24gb
 *   --vcpus <n>      default 4
 *   --ram <gb>       default 16
 *   --storage <gb>   default 100 (API minimum)
 *   --image <slug>   default ubuntu2404
 */

import { randomBytes } from 'node:crypto'
import { generateRentalKeypair } from '../src/services/inbound/ssh-keygen.js'

const SCRIPT_VERSION = '2026-06-08-v2-dashboard-bearer'
const BASE_URL = 'https://dashboard.tensordock.com/api/v2'

interface Args {
  keep: boolean
  location?: string
  gpu?: string
  vcpus: number
  ram: number
  storage: number
  image: string
}

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  const out: Args = {
    keep: false,
    vcpus: 4,
    ram: 16,
    storage: 100,
    image: 'ubuntu2404',
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--keep') out.keep = true
    else if (a === '--location') out.location = argv[++i]
    else if (a === '--gpu') out.gpu = argv[++i]
    else if (a === '--vcpus') out.vcpus = parseInt(argv[++i]!, 10)
    else if (a === '--ram') out.ram = parseInt(argv[++i]!, 10)
    else if (a === '--storage') out.storage = parseInt(argv[++i]!, 10)
    else if (a === '--image') out.image = argv[++i]!
  }
  return out
}

async function req<T>(
  path: string,
  method: 'GET' | 'POST' | 'DELETE',
  token: string,
  body?: unknown,
): Promise<{ status: number; ok: boolean; text: string; json: T | null }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json: T | null = null
  try { json = JSON.parse(text) as T } catch { /* keep null */ }
  return { status: res.status, ok: res.ok, text, json }
}

async function main(): Promise<void> {
  console.log(`tensordock-v2-deploy-test v${SCRIPT_VERSION}`)
  console.log()

  const token = (process.env.TENSORDOCK_API_TOKEN ?? '').trim()
  if (!token) {
    console.log('TENSORDOCK_API_TOKEN must be set (the alphanumeric API token, not the Authorization ID UUID).')
    process.exit(1)
  }
  console.log(`Using token ${token.slice(0, 4)}...${token.slice(-4)} against ${BASE_URL}`)
  console.log()

  const args = parseArgs()
  console.log(`Args: location=${args.location ?? '(auto)'} gpu=${args.gpu ?? '(auto)'} vcpus=${args.vcpus} ram=${args.ram} storage=${args.storage} image="${args.image}" keep=${args.keep}`)
  console.log()

  // Step 1: verify auth via GET /instances (we already know this works).
  console.log('Verifying auth via GET /instances ...')
  const list = await req<{ data: unknown }>('/instances', 'GET', token)
  if (!list.ok) {
    console.log(`AUTH FAILED HTTP ${list.status}: ${list.text.slice(0, 500)}`)
    process.exit(1)
  }
  console.log(`  -> auth ok.`)
  console.log()

  // Step 2: discover locations + hostnodes. Try common path variants.
  let locationId = args.location
  let gpuModel = args.gpu

  if (!locationId || !gpuModel) {
    console.log('Discovering locations + hostnodes via GET /hostnodes ...')
    const hostnodes = await req<unknown>('/hostnodes', 'GET', token)
    console.log(`  HTTP ${hostnodes.status} content-type=${hostnodes.json ? 'json' : 'other'}`)
    if (hostnodes.ok && hostnodes.text.length < 5000) {
      console.log(`  body: ${hostnodes.text}`)
    } else if (hostnodes.ok) {
      console.log(`  body (first 3000 chars): ${hostnodes.text.slice(0, 3000)}`)
    } else {
      console.log(`  hostnodes call FAILED HTTP ${hostnodes.status}: ${hostnodes.text.slice(0, 500)}`)
      console.log()
      console.log('Trying GET /locations ...')
      const locs = await req<unknown>('/locations', 'GET', token)
      console.log(`  HTTP ${locs.status}`)
      console.log(`  body: ${locs.text.slice(0, 2000)}`)
      console.log()
      console.log('Need a location_id and gpu model from one of these responses.')
      console.log('Re-run with --location <id> --gpu <model> once you spot them in the output above.')
      process.exit(1)
    }

    if (!locationId || !gpuModel) {
      console.log()
      console.log('Re-run with --location <id> --gpu <model> picked from the hostnode/location JSON above.')
      process.exit(1)
    }
  }

  // Step 3: mint SSH keypair for the deploy.
  const keypair = generateRentalKeypair(`v2-probe-${Date.now()}`)
  const name = `a2e-v2-probe-${randomBytes(4).toString('hex')}`

  const deployBody = {
    data: {
      type: 'virtualmachine',
      attributes: {
        name,
        type: 'virtualmachine',
        image: args.image,
        resources: {
          vcpu_count: args.vcpus,
          ram_gb: args.ram,
          storage_gb: args.storage,
          gpus: {
            [gpuModel!]: { count: 1 },
          },
        },
        location_id: locationId!,
        useDedicatedIp: false,
        ssh_key: keypair.publicKeyOpenssh.trim(),
      },
    },
  }

  console.log('POST /instances body:')
  const logBody = JSON.parse(JSON.stringify(deployBody)) as typeof deployBody
  logBody.data.attributes.ssh_key = `<${keypair.publicKeyOpenssh.trim().length} chars: ${keypair.publicKeyOpenssh.trim().slice(0, 20)}...>`
  console.log(JSON.stringify(logBody, null, 2))
  console.log()

  const start = Date.now()
  const deploy = await req<{ data?: { id?: string; status?: string } }>('/instances', 'POST', token, deployBody)
  const elapsed = Date.now() - start
  console.log(`HTTP ${deploy.status} ${deploy.ok ? 'OK' : 'FAIL'} in ${elapsed}ms`)
  console.log()
  console.log('--- RESPONSE BODY ---')
  console.log(deploy.text)
  console.log('---------------------')
  console.log()

  if (!deploy.ok) {
    console.log('Deploy FAILED. Inspect body above for the cause.')
    process.exit(1)
  }

  const instanceId = deploy.json?.data?.id
  if (!instanceId) {
    console.log('Deploy 200 but no instance id in response. Inspect body.')
    process.exit(1)
  }

  console.log(`Deploy OK. instance_id=${instanceId}`)
  console.log()

  if (args.keep) {
    console.log('--keep set: leaving instance running. Clean up via dashboard or delete endpoint.')
    return
  }

  console.log('Sleeping 30s before auto-delete ...')
  await new Promise((resolve) => setTimeout(resolve, 30_000))

  console.log(`DELETE /instances/${instanceId} ...`)
  const del = await req<unknown>(`/instances/${instanceId}`, 'DELETE', token)
  console.log(`  HTTP ${del.status} ${del.ok ? 'OK' : 'FAIL'}: ${del.text.slice(0, 300)}`)
}

main().catch((err) => {
  console.error('tensordock-v2-deploy-test failed:', err)
  process.exit(1)
})
