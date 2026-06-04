/**
 * T5f / Milestone 1.5 — Phala Network rental orchestrator.
 *
 * Mirror of runpod-provision.ts + lambda-provision.ts, adapted for
 * Phala's CVM (confidential VM) lifecycle. Three operations:
 *
 *   provisionPhalaRental(prisma, computeRequestId, options?)
 *     1. Lock the ComputeRequest, verify status=PENDING
 *     2. Map GpuTier+gpuCount -> Phala instance_type_id (or use override)
 *     3. Verify the SKU is in the live catalog + snapshot the rate
 *     4. Generate ephemeral ed25519 keypair
 *     5. createCvm() with PUBLIC_KEY env injected into default Compose
 *     6. Persist ExternalRental (provider='PHALA') with encrypted
 *        privkey + provider price for T6 settlement
 *     Returns the ExternalRental id.
 *
 *   pollPhalaRentalStatus(prisma, externalRentalId)
 *     Single poll. Reads Phala CVM state, updates status + sshHost +
 *     sshPort + launchedAt as the CVM transitions through the boot +
 *     attestation handshake (typically 90-180s end-to-end, longer
 *     than Lambda/RunPod due to TEE setup).
 *
 *   terminatePhalaRental(prisma, externalRentalId, reason)
 *     1. Tell Phala to terminate the CVM (DELETE /cvms/{id})
 *     2. Mark ExternalRental CLOSED with timestamps
 *     Idempotent on the Phala side (404 is a no-op in terminateCvm).
 *
 * Status mapping (Phala -> our ExternalRental.status):
 *   CREATING / STARTING       -> PENDING
 *   RUNNING                   -> ACTIVE
 *   STOPPING                  -> CLOSING
 *   STOPPED / TERMINATED      -> CLOSED
 *
 * SSH model: Phala runs a Docker Compose inside the CVM. Our default
 * Compose (phala-default-compose.ts) uses the runpod/pytorch base
 * image whose entrypoint reads PUBLIC_KEY from env and writes it to
 * /root/.ssh/authorized_keys. So SSH bootstrap is purely env-var
 * driven, same pattern as RunPod — no per-rental key registration on
 * the provider side, providerSshKeyId stays null.
 *
 * Region: Phala's CVM detail endpoint may not surface a region
 * (auto-selected from available capacity). We persist whatever Phala
 * returns and default to "(phala)" as a placeholder for rentals
 * where Phala returns no region string.
 */

import type { PrismaClient } from '@a2e/database'
import {
  PhalaApiError,
  PhalaClient,
  type PhalaCvm,
  type PhalaCvmStatus,
} from './phala-adapter.js'
import { phalaTypeForTier, fitsSinglePhalaCvm } from './phala-tier-mapping.js'
import { generateRentalKeypair } from './ssh-keygen.js'
import { encryptPrivateKey, isKeyEncryptionConfigured } from './key-encryption.js'

export class PhalaProvisionError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message)
    this.name = 'PhalaProvisionError'
  }
}

export interface PhalaProvisionResult {
  externalRentalId: string
  providerInstanceId: string
  providerInstanceType: string
  providerRegion: string
  providerPricePerHourUsd: number
}

export interface PhalaProvisionOptions {
  client?: PhalaClient
  /**
   * Test-only: skip GpuTier -> instance_type_id mapping and use the
   * given Phala instance id directly. Used by phala-provision:test
   * --type for arbitrary-SKU dry-runs. Production allocator path
   * never sets this.
   */
  instanceTypeOverride?: string
  /**
   * Override the default Compose base image. Must include
   * openssh-server and an entrypoint that processes PUBLIC_KEY.
   * Default is PHALA_DEFAULT_BASE_IMAGE (runpod/pytorch).
   */
  imageOverride?: string
  /** Container disk size in GB; default is the SKU's default_disk_size_gb. */
  containerDiskInGb?: number
  /** Required TEE primitive; defaults to 'ANY' (Phala picks). */
  teeMode?: 'TDX' | 'SEV-SNP' | 'ANY'
}

/**
 * Stand up a Phala CVM to serve the buyer's ComputeRequest.
 * Idempotent on the ComputeRequest: if an ExternalRental row already
 * exists, returns its details without provisioning again (and without
 * double-billing Phala).
 */
export async function provisionPhalaRental(
  prisma: PrismaClient,
  computeRequestId: string,
  options: PhalaProvisionOptions = {},
): Promise<PhalaProvisionResult> {
  if (!isKeyEncryptionConfigured()) {
    throw new PhalaProvisionError(
      'SSH_KEY_ENCRYPTION_KEY is not set. See key-encryption.ts header for the one-liner to generate it.',
    )
  }

  // Idempotency guard — same pattern as RunPod / Lambda.
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
    throw new PhalaProvisionError(`ComputeRequest ${computeRequestId} not found`)
  }

  // Resolve which Phala SKU we're provisioning. Production: tier
  // mapping (currently H200-only). Override path: dry-runs against
  // arbitrary instance ids.
  let resolvedInstanceTypeId: string
  if (options.instanceTypeOverride) {
    resolvedInstanceTypeId = options.instanceTypeOverride
  } else {
    const mapping = phalaTypeForTier(cr.gpuTier, cr.gpuCount)
    if (!mapping) {
      throw new PhalaProvisionError(
        `Phala does not carry tier ${cr.gpuTier} x${cr.gpuCount} in our mapping. Allocator should skip Phala for this tier or update phala-tier-mapping.ts.`,
      )
    }
    if (!fitsSinglePhalaCvm(cr.gpuTier, cr.gpuCount)) {
      throw new PhalaProvisionError(
        `Request needs ${cr.gpuCount} ${cr.gpuTier} GPUs but Phala has no single-CVM SKU that matches. Multi-CVM clusters are out of scope for T5f Phase 1.`,
      )
    }
    resolvedInstanceTypeId = mapping.instanceTypeId
  }

  const api = options.client ?? new PhalaClient()

  // Step 1: verify Phala has this SKU + snapshot the per-hour rate
  // (locked into the ExternalRental row for T6 settlement / refunds).
  // Use listInstanceTypes (not listGpuTypes) so CPU TEE SKUs are
  // accepted via --type override for cheap adapter validation. The
  // standard allocator path still only targets GPU mappings.
  const instanceTypes = await api.listInstanceTypes()
  const match = instanceTypes.find((t) => t.id === resolvedInstanceTypeId)
  if (!match) {
    throw new PhalaProvisionError(
      `Phala has no instance type named ${resolvedInstanceTypeId}. Update phala-tier-mapping.ts or wait for Phala to add the SKU.`,
    )
  }
  // Unlike RunPod, Phala's catalog endpoint doesn't expose live
  // capacity. hasCurrentStock is always true; we let createCvm
  // return 409/503 if all nodes are busy and let the allocator
  // fall through to the next supplier.

  // Step 2: mint ephemeral keypair. Phala's PUBLIC_KEY-via-env
  // pattern mirrors RunPod — no per-rental key registration step
  // on the provider side. providerSshKeyId stays null.
  const keypair = generateRentalKeypair(cr.id)

  // Step 3: create the CVM. Phala returns the CVM id immediately
  // even though TEE attestation + boot are still in progress; the
  // poll worker waits for status=RUNNING + publicIp + sshPort.
  let providerInstanceId: string
  try {
    providerInstanceId = await api.createCvm({
      name: `tokenos-${cr.id.slice(0, 12)}`,
      gpuTypeId: resolvedInstanceTypeId,
      gpuCount: cr.gpuCount,
      sshPublicKey: keypair.publicKeyOpenssh,
      ...(options.imageOverride !== undefined ? { imageName: options.imageOverride } : {}),
      ...(options.containerDiskInGb !== undefined
        ? { containerDiskInGb: options.containerDiskInGb }
        : {}),
      teeMode: options.teeMode ?? 'ANY',
    })
  } catch (err) {
    // createCvm body schema is best-guess in Milestone 1.4. The
    // first real attempt is likely to surface a 422 from Phala with
    // the actual required field names; bubble those up so the
    // operator can adjust phala-adapter.ts createCvm body shape.
    throw new PhalaProvisionError(
      `Phala createCvm failed for ${resolvedInstanceTypeId}: ${(err as Error).message}`,
      err,
    )
  }

  // Step 4: persist. region defaults to "(phala)" placeholder; Phala
  // may or may not populate region in the CVM detail response (poll
  // worker overwrites if it does).
  const encryptedPrivKey = encryptPrivateKey(keypair.privateKeyPem)
  const row = await prisma.externalRental.create({
    data: {
      computeRequestId: cr.id,
      provider: 'PHALA',
      providerInstanceId,
      providerSshKeyId: null,
      providerInstanceType: resolvedInstanceTypeId,
      providerRegion: '(phala)',
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
    providerInstanceType: resolvedInstanceTypeId,
    providerRegion: '(phala)',
    providerPricePerHourUsd: match.pricePerHourUsd,
  }
}

/**
 * Poll Phala for one rental's status. Updates ExternalRental.status +
 * sshHost + sshPort + region + launchedAt as appropriate. Returns
 * the latest snapshot or null if the CVM is gone / closed.
 */
export async function pollPhalaRentalStatus(
  prisma: PrismaClient,
  externalRentalId: string,
  client?: PhalaClient,
): Promise<PhalaCvm | null> {
  const row = await prisma.externalRental.findUnique({
    where: { id: externalRentalId },
  })
  if (!row) {
    throw new PhalaProvisionError(`ExternalRental ${externalRentalId} not found`)
  }
  if (row.status === 'CLOSED' || row.status === 'FAILED') {
    return null
  }

  const api = client ?? new PhalaClient()
  let cvm: PhalaCvm
  try {
    cvm = await api.getCvm(row.providerInstanceId)
  } catch (err) {
    if (err instanceof PhalaApiError && err.statusCode === 404) {
      // CVM gone from Phala's side (likely terminated out-of-band
      // or never existed). Close the row so it doesn't poll forever.
      await prisma.externalRental.update({
        where: { id: externalRentalId },
        data: {
          status: 'CLOSED',
          terminatedAt: new Date(),
          lastNote: 'Phala returned 404 on getCvm; presumed terminated',
        },
      })
      return null
    }
    throw err
  }

  const newStatus = mapPhalaStatus(cvm.status)
  const updates: Record<string, unknown> = { status: newStatus, lastError: null }
  if (newStatus === 'ACTIVE' && !row.launchedAt) {
    updates.launchedAt = new Date()
  }
  if (cvm.publicIp && row.sshHost !== cvm.publicIp) {
    updates.sshHost = cvm.publicIp
  }
  if (cvm.sshPort !== null && row.sshPort !== cvm.sshPort) {
    updates.sshPort = cvm.sshPort
  }
  if (cvm.region && row.providerRegion === '(phala)') {
    updates.providerRegion = cvm.region
  }
  // T7: capture Phala's attestation report URL when the CVM exposes
  // it (post TEE handshake on TDX+SEV-SNP H200 SKUs). Buyers verify
  // their confidential workload via this link.
  if (cvm.attestationReportUrl && row.attestationUrl !== cvm.attestationReportUrl) {
    updates.attestationUrl = cvm.attestationReportUrl
    updates.attestationFetchedAt = new Date()
  }
  if (newStatus === 'CLOSED' && !row.terminatedAt) {
    updates.terminatedAt = new Date()
  }
  await prisma.externalRental.update({
    where: { id: externalRentalId },
    data: updates,
  })
  return cvm
}

/**
 * Terminate the Phala CVM and mark the ExternalRental row CLOSED.
 * Safe to call multiple times (Phala's DELETE is idempotent on 404
 * per terminateCvm). Wired into T6 terminate-dispatcher.ts in
 * Milestone 1.7 so rentals stop billing both on-platform and on
 * Phala's side simultaneously.
 */
export async function terminatePhalaRental(
  prisma: PrismaClient,
  externalRentalId: string,
  reason: string,
  client?: PhalaClient,
): Promise<void> {
  const row = await prisma.externalRental.findUnique({
    where: { id: externalRentalId },
  })
  if (!row) {
    throw new PhalaProvisionError(`ExternalRental ${externalRentalId} not found`)
  }
  if (row.status === 'CLOSED') return

  const api = client ?? new PhalaClient()

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
    await api.terminateCvm(row.providerInstanceId)
  } catch (err) {
    // Surface the error but still mark CLOSED so the row doesn't
    // hang in CLOSING forever — admin investigates via lastError.
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

function mapPhalaStatus(
  s: PhalaCvmStatus,
): 'PENDING' | 'ACTIVE' | 'CLOSING' | 'CLOSED' {
  switch (s) {
    case 'CREATING':
    case 'STARTING':
      return 'PENDING'
    case 'RUNNING':
      return 'ACTIVE'
    case 'STOPPING':
      return 'CLOSING'
    case 'STOPPED':
      // dstack 'stopped' is a paused/transient state, NOT terminated.
      // A freshly-provisioned CVM is briefly 'stopped' before start
      // takes effect, and an explicitly stopped CVM can be restarted.
      // Treat as PENDING so the poll worker keeps tracking it instead
      // of prematurely closing the rental. Real termination surfaces
      // as a 404 from getCvm (handled separately above).
      return 'PENDING'
    case 'TERMINATED':
      return 'CLOSED'
    default:
      return 'PENDING'
  }
}
