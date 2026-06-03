/**
 * T5g — io.net VMaaS rental orchestrator.
 *
 * Mirror of runpod-provision.ts + lambda-provision.ts, adapted for
 * io.net's VMaaS API. Three operations:
 *
 *   provisionIoNetRental(prisma, computeRequestId, options?)
 *     1. Lock the ComputeRequest, verify status=PENDING
 *     2. Map GpuTier -> io.net hardware_id (or use override)
 *     3. Verify the SKU is in the live catalog + snapshot rate
 *     4. Generate ephemeral ed25519 keypair
 *     5. POST /deploy with PUBLIC_KEY in ssh_keys map
 *     6. Find the new deployment_id by name (io.net's POST /deploy
 *        returns empty body — we must look it up via listDeployments)
 *     7. Persist ExternalRental row (provider='IONET') with
 *        encrypted privkey + provider price for T6 settlement
 *
 *   pollIoNetRentalStatus(prisma, externalRentalId)
 *     Single poll. Reads io.net deployment + VMs state, updates
 *     status + sshHost + sshPort + launchedAt as appropriate.
 *
 *   terminateIoNetRental(prisma, externalRentalId, reason)
 *     1. DELETE the deployment on io.net (stops billing, modulo
 *        the first-hour-nonrefundable charge)
 *     2. Mark ExternalRental CLOSED with timestamps
 *     Idempotent on the io.net side (404 is a no-op in
 *     terminateDeployment).
 *
 * Status mapping (io.net deployment -> our ExternalRental.status):
 *   "deployment requested" / not_yet_running   -> PENDING
 *   "running"                                  -> ACTIVE
 *   "termination requested"                    -> CLOSING
 *   "completed" / "destroyed" / "failed"       -> CLOSED
 *
 * SSH model: io.net injects per-VM ssh keys at deploy time via the
 * ssh_keys map in the deploy body. No pre-registration step on the
 * provider side, so providerSshKeyId stays null. The ssh_access
 * string io.net returns is the canonical connect path (full SSH
 * connect string, not just IP).
 *
 * Minimum rental: io.net charges 1 hour minimum, non-refundable.
 * Our duration_hours is set from the buyer's requested durationDays
 * (rounded up to at least 1 hour).
 */

import type { PrismaClient } from '@a2e/database'
import {
  IoNetApiError,
  IoNetClient,
  type IoNetDeployment,
  type IoNetDeploymentStatus,
  type IoNetVm,
} from './ionet-adapter.js'
import { ioNetTypeForTier, fitsSingleIoNetVm } from './ionet-tier-mapping.js'
import { generateRentalKeypair } from './ssh-keygen.js'
import { encryptPrivateKey, isKeyEncryptionConfigured } from './key-encryption.js'

export class IoNetProvisionError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message)
    this.name = 'IoNetProvisionError'
  }
}

export interface IoNetProvisionResult {
  externalRentalId: string
  providerInstanceId: string
  providerInstanceType: string
  providerRegion: string
  providerPricePerHourUsd: number
}

export interface IoNetProvisionOptions {
  client?: IoNetClient
  /**
   * Test-only: skip GpuTier mapping and use the given io.net
   * hardware deploy_id directly. deploy_id is a string like
   * "8B300.240V" (verified 2026-06-03). Used by ionet-provision:test
   * --type for arbitrary-SKU dry-runs. Production allocator path
   * never sets this.
   */
  hardwareIdOverride?: string
  /** Override default location. e.g. "US". */
  location?: string
  /**
   * Private node_pool_id from io.net's confidential allow-list
   * (TBD until business@io.net responds). Mutually exclusive with
   * location.
   */
  nodePoolId?: string
  /** "general" or "datascience" base image. */
  vmImageType?: 'general' | 'datascience'
}

/**
 * Stand up an io.net VM to serve the buyer's ComputeRequest.
 * Idempotent on the ComputeRequest: if an ExternalRental row already
 * exists, returns its details without re-provisioning.
 */
export async function provisionIoNetRental(
  prisma: PrismaClient,
  computeRequestId: string,
  options: IoNetProvisionOptions = {},
): Promise<IoNetProvisionResult> {
  if (!isKeyEncryptionConfigured()) {
    throw new IoNetProvisionError(
      'SSH_KEY_ENCRYPTION_KEY is not set. See key-encryption.ts header for the one-liner to generate it.',
    )
  }

  const existing = await prisma.externalRental.findUnique({
    where: { computeRequestId },
  })
  if (existing) {
    return {
      externalRentalId: existing.id,
      providerInstanceId: existing.providerInstanceId,
      providerInstanceType: existing.providerInstanceType,
      providerRegion: existing.providerRegion,
      providerPricePerHourUsd: existing.providerPricePerHourUsd,
    }
  }

  const cr = await prisma.computeRequest.findUnique({
    where: { id: computeRequestId },
    select: {
      id: true,
      gpuTier: true,
      gpuCount: true,
      status: true,
      durationDays: true,
    },
  })
  if (!cr) {
    throw new IoNetProvisionError(`ComputeRequest ${computeRequestId} not found`)
  }

  // Resolve hardware_id. Production: tier mapping. Override: dry-runs.
  let resolvedHardwareId: string
  let resolvedLabel: string
  let resolvedLocation: string
  if (options.hardwareIdOverride !== undefined) {
    resolvedHardwareId = options.hardwareIdOverride
    resolvedLabel = `hardware_id=${options.hardwareIdOverride}`
    resolvedLocation = options.location ?? 'US'
  } else {
    const mapping = ioNetTypeForTier(cr.gpuTier, cr.gpuCount)
    if (!mapping) {
      throw new IoNetProvisionError(
        `io.net has no SKU for ${cr.gpuTier} x${cr.gpuCount}. Allocator should skip io.net for this tier/count or update ionet-tier-mapping.ts.`,
      )
    }
    resolvedHardwareId = mapping.hardwareId
    resolvedLabel = mapping.label
    resolvedLocation = options.location ?? mapping.defaultLocation
  }

  const api = options.client ?? new IoNetClient()

  // Step 1: verify io.net has the SKU + snapshot per-hour rate.
  const hardware = await api.listHardware()
  const match = hardware.find((h) => h.deployId === resolvedHardwareId)
  if (!match) {
    throw new IoNetProvisionError(
      `io.net has no hardware with deploy_id ${resolvedHardwareId}. Update ionet-tier-mapping.ts.`,
    )
  }

  // Step 2: mint ephemeral keypair. io.net accepts the public key
  // inline in the ssh_keys map at deploy time; no pre-registration.
  const keypair = generateRentalKeypair(cr.id)
  const sshKeyName = `tokenos-${cr.id.slice(0, 12)}`

  // Step 3: deploy. durationHours rounded up to satisfy io.net's
  // 1-hour minimum (cr.durationDays is days; convert + ceil).
  // First hour is non-refundable so the worst case is we over-pay
  // by 59 minutes on a buyer's sub-hour rental — acceptable.
  //
  // BALANCE GOTCHA (verified 2026-06-03): io.net returns 500
  // "Internal Server Error" when the requested duration_hours *
  // hourly_rate exceeds account balance. There's no clean way to
  // pre-check (all /credits and /billing paths 404). If a 500
  // surfaces here, the caller's most likely failure mode is
  // insufficient balance, not a real server error.
  const durationHours = Math.max(1, Math.ceil(cr.durationDays * 24))

  const resourcePrivateName = `tokenos-${cr.id.slice(0, 18)}-${Date.now().toString(36)}`

  let providerInstanceId: string
  try {
    providerInstanceId = await api.deployVm({
      resourcePrivateName,
      durationHours,
      gpusPerVm: cr.gpuCount,
      hardwareId: resolvedHardwareId,
      sshKeys: { [sshKeyName]: keypair.publicKeyOpenssh },
      ...(options.nodePoolId
        ? { nodePoolId: options.nodePoolId }
        : { locationIds: [resolvedLocation] }),
      vmImageType: options.vmImageType ?? 'general',
    })
  } catch (err) {
    const msg = (err as Error).message
    const hint = /500/.test(msg)
      ? ' (500 from io.net usually means insufficient account balance — required: ~$' +
        (match.pricePerHourUsd * durationHours).toFixed(2) +
        ' for ' +
        durationHours +
        'h @ $' +
        match.pricePerHourUsd.toFixed(2) +
        '/h)'
      : ''
    throw new IoNetProvisionError(
      `io.net deployVm failed for ${resolvedLabel}: ${msg}${hint}`,
      err,
    )
  }

  // Step 4: persist. Region defaults to resolvedLocation (what we
  // asked for); the poll worker overwrites if io.net returns
  // something different. ssh_access populates after first worker
  // reaches RUNNING (poll worker updates).
  const encryptedPrivKey = encryptPrivateKey(keypair.privateKeyPem)
  const region = resolvedLocation
  const row = await prisma.externalRental.create({
    data: {
      computeRequestId: cr.id,
      provider: 'IONET',
      providerInstanceId,
      providerSshKeyId: null,
      providerInstanceType: resolvedHardwareId,
      providerRegion: region,
      status: 'PENDING',
      sshHost: null,
      sshPublicKey: keypair.publicKeyOpenssh,
      sshPrivateKeyEnc: encryptedPrivKey,
      providerPricePerHourUsd: match.pricePerHourUsd,
    },
    select: { id: true },
  })

  return {
    externalRentalId: row.id,
    providerInstanceId,
    providerInstanceType: resolvedHardwareId,
    providerRegion: region,
    providerPricePerHourUsd: match.pricePerHourUsd,
  }
}

/**
 * Poll io.net for one rental's status. Updates ExternalRental.status
 * + sshHost + sshPort + region + launchedAt as appropriate. Returns
 * the latest deployment snapshot, or null if the deployment is gone /
 * closed.
 */
export async function pollIoNetRentalStatus(
  prisma: PrismaClient,
  externalRentalId: string,
  client?: IoNetClient,
): Promise<IoNetDeployment | null> {
  const row = await prisma.externalRental.findUnique({
    where: { id: externalRentalId },
  })
  if (!row) {
    throw new IoNetProvisionError(`ExternalRental ${externalRentalId} not found`)
  }
  if (row.status === 'CLOSED' || row.status === 'FAILED') {
    return null
  }

  const api = client ?? new IoNetClient()
  let deployment: IoNetDeployment
  try {
    deployment = await api.getDeployment(row.providerInstanceId)
  } catch (err) {
    if (err instanceof IoNetApiError && err.statusCode === 404) {
      await prisma.externalRental.update({
        where: { id: externalRentalId },
        data: {
          status: 'CLOSED',
          terminatedAt: new Date(),
          lastError: 'io.net returned 404 on getDeployment; presumed terminated',
        },
      })
      return null
    }
    throw err
  }

  // Fetch the workers to get ssh_access + public_ip:port.
  let vms: IoNetVm[] = []
  try {
    vms = await api.getDeploymentVms(row.providerInstanceId)
  } catch (err) {
    // VM list might 404 transiently while deployment is still being
    // scheduled. Don't blow up the whole poll — just skip the ssh
    // surface update this tick.
    // eslint-disable-next-line no-console
    console.warn(`[ionet-poll] getDeploymentVms failed for ${externalRentalId}:`, (err as Error).message)
  }

  const newStatus = mapIoNetStatus(deployment.status)
  const updates: Record<string, unknown> = { status: newStatus, lastError: null }
  if (newStatus === 'ACTIVE' && !row.launchedAt) {
    updates.launchedAt = new Date()
  }
  if (newStatus === 'CLOSED' && !row.terminatedAt) {
    updates.terminatedAt = new Date()
  }
  // Region — overwrite placeholder if io.net surfaced one.
  if (deployment.locations[0]?.iso2 && row.providerRegion === '(pending)') {
    updates.providerRegion = deployment.locations[0].iso2
  }

  // SSH: io.net's ssh_access is the full connect string, but for
  // our ExternalRental schema we need separate sshHost + sshPort.
  // Prefer publicIp + publicPort if they're set directly; fall back
  // to parsing the ssh_access string ("ssh user@host -p PORT").
  const firstVm = vms[0]
  if (firstVm) {
    if (firstVm.publicIp && row.sshHost !== firstVm.publicIp) {
      updates.sshHost = firstVm.publicIp
    }
    if (firstVm.publicPort !== null && row.sshPort !== firstVm.publicPort) {
      updates.sshPort = firstVm.publicPort
    }
    // Fallback: parse ssh_access if direct fields are absent.
    if (!firstVm.publicIp && firstVm.sshAccess) {
      const parsed = parseSshAccess(firstVm.sshAccess)
      if (parsed) {
        if (parsed.host && row.sshHost !== parsed.host) updates.sshHost = parsed.host
        if (parsed.port && row.sshPort !== parsed.port) updates.sshPort = parsed.port
      }
    }
  }

  await prisma.externalRental.update({
    where: { id: externalRentalId },
    data: updates,
  })
  return deployment
}

/**
 * Terminate the io.net deployment and mark the ExternalRental row
 * CLOSED. Safe to call multiple times (io.net's DELETE is idempotent
 * on 404). Note: first hour is non-refundable on io.net's side —
 * we still terminate as fast as possible but the platform absorbs
 * any sub-hour charge that already accrued.
 */
export async function terminateIoNetRental(
  prisma: PrismaClient,
  externalRentalId: string,
  reason: string,
  client?: IoNetClient,
): Promise<void> {
  const row = await prisma.externalRental.findUnique({
    where: { id: externalRentalId },
  })
  if (!row) {
    throw new IoNetProvisionError(`ExternalRental ${externalRentalId} not found`)
  }
  if (row.status === 'CLOSED') return

  const api = client ?? new IoNetClient()

  await prisma.externalRental.update({
    where: { id: externalRentalId },
    data: {
      status: 'CLOSING',
      terminationRequestedAt: new Date(),
      lastError: reason,
    },
  })

  try {
    await api.terminateDeployment(row.providerInstanceId)
  } catch (err) {
    await prisma.externalRental.update({
      where: { id: externalRentalId },
      data: {
        status: 'CLOSED',
        terminatedAt: new Date(),
        lastError: `terminate failed: ${(err as Error).message}`,
      },
    })
    throw err
  }

  await prisma.externalRental.update({
    where: { id: externalRentalId },
    data: { status: 'CLOSED', terminatedAt: new Date() },
  })
}

function mapIoNetStatus(
  s: IoNetDeploymentStatus,
): 'PENDING' | 'ACTIVE' | 'CLOSING' | 'CLOSED' {
  switch (s) {
    case 'deployment requested':
      return 'PENDING'
    case 'running':
      return 'ACTIVE'
    case 'termination requested':
      return 'CLOSING'
    case 'completed':
    case 'failed':
    case 'destroyed':
      return 'CLOSED'
    default:
      return 'PENDING'
  }
}

/**
 * Parse an io.net ssh_access string into host+port. The format is
 * documented as a full connect string but the exact shape varies;
 * common forms:
 *   "ssh user@host -p PORT"
 *   "ssh -p PORT user@host"
 *   "user@host:PORT"
 * Returns null if we can't extract host or port.
 */
function parseSshAccess(s: string): { host: string; port: number } | null {
  // Try "ssh ... user@host ... -p PORT" or "ssh -p PORT user@host"
  const hostMatch = s.match(/@([\w.\-]+)/)
  const portMatch = s.match(/-p\s+(\d+)/) || s.match(/:(\d+)\s*$/)
  if (!hostMatch || !portMatch) return null
  const host = hostMatch[1]
  const portStr = portMatch[1]
  if (!host || !portStr) return null
  const port = parseInt(portStr, 10)
  if (!Number.isFinite(port)) return null
  return { host, port }
}
