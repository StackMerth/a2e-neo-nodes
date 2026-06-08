/**
 * Shadeform rental orchestrator.
 *
 * Provision rentals through Shadeform's aggregator API. One adapter,
 * 18 underlying clouds (Crusoe, Lambda, Hyperstack, Latitude, Verda,
 * DataCrunch / DigitalOcean / Massedcompute / Nebius / Vultr /
 * Paperspace / Scaleway / Voltagepark / IMWT / Horizon / Boostrun /
 * Amaya / ExcessSupply / Denvr).
 *
 * The flow is two-step per Shadeform's contract:
 *
 *   1. POST /sshkeys/add  body { name, public_key } -> { id }
 *      Shadeform requires SSH keys to be pre-registered before deploys.
 *      We mint an ephemeral keypair, register the pubkey, save the id.
 *
 *   2. POST /instances/create body { cloud, region, shade_instance_type,
 *      shade_cloud, name, ssh_key_id } -> { id, status='creating' }
 *      Returns immediately; status transitions creating -> pending ->
 *      active via subsequent /instances/{id}/info polls.
 *
 * Status mapping:
 *   creating / pending_provider / pending -> PENDING
 *   active                                 -> ACTIVE
 *   error                                  -> FAILED
 *   deleting / deleted                     -> CLOSED
 *
 * Termination:
 *   POST /instances/{id}/delete            stops billing
 *   POST /sshkeys/{key_id}/delete          cleans up the ephemeral key
 *
 * Configuration:
 *   SHADEFORM_API_KEY              required
 *   SHADEFORM_ALLOCATOR_ENABLED    default true; flip false to bypass
 *   SHADEFORM_CLOUD_EXCLUDE        comma-separated cloud names to skip;
 *                                  set to 'lambdalabs,crusoe' once we
 *                                  have direct adapters for those.
 *   SHADEFORM_SHADE_CLOUD          default true; uses Shade Cloud
 *                                  (managed by Shadeform) instead of
 *                                  the user's own connected cloud
 *                                  accounts. Set false to require BYOA
 *                                  for every deploy.
 */

import type { PrismaClient } from '@a2e/database'
import {
  ShadeFormClient,
  ShadeFormApiError,
  findCheapestShadeFormType,
  centsToDollars,
  type ShadeFormInstanceInfo,
  type ShadeFormInstanceStatus,
} from './shadeform-adapter.js'
import { generateRentalKeypair } from './ssh-keygen.js'
import { encryptPrivateKey, isKeyEncryptionConfigured } from './key-encryption.js'

export class ShadeFormProvisionError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message)
    this.name = 'ShadeFormProvisionError'
  }
}

export interface ShadeFormProvisionResult {
  externalRentalId: string
  providerInstanceId: string
  providerInstanceType: string
  providerRegion: string
  providerPricePerHourUsd: number
}

export interface ShadeFormProvisionOptions {
  client?: ShadeFormClient
  /** When true, use Shade Cloud (managed). Default true. */
  shadeCloud?: boolean
}

function isShadeCloudDefault(): boolean {
  return process.env.SHADEFORM_SHADE_CLOUD?.toLowerCase() !== 'false'
}

export async function provisionShadeFormRental(
  prisma: PrismaClient,
  computeRequestId: string,
  options: ShadeFormProvisionOptions = {},
): Promise<ShadeFormProvisionResult> {
  if (!isKeyEncryptionConfigured()) {
    throw new ShadeFormProvisionError(
      'SSH_KEY_ENCRYPTION_KEY env var must be set before any external rental can be provisioned.',
    )
  }

  const cr = await prisma.computeRequest.findUnique({ where: { id: computeRequestId } })
  if (!cr) throw new ShadeFormProvisionError(`ComputeRequest ${computeRequestId} not found.`)
  if (cr.status !== 'PENDING') {
    throw new ShadeFormProvisionError(
      `ComputeRequest ${computeRequestId} is in ${cr.status}, expected PENDING.`,
    )
  }

  const api = options.client ?? new ShadeFormClient()

  // Step 1: pick the cheapest available (cloud, instance_type, region)
  // matching tier + gpuCount, post cloud-exclusion filter.
  const cheapest = await findCheapestShadeFormType(api, cr.gpuTier, cr.gpuCount)
  if (!cheapest) {
    throw new ShadeFormProvisionError(
      `Shadeform has no available supply for ${cr.gpuTier} x ${cr.gpuCount}. Allocator should fall through.`,
    )
  }
  const region = pickFirstAvailableRegion(cheapest.type.availability)
  if (!region) {
    throw new ShadeFormProvisionError(
      `Shadeform supply found for ${cr.gpuTier} x ${cr.gpuCount} but no available region. Allocator should fall through.`,
    )
  }

  // Step 2: mint ephemeral keypair + register the pubkey with Shadeform.
  const keypair = generateRentalKeypair(cr.id)
  const keyLabel = `a2e-${cr.id.slice(0, 12)}-${Date.now().toString(36)}`
  let sshKeyId: string
  try {
    const result = await api.addSshKey({
      name: keyLabel,
      public_key: keypair.publicKeyOpenssh.trim(),
    })
    sshKeyId = result.id
  } catch (err) {
    const msg = err instanceof ShadeFormApiError ? err.message : (err as Error).message
    throw new ShadeFormProvisionError(`Shadeform addSshKey failed: ${msg}`, err)
  }

  // Step 3: create the instance. shade_cloud=true uses Shadeform's
  // managed accounts at the upstream cloud; cheaper for buyers without
  // their own provider relationships.
  const shadeCloud = options.shadeCloud ?? isShadeCloudDefault()
  const vmName = `a2e-${cr.id.slice(0, 12)}`

  let createResp
  try {
    createResp = await api.createInstance({
      cloud: cheapest.type.cloud,
      region,
      shade_instance_type: cheapest.type.shade_instance_type,
      shade_cloud: shadeCloud,
      name: vmName,
      ssh_key_id: sshKeyId,
    })
  } catch (err) {
    // Roll back the ssh key we just registered so we don't leak keys.
    await api.deleteSshKey(sshKeyId).catch(() => undefined)
    const msg = err instanceof ShadeFormApiError ? err.message : (err as Error).message
    throw new ShadeFormProvisionError(
      `Shadeform createInstance failed for ${cheapest.type.cloud}/${cheapest.type.shade_instance_type} in ${region}: ${msg}`,
      err,
    )
  }

  // Step 4: persist. sshHost + sshPort will be populated by the first
  // poll once Shadeform reports the instance as active.
  const encryptedPrivKey = encryptPrivateKey(keypair.privateKeyPem)
  // Tag the Shadeform ssh_key_id onto providerSshKeyId so termination
  // can delete it.
  const row = await prisma.externalRental.create({
    data: {
      computeRequestId: cr.id,
      provider: 'SHADEFORM',
      providerInstanceId: createResp.id,
      providerSshKeyId: sshKeyId,
      providerInstanceType: cheapest.type.shade_instance_type,
      providerRegion: region,
      status: 'PENDING',
      sshHost: null,
      sshPort: undefined,
      // Don't hardcode sshUsername. Shadeform's /instances/{id}/info
      // returns ssh_user which varies by underlying cloud
      // (shade_cloud=true uses 'shadeform'; BYOA cloud accounts may use
      // 'ubuntu', 'root', etc.). pollShadeFormRentalStatus persists
      // info.ssh_user on the first poll after status=active. Schema
      // default 'ubuntu' is a safe placeholder until that fires.
      sshPublicKey: keypair.publicKeyOpenssh,
      sshPrivateKeyEnc: encryptedPrivKey,
      providerPricePerHourUsd: cheapest.pricePerHourUsd,
    },
    select: { id: true },
  })

  return {
    externalRentalId: row.id,
    providerInstanceId: createResp.id,
    providerInstanceType: cheapest.type.shade_instance_type,
    providerRegion: region,
    providerPricePerHourUsd: cheapest.pricePerHourUsd,
  }
}

/**
 * Poll Shadeform for one rental's status. Updates ExternalRental row.
 */
export async function pollShadeFormRentalStatus(
  prisma: PrismaClient,
  externalRentalId: string,
  client?: ShadeFormClient,
): Promise<ShadeFormInstanceInfo | null> {
  const row = await prisma.externalRental.findUnique({ where: { id: externalRentalId } })
  if (!row) throw new ShadeFormProvisionError(`ExternalRental ${externalRentalId} not found`)
  if (row.status === 'CLOSED' || row.status === 'FAILED') return null
  if (!row.providerInstanceId) {
    throw new ShadeFormProvisionError(
      `ExternalRental ${externalRentalId} has no providerInstanceId — provision never completed.`,
    )
  }

  const api = client ?? new ShadeFormClient()
  let info: ShadeFormInstanceInfo
  try {
    info = await api.getInstance(row.providerInstanceId)
  } catch (err) {
    if (err instanceof ShadeFormApiError && err.statusCode === 404) {
      await prisma.externalRental.update({
        where: { id: externalRentalId },
        data: { status: 'CLOSED', terminatedAt: row.terminatedAt ?? new Date() },
      })
      return null
    }
    throw err
  }

  const newStatus = mapShadeFormStatus(info.status)
  const updates: Record<string, unknown> = { status: newStatus, lastError: null }
  if (newStatus === 'ACTIVE' && !row.launchedAt) updates.launchedAt = new Date()
  if (info.ip && row.sshHost !== info.ip) updates.sshHost = info.ip
  if (info.ssh_port !== undefined && info.ssh_port !== null && row.sshPort !== info.ssh_port) {
    updates.sshPort = info.ssh_port
  }
  // Persist the actual SSH login user reported by Shadeform. Shade Cloud
  // (massedcompute / etc. with shade_cloud=true) uses 'shadeform'; BYOA
  // setups vary. The buyer SSH panel reads this row directly, so without
  // this update buyers see whatever default we wrote at create time and
  // get "Permission denied (publickey)" because they try the wrong user.
  if (info.ssh_user && row.sshUsername !== info.ssh_user) {
    updates.sshUsername = info.ssh_user
  }
  if (info.region && row.providerRegion !== info.region) updates.providerRegion = info.region
  if (typeof info.hourly_price === 'number') {
    // Shadeform reports hourly_price in cents on /info responses too.
    const usd = centsToDollars(info.hourly_price)
    if (usd > 0 && Math.abs(usd - row.providerPricePerHourUsd) > 0.001) {
      updates.providerPricePerHourUsd = usd
    }
  }
  if (newStatus === 'CLOSED' && !row.terminatedAt) updates.terminatedAt = new Date()

  await prisma.externalRental.update({ where: { id: externalRentalId }, data: updates })
  return info
}

/**
 * Terminate. Deletes the instance on Shadeform and the ephemeral
 * SSH key we registered. Idempotent.
 */
export async function terminateShadeFormRental(
  prisma: PrismaClient,
  externalRentalId: string,
  reason: string,
  client?: ShadeFormClient,
): Promise<void> {
  const row = await prisma.externalRental.findUnique({ where: { id: externalRentalId } })
  if (!row) throw new ShadeFormProvisionError(`ExternalRental ${externalRentalId} not found`)
  if (row.status === 'CLOSED') return

  const api = client ?? new ShadeFormClient()
  if (row.providerInstanceId) {
    try {
      await api.deleteInstance(row.providerInstanceId)
    } catch (err) {
      if (err instanceof ShadeFormApiError && err.statusCode === 404) {
        // Already gone; continue.
      } else {
        throw err
      }
    }
  }

  // Best-effort SSH key cleanup. Shadeform key registrations don't bill,
  // but leaving stale keys around causes name collisions for retried
  // provisions on the same compute request.
  if (row.providerSshKeyId) {
    await api.deleteSshKey(row.providerSshKeyId).catch(() => undefined)
  }

  await prisma.externalRental.update({
    where: { id: externalRentalId },
    data: { status: 'CLOSED', terminatedAt: new Date(), lastError: reason },
  })
}

function pickFirstAvailableRegion(
  availability: Array<{ region?: string; available?: boolean }> | undefined,
): string | null {
  if (!availability) return null
  for (const a of availability) {
    if (a.available !== false && a.region) return a.region
  }
  return null
}

function mapShadeFormStatus(
  raw: ShadeFormInstanceStatus | undefined,
): 'PENDING' | 'ACTIVE' | 'DEGRADED' | 'CLOSED' | 'FAILED' {
  if (!raw) return 'PENDING'
  if (raw === 'active') return 'ACTIVE'
  if (raw === 'error') return 'FAILED'
  if (raw === 'deleting' || raw === 'deleted') return 'CLOSED'
  return 'PENDING'
}
