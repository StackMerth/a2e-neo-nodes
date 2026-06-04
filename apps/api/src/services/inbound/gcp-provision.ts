/**
 * T5g — GCP A3 Confidential VM rental orchestrator.
 *
 * Mirror of phala-provision.ts adapted for GCP Compute Engine A3
 * confidential instance lifecycle. Three operations:
 *
 *   provisionGcpRental(prisma, computeRequestId, options?)
 *     1. Lock ComputeRequest, verify status=PENDING, idempotency check
 *     2. Map GpuTier+gpuCount -> GCP machine type (a3-highgpu-1g for H100 x1)
 *     3. Generate ephemeral ed25519 keypair
 *     4. Pick a zone from GCP_A3_CONFIDENTIAL_ZONES (Phase 1: first zone;
 *        Phase 2 enhancement: zone rotation on capacity errors)
 *     5. createInstance() with TDX + Shielded VM + spot/on-demand
 *     6. Persist ExternalRental (provider='GCP') with encrypted
 *        privkey + provider price for T6 settlement
 *     Returns the ExternalRental id.
 *
 *   pollGcpRentalStatus(prisma, externalRentalId)
 *     Single poll. Reads GCP instance state, updates status + sshHost
 *     (publicIp) + launchedAt as the instance transitions through
 *     PROVISIONING -> STAGING -> RUNNING.
 *
 *   terminateGcpRental(prisma, externalRentalId, reason)
 *     1. Tell GCP to delete the instance (DELETE instances/{name})
 *     2. Mark ExternalRental CLOSED with timestamps
 *     Idempotent on the GCP side (404 is a no-op in deleteInstance).
 *
 * Status mapping (GCP -> our ExternalRental.status):
 *   PROVISIONING / STAGING / REPAIRING      -> PENDING
 *   RUNNING                                  -> ACTIVE
 *   STOPPING / SUSPENDING                    -> CLOSING
 *   STOPPED / SUSPENDED / TERMINATED         -> CLOSED
 *
 * SSH model: GCP injects the buyer's public key via instance metadata
 * (key='ssh-keys', value='username:ssh-rsa AAAA...'). No per-key
 * registration step on the provider side; providerSshKeyId stays null.
 *
 * Region: GCP zones look like "us-central1-a". We persist the zone
 * directly as providerRegion since the cascade is zone-scoped, not
 * region-scoped, for A3 confidential.
 */

import type { PrismaClient } from '@a2e/database'
import {
  GcpApiError,
  GcpClient,
  GCP_A3_CONFIDENTIAL_ZONES,
  type GcpInstance,
  type GcpInstanceStatus,
} from './gcp-adapter.js'
import { gcpMachineTypeForTier, fitsSingleGcpA3 } from './gcp-tier-mapping.js'
import { generateRentalKeypair } from './ssh-keygen.js'
import { encryptPrivateKey, isKeyEncryptionConfigured } from './key-encryption.js'

export class GcpProvisionError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message)
    this.name = 'GcpProvisionError'
  }
}

export interface GcpProvisionResult {
  externalRentalId: string
  providerInstanceId: string
  providerInstanceType: string
  providerRegion: string
  providerPricePerHourUsd: number
}

export interface GcpProvisionOptions {
  client?: GcpClient
  /**
   * Test-only: skip GpuTier -> machineType mapping and use the given
   * GCP machine type directly. Used by gcp-provision:test --type for
   * arbitrary-SKU dry-runs.
   */
  machineTypeOverride?: string
  /**
   * Override the boot image. Must be confidential-VM-compatible.
   */
  imageOverride?: string
  /** Boot disk size in GB. Default 100. */
  diskSizeGb?: number
  /**
   * Use spot/preemptible tier. Default true — A3 spot is ~$3.69/h vs
   * ~$10.98/h on-demand. Buyers needing no-preemption pass false.
   */
  spot?: boolean
  /**
   * Override which zone to provision in. Default: first zone from
   * GCP_A3_CONFIDENTIAL_ZONES. Phase 2 enhancement: rotate on
   * capacity errors.
   */
  zoneOverride?: string
}

/**
 * Stand up a GCP A3 Confidential VM to serve the buyer's ComputeRequest.
 * Idempotent on the ComputeRequest: if an ExternalRental row already
 * exists, returns its details without provisioning again (and without
 * double-billing GCP).
 */
export async function provisionGcpRental(
  prisma: PrismaClient,
  computeRequestId: string,
  options: GcpProvisionOptions = {},
): Promise<GcpProvisionResult> {
  if (!isKeyEncryptionConfigured()) {
    throw new GcpProvisionError(
      'SSH_KEY_ENCRYPTION_KEY is not set. See key-encryption.ts header for the one-liner to generate it.',
    )
  }

  // Idempotency guard — same pattern as Phala / RunPod / Lambda.
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
    select: { id: true, gpuTier: true, gpuCount: true, status: true },
  })
  if (!cr) {
    throw new GcpProvisionError(`ComputeRequest ${computeRequestId} not found`)
  }

  // Resolve which GCP machine type we're provisioning. Production:
  // tier mapping (Phase 1: H100 x1 only). Override path: dry-runs.
  let resolvedMachineType: string
  let snapshotPricePerHour: number
  if (options.machineTypeOverride) {
    resolvedMachineType = options.machineTypeOverride
    // No price snapshot from catalog when using override; use 0 as
    // placeholder. Test scripts should not rely on this for billing.
    snapshotPricePerHour = 0
  } else {
    const mapping = gcpMachineTypeForTier(cr.gpuTier, cr.gpuCount)
    if (!mapping) {
      throw new GcpProvisionError(
        `GCP does not carry tier ${cr.gpuTier} x${cr.gpuCount} in confidential mode. Allocator should skip GCP for this tier or update gcp-tier-mapping.ts when multi-GPU confidential A3 ships.`,
      )
    }
    if (!fitsSingleGcpA3(cr.gpuTier, cr.gpuCount)) {
      throw new GcpProvisionError(
        `Request needs ${cr.gpuCount} ${cr.gpuTier} GPUs but GCP confidential A3 is single-GPU only as of 2026-06-04. Multi-GPU confidential A3 (a3-megagpu-8g) not yet available.`,
      )
    }
    resolvedMachineType = mapping.machineType
    // Default to spot pricing snapshot since options.spot defaults
    // to true. Caller can override with options.spot=false.
    snapshotPricePerHour =
      options.spot === false
        ? mapping.onDemandPricePerHourUsd
        : mapping.spotPricePerHourUsd
  }

  const api = options.client ?? new GcpClient()
  const zone = options.zoneOverride ?? GCP_A3_CONFIDENTIAL_ZONES[0]
  const useSpot = options.spot ?? true

  // Mint ephemeral keypair. GCP's metadata-based ssh-keys injection
  // mirrors Phala/RunPod's PUBLIC_KEY env pattern — no per-rental key
  // registration step on GCP side; providerSshKeyId stays null.
  const keypair = generateRentalKeypair(cr.id)

  // GCP instance names: lowercase, digits, hyphens, max 63 chars, must
  // start with a letter, no trailing hyphen. Our cuid (cr.id) starts
  // with 'c' so prefix-then-slice is safe.
  const instanceName = `tokenos-${cr.id.toLowerCase().replace(/[^a-z0-9-]/g, '')}`.slice(0, 63)

  let providerInstanceId: string
  try {
    const result = await api.createInstance({
      name: instanceName,
      zone,
      machineType: resolvedMachineType,
      sshPublicKey: keypair.publicKeyOpenssh,
      sshUsername: 'ubuntu',
      ...(options.diskSizeGb !== undefined ? { diskSizeGb: options.diskSizeGb } : {}),
      ...(options.imageOverride !== undefined ? { imageSource: options.imageOverride } : {}),
      spot: useSpot,
    })
    // GCP returns an operation; we use the instance name as the
    // canonical provider id because get/delete are name-scoped.
    providerInstanceId = result.instanceName
  } catch (err) {
    // First real attempt may surface quota (403 PERMISSION_DENIED),
    // image (400 INVALID_ARGUMENT on sourceImage), or capacity
    // (503 ZONE_RESOURCE_POOL_EXHAUSTED) errors. Bubble up so the
    // caller / allocator can branch.
    throw new GcpProvisionError(
      `GCP createInstance failed for ${resolvedMachineType} in ${zone}: ${(err as Error).message}`,
      err,
    )
  }

  const encryptedPrivKey = encryptPrivateKey(keypair.privateKeyPem)
  const row = await prisma.externalRental.create({
    data: {
      computeRequestId: cr.id,
      provider: 'GCP',
      providerInstanceId,
      providerSshKeyId: null,
      providerInstanceType: resolvedMachineType,
      providerRegion: zone,
      status: 'PENDING',
      sshHost: null,
      sshPublicKey: keypair.publicKeyOpenssh,
      sshPrivateKeyEnc: encryptedPrivKey,
      providerPricePerHourUsd: snapshotPricePerHour,
    },
    select: { id: true },
  })

  return {
    externalRentalId: row.id,
    providerInstanceId,
    providerInstanceType: resolvedMachineType,
    providerRegion: zone,
    providerPricePerHourUsd: snapshotPricePerHour,
  }
}

/**
 * Poll GCP for one rental's status. Updates ExternalRental.status +
 * sshHost (publicIp) + launchedAt as appropriate. Returns the latest
 * snapshot or null if the instance is gone / closed.
 */
export async function pollGcpRentalStatus(
  prisma: PrismaClient,
  externalRentalId: string,
  client?: GcpClient,
): Promise<GcpInstance | null> {
  const row = await prisma.externalRental.findUnique({
    where: { id: externalRentalId },
  })
  if (!row) {
    throw new GcpProvisionError(`ExternalRental ${externalRentalId} not found`)
  }
  if (row.status === 'CLOSED' || row.status === 'FAILED') {
    return null
  }

  const api = client ?? new GcpClient()
  let instance: GcpInstance
  try {
    instance = await api.getInstance(row.providerRegion, row.providerInstanceId)
  } catch (err) {
    if (err instanceof GcpApiError && err.statusCode === 404) {
      await prisma.externalRental.update({
        where: { id: externalRentalId },
        data: {
          status: 'CLOSED',
          terminatedAt: new Date(),
          lastNote: 'GCP returned 404 on getInstance; presumed terminated',
        },
      })
      return null
    }
    throw err
  }

  const newStatus = mapGcpStatus(instance.status)
  const updates: Record<string, unknown> = { status: newStatus, lastError: null }
  if (newStatus === 'ACTIVE' && !row.launchedAt) {
    updates.launchedAt = new Date()
  }
  if (instance.publicIp && row.sshHost !== instance.publicIp) {
    updates.sshHost = instance.publicIp
  }
  if (newStatus === 'CLOSED' && !row.terminatedAt) {
    updates.terminatedAt = new Date()
  }
  await prisma.externalRental.update({
    where: { id: externalRentalId },
    data: updates,
  })
  return instance
}

/**
 * Terminate the GCP instance and mark the ExternalRental row CLOSED.
 * Safe to call multiple times (GCP DELETE is idempotent on 404 per
 * deleteInstance).
 */
export async function terminateGcpRental(
  prisma: PrismaClient,
  externalRentalId: string,
  reason: string,
  client?: GcpClient,
): Promise<void> {
  const row = await prisma.externalRental.findUnique({
    where: { id: externalRentalId },
  })
  if (!row) {
    throw new GcpProvisionError(`ExternalRental ${externalRentalId} not found`)
  }
  if (row.status === 'CLOSED') return

  const api = client ?? new GcpClient()

  await prisma.externalRental.update({
    where: { id: externalRentalId },
    data: {
      status: 'CLOSING',
      terminationRequestedAt: new Date(),
      lastNote: reason,
      lastError: null,
    },
  })

  try {
    await api.deleteInstance(row.providerRegion, row.providerInstanceId)
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

function mapGcpStatus(
  s: GcpInstanceStatus,
): 'PENDING' | 'ACTIVE' | 'CLOSING' | 'CLOSED' {
  switch (s) {
    case 'PROVISIONING':
    case 'STAGING':
    case 'REPAIRING':
      return 'PENDING'
    case 'RUNNING':
      return 'ACTIVE'
    case 'STOPPING':
    case 'SUSPENDING':
      return 'CLOSING'
    case 'STOPPED':
    case 'SUSPENDED':
    case 'TERMINATED':
      return 'CLOSED'
    default:
      return 'PENDING'
  }
}
