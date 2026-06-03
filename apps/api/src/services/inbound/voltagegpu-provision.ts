/**
 * T5h — VoltageGPU rental orchestrator.
 *
 * Mirror of ionet-provision.ts / runpod-provision.ts adapted for
 * VoltageGPU's confidential GPU pods. Three operations:
 *
 *   provisionVoltageGpuRental(prisma, computeRequestId, options?)
 *     1. Idempotency check via ExternalRental.computeRequestId
 *     2. Map (tier, count) -> VoltageGPU offer id (or use override)
 *     3. Verify offer is in catalog + snapshot the price
 *     4. Generate ephemeral ed25519 keypair
 *     5. createPod() with PUBLIC_KEY injected via ssh_public_key
 *     6. Persist ExternalRental (provider='VOLTAGE_GPU')
 *
 *   pollVoltageGpuRentalStatus(prisma, externalRentalId)
 *     Single poll. Reads pod status, updates ExternalRental fields.
 *
 *   terminateVoltageGpuRental(prisma, externalRentalId, reason)
 *     DELETE the pod; mark ExternalRental CLOSED.
 *
 * Status mapping (VoltageGPU -> ExternalRental):
 *   creating / starting     -> PENDING
 *   running                 -> ACTIVE
 *   stopping                -> CLOSING
 *   stopped / terminated /
 *   failed                  -> CLOSED
 *
 * SSH model: VoltageGPU injects ssh_public_key at pod create. SSH
 * user is exposed in the pod detail response (presumably "ionet"
 * style — verify empirically and update sshUsername at provision).
 * No per-rental key registration step on the provider side, so
 * providerSshKeyId stays null.
 */

import type { PrismaClient } from '@a2e/database'
import {
  VoltageGpuApiError,
  VoltageGpuClient,
  type VoltageGpuPod,
  type VoltageGpuPodStatus,
} from './voltagegpu-adapter.js'
import {
  voltageGpuTypeForTier,
  fitsSingleVoltageGpuPod,
} from './voltagegpu-tier-mapping.js'
import { generateRentalKeypair } from './ssh-keygen.js'
import { encryptPrivateKey, isKeyEncryptionConfigured } from './key-encryption.js'

export class VoltageGpuProvisionError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message)
    this.name = 'VoltageGpuProvisionError'
  }
}

export interface VoltageGpuProvisionResult {
  externalRentalId: string
  providerInstanceId: string
  providerInstanceType: string
  providerRegion: string
  providerPricePerHourUsd: number
}

export interface VoltageGpuProvisionOptions {
  client?: VoltageGpuClient
  /** Test-only: skip tier mapping and use the given offer id. */
  hardwareIdOverride?: string
  /** Region preference (default = mapping's defaultRegion). */
  region?: string
}

export async function provisionVoltageGpuRental(
  prisma: PrismaClient,
  computeRequestId: string,
  options: VoltageGpuProvisionOptions = {},
): Promise<VoltageGpuProvisionResult> {
  if (!isKeyEncryptionConfigured()) {
    throw new VoltageGpuProvisionError(
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
    select: { id: true, gpuTier: true, gpuCount: true, status: true },
  })
  if (!cr) {
    throw new VoltageGpuProvisionError(`ComputeRequest ${computeRequestId} not found`)
  }

  let resolvedHardwareId: string
  let resolvedLabel: string
  let resolvedRegion: string
  if (options.hardwareIdOverride) {
    resolvedHardwareId = options.hardwareIdOverride
    resolvedLabel = `hardware_id=${options.hardwareIdOverride}`
    resolvedRegion = options.region ?? 'EU'
  } else {
    const mapping = voltageGpuTypeForTier(cr.gpuTier, cr.gpuCount)
    if (!mapping) {
      throw new VoltageGpuProvisionError(
        `VoltageGPU has no SKU for ${cr.gpuTier} x${cr.gpuCount}. Update voltagegpu-tier-mapping.ts after running voltagegpu:inspect.`,
      )
    }
    if (!fitsSingleVoltageGpuPod(cr.gpuTier, cr.gpuCount)) {
      throw new VoltageGpuProvisionError(
        `Request needs ${cr.gpuCount} GPUs but VoltageGPU offer ${mapping.label} doesn't match.`,
      )
    }
    resolvedHardwareId = mapping.hardwareId
    resolvedLabel = mapping.label
    resolvedRegion = options.region ?? mapping.defaultRegion
  }

  const api = options.client ?? new VoltageGpuClient()

  // Step 1: verify offer + snapshot rate.
  const offers = await api.listOffers()
  const match = offers.find((o) => o.id === resolvedHardwareId)
  if (!match) {
    throw new VoltageGpuProvisionError(
      `VoltageGPU has no offer with id ${resolvedHardwareId}. Update voltagegpu-tier-mapping.ts.`,
    )
  }

  // Step 2: mint ephemeral keypair.
  const keypair = generateRentalKeypair(cr.id)

  // Step 3: create the pod.
  let providerInstanceId: string
  try {
    providerInstanceId = await api.createPod({
      name: `tokenos-${cr.id.slice(0, 12)}`,
      gpuType: resolvedHardwareId,
      gpuCount: cr.gpuCount,
      sshPublicKey: keypair.publicKeyOpenssh,
      region: resolvedRegion,
      confidential: true,
    })
  } catch (err) {
    throw new VoltageGpuProvisionError(
      `VoltageGPU createPod failed for ${resolvedLabel}: ${(err as Error).message}`,
      err,
    )
  }

  // Step 4: persist. sshUsername defaults to "root" per VoltageGPU's
  // quick-start docs (`ssh root@<pod-ip>`). Poll worker overwrites
  // if the pod detail response surfaces a different user.
  const encryptedPrivKey = encryptPrivateKey(keypair.privateKeyPem)
  const row = await prisma.externalRental.create({
    data: {
      computeRequestId: cr.id,
      provider: 'VOLTAGE_GPU',
      providerInstanceId,
      providerSshKeyId: null,
      providerInstanceType: resolvedHardwareId,
      providerRegion: resolvedRegion,
      status: 'PENDING',
      sshHost: null,
      sshUsername: 'root',
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
    providerRegion: resolvedRegion,
    providerPricePerHourUsd: match.pricePerHourUsd,
  }
}

export async function pollVoltageGpuRentalStatus(
  prisma: PrismaClient,
  externalRentalId: string,
  client?: VoltageGpuClient,
): Promise<VoltageGpuPod | null> {
  const row = await prisma.externalRental.findUnique({
    where: { id: externalRentalId },
  })
  if (!row) {
    throw new VoltageGpuProvisionError(`ExternalRental ${externalRentalId} not found`)
  }
  if (row.status === 'CLOSED' || row.status === 'FAILED') {
    return null
  }

  const api = client ?? new VoltageGpuClient()
  let pod: VoltageGpuPod
  try {
    pod = await api.getPod(row.providerInstanceId)
  } catch (err) {
    if (err instanceof VoltageGpuApiError && err.statusCode === 404) {
      await prisma.externalRental.update({
        where: { id: externalRentalId },
        data: {
          status: 'CLOSED',
          terminatedAt: new Date(),
          lastNote: 'VoltageGPU returned 404 on getPod; presumed terminated',
        },
      })
      return null
    }
    throw err
  }

  const newStatus = mapVoltageGpuStatus(pod.status)
  const updates: Record<string, unknown> = { status: newStatus, lastError: null }
  if (newStatus === 'ACTIVE' && !row.launchedAt) {
    updates.launchedAt = new Date()
  }
  if (newStatus === 'CLOSED' && !row.terminatedAt) {
    updates.terminatedAt = new Date()
  }
  if (pod.publicIp && row.sshHost !== pod.publicIp) {
    updates.sshHost = pod.publicIp
  }
  if (pod.sshPort !== null && row.sshPort !== pod.sshPort) {
    updates.sshPort = pod.sshPort
  }
  if (pod.sshUser && row.sshUsername !== pod.sshUser) {
    updates.sshUsername = pod.sshUser
  }
  if (pod.region && row.providerRegion !== pod.region) {
    updates.providerRegion = pod.region
  }
  await prisma.externalRental.update({
    where: { id: externalRentalId },
    data: updates,
  })
  return pod
}

export async function terminateVoltageGpuRental(
  prisma: PrismaClient,
  externalRentalId: string,
  reason: string,
  client?: VoltageGpuClient,
): Promise<void> {
  const row = await prisma.externalRental.findUnique({
    where: { id: externalRentalId },
  })
  if (!row) {
    throw new VoltageGpuProvisionError(`ExternalRental ${externalRentalId} not found`)
  }
  if (row.status === 'CLOSED') return

  const api = client ?? new VoltageGpuClient()

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
    await api.terminatePod(row.providerInstanceId)
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

function mapVoltageGpuStatus(
  s: VoltageGpuPodStatus,
): 'PENDING' | 'ACTIVE' | 'CLOSING' | 'CLOSED' {
  switch (s) {
    case 'creating':
    case 'starting':
      return 'PENDING'
    case 'running':
      return 'ACTIVE'
    case 'stopping':
      return 'CLOSING'
    case 'stopped':
    case 'terminated':
    case 'failed':
      return 'CLOSED'
    default:
      return 'PENDING'
  }
}
