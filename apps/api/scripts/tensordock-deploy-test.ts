/**
 * Direct TensorDock deploy probe. Bypasses the allocator and the
 * compute-request flow entirely; hits /client/deploy/single ONCE with
 * EXACTLY the body the cascade would send, then prints the FULL raw
 * response (HTTP status + body, no truncation). On success, sleeps
 * 30s then deletes the VM automatically.
 *
 * Use this to debug why deploys 500 — Render's log viewer truncates
 * long HTML bodies at the first newline, so the allocator path can't
 * surface the actual exception message. This script writes to stdout
 * directly so the entire HTML response is preserved.
 *
 *   pnpm --filter @a2e/api exec tsx scripts/tensordock-deploy-test.ts
 *     -> uses the cheapest matching host for the default tier
 *
 *   pnpm --filter @a2e/api exec tsx scripts/tensordock-deploy-test.ts --gpu rtxa4000
 *     -> filter to a specific GPU substring
 *
 *   pnpm --filter @a2e/api exec tsx scripts/tensordock-deploy-test.ts --host <id>
 *     -> pin a specific host
 *
 *   pnpm --filter @a2e/api exec tsx scripts/tensordock-deploy-test.ts --keep
 *     -> on success, DO NOT auto-delete (manual cleanup required)
 *
 *   pnpm --filter @a2e/api exec tsx scripts/tensordock-deploy-test.ts --os "Ubuntu 20.04 LTS"
 *     -> override the operating_system slug (alx-proven default is
 *        Ubuntu 22.04 LTS but some hosts only carry 20.04)
 *
 * Bill cost: $0.01-$0.05 per run depending on rate + 30s auto-delete.
 */

import { randomBytes } from 'node:crypto'
import {
  TensorDockClient,
  TensorDockApiError,
  flattenHostNodes,
  isTensorDockConfigured,
} from '../src/services/inbound/tensordock-adapter.js'
import { generateRentalKeypair } from '../src/services/inbound/ssh-keygen.js'

const SCRIPT_VERSION = '2026-06-08-47822e0-plus'

interface Args {
  gpu?: string
  host?: string
  keep: boolean
  os: string
  noCloudinit: boolean
  storage: number
  vcpus: number
  ram: number
  /** Cloud-init format: 'header' = standard #cloud-config, 'alx' = bare YAML
   * matching the alx_tensordock_deploy sample, 'bash' = raw bash script. */
  cloudInitFormat: 'header' | 'alx' | 'bash'
}

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  const out: Args = {
    keep: false,
    os: 'Ubuntu 22.04 LTS',
    noCloudinit: false,
    // alx default is 70 GB storage; was 50 which triggered a deeper
    // provision-time failure on the rtxa4000 host (3.5s slow-fail).
    storage: 70,
    vcpus: 4,
    ram: 16,
    cloudInitFormat: 'alx',
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--gpu') out.gpu = argv[++i]
    else if (a === '--host') out.host = argv[++i]
    else if (a === '--os') out.os = argv[++i]!
    else if (a === '--keep') out.keep = true
    else if (a === '--no-cloudinit') out.noCloudinit = true
    else if (a === '--storage') out.storage = parseInt(argv[++i]!, 10)
    else if (a === '--vcpus') out.vcpus = parseInt(argv[++i]!, 10)
    else if (a === '--ram') out.ram = parseInt(argv[++i]!, 10)
    else if (a === '--cloudinit') {
      const v = argv[++i]
      if (v === 'header' || v === 'alx' || v === 'bash') out.cloudInitFormat = v
    }
  }
  return out
}

async function rawRequest(
  baseUrl: string,
  path: string,
  bodyFields: Record<string, string>,
): Promise<{ status: number; ok: boolean; bodyText: string; contentType: string | null }> {
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(bodyFields)) body.set(k, v)
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const text = await res.text()
  return {
    status: res.status,
    ok: res.ok,
    bodyText: text,
    contentType: res.headers.get('content-type'),
  }
}

async function main(): Promise<void> {
  console.log(`tensordock-deploy-test v${SCRIPT_VERSION}`)
  console.log()

  if (!isTensorDockConfigured()) {
    console.log('TENSORDOCK_API_KEY and TENSORDOCK_API_TOKEN must be set.')
    process.exit(1)
  }

  const apiKey = process.env.TENSORDOCK_API_KEY!.trim()
  const apiToken = process.env.TENSORDOCK_API_TOKEN!.trim()
  const baseUrl = (process.env.TENSORDOCK_API_BASE ?? 'https://marketplace.tensordock.com/api/v0').replace(/\/+$/, '')

  const args = parseArgs()
  console.log(`Args: gpu=${args.gpu ?? '(any)'} host=${args.host ?? '(any)'} os="${args.os}" keep=${args.keep} no-cloudinit=${args.noCloudinit}`)
  console.log()

  // Step 1: hostnode catalog.
  const client = new TensorDockClient()
  console.log('Fetching host catalog via /client/deploy/hostnodes ...')
  const hostsResp = await client.listHostNodes()
  const rows = flattenHostNodes(hostsResp)

  // Pick host.
  let chosen
  if (args.host) {
    chosen = rows.find((r) => r.hostId === args.host)
    if (!chosen) {
      console.log(`No host with id ${args.host} in catalog.`)
      process.exit(1)
    }
  } else {
    const candidates = rows
      .filter((r) => r.online && r.amount >= 1 && (r.price ?? Infinity) > 0)
      .filter((r) => !args.gpu || r.gpu_model.toLowerCase().includes(args.gpu.toLowerCase()))
      .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))
    chosen = candidates[0]
    if (!chosen) {
      console.log('No matching host with capacity. Try --gpu <token> or unset.')
      process.exit(1)
    }
  }

  console.log(`Chosen host: ${chosen.hostId}`)
  console.log(`  country: ${chosen.country}`)
  console.log(`  gpu_model: ${chosen.gpu_model}`)
  console.log(`  amount: ${chosen.amount} card(s)`)
  console.log(`  price: ${chosen.price !== undefined ? `$${chosen.price.toFixed(2)}/h` : '(unknown)'}`)
  console.log(`  available external ports (first 5 of ${chosen.availableExternalPorts.length}): ${chosen.availableExternalPorts.slice(0, 5).join(', ')}${chosen.availableExternalPorts.length > 5 ? ', ...' : ''}`)
  console.log()

  if (chosen.availableExternalPorts.length === 0) {
    console.log('Host has no free external ports. Cannot deploy.')
    process.exit(1)
  }

  // Step 2: build deploy body.
  const keypair = generateRentalKeypair(`testprobe-${Date.now()}`)
  const password = randomBytes(24).toString('base64url')
  const internalPort = 22
  const externalPort = chosen.availableExternalPorts[0]!

  const cloudInit = args.noCloudinit
    ? ''
    : [
      '#cloud-config',
      'ssh_pwauth: false',
      'users:',
      '  - name: root',
      '    lock_passwd: false',
      '    ssh_authorized_keys:',
      `      - ${keypair.publicKeyOpenssh.trim()}`,
      'runcmd:',
      '  - [ mkdir, -p, /root/.ssh ]',
      `  - bash -c "echo '${keypair.publicKeyOpenssh.trim()}' >> /root/.ssh/authorized_keys"`,
      '  - [ chmod, "600", /root/.ssh/authorized_keys ]',
      '  - [ chmod, "700", /root/.ssh ]',
      '  - [ systemctl, restart, sshd ]',
    ].join('\\n')

  const body: Record<string, string> = {
    api_key: apiKey,
    api_token: apiToken,
    name: `a2e-probe-${randomBytes(4).toString('hex')}`,
    password,
    hostnode: chosen.hostId,
    gpu_model: chosen.gpu_model,
    gpu_count: '1',
    vcpus: '4',
    ram: '16',
    storage: '50',
    operating_system: args.os,
    internal_ports: `{${internalPort}}`,
    external_ports: `{${externalPort}}`,
  }
  if (cloudInit) body.cloudinit_script = cloudInit

  // Log body shape (redact secrets).
  const bodyForLog = { ...body }
  bodyForLog.api_key = `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`
  bodyForLog.api_token = `${apiToken.slice(0, 4)}...${apiToken.slice(-4)}`
  bodyForLog.password = '<redacted>'
  if (bodyForLog.cloudinit_script) {
    bodyForLog.cloudinit_script = `<${(cloudInit as string).length} chars: ${(cloudInit as string).slice(0, 80)}...>`
  }
  console.log('POST body fields:')
  for (const [k, v] of Object.entries(bodyForLog)) console.log(`  ${k}: ${v}`)
  console.log()

  // Step 3: send.
  console.log(`Calling ${baseUrl}/client/deploy/single ...`)
  const start = Date.now()
  const resp = await rawRequest(baseUrl, '/client/deploy/single', body)
  const elapsed = Date.now() - start
  console.log(`HTTP ${resp.status} ${resp.ok ? 'OK' : 'FAIL'} in ${elapsed}ms`)
  console.log(`Content-Type: ${resp.contentType ?? '(none)'}`)
  console.log()
  console.log('--- BEGIN RESPONSE BODY ---')
  console.log(resp.bodyText)
  console.log('--- END RESPONSE BODY ---')
  console.log()

  if (!resp.ok) {
    console.log('Deploy FAILED. Use the response body above to identify the cause.')
    console.log('Common failures:')
    console.log('  - "operating_system" -> the host does not support that OS slug; try --os "Ubuntu 20.04 LTS"')
    console.log('  - "external_ports" -> the port we picked is not in the host\'s pool')
    console.log('  - "cloudinit_script" -> retry with --no-cloudinit to bypass cloud-init')
    console.log('  - "gpu_count" -> request count exceeds host availability')
    console.log('  - 500 generic -> TensorDock side; try a different --host')
    process.exit(1)
  }

  // Parse server id from successful response.
  let parsed: { success?: boolean; server?: string | { id?: string }; ip?: string; port_forwards?: Record<string, number> }
  try {
    parsed = JSON.parse(resp.bodyText)
  } catch {
    console.log('Response was 2xx but not JSON. Cannot extract server id.')
    process.exit(1)
  }

  const serverId = typeof parsed.server === 'string' ? parsed.server : parsed.server?.id
  if (!serverId) {
    console.log('Response 2xx but no server id in body.')
    process.exit(1)
  }

  console.log(`Deploy OK. server_id=${serverId} ip=${parsed.ip ?? '(none)'}`)
  if (parsed.port_forwards) {
    console.log(`port_forwards: ${JSON.stringify(parsed.port_forwards)}`)
  }

  if (args.keep) {
    console.log()
    console.log('--keep set: NOT auto-deleting. Clean up manually via dashboard.')
    return
  }

  console.log()
  console.log('Sleeping 30s before auto-delete ...')
  await new Promise((resolve) => setTimeout(resolve, 30_000))

  console.log(`Deleting server ${serverId} ...`)
  try {
    const deleteResp = await client.deleteServer(serverId)
    console.log(`Delete response: success=${deleteResp.success} error=${deleteResp.error ?? '(none)'}`)
  } catch (err) {
    if (err instanceof TensorDockApiError) {
      console.log(`Delete failed: HTTP ${err.statusCode}: ${TensorDockApiError.summarize(err.body)}`)
    } else {
      console.log(`Delete failed: ${err instanceof Error ? err.message : err}`)
    }
  }
}

main().catch((err) => {
  console.error('tensordock-deploy-test failed:', err)
  process.exit(1)
})
