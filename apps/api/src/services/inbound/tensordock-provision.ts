/**
 * TensorDock rental orchestrator.
 *
 * Mirror of vastai-provision.ts adapted to TensorDock's marketplace
 * model (POST /client/deploy/single with a specific hostnode UUID +
 * full VM spec). Three operations:
 *
 *   provisionTensorDockRental(prisma, computeRequestId, options?)
 *     1. Verify request, map GpuTier -> TensorDock model substring set
 *     2. GET /client/deploy/hostnodes (no auth), filter to online hosts
 *        carrying a matching model with >= gpuCount cards
 *     3. Pick the cheapest host by per-card price
 *     4. Generate ephemeral ed25519 keypair + random root password
 *     5. Render cloud-init script that drops the pubkey into root's
 *        authorized_keys and ensures sshd runs
 *     6. POST /client/deploy/single with hostnode + cloudinit_script
 *     7. Persist ExternalRental (provider='TENSORDOCK') with encrypted
 *        privkey + provider price + initial port_forwards mapping
 *
 *   pollTensorDockRentalStatus(prisma, externalRentalId)
 *     One poll of /client/get/single. Updates status + sshHost +
 *     sshPort + launchedAt when status transitions to running.
 *
 *   terminateTensorDockRental(prisma, externalRentalId, reason)
 *     Calls /client/delete/single. Idempotent (deleting twice is OK).
 *
 * Status mapping (TensorDock -> ExternalRental.status):
 *   pending / installing / building   -> PENDING
 *   running                            -> ACTIVE
 *   stopped / paused                   -> DEGRADED
 *   terminated / deleted               -> CLOSED
 *
 * SSH model. TensorDock allocates EXTERNAL ports per host and maps
 * them to the VM's internal ports via the host's NAT. The deploy
 * response returns port_forwards as { "<external>": <internal> }, so
 * the external port whose value is 22 is the SSH port we expose to
 * buyers. The cloud-init script installs the pubkey into
 * /root/.ssh/authorized_keys; sshUsername=root.
 */

import type { PrismaClient } from '@a2e/database'
import { randomBytes } from 'node:crypto'
import {
  TensorDockClient,
  TensorDockApiError,
  flattenHostNodes,
  type TensorDockServer,
} from './tensordock-adapter.js'
import {
  tensorDockTypeForTier,
  fitsSingleTensorDockHost,
  stockMatchesTier,
} from './tensordock-tier-mapping.js'
import { generateRentalKeypair } from './ssh-keygen.js'
import { encryptPrivateKey, isKeyEncryptionConfigured } from './key-encryption.js'

export class TensorDockProvisionError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message)
    this.name = 'TensorDockProvisionError'
  }
}

export interface TensorDockProvisionResult {
  externalRentalId: string
  providerInstanceId: string
  providerInstanceType: string
  providerRegion: string
  providerPricePerHourUsd: number
}

export interface TensorDockProvisionOptions {
  client?: TensorDockClient
  /** OS slug to request. TensorDock accepts "Ubuntu 22.04 LTS" etc. */
  operatingSystem?: string
  /** Storage in GB. Default 100. */
  storageGb?: number
  /**
   * Internal ports to expose. SSH (22) is always added; additional
   * entries are appended. Useful for buyers who want Jupyter / VNC.
   */
  extraInternalPorts?: number[]
}

const DEFAULT_OS = 'Ubuntu 22.04 LTS'

export async function provisionTensorDockRental(
  prisma: PrismaClient,
  computeRequestId: string,
  options: TensorDockProvisionOptions = {},
): Promise<TensorDockProvisionResult> {
  if (!isKeyEncryptionConfigured()) {
    throw new TensorDockProvisionError(
      'SSH_KEY_ENCRYPTION_KEY env var must be set before any external rental can be provisioned.',
    )
  }

  const cr = await prisma.computeRequest.findUnique({ where: { id: computeRequestId } })
  if (!cr) throw new TensorDockProvisionError(`ComputeRequest ${computeRequestId} not found.`)
  if (cr.status !== 'PENDING') {
    throw new TensorDockProvisionError(
      `ComputeRequest ${computeRequestId} is in ${cr.status}, expected PENDING.`,
    )
  }

  // Step 1: GpuTier -> TensorDock model substring set.
  const mapping = tensorDockTypeForTier(cr.gpuTier)
  if (!mapping) {
    throw new TensorDockProvisionError(
      `TensorDock has no mapping for tier ${cr.gpuTier}. Allocator should skip TensorDock for this request.`,
    )
  }
  if (!fitsSingleTensorDockHost(cr.gpuTier, cr.gpuCount)) {
    throw new TensorDockProvisionError(
      `Tier ${cr.gpuTier} x ${cr.gpuCount} exceeds TensorDock per-host max (${mapping.gpusPerHostMax}).`,
    )
  }

  const api = options.client ?? new TensorDockClient()

  // Step 2: hostnode catalog (no auth round-trip needed).
  const hostsResp = await api.listHostNodes()
  const rows = flattenHostNodes(hostsResp)
  const candidates = rows
    .filter((r) => r.online)
    .filter((r) => stockMatchesTier(r.gpu_model, cr.gpuTier))
    .filter((r) => r.amount >= cr.gpuCount)

  if (candidates.length === 0) {
    throw new TensorDockProvisionError(
      `TensorDock has no online hosts carrying tier ${cr.gpuTier} x ${cr.gpuCount} right now.`,
    )
  }

  // Step 3: pick cheapest by per-card price. Hosts without a price
  // sink to the bottom; we prefer hosts that surface live pricing.
  const ranked = [...candidates].sort((a, b) => {
    const ap = a.price ?? Number.POSITIVE_INFINITY
    const bp = b.price ?? Number.POSITIVE_INFINITY
    return ap - bp
  })
  const cheapest = ranked[0]
  if (!cheapest) {
    throw new TensorDockProvisionError(
      `TensorDock candidate ranking returned empty for ${cr.gpuTier} x ${cr.gpuCount}.`,
    )
  }
  const perCardPrice = cheapest.price ?? mapping.approxPricePerGpuHourUsd
  const totalPricePerHourUsd = perCardPrice * cr.gpuCount

  // Step 4: keypair + random root password. TensorDock requires a
  // root password even when we only intend to use SSH-key auth, so we
  // mint a strong random one and never surface it (SSH key is the only
  // path buyers use).
  const keypair = generateRentalKeypair(cr.id)
  const rootPassword = randomBytes(24).toString('base64url')

  // Step 5: cloud-init that installs pubkey + ensures sshd is up.
  // The alx deploy script sends cloudinit_script with newlines
  // escaped as the literal two-char sequence \n (not actual newline).
  // We do the same to avoid triggering TensorDock's server-side parser
  // edge case where form-encoded raw newlines 500 the request.
  const cloudInit = [
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

  // Step 6: pick external ports from the host's pre-allocated pool.
  // TensorDock will 500 if external_ports contains values outside
  // host.networking.ports (the alx deploy script does exactly this
  // mapping: external_ports = host.networking.ports[:num_internal]).
  const internalPorts = [22, ...(options.extraInternalPorts ?? [])]
  if (cheapest.availableExternalPorts.length < internalPorts.length) {
    throw new TensorDockProvisionError(
      `TensorDock host ${cheapest.hostId} only has ${cheapest.availableExternalPorts.length} external ports free, ` +
      `but rental wants ${internalPorts.length} (${internalPorts.join(', ')}). Allocator should fall through to next provider.`,
    )
  }
  const externalPorts = cheapest.availableExternalPorts.slice(0, internalPorts.length)

  let deployResp
  try {
    deployResp = await api.deployServer({
      name: `a2e-${cr.id.slice(0, 12)}`,
      password: rootPassword,
      hostnode: cheapest.hostId,
      gpu_model: cheapest.gpu_model,
      gpu_count: cr.gpuCount,
      vcpus: mapping.vcpusPerGpu * cr.gpuCount,
      ram: mapping.ramGbPerGpu * cr.gpuCount,
      storage: options.storageGb ?? mapping.storageGb,
      operating_system: options.operatingSystem ?? DEFAULT_OS,
      internal_ports: internalPorts,
      external_ports: externalPorts,
      cloudinit_script: cloudInit,
    })
  } catch (err) {
    const msg = err instanceof TensorDockApiError ? err.message : (err as Error).message
    throw new TensorDockProvisionError(
      `TensorDock deploy failed for ${mapping.label} on host ${cheapest.hostId} ` +
      `(internal=${JSON.stringify(internalPorts)}, external=${JSON.stringify(externalPorts)}): ${msg}`,
      err,
    )
  }

  if (!deployResp.success) {
    throw new TensorDockProvisionError(
      `TensorDock deploy returned success=false for host ${cheapest.hostId}: ${deployResp.error ?? '(no error)'}`,
    )
  }

  const providerInstanceId = extractServerId(deployResp)
  if (!providerInstanceId) {
    throw new TensorDockProvisionError(
      `TensorDock deploy succeeded but response had no server id. Raw: ${JSON.stringify(deployResp)}`,
    )
  }

  // Find SSH external port from port_forwards. The map is
  // { external_port_string: internal_port_number }, so we invert to
  // find which external port maps to internal 22.
  const sshPort = extractSshExternalPort(deployResp.port_forwards)

  // Step 7: persist. Encrypt privkey; sshUsername=root because cloud-
  // init installs the key into /root/.ssh/authorized_keys.
  const encryptedPrivKey = encryptPrivateKey(keypair.privateKeyPem)
  const region = cheapest.country

  const row = await prisma.externalRental.create({
    data: {
      computeRequestId: cr.id,
      provider: 'TENSORDOCK',
      providerInstanceId,
      providerSshKeyId: null,
      providerInstanceType: cheapest.gpu_model,
      providerRegion: region,
      status: 'PENDING',
      sshHost: deployResp.ip ?? null,
      sshPort: sshPort ?? undefined,
      sshUsername: 'root',
      sshPublicKey: keypair.publicKeyOpenssh,
      sshPrivateKeyEnc: encryptedPrivKey,
      providerPricePerHourUsd: totalPricePerHourUsd,
    },
    select: { id: true },
  })

  return {
    externalRentalId: row.id,
    providerInstanceId,
    providerInstanceType: cheapest.gpu_model,
    providerRegion: region,
    providerPricePerHourUsd: totalPricePerHourUsd,
  }
}

/**
 * Poll TensorDock for a rental's status. Updates ExternalRental
 * status + sshHost + sshPort + launchedAt as appropriate.
 */
export async function pollTensorDockRentalStatus(
  prisma: PrismaClient,
  externalRentalId: string,
  client?: TensorDockClient,
): Promise<TensorDockServer | null> {
  const row = await prisma.externalRental.findUnique({ where: { id: externalRentalId } })
  if (!row) throw new TensorDockProvisionError(`ExternalRental ${externalRentalId} not found`)
  if (row.status === 'CLOSED' || row.status === 'FAILED') return null
  if (!row.providerInstanceId) {
    throw new TensorDockProvisionError(
      `ExternalRental ${externalRentalId} has no providerInstanceId — provision never completed.`,
    )
  }

  const api = client ?? new TensorDockClient()
  let resp
  try {
    resp = await api.getServer(row.providerInstanceId)
  } catch (err) {
    if (err instanceof TensorDockApiError && err.statusCode === 404) {
      await prisma.externalRental.update({
        where: { id: externalRentalId },
        data: { status: 'CLOSED', terminatedAt: row.terminatedAt ?? new Date() },
      })
      return null
    }
    throw err
  }
  if (!resp.success || !resp.server) {
    return null
  }
  const server = resp.server

  const newStatus = mapTensorDockStatus(server.status)
  const updates: Record<string, unknown> = { status: newStatus, lastError: null }
  if (newStatus === 'ACTIVE' && !row.launchedAt) updates.launchedAt = new Date()
  if (server.ip && row.sshHost !== server.ip) updates.sshHost = server.ip
  const sshPort = extractSshExternalPort(server.port_forwards)
  if (sshPort !== null && row.sshPort !== sshPort) updates.sshPort = sshPort
  if (newStatus === 'CLOSED' && !row.terminatedAt) updates.terminatedAt = new Date()

  await prisma.externalRental.update({ where: { id: externalRentalId }, data: updates })
  return server
}

/**
 * Terminate a TensorDock rental. Idempotent: re-deleting a torn-down
 * server is a no-op on TensorDock's side and a no-op for us if the
 * row is already CLOSED.
 */
export async function terminateTensorDockRental(
  prisma: PrismaClient,
  externalRentalId: string,
  reason: string,
  client?: TensorDockClient,
): Promise<void> {
  const row = await prisma.externalRental.findUnique({ where: { id: externalRentalId } })
  if (!row) throw new TensorDockProvisionError(`ExternalRental ${externalRentalId} not found`)
  if (row.status === 'CLOSED') return
  if (!row.providerInstanceId) {
    await prisma.externalRental.update({
      where: { id: externalRentalId },
      data: { status: 'CLOSED', terminatedAt: new Date(), lastError: reason },
    })
    return
  }

  const api = client ?? new TensorDockClient()
  try {
    await api.deleteServer(row.providerInstanceId)
  } catch (err) {
    if (err instanceof TensorDockApiError && err.statusCode === 404) {
      // Already gone; treat as success.
    } else {
      throw err
    }
  }

  await prisma.externalRental.update({
    where: { id: externalRentalId },
    data: { status: 'CLOSED', terminatedAt: new Date(), lastError: reason },
  })
}

function extractServerId(resp: { server?: string | { id?: string } }): string | null {
  if (typeof resp.server === 'string') return resp.server
  if (resp.server && typeof resp.server === 'object' && typeof resp.server.id === 'string') {
    return resp.server.id
  }
  return null
}

function extractSshExternalPort(portForwards: Record<string, number> | undefined): number | null {
  if (!portForwards) return null
  for (const [extPort, intPort] of Object.entries(portForwards)) {
    if (Number(intPort) === 22) {
      const n = parseInt(extPort, 10)
      if (Number.isFinite(n)) return n
    }
  }
  return null
}

function mapTensorDockStatus(
  raw: string | undefined,
): 'PENDING' | 'ACTIVE' | 'DEGRADED' | 'CLOSED' | 'FAILED' {
  if (!raw) return 'PENDING'
  const s = raw.toLowerCase()
  if (s.includes('running')) return 'ACTIVE'
  if (s.includes('terminated') || s.includes('deleted')) return 'CLOSED'
  if (s.includes('failed') || s.includes('error')) return 'FAILED'
  if (s.includes('stopped') || s.includes('paused')) return 'DEGRADED'
  return 'PENDING'
}
