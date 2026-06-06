/**
 * Vast.ai rental orchestrator.
 *
 * Mirror of runpod-provision.ts + ionet-provision.ts adapted for
 * Vast.ai's offers-and-bookings model. Three operations:
 *
 *   provisionVastAiRental(prisma, computeRequestId, options?)
 *     1. Verify the request, map GpuTier -> Vast.ai gpu_name + count
 *     2. Query /bundles/ for verified-host offers matching the SKU
 *     3. Pick the cheapest offer
 *     4. Mint ephemeral ed25519 keypair
 *     5. PUT /asks/<offer_id>/ with the onstart script that installs
 *        the buyer's pubkey into root's authorized_keys + starts sshd
 *     6. Persist ExternalRental row (provider='VASTAI') with encrypted
 *        privkey + provider price for settlement
 *
 *   pollVastAiRentalStatus(prisma, externalRentalId)
 *     Single poll. Reads /instances/<id>/, updates ExternalRental
 *     status + sshHost + sshPort + launchedAt as appropriate.
 *
 *   terminateVastAiRental(prisma, externalRentalId, reason)
 *     1. DELETE /instances/<id>/ on Vast.ai (stops billing immediately
 *        — Vast.ai bills per-second so termination is clean)
 *     2. Mark ExternalRental CLOSED with terminatedAt timestamp
 *     Idempotent — re-destroying a destroyed instance returns 200.
 *
 * Status mapping (Vast.ai actual_status -> our ExternalRental.status):
 *   "created" / "loading"     -> PENDING
 *   "running"                  -> ACTIVE
 *   "stopping"                 -> CLOSING
 *   "exited"                   -> CLOSED
 *
 * SSH model: Vast.ai's onstart script runs once at container start;
 * we use it to install the buyer's pubkey into root's authorized_keys
 * and start the SSH daemon. The default image (runpod/pytorch ships
 * the same way RunPod uses it) runs as root inside the container.
 * sshUsername=root on the ExternalRental row, matching what worked
 * for RunPod community-tier rentals.
 *
 * Pricing: Vast.ai bills PER SECOND (vs RunPod's per-minute, Lambda's
 * per-hour). Our per-minute-meter rounds to minute granularity, so a
 * 30-second test rental still gets charged for 1 minute internally —
 * but Vast.ai bills us for 30 seconds. Net effect: small margin pad
 * for the platform on sub-minute rentals. Acceptable for v1.
 */

import type { PrismaClient } from '@a2e/database'
import {
  VastAiClient,
  VastAiApiError,
  type VastAiInstance,
} from './vastai-adapter.js'
import { vastAiTypeForTier, fitsSingleVastAiHost } from './vastai-tier-mapping.js'
import { generateRentalKeypair } from './ssh-keygen.js'
import { encryptPrivateKey, isKeyEncryptionConfigured } from './key-encryption.js'

export class VastAiProvisionError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message)
    this.name = 'VastAiProvisionError'
  }
}

export interface VastAiProvisionResult {
  externalRentalId: string
  providerInstanceId: string
  providerInstanceType: string
  providerRegion: string
  providerPricePerHourUsd: number
}

export interface VastAiProvisionOptions {
  client?: VastAiClient
  /** Override the container image. Defaults to DEFAULT_VASTAI_IMAGE. */
  imageOverride?: string
  /** Minimum host reliability score. Defaults to 0.95. */
  minReliability?: number
  /** Container disk allocation in GB. Default 50. */
  diskGb?: number
}

/**
 * Provision a Vast.ai rental for a ComputeRequest. Called by the
 * compute-allocator's external cascade when VASTAI wins the probe.
 *
 * Mirrors provisionRunPodRental's contract: returns a result with the
 * externalRentalId + provider metadata, throws VastAiProvisionError on
 * any failure. Caller is responsible for transitioning the
 * ComputeRequest to PROVISIONING_EXTERNAL after this resolves.
 */
export async function provisionVastAiRental(
  prisma: PrismaClient,
  computeRequestId: string,
  options: VastAiProvisionOptions = {},
): Promise<VastAiProvisionResult> {
  if (!isKeyEncryptionConfigured()) {
    throw new VastAiProvisionError(
      'SSH_KEY_ENCRYPTION_KEY env var must be set before any external rental can be provisioned.',
    )
  }

  const cr = await prisma.computeRequest.findUnique({
    where: { id: computeRequestId },
  })
  if (!cr) {
    throw new VastAiProvisionError(`ComputeRequest ${computeRequestId} not found.`)
  }
  if (cr.status !== 'PENDING') {
    throw new VastAiProvisionError(
      `ComputeRequest ${computeRequestId} is in ${cr.status}, expected PENDING. Allocator should not have called this.`,
    )
  }

  // Step 1: GpuTier -> Vast.ai SKU mapping.
  const mapping = vastAiTypeForTier(cr.gpuTier, cr.gpuCount)
  if (!mapping) {
    throw new VastAiProvisionError(
      `Vast.ai does not carry tier ${cr.gpuTier} at gpuCount=${cr.gpuCount} in our mapping. ` +
      'Allocator should skip Vast.ai for this request, or update vastai-tier-mapping.ts.',
    )
  }
  if (!fitsSingleVastAiHost(cr.gpuTier, cr.gpuCount)) {
    throw new VastAiProvisionError(
      `Tier ${cr.gpuTier} x ${cr.gpuCount} doesn't fit a single Vast.ai host SKU. Multi-host clusters are out of scope.`,
    )
  }

  const api = options.client ?? new VastAiClient()

  // Step 2: query /bundles/ for verified-host offers matching the SKU.
  // Filter on reliability so we don't pick a churn-prone host.
  const minReliability = options.minReliability ?? 0.95
  const offers = await api.listOffers({
    gpu_name: { eq: mapping.gpuName },
    num_gpus: { eq: mapping.gpusPerHost },
    reliability2: { gte: minReliability },
  })
  if (offers.length === 0) {
    throw new VastAiProvisionError(
      `Vast.ai has no verified offers (reliability >= ${minReliability}) for ` +
      `${mapping.label}. Try again shortly or fall back to next provider.`,
    )
  }

  // listOffers sorts dph_total ASC so the first is cheapest.
  const cheapest = offers[0]
  if (!cheapest) {
    throw new VastAiProvisionError(
      `Vast.ai returned an empty offer list after filtering ${mapping.label} — shouldn't reach here.`,
    )
  }

  // Step 3: mint ephemeral keypair. Vast.ai doesn't pre-register
  // public keys; we install via the onstart script inline.
  const keypair = generateRentalKeypair(cr.id)

  // Step 4: book the offer. Vast.ai returns the new instance id
  // immediately; instance starts at 'created' status and transitions
  // through 'loading' (image pull) into 'running'.
  let providerInstanceId: number
  try {
    providerInstanceId = await api.bookOffer({
      offerId: cheapest.id,
      imageName: options.imageOverride,
      sshPublicKey: keypair.publicKeyOpenssh,
      diskGb: options.diskGb ?? 50,
    })
  } catch (err) {
    const msg = err instanceof VastAiApiError ? err.message : (err as Error).message
    throw new VastAiProvisionError(
      `Vast.ai bookOffer failed for ${mapping.label} (offer ${cheapest.id}): ${msg}`,
      err,
    )
  }

  // Step 5: persist. Encrypt the privkey at rest; the rental detail
  // route decrypts on demand. sshUsername=root matches the onstart
  // script's authorized_keys install location.
  const encryptedPrivKey = encryptPrivateKey(keypair.privateKeyPem)
  const region = cheapest.geolocation ?? 'unknown'

  const row = await prisma.externalRental.create({
    data: {
      computeRequestId: cr.id,
      provider: 'VASTAI',
      providerInstanceId: String(providerInstanceId),
      providerSshKeyId: null,
      providerInstanceType: mapping.gpuName,
      providerRegion: region,
      status: 'PENDING',
      sshHost: null,
      // Vast.ai's pytorch images run as root inside the container; our
      // onstart script installs the pubkey into /root/.ssh/. Set
      // sshUsername explicitly to root so the rental page builds the
      // SSH command correctly (the column default of 'ubuntu' would
      // produce the same publickey-rejected failure pattern that bit
      // RunPod buyers before 3555a58).
      sshUsername: 'root',
      sshPublicKey: keypair.publicKeyOpenssh,
      sshPrivateKeyEnc: encryptedPrivKey,
      providerPricePerHourUsd: cheapest.dphTotal,
    },
    select: { id: true },
  })

  return {
    externalRentalId: row.id,
    providerInstanceId: String(providerInstanceId),
    providerInstanceType: mapping.gpuName,
    providerRegion: region,
    providerPricePerHourUsd: cheapest.dphTotal,
  }
}

/**
 * Poll Vast.ai for one rental's status. Updates ExternalRental.status
 * + sshHost + sshPort + launchedAt as appropriate. Returns the latest
 * instance snapshot, or null if the instance is gone / closed.
 */
export async function pollVastAiRentalStatus(
  prisma: PrismaClient,
  externalRentalId: string,
  client?: VastAiClient,
): Promise<VastAiInstance | null> {
  const row = await prisma.externalRental.findUnique({
    where: { id: externalRentalId },
  })
  if (!row) {
    throw new VastAiProvisionError(`ExternalRental ${externalRentalId} not found`)
  }
  if (row.status === 'CLOSED' || row.status === 'FAILED') {
    return null
  }
  if (!row.providerInstanceId) {
    throw new VastAiProvisionError(
      `ExternalRental ${externalRentalId} has no providerInstanceId — provision never completed.`,
    )
  }

  const api = client ?? new VastAiClient()
  let instance: VastAiInstance
  try {
    instance = await api.getInstance(parseInt(row.providerInstanceId, 10))
  } catch (err) {
    // Vast.ai returns 404 when an instance is fully torn down. Treat
    // as CLOSED rather than propagating an error.
    if (err instanceof VastAiApiError && err.statusCode === 404) {
      await prisma.externalRental.update({
        where: { id: externalRentalId },
        data: {
          status: 'CLOSED',
          terminatedAt: row.terminatedAt ?? new Date(),
        },
      })
      return null
    }
    throw err
  }

  // Translate Vast.ai status -> our ExternalRental.status enum.
  const newStatus = mapVastAiStatus(instance.status)
  const updates: Record<string, unknown> = { status: newStatus, lastError: null }
  if (newStatus === 'ACTIVE' && !row.launchedAt) {
    updates.launchedAt = new Date()
  }
  if (instance.publicIpaddr && row.sshHost !== instance.publicIpaddr) {
    updates.sshHost = instance.publicIpaddr
  }
  if (instance.sshPort !== null && row.sshPort !== instance.sshPort) {
    updates.sshPort = instance.sshPort
  }
  if (instance.geolocation && row.providerRegion !== instance.geolocation) {
    updates.providerRegion = instance.geolocation
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
 * Terminate a Vast.ai rental. Destroys the instance on Vast.ai (stops
 * billing) and marks the ExternalRental row CLOSED.
 *
 * Idempotent: re-terminating a destroyed instance is a no-op.
 */
export async function terminateVastAiRental(
  prisma: PrismaClient,
  externalRentalId: string,
  reason: string,
  client?: VastAiClient,
): Promise<void> {
  const row = await prisma.externalRental.findUnique({
    where: { id: externalRentalId },
  })
  if (!row) {
    throw new VastAiProvisionError(`ExternalRental ${externalRentalId} not found`)
  }
  if (row.status === 'CLOSED') return
  if (!row.providerInstanceId) {
    // Nothing booked upstream; just close locally.
    await prisma.externalRental.update({
      where: { id: externalRentalId },
      data: {
        status: 'CLOSED',
        terminatedAt: new Date(),
        lastError: `Terminated locally (no upstream instance): ${reason}`,
      },
    })
    return
  }

  const api = client ?? new VastAiClient()
  try {
    await api.destroyInstance(parseInt(row.providerInstanceId, 10))
  } catch (err) {
    // 404 means already destroyed on Vast.ai's side; idempotent.
    if (!(err instanceof VastAiApiError) || err.statusCode !== 404) {
      throw new VastAiProvisionError(
        `Vast.ai destroyInstance failed for ${row.providerInstanceId}: ${(err as Error).message}`,
        err,
      )
    }
  }

  await prisma.externalRental.update({
    where: { id: externalRentalId },
    data: {
      status: 'CLOSED',
      terminatedAt: new Date(),
      lastError: `Terminated: ${reason}`,
    },
  })
}

/**
 * Vast.ai status string -> our ExternalRental.status enum.
 *
 * Vast.ai's API reports actual_status from the host's perspective and
 * cur_state from the API's view; the adapter picks the more accurate
 * one. We collapse the granular states into the four we track on the
 * ExternalRental table.
 */
function mapVastAiStatus(
  status: VastAiInstance['status'],
): 'PENDING' | 'ACTIVE' | 'CLOSING' | 'CLOSED' {
  switch (status) {
    case 'created':
    case 'loading':
      return 'PENDING'
    case 'running':
      return 'ACTIVE'
    case 'stopping':
      return 'CLOSING'
    case 'exited':
      return 'CLOSED'
  }
}
