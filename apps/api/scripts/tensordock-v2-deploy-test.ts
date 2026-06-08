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

const SCRIPT_VERSION = '2026-06-08-v2-default-image-nvidia-570'
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
    // Docs Instance Creation example uses storage_gb: 200; the stated
    // minimum of 100 was rejected at the deploy stage with a generic
    // "unexpected error". 200 matches what TensorDock's docs show
    // works.
    storage: 200,
    // ubuntu2404 (no driver) deploys took ~9s then failed with
    // "unexpected error during deployment" — the GPU couldn't bind
    // without NVIDIA drivers. Use the _nvidia_570 variant: Ubuntu
    // 24.04 with drivers pre-installed. Valid enum from API docs:
    //   ubuntu2204, ubuntu2404, ubuntu2204_nvidia_550, _570
    //   ubuntu2404_nvidia_550, _570
    //   ubuntu2404_ml_everything, ubuntu2404_ml_pytorch,
    //   ubuntu2404_ml_tensorflow, ubuntu2204_base, ubuntu2404_base,
    //   windows10
    image: 'ubuntu2404_nvidia_570',
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

  // Step 2: always re-fetch hostnodes so we pick a live host. Even
  // when --location and --gpu are passed, the host might have lost
  // capacity since the operator picked it; we use the fresh catalog
  // to drive port-forwarding vs dedicated-IP decisions plus available
  // external port selection.
  console.log('Fetching live hostnodes catalog via GET /hostnodes ...')
  type HostNode = {
    id: string
    location_id: string
    available_resources?: {
      gpus?: Array<{ v0Name?: string; availableCount?: number; price_per_hr?: number }>
      available_ports?: number[]
      has_public_ip_available?: boolean
    }
    location?: { city?: string; country?: string }
  }
  const hostnodes = await req<{ data?: { hostnodes?: HostNode[] } }>('/hostnodes', 'GET', token)
  if (!hostnodes.ok || !hostnodes.json?.data?.hostnodes) {
    console.log(`  hostnodes failed: HTTP ${hostnodes.status} ${hostnodes.text.slice(0, 300)}`)
    process.exit(1)
  }
  const allHosts = hostnodes.json.data.hostnodes
  console.log(`  -> ${allHosts.length} hostnodes returned.`)

  // Filter to hosts with available capacity for the requested (or any
  // priority) GPU and a viable network mode.
  const gpuFilter = args.gpu
  const candidates = allHosts.flatMap((h) => {
    const gpus = h.available_resources?.gpus ?? []
    const ports = h.available_resources?.available_ports ?? []
    const hasIp = h.available_resources?.has_public_ip_available === true
    return gpus
      .filter((g) => g.v0Name && (g.availableCount ?? 0) >= 1)
      .filter((g) => !gpuFilter || g.v0Name === gpuFilter)
      .map((g) => ({
        hostId: h.id,
        locationId: h.location_id,
        city: h.location?.city ?? '?',
        country: h.location?.country ?? '?',
        gpuModel: g.v0Name!,
        available: g.availableCount!,
        pricePerHr: g.price_per_hr ?? 0,
        externalPort: ports[0] ?? 0,
        usePortForward: ports.length > 0,
        useDedicatedIp: hasIp && ports.length === 0,
      }))
      .filter((c) => c.usePortForward || c.useDedicatedIp)
  })
  if (candidates.length === 0) {
    console.log('No hosts with capacity + viable network mode right now. Try again in a moment or pick a different --gpu.')
    process.exit(1)
  }
  candidates.sort((a, b) => a.pricePerHr - b.pricePerHr)
  const chosen = args.location
    ? candidates.find((c) => c.locationId === args.location) ?? candidates[0]!
    : candidates[0]!
  console.log(`  -> chose ${chosen.gpuModel} at ${chosen.city}, ${chosen.country}: $${chosen.pricePerHr.toFixed(2)}/h ` +
    `(host ${chosen.hostId}, mode=${chosen.usePortForward ? 'port_forward' : 'dedicated_ip'})`)
  console.log()
  const locationId = chosen.locationId
  const gpuModel = chosen.gpuModel
  const externalPort = chosen.externalPort
  const useDedicatedIp = chosen.useDedicatedIp

  // Step 3: mint SSH keypair for the deploy.
  const keypair = generateRentalKeypair(`v2-probe-${Date.now()}`)
  const name = `a2e-v2-probe-${randomBytes(4).toString('hex')}`

  // port_forwards / useDedicatedIp already resolved during host
  // selection above based on the live catalog.
  const attrs: Record<string, unknown> = {
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
    useDedicatedIp,
    ssh_key: keypair.publicKeyOpenssh.trim(),
  }
  if (!useDedicatedIp) {
    attrs.port_forwards = [{ internal_port: 22, external_port: externalPort }]
  }
  const deployBody = { data: { type: 'virtualmachine', attributes: attrs } }

  console.log('POST /instances body:')
  const logBody = JSON.parse(JSON.stringify(deployBody)) as { data: { attributes: { ssh_key: string } } }
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
