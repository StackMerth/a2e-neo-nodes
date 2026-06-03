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
  VOLTAGEGPU_SSH_HOST,
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

  // Step 3: register the public key with VoltageGPU. They require
  // pre-registered keys identified by UID in the deploy body (NOT
  // inline like RunPod / io.net). Same Lambda-style two-step flow.
  // Verified empirically 2026-06-03 via CLI HTTP capture.
  const sshKeyName = `tokenos-${cr.id.slice(0, 12)}`
  let providerSshKeyId: string
  try {
    providerSshKeyId = await api.registerSshKey({
      name: sshKeyName,
      publicKey: keypair.publicKeyOpenssh,
    })
  } catch (err) {
    throw new VoltageGpuProvisionError(
      `VoltageGPU registerSshKey failed for ${cr.id}: ${(err as Error).message}`,
      err,
    )
  }

  // Step 4: deploy the pod. Verified body shape includes
  // {provider, name, resource_name, template OR image, ssh_keys}.
  // Default template (set by adapter) provides systemd PID 1 + sshd.
  // The provider string ("targon") comes from the catalog entry.
  let createResult
  try {
    const offerProvider =
      (match.raw as { provider?: string } | undefined)?.provider ?? 'targon'
    createResult = await api.createPod({
      name: `tokenos-${cr.id.slice(0, 12)}`,
      gpuType: resolvedHardwareId,
      gpuCount: cr.gpuCount,
      sshPublicKey: keypair.publicKeyOpenssh,
      sshKeyIds: [providerSshKeyId],
      provider: offerProvider,
      region: resolvedRegion,
      confidential: true,
      // template defaults to VOLTAGEGPU_DEFAULT_TEMPLATE; can override later
    })
  } catch (err) {
    // Roll back the SSH key registration so we don't leave orphans
    // when deploy fails (insufficient balance, capacity, etc.).
    void api.deleteSshKey(providerSshKeyId).catch(() => {})
    throw new VoltageGpuProvisionError(
      `VoltageGPU createPod failed for ${resolvedLabel}: ${(err as Error).message}`,
      err,
    )
  }

  // Step 5: persist. SSH connection info comes from the POST response
  // (targonUid + ssh_command). The GET endpoint does NOT return SSH
  // details so we MUST persist them now or lose them.
  //   sshHost: constant jump-host (parsed from ssh_command if present)
  //   sshUsername: targonUid (the worker id used as SSH user)
  //   sshPort: 22 (no explicit port in VoltageGPU's ssh_command format)
  const encryptedPrivKey = encryptPrivateKey(keypair.privateKeyPem)
  const sshUsername = createResult.targonUid ?? 'wrk-unknown'
  // If the initial status from create response is already running,
  // mark the row ACTIVE immediately. Otherwise PENDING and poll
  // worker will promote it.
  const initialStatus = createResult.status === 'running' ? 'ACTIVE' : 'PENDING'
  const row = await prisma.externalRental.create({
    data: {
      computeRequestId: cr.id,
      provider: 'VOLTAGE_GPU',
      providerInstanceId: createResult.id,
      providerSshKeyId,
      providerInstanceType: resolvedHardwareId,
      providerRegion: resolvedRegion,
      status: initialStatus,
      sshHost: VOLTAGEGPU_SSH_HOST,
      sshPort: 22,
      sshUsername,
      sshPublicKey: keypair.publicKeyOpenssh,
      sshPrivateKeyEnc: encryptedPrivKey,
      providerPricePerHourUsd: match.pricePerHourUsd,
      launchedAt: initialStatus === 'ACTIVE' ? new Date() : null,
    },
    select: { id: true },
  })

  return {
    externalRentalId: row.id,
    providerInstanceId: createResult.id,
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
  const updates: Record<string, unknown> = { status: newStatus }
  if (newStatus === 'ACTIVE' && !row.launchedAt) {
    updates.launchedAt = new Date()
  }
  if (newStatus === 'CLOSED' && !row.terminatedAt) {
    updates.terminatedAt = new Date()
  }
  // GET /pods/{id} response does NOT return SSH info — only workload
  // status. So we do NOT overwrite sshHost / sshUsername / sshPort
  // here; they were set at provision time from the POST response.
  //
  // Capture VoltageGPU's status message for visibility. Treat
  // "error" status as a hard failure: surface message to lastError
  // so admin + buyer see why the pod failed (e.g. "Container keeps
  // crashing - CrashLoopBackOff"). For non-error states, clear
  // lastError since the rental is healthy again.
  if (pod.status === 'failed' || pod.status === 'stopped' || pod.statusMessage?.includes('crash')) {
    if (pod.statusMessage) {
      updates.lastError = pod.statusMessage
    }
  } else if (newStatus === 'CLOSED') {
    // Clean termination — store the message as a note rather than
    // an error.
    if (pod.statusMessage) {
      updates.lastNote = pod.statusMessage
    }
    updates.lastError = null
  } else {
    updates.lastError = null
  }
  // T7: capture the attestation report URL once VoltageGPU exposes
  // it (typically after the pod reaches RUNNING and the TDX/CC
  // handshake completes). Buyers click this on their rental detail
  // page to cryptographically verify they're in a real TEE.
  if (pod.attestationReportUrl && row.attestationUrl !== pod.attestationReportUrl) {
    updates.attestationUrl = pod.attestationReportUrl
    updates.attestationFetchedAt = new Date()
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

  // Clean up the registered SSH key. Best-effort: stranded keys
  // aren't billable, but admin clutter is annoying. 404 = already
  // gone, treat as success.
  if (row.providerSshKeyId) {
    void api.deleteSshKey(row.providerSshKeyId).catch(() => {})
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
      // VoltageGPU also emits "error" (CrashLoopBackOff and similar
      // unrecoverable workload states). Treat as CLOSED so the poll
      // worker cancels the request and refunds the buyer rather
      // than letting it sit in PENDING forever.
      if ((s as string) === 'error') return 'CLOSED'
      return 'PENDING'
  }
}
