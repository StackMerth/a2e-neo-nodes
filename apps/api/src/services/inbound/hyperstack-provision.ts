/**
 * Hyperstack rental orchestrator.
 *
 * Provision GPU rentals through Hyperstack's direct REST. Mirror of
 * shadeform-provision.ts but talks straight to NexGen Cloud's API
 * instead of going through Shadeform's aggregator.
 *
 * The flow:
 *
 *   1. Find cheapest flavor matching (gpuTier, gpuCount). Pick the
 *      environment where it's available (HYPERSTACK_ENVIRONMENT env
 *      override OR the flavor's region_name OR first listed env).
 *
 *   2. POST /core/keypairs body { name, public_key, environment_name }
 *      -> { id }. Hyperstack scopes keypairs per environment, so the
 *      same name in a different region is allowed.
 *
 *   3. POST /core/virtual-machines body { name, environment_name,
 *      image_name, flavor_name, key_name, assign_floating_ip: true,
 *      count: 1 } -> { data: [{ id, status: 'CREATING', ... }] }.
 *      Floating IP is the publicly-reachable address; without it the
 *      buyer can't SSH in.
 *
 * Status mapping (Hyperstack -> our ExternalRental):
 *   CREATING / BUILD / PROVISIONING / REBUILD -> PENDING
 *   ACTIVE                                    -> ACTIVE
 *   ERROR                                     -> FAILED
 *   DELETING / DELETED                        -> CLOSED
 *
 * Termination:
 *   DELETE /core/virtual-machines/{id}        stops billing
 *   DELETE /core/keypairs/{id}                cleans up the ephemeral key
 *
 * Configuration:
 *   HYPERSTACK_API_KEY              required
 *   HYPERSTACK_ALLOCATOR_ENABLED    default true; flip false to bypass
 *   HYPERSTACK_ENVIRONMENT          optional preferred region
 *   HYPERSTACK_DEFAULT_IMAGE        optional image name override
 *
 * Default SSH user on Hyperstack's stock Ubuntu CUDA image: 'ubuntu'.
 * We let the schema default fire and don't surface that in the row at
 * create time; the poll worker doesn't update sshUsername because
 * Hyperstack's getVm response doesn't include an ssh_user field. If
 * Hyperstack ever adds it, mirror the shadeform-provision pattern.
 */

import type { PrismaClient } from '@a2e/database'
import {
  HyperstackClient,
  HyperstackApiError,
  findCheapestHyperstackFlavor,
  hyperstackDefaultImage,
  pickHyperstackEnvironment,
  hyperstackPriceUsd,
  type HyperstackVm,
  type HyperstackVmStatus,
} from './hyperstack-adapter.js'
import { generateRentalKeypair } from './ssh-keygen.js'
import { encryptPrivateKey, isKeyEncryptionConfigured } from './key-encryption.js'

export class HyperstackProvisionError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message)
    this.name = 'HyperstackProvisionError'
  }
}

export interface HyperstackProvisionResult {
  externalRentalId: string
  providerInstanceId: string
  providerInstanceType: string
  providerRegion: string
  providerPricePerHourUsd: number
}

export interface HyperstackProvisionOptions {
  client?: HyperstackClient
}

export async function provisionHyperstackRental(
  prisma: PrismaClient,
  computeRequestId: string,
  options: HyperstackProvisionOptions = {},
): Promise<HyperstackProvisionResult> {
  if (!isKeyEncryptionConfigured()) {
    throw new HyperstackProvisionError(
      'SSH_KEY_ENCRYPTION_KEY env var must be set before any external rental can be provisioned.',
    )
  }

  const cr = await prisma.computeRequest.findUnique({ where: { id: computeRequestId } })
  if (!cr) throw new HyperstackProvisionError(`ComputeRequest ${computeRequestId} not found.`)
  if (cr.status !== 'PENDING') {
    throw new HyperstackProvisionError(
      `ComputeRequest ${computeRequestId} is in ${cr.status}, expected PENDING.`,
    )
  }

  const api = options.client ?? new HyperstackClient()

  const cheapest = await findCheapestHyperstackFlavor(api, cr.gpuTier, cr.gpuCount)
  if (!cheapest) {
    throw new HyperstackProvisionError(
      `Hyperstack has no flavor matching ${cr.gpuTier} x ${cr.gpuCount}. Allocator should fall through.`,
    )
  }

  const environment = await pickHyperstackEnvironment(api, cheapest.flavor)
  if (!environment) {
    throw new HyperstackProvisionError(
      `No Hyperstack environment available for flavor ${cheapest.flavor.name}.`,
    )
  }

  const keypair = generateRentalKeypair(cr.id)
  const keyLabel = `a2e-${cr.id.slice(0, 12)}-${Date.now().toString(36)}`
  let keypairId: number
  try {
    const result = await api.createKeypair({
      name: keyLabel,
      public_key: keypair.publicKeyOpenssh.trim(),
      environment_name: environment,
    })
    keypairId = result.id
  } catch (err) {
    const msg = err instanceof HyperstackApiError ? err.message : (err as Error).message
    throw new HyperstackProvisionError(`Hyperstack createKeypair failed: ${msg}`, err)
  }

  const vmName = `a2e-${cr.id.slice(0, 12)}`
  let vm: HyperstackVm
  try {
    vm = await api.createVm({
      name: vmName,
      environment_name: environment,
      image_name: hyperstackDefaultImage(),
      flavor_name: cheapest.flavor.name,
      key_name: keyLabel,
      assign_floating_ip: true,
      count: 1,
    })
  } catch (err) {
    // Roll back the keypair so we don't leak names.
    await api.deleteKeypair(keypairId).catch(() => undefined)
    const msg = err instanceof HyperstackApiError ? err.message : (err as Error).message
    throw new HyperstackProvisionError(
      `Hyperstack createVm failed for ${cheapest.flavor.name} in ${environment}: ${msg}`,
      err,
    )
  }

  // Open SSH inbound on the new VM. Hyperstack VMs default-deny ALL
  // inbound traffic; without this the VM reaches ACTIVE but ssh times
  // out (verified 2026-06-09 against VM 863056 cmq61hel9000). The
  // sg-rule is per-VM so no shared firewall state to manage. Failure
  // here would leave a working VM with no SSH route; we tear down both
  // the VM and the keypair to avoid orphaned resources.
  try {
    await api.addVmSecurityRule(vm.id, {
      direction: 'ingress',
      protocol: 'tcp',
      port_range_min: 22,
      port_range_max: 22,
      remote_ip_prefix: '0.0.0.0/0',
      ethertype: 'IPv4',
    })
  } catch (err) {
    await api.deleteVm(vm.id).catch(() => undefined)
    await api.deleteKeypair(keypairId).catch(() => undefined)
    const msg = err instanceof HyperstackApiError ? err.message : (err as Error).message
    throw new HyperstackProvisionError(
      `Hyperstack addVmSecurityRule (SSH ingress) failed for vm ${vm.id}: ${msg}`,
      err,
    )
  }

  const encryptedPrivKey = encryptPrivateKey(keypair.privateKeyPem)
  const row = await prisma.externalRental.create({
    data: {
      computeRequestId: cr.id,
      provider: 'HYPERSTACK',
      providerInstanceId: String(vm.id),
      providerSshKeyId: String(keypairId),
      providerInstanceType: cheapest.flavor.name,
      providerRegion: environment,
      status: 'PENDING',
      sshHost: null,
      sshPort: undefined,
      // Don't hardcode sshUsername. Hyperstack's stock Ubuntu CUDA image
      // defaults to 'ubuntu', but we let the schema default surface and
      // overwrite it from the VM details in the poll if Hyperstack ever
      // surfaces ssh_user.
      sshPublicKey: keypair.publicKeyOpenssh,
      sshPrivateKeyEnc: encryptedPrivKey,
      providerPricePerHourUsd: cheapest.pricePerHourUsd,
    },
    select: { id: true },
  })

  return {
    externalRentalId: row.id,
    providerInstanceId: String(vm.id),
    providerInstanceType: cheapest.flavor.name,
    providerRegion: environment,
    providerPricePerHourUsd: cheapest.pricePerHourUsd,
  }
}

/**
 * Poll Hyperstack for one rental's status. Updates ExternalRental row.
 */
export async function pollHyperstackRentalStatus(
  prisma: PrismaClient,
  externalRentalId: string,
  client?: HyperstackClient,
): Promise<HyperstackVm | null> {
  const row = await prisma.externalRental.findUnique({ where: { id: externalRentalId } })
  if (!row) throw new HyperstackProvisionError(`ExternalRental ${externalRentalId} not found`)
  if (row.status === 'CLOSED' || row.status === 'FAILED') return null
  if (!row.providerInstanceId) {
    throw new HyperstackProvisionError(
      `ExternalRental ${externalRentalId} has no providerInstanceId.`,
    )
  }

  const api = client ?? new HyperstackClient()
  let vm: HyperstackVm
  try {
    vm = await api.getVm(parseInt(row.providerInstanceId, 10))
  } catch (err) {
    if (err instanceof HyperstackApiError && err.statusCode === 404) {
      await prisma.externalRental.update({
        where: { id: externalRentalId },
        data: { status: 'CLOSED', terminatedAt: row.terminatedAt ?? new Date() },
      })
      return null
    }
    throw err
  }

  const newStatus = mapHyperstackStatus(vm.status)
  const updates: Record<string, unknown> = { status: newStatus, lastError: null }
  if (newStatus === 'ACTIVE' && !row.launchedAt) updates.launchedAt = new Date()
  const surfacedIp = vm.floating_ip ?? vm.fixed_ip ?? null
  if (surfacedIp && row.sshHost !== surfacedIp) updates.sshHost = surfacedIp
  if (vm.ssh_port !== undefined && vm.ssh_port !== null && row.sshPort !== vm.ssh_port) {
    updates.sshPort = vm.ssh_port
  }
  if (newStatus === 'CLOSED' && !row.terminatedAt) updates.terminatedAt = new Date()

  await prisma.externalRental.update({ where: { id: externalRentalId }, data: updates })
  return vm
}

/**
 * Terminate. Deletes the VM on Hyperstack and the ephemeral SSH key
 * we registered. Idempotent.
 */
export async function terminateHyperstackRental(
  prisma: PrismaClient,
  externalRentalId: string,
  reason: string,
  client?: HyperstackClient,
): Promise<void> {
  const row = await prisma.externalRental.findUnique({ where: { id: externalRentalId } })
  if (!row) throw new HyperstackProvisionError(`ExternalRental ${externalRentalId} not found`)
  if (row.status === 'CLOSED') return

  const api = client ?? new HyperstackClient()
  if (row.providerInstanceId) {
    try {
      await api.deleteVm(parseInt(row.providerInstanceId, 10))
    } catch (err) {
      if (err instanceof HyperstackApiError && err.statusCode === 404) {
        // already gone
      } else {
        throw err
      }
    }
  }

  // Best-effort SSH key cleanup so retried provisions on the same
  // computeRequestId don't hit name collisions.
  if (row.providerSshKeyId) {
    const parsed = parseInt(row.providerSshKeyId, 10)
    if (Number.isFinite(parsed)) {
      await api.deleteKeypair(parsed).catch(() => undefined)
    }
  }

  await prisma.externalRental.update({
    where: { id: externalRentalId },
    data: { status: 'CLOSED', terminatedAt: new Date(), lastError: reason },
  })
}

function mapHyperstackStatus(
  raw: HyperstackVmStatus | undefined,
): 'PENDING' | 'ACTIVE' | 'DEGRADED' | 'CLOSED' | 'FAILED' {
  if (!raw) return 'PENDING'
  const u = String(raw).toUpperCase()
  if (u === 'ACTIVE') return 'ACTIVE'
  if (u === 'ERROR') return 'FAILED'
  if (u === 'DELETING' || u === 'DELETED' || u === 'SHUTOFF') return 'CLOSED'
  return 'PENDING'
}

// Re-export so the allocator + tests can import without grabbing the
// whole adapter module.
export { hyperstackPriceUsd }
