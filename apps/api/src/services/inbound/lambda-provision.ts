/**
 * T5a — Lambda Labs rental orchestrator.
 *
 * Three operations exposed:
 *
 *   provisionLambdaRental(prisma, computeRequestId)
 *     1. Lock the ComputeRequest, verify status=PENDING
 *     2. Map GpuTier -> Lambda instance type
 *     3. Pick a region with current capacity (round-robin if multi)
 *     4. Generate ephemeral ed25519 keypair
 *     5. Upload public key to Lambda (so it lands in authorized_keys)
 *     6. Launch the instance
 *     7. Persist ExternalRental row with status=PENDING + encrypted
 *        privkey + provider price for T6 settlement
 *     Returns the ExternalRental id. Throws on any step error — the
 *     allocator (T5b) catches and refunds the buyer.
 *
 *   pollLambdaRentalStatus(prisma, externalRentalId)
 *     Single poll. Reads Lambda's /instances/{id}, updates the
 *     ExternalRental row's status + ip + launchedAt. Called from a
 *     repeating worker (T5b) until status is ACTIVE.
 *
 *   terminateLambdaRental(prisma, externalRentalId, reason)
 *     1. Tell Lambda to terminate the instance
 *     2. Delete the ephemeral SSH key from Lambda (cleanup)
 *     3. Mark ExternalRental as CLOSED with terminationRequestedAt + terminatedAt
 *     Idempotent on the Lambda side (already-terminated ids and
 *     already-deleted keys are no-ops).
 *
 * Status mapping (Lambda -> our ExternalRental.status):
 *   booting     -> PENDING
 *   active      -> ACTIVE
 *   unhealthy   -> ACTIVE (still usable; admin alerted separately)
 *   terminating -> CLOSING
 *   terminated  -> CLOSED
 *
 * All three functions are safe to call before Lambda is configured —
 * provisionLambdaRental throws a clear error message, and the
 * allocator will branch on isLambdaConfigured() before reaching here.
 */

import type { PrismaClient } from '@a2e/database'
import {
  LambdaApiError,
  LambdaClient,
  type LambdaInstance,
  type LambdaInstanceStatus,
} from './lambda-adapter.js'
import { lambdaTypeForTier, fitsSingleLambdaInstance } from './tier-mapping.js'
import { generateRentalKeypair } from './ssh-keygen.js'
import { encryptPrivateKey, isKeyEncryptionConfigured } from './key-encryption.js'

export class LambdaProvisionError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message)
    this.name = 'LambdaProvisionError'
  }
}

export interface ProvisionResult {
  externalRentalId: string
  providerInstanceId: string
  providerInstanceType: string
  providerRegion: string
  providerPricePerHourUsd: number
}

/**
 * Stand up a Lambda instance to serve the buyer's ComputeRequest.
 * Idempotent on the ComputeRequest: if an ExternalRental row already
 * exists for the request, returns its details without provisioning
 * again (defensive — should not happen if the allocator's status
 * guard is honored).
 */
export interface ProvisionOptions {
  client?: LambdaClient
  /**
   * Test-only: skip GpuTier -> instance type mapping and use the given
   * Lambda SKU directly. Used by lambda-provision:test --type to dry-run
   * any SKU regardless of how we've mapped our internal tiers. The
   * allocator (T5b) never sets this — production rentals always go
   * through tier mapping for the buyer-facing GpuTier guarantee.
   */
  instanceTypeOverride?: string
}

export async function provisionLambdaRental(
  prisma: PrismaClient,
  computeRequestId: string,
  optionsOrClient?: ProvisionOptions | LambdaClient,
): Promise<ProvisionResult> {
  // Back-compat: callers that pass a bare LambdaClient still work.
  const options: ProvisionOptions = optionsOrClient instanceof LambdaClient
    ? { client: optionsOrClient }
    : optionsOrClient ?? {}
  const client = options.client
  if (!isKeyEncryptionConfigured()) {
    throw new LambdaProvisionError(
      'SSH_KEY_ENCRYPTION_KEY is not set. See key-encryption.ts header for the one-liner to generate it.',
    )
  }

  // Idempotency: if we already provisioned this request, return the
  // existing row instead of double-billing Lambda.
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
    throw new LambdaProvisionError(`ComputeRequest ${computeRequestId} not found`)
  }

  // Resolve which Lambda SKU we're provisioning. Production path:
  // GpuTier -> mapping table. Test-only override skips the mapping so a
  // human can dry-run any SKU (e.g. cheapest with current capacity)
  // without touching tier-mapping.ts.
  let resolvedInstanceType: string
  if (options.instanceTypeOverride) {
    resolvedInstanceType = options.instanceTypeOverride
  } else {
    const mapping = lambdaTypeForTier(cr.gpuTier)
    if (!mapping) {
      throw new LambdaProvisionError(
        `Lambda does not carry tier ${cr.gpuTier} (consumer/unknown SKU). Allocator should skip Lambda for this tier.`,
      )
    }
    if (!fitsSingleLambdaInstance(cr.gpuTier, cr.gpuCount)) {
      throw new LambdaProvisionError(
        `Request needs ${cr.gpuCount} GPUs but Lambda's ${mapping.instanceTypeName} only provides ${mapping.gpusPerInstance}. Multi-instance clusters are out of scope for T5a.`,
      )
    }
    resolvedInstanceType = mapping.instanceTypeName
  }

  const api = client ?? new LambdaClient()

  // Step 1: find a region with current capacity for this type.
  const types = await api.listInstanceTypes()
  const match = types.find((t) => t.name === resolvedInstanceType)
  if (!match) {
    throw new LambdaProvisionError(
      `Lambda has no instance type named ${resolvedInstanceType}. Update tier-mapping.ts or wait for Lambda to add the SKU.`,
    )
  }
  if (match.regionsAvailable.length === 0) {
    throw new LambdaProvisionError(
      `Lambda has no current capacity for ${resolvedInstanceType}. Try again shortly or fall back to internal nodes.`,
    )
  }
  // Pick the first region. T5b can add price/latency-aware selection;
  // for now the buyer gets whichever region had capacity first in
  // Lambda's response.
  const region = match.regionsAvailable[0]!

  // Step 2: mint the ephemeral keypair + upload public key.
  const keypair = generateRentalKeypair(cr.id)
  let providerSshKeyId: string | null = null
  try {
    const added = await api.addSshKey(keypair.keyName, keypair.publicKeyOpenssh)
    providerSshKeyId = added.id
  } catch (err) {
    throw new LambdaProvisionError(
      `Failed to register SSH key with Lambda: ${(err as Error).message}`,
      err,
    )
  }

  // Step 3: launch. If launch throws after the key was added, clean
  // up the key so Lambda doesn't accumulate orphaned keys per failed
  // provision.
  let providerInstanceId: string
  try {
    const ids = await api.launchInstance({
      region,
      instanceTypeName: resolvedInstanceType,
      sshKeyNames: [keypair.keyName],
      name: `tokenos-${cr.id.slice(0, 12)}`,
    })
    if (ids.length === 0) {
      throw new LambdaProvisionError('Lambda returned an empty instance_ids array on launch.')
    }
    providerInstanceId = ids[0]!
  } catch (err) {
    if (providerSshKeyId) {
      // Best-effort cleanup. Don't let a failure here mask the real error.
      api.deleteSshKey(providerSshKeyId).catch(() => undefined)
    }
    throw new LambdaProvisionError(
      `Lambda launch failed for ${resolvedInstanceType} in ${region}: ${(err as Error).message}`,
      err,
    )
  }

  // Step 4: persist the ExternalRental row. The encrypted private key
  // is the only ciphertext stored anywhere — no plaintext ever touches
  // the DB.
  const encryptedPrivKey = encryptPrivateKey(keypair.privateKeyPem)
  const row = await prisma.externalRental.create({
    data: {
      computeRequestId: cr.id,
      provider: 'LAMBDA',
      providerInstanceId,
      providerSshKeyId,
      providerInstanceType: resolvedInstanceType,
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
    providerInstanceType: resolvedInstanceType,
    providerRegion: region,
    providerPricePerHourUsd: match.pricePerHourUsd,
  }
}

/**
 * Poll Lambda for one rental's status. Updates ExternalRental.status
 * + sshHost + launchedAt as appropriate. Returns the latest snapshot.
 * Idempotent on a no-change tick.
 */
export async function pollLambdaRentalStatus(
  prisma: PrismaClient,
  externalRentalId: string,
  client?: LambdaClient,
): Promise<LambdaInstance | null> {
  const row = await prisma.externalRental.findUnique({
    where: { id: externalRentalId },
  })
  if (!row) {
    throw new LambdaProvisionError(`ExternalRental ${externalRentalId} not found`)
  }
  if (row.status === 'CLOSED' || row.status === 'FAILED') {
    return null
  }

  const api = client ?? new LambdaClient()
  let inst: LambdaInstance
  try {
    inst = await api.getInstance(row.providerInstanceId)
  } catch (err) {
    if (err instanceof LambdaApiError && err.statusCode === 404) {
      // Lambda lost track of the instance (rare). Mark closed so the
      // allocator can refund the buyer.
      await prisma.externalRental.update({
        where: { id: externalRentalId },
        data: {
          status: 'CLOSED',
          terminatedAt: new Date(),
          lastNote: 'Lambda returned 404 on getInstance; presumed terminated',
        },
      })
      return null
    }
    throw err
  }

  const newStatus = mapLambdaStatus(inst.status)
  const updates: Record<string, unknown> = { status: newStatus, lastError: null }
  if (newStatus === 'ACTIVE' && !row.launchedAt) {
    updates.launchedAt = new Date()
  }
  if (inst.ip && row.sshHost !== inst.ip) {
    updates.sshHost = inst.ip
  }
  if (newStatus === 'CLOSED' && !row.terminatedAt) {
    updates.terminatedAt = new Date()
  }
  await prisma.externalRental.update({
    where: { id: externalRentalId },
    data: updates,
  })
  return inst
}

/**
 * Terminate the Lambda instance + delete the ephemeral SSH key.
 * Marks the ExternalRental row CLOSED with a termination reason.
 * Safe to call multiple times.
 */
export async function terminateLambdaRental(
  prisma: PrismaClient,
  externalRentalId: string,
  reason: string,
  client?: LambdaClient,
): Promise<void> {
  const row = await prisma.externalRental.findUnique({
    where: { id: externalRentalId },
  })
  if (!row) {
    throw new LambdaProvisionError(`ExternalRental ${externalRentalId} not found`)
  }
  if (row.status === 'CLOSED') {
    return
  }

  const api = client ?? new LambdaClient()

  await prisma.externalRental.update({
    where: { id: externalRentalId },
    data: {
      status: 'CLOSING',
      terminationRequestedAt: new Date(),
      lastNote: reason,
      lastError: null,
    },
  })

  // Terminate the instance (idempotent on Lambda's side).
  try {
    await api.terminateInstances([row.providerInstanceId])
  } catch (err) {
    if (!(err instanceof LambdaApiError && err.statusCode === 404)) {
      // Record the error but don't fail the whole termination — the
      // SSH key cleanup is still worth doing, and on retry the
      // instance terminate may succeed.
      await prisma.externalRental.update({
        where: { id: externalRentalId },
        data: { lastError: `terminate: ${(err as Error).message}` },
      })
    }
  }

  // Delete the ephemeral SSH key. Best-effort: a stranded key is
  // wasteful but not dangerous, and Lambda silently no-ops 404s
  // inside deleteSshKey already.
  if (row.providerSshKeyId) {
    try {
      await api.deleteSshKey(row.providerSshKeyId)
    } catch {
      // Already logged on the row above if we even reached this branch.
    }
  }

  await prisma.externalRental.update({
    where: { id: externalRentalId },
    data: {
      status: 'CLOSED',
      terminatedAt: new Date(),
      // lastNote already set when CLOSING transitioned; do not
      // re-write here to preserve the original termination reason
      // in case any retry hits this final update.
    },
  })
}

function mapLambdaStatus(s: LambdaInstanceStatus): string {
  switch (s) {
    case 'booting':
      return 'PENDING'
    case 'active':
    case 'unhealthy':
      return 'ACTIVE'
    case 'terminating':
      return 'CLOSING'
    case 'terminated':
      return 'CLOSED'
  }
}
