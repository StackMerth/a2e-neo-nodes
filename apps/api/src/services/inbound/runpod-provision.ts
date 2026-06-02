/**
 * T5e — RunPod rental orchestrator.
 *
 * Mirror of lambda-provision.ts for RunPod. Three operations:
 *
 *   provisionRunPodRental(prisma, computeRequestId, options?)
 *     1. Lock the ComputeRequest, verify status=PENDING
 *     2. Map GpuTier -> RunPod gpu type id (or use override)
 *     3. Verify the SKU has current stock
 *     4. Generate ephemeral ed25519 keypair
 *     5. Create a pod with PUBLIC_KEY env injected for SSH bootstrap
 *     6. Persist ExternalRental row (provider='RUNPOD') with encrypted
 *        privkey + provider price for T6 settlement
 *     Returns the ExternalRental id.
 *
 *   pollRunPodRentalStatus(prisma, externalRentalId)
 *     Single poll. Reads RunPod's pod state, updates status + sshHost
 *     + sshPort + launchedAt on the ExternalRental row.
 *
 *   terminateRunPodRental(prisma, externalRentalId, reason)
 *     1. Tell RunPod to DELETE the pod (full release, ends billing)
 *     2. Mark ExternalRental CLOSED with timestamps
 *     Idempotent on the RunPod side (404 is a no-op).
 *
 * Status mapping (RunPod -> our ExternalRental.status):
 *   CREATED / STARTING  -> PENDING
 *   RUNNING             -> ACTIVE
 *   PAUSED              -> ACTIVE   (still allocated, admin alerted separately)
 *   EXITED / TERMINATED -> CLOSED
 *
 * SSH model: RunPod containers carry openssh-server (in the default
 * image) plus an entrypoint that consumes the PUBLIC_KEY env var on
 * first boot and writes it to /root/.ssh/authorized_keys. So the
 * buyer's SSH access is bootstrapped purely via the env var we set at
 * pod creation — no per-rental key-registration step like Lambda's.
 * That means there's no providerSshKeyId to track for cleanup; we
 * leave that column null for RunPod rentals.
 */

import type { PrismaClient } from '@a2e/database'
import {
  RunPodApiError,
  RunPodClient,
  DEFAULT_RUNPOD_IMAGE,
  type RunPodPod,
  type RunPodPodStatus,
} from './runpod-adapter.js'
import { runPodTypeForTier, fitsSingleRunPodPod } from './runpod-tier-mapping.js'
import { generateRentalKeypair } from './ssh-keygen.js'
import { encryptPrivateKey, isKeyEncryptionConfigured } from './key-encryption.js'

export class RunPodProvisionError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message)
    this.name = 'RunPodProvisionError'
  }
}

export interface RunPodProvisionResult {
  externalRentalId: string
  providerInstanceId: string
  providerInstanceType: string
  providerRegion: string
  providerPricePerHourUsd: number
}

export interface RunPodProvisionOptions {
  client?: RunPodClient
  /**
   * Test-only: skip GpuTier -> gpu type mapping and use the given
   * RunPod gpuTypeId directly. Used by runpod-provision:test --type
   * for arbitrary-SKU dry-runs. Production allocator path never sets
   * this.
   */
  gpuTypeOverride?: string
  /**
   * Override the default container image. Must include openssh-server
   * and the standard RunPod entrypoint that processes PUBLIC_KEY.
   * Default is DEFAULT_RUNPOD_IMAGE (RunPod's base CUDA dev image).
   */
  imageOverride?: string
  /** RunPod tier; defaults to ALL (cheapest available). */
  cloudType?: 'ALL' | 'SECURE' | 'COMMUNITY'
}

/**
 * Stand up a RunPod pod to serve the buyer's ComputeRequest.
 * Idempotent on the ComputeRequest: if an ExternalRental row already
 * exists, returns its details without provisioning again.
 */
export async function provisionRunPodRental(
  prisma: PrismaClient,
  computeRequestId: string,
  options: RunPodProvisionOptions = {},
): Promise<RunPodProvisionResult> {
  if (!isKeyEncryptionConfigured()) {
    throw new RunPodProvisionError(
      'SSH_KEY_ENCRYPTION_KEY is not set. See key-encryption.ts header for the one-liner to generate it.',
    )
  }

  // Idempotency: if we already provisioned this request, return the
  // existing row instead of double-billing RunPod.
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
    throw new RunPodProvisionError(`ComputeRequest ${computeRequestId} not found`)
  }

  // Resolve which RunPod SKU we're provisioning. Production: tier
  // mapping. Override path: dry-runs against arbitrary SKUs.
  let resolvedGpuTypeId: string
  if (options.gpuTypeOverride) {
    resolvedGpuTypeId = options.gpuTypeOverride
  } else {
    const mapping = runPodTypeForTier(cr.gpuTier)
    if (!mapping) {
      throw new RunPodProvisionError(
        `RunPod does not carry tier ${cr.gpuTier} in our mapping. Allocator should skip RunPod for this tier or update runpod-tier-mapping.ts.`,
      )
    }
    if (!fitsSingleRunPodPod(cr.gpuTier, cr.gpuCount)) {
      throw new RunPodProvisionError(
        `Request needs ${cr.gpuCount} GPUs but RunPod ${mapping.gpuTypeId} caps at ${mapping.maxGpusPerPod} per pod. Multi-pod clusters are out of scope for T5e.`,
      )
    }
    resolvedGpuTypeId = mapping.gpuTypeId
  }

  const api = options.client ?? new RunPodClient()

  // Step 1: verify RunPod has stock for this SKU + the per-hour
  // price (snapshotted on the ExternalRental row for T6 settlement).
  const gpuTypes = await api.listGpuTypes()
  const match = gpuTypes.find((t) => t.id === resolvedGpuTypeId)
  if (!match) {
    throw new RunPodProvisionError(
      `RunPod has no gpu type named ${resolvedGpuTypeId}. Update runpod-tier-mapping.ts or wait for RunPod to add the SKU.`,
    )
  }
  if (!match.hasCurrentStock || match.lowestPricePerHourUsd === null) {
    throw new RunPodProvisionError(
      `RunPod has no current capacity for ${resolvedGpuTypeId}. Try again shortly or fall back to internal nodes.`,
    )
  }

  // Step 2: mint the ephemeral keypair. Unlike Lambda we don't pre-
  // register the public key with RunPod — the entrypoint of our
  // default image picks PUBLIC_KEY out of env and writes it to
  // authorized_keys on first boot. So just generate the pair here.
  const keypair = generateRentalKeypair(cr.id)

  // Step 3: create the pod. RunPod returns the pod id immediately
  // even though the container is still scheduling; the poll worker
  // picks up the ip + ssh port once status flips to RUNNING.
  let providerInstanceId: string
  try {
    providerInstanceId = await api.createPod({
      name: `tokenos-${cr.id.slice(0, 12)}`,
      gpuTypeId: resolvedGpuTypeId,
      gpuCount: cr.gpuCount,
      sshPublicKey: keypair.publicKeyOpenssh,
      imageName: options.imageOverride ?? DEFAULT_RUNPOD_IMAGE,
      cloudType: options.cloudType ?? 'ALL',
    })
  } catch (err) {
    throw new RunPodProvisionError(
      `RunPod createPod failed for ${resolvedGpuTypeId}: ${(err as Error).message}`,
      err,
    )
  }

  // Step 4: persist. RunPod doesn't have a per-rental ssh key id on
  // its side, so providerSshKeyId stays null for RunPod rows. region
  // populates after the first poll when RunPod attaches the pod to a
  // datacenter — at create time we don't have it yet, so use the
  // tier label as a placeholder.
  const encryptedPrivKey = encryptPrivateKey(keypair.privateKeyPem)
  const row = await prisma.externalRental.create({
    data: {
      computeRequestId: cr.id,
      provider: 'RUNPOD',
      providerInstanceId,
      providerSshKeyId: null,
      providerInstanceType: resolvedGpuTypeId,
      providerRegion: '(pending)',
      status: 'PENDING',
      sshHost: null,
      sshPublicKey: keypair.publicKeyOpenssh,
      sshPrivateKeyEnc: encryptedPrivKey,
      providerPricePerHourUsd: match.lowestPricePerHourUsd,
    },
    select: { id: true },
  })

  return {
    externalRentalId: row.id,
    providerInstanceId,
    providerInstanceType: resolvedGpuTypeId,
    providerRegion: '(pending)',
    providerPricePerHourUsd: match.lowestPricePerHourUsd,
  }
}

/**
 * Poll RunPod for one rental's status. Updates ExternalRental.status +
 * sshHost + sshPort + region + launchedAt as appropriate. Returns the
 * latest snapshot.
 */
export async function pollRunPodRentalStatus(
  prisma: PrismaClient,
  externalRentalId: string,
  client?: RunPodClient,
): Promise<RunPodPod | null> {
  const row = await prisma.externalRental.findUnique({
    where: { id: externalRentalId },
  })
  if (!row) {
    throw new RunPodProvisionError(`ExternalRental ${externalRentalId} not found`)
  }
  if (row.status === 'CLOSED' || row.status === 'FAILED') {
    return null
  }

  const api = client ?? new RunPodClient()
  let pod: RunPodPod
  try {
    pod = await api.getPod(row.providerInstanceId)
  } catch (err) {
    if (err instanceof RunPodApiError && err.statusCode === 404) {
      await prisma.externalRental.update({
        where: { id: externalRentalId },
        data: {
          status: 'CLOSED',
          terminatedAt: new Date(),
          lastError: 'RunPod returned 404 on getPod; presumed terminated',
        },
      })
      return null
    }
    throw err
  }

  const newStatus = mapRunPodStatus(pod.status)
  const updates: Record<string, unknown> = { status: newStatus, lastError: null }
  if (newStatus === 'ACTIVE' && !row.launchedAt) {
    updates.launchedAt = new Date()
  }
  if (pod.publicIp && row.sshHost !== pod.publicIp) {
    updates.sshHost = pod.publicIp
  }
  if (pod.sshPort !== null && row.sshPort !== pod.sshPort) {
    updates.sshPort = pod.sshPort
  }
  if (pod.region && row.providerRegion === '(pending)') {
    updates.providerRegion = pod.region
  }
  if (newStatus === 'CLOSED' && !row.terminatedAt) {
    updates.terminatedAt = new Date()
  }
  await prisma.externalRental.update({
    where: { id: externalRentalId },
    data: updates,
  })
  return pod
}

/**
 * Terminate the RunPod pod and mark the ExternalRental row CLOSED.
 * Safe to call multiple times (RunPod's DELETE is idempotent on 404).
 */
export async function terminateRunPodRental(
  prisma: PrismaClient,
  externalRentalId: string,
  reason: string,
  client?: RunPodClient,
): Promise<void> {
  const row = await prisma.externalRental.findUnique({
    where: { id: externalRentalId },
  })
  if (!row) {
    throw new RunPodProvisionError(`ExternalRental ${externalRentalId} not found`)
  }
  if (row.status === 'CLOSED') return

  const api = client ?? new RunPodClient()

  await prisma.externalRental.update({
    where: { id: externalRentalId },
    data: {
      status: 'CLOSING',
      terminationRequestedAt: new Date(),
      lastError: reason,
    },
  })

  try {
    await api.terminatePod(row.providerInstanceId)
  } catch (err) {
    // Surface the error but still mark CLOSED so the row doesn't
    // hang forever — admin can investigate from the audit log.
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

function mapRunPodStatus(s: RunPodPodStatus): 'PENDING' | 'ACTIVE' | 'CLOSED' {
  switch (s) {
    case 'CREATED':
    case 'STARTING':
      return 'PENDING'
    case 'RUNNING':
    case 'PAUSED':
      return 'ACTIVE'
    case 'EXITED':
    case 'TERMINATED':
      return 'CLOSED'
    default:
      return 'PENDING'
  }
}
