/**
 * T5h — Azure NCCadsH100v5 Confidential VM rental orchestrator.
 *
 * Mirror of gcp-provision.ts adapted for Azure Compute REST API.
 * Three operations:
 *
 *   provisionAzureRental(prisma, computeRequestId, options?)
 *     1. Lock ComputeRequest, verify status, idempotency check
 *     2. Map GpuTier+gpuCount -> Azure VM size (Standard_NCC40ads_H100_v5)
 *     3. Generate ephemeral ed25519 keypair
 *     4. Pick a region from AZURE_NCC_H100_REGIONS
 *     5. createInstance() with SEV-SNP + Confidential VM securityProfile
 *        + Spot priority
 *     6. Persist ExternalRental (provider='AZURE') with encrypted
 *        privkey + provider price for T6 settlement
 *     Returns the ExternalRental id.
 *
 *   pollAzureRentalStatus(prisma, externalRentalId)
 *     Single poll. Reads Azure VM state, updates status + sshHost +
 *     launchedAt as VM transitions through creating -> running.
 *
 *   terminateAzureRental(prisma, externalRentalId, reason)
 *     1. Tell Azure to delete the VM
 *     2. Mark ExternalRental CLOSED with timestamps
 *     Idempotent on Azure side (404 = no-op in deleteInstance).
 *
 * Status mapping (Azure -> ExternalRental.status):
 *   creating / starting / updating         -> PENDING
 *   running                                 -> ACTIVE
 *   stopping / deallocating / deleting     -> CLOSING
 *   stopped / deallocated                  -> CLOSED
 *   failed                                  -> FAILED
 *
 * SSH model: Azure injects buyer's public key via VM osProfile
 *   osProfile.linuxConfiguration.ssh.publicKeys
 *   adminUsername = 'azureuser'
 * No per-key registration on Azure side; providerSshKeyId stays null.
 *
 * Resource group strategy: each rental gets its own RG named
 * 'tokenos-rental-<id>'. RG deletion on terminate auto-cleans
 * dependent resources (NIC, public IP, disk). Phase 1 deletes only
 * the VM; Phase 2 enhancement adds full RG teardown.
 */

import type { PrismaClient } from '@a2e/database'
import {
  AzureApiError,
  AzureClient,
  AZURE_NCC_H100_REGIONS,
  type AzureVm,
  type AzureVmStatus,
} from './azure-adapter.js'
import { azureVmSizeForTier, fitsSingleAzureNcc } from './azure-tier-mapping.js'
import { generateRentalKeypair } from './ssh-keygen.js'
import { encryptPrivateKey, isKeyEncryptionConfigured } from './key-encryption.js'

export class AzureProvisionError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message)
    this.name = 'AzureProvisionError'
  }
}

export interface AzureProvisionResult {
  externalRentalId: string
  providerInstanceId: string
  providerInstanceType: string
  providerRegion: string
  providerPricePerHourUsd: number
}

export interface AzureProvisionOptions {
  client?: AzureClient
  /**
   * Test-only: skip GpuTier -> vmSize mapping and use the given
   * Azure VM size directly. Used by azure-provision:test --type for
   * arbitrary-SKU dry-runs.
   */
  vmSizeOverride?: string
  /**
   * Override the OS image reference. Must be confidential-VM-compatible.
   */
  imageOverride?: {
    publisher: string
    offer: string
    sku: string
    version: string
  }
  /** OS disk size in GB. Default 128. */
  osDiskSizeGb?: number
  /**
   * Use Spot priority. Default true — NCCadsH100v5 spot is ~$2.19/h
   * vs ~$6.98/h on-demand. Buyers needing no-preemption pass false.
   */
  spot?: boolean
  /**
   * Override which region to provision in. Default: first region in
   * AZURE_NCC_H100_REGIONS. Phase 2 enhancement: rotate on capacity
   * errors.
   */
  regionOverride?: string
  /**
   * Override the resource group. Default: per-rental RG named
   * 'tokenos-rental-<short id>'.
   */
  resourceGroupOverride?: string
}

/**
 * Stand up an Azure NCCadsH100v5 Confidential VM. Idempotent on the
 * ComputeRequest: if an ExternalRental row already exists, returns
 * its details without provisioning again.
 */
export async function provisionAzureRental(
  prisma: PrismaClient,
  computeRequestId: string,
  options: AzureProvisionOptions = {},
): Promise<AzureProvisionResult> {
  if (!isKeyEncryptionConfigured()) {
    throw new AzureProvisionError(
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
    throw new AzureProvisionError(`ComputeRequest ${computeRequestId} not found`)
  }

  let resolvedVmSize: string
  let snapshotPricePerHour: number
  if (options.vmSizeOverride) {
    resolvedVmSize = options.vmSizeOverride
    snapshotPricePerHour = 0
  } else {
    const mapping = azureVmSizeForTier(cr.gpuTier, cr.gpuCount)
    if (!mapping) {
      throw new AzureProvisionError(
        `Azure does not carry tier ${cr.gpuTier} x${cr.gpuCount} in confidential mode. Allocator should skip Azure for this tier or update azure-tier-mapping.ts when multi-GPU confidential NCC ships.`,
      )
    }
    if (!fitsSingleAzureNcc(cr.gpuTier, cr.gpuCount)) {
      throw new AzureProvisionError(
        `Request needs ${cr.gpuCount} ${cr.gpuTier} GPUs but Azure confidential NCC is single-GPU only as of 2026-06-04.`,
      )
    }
    resolvedVmSize = mapping.vmSize
    snapshotPricePerHour =
      options.spot === false
        ? mapping.onDemandPricePerHourUsd
        : mapping.spotPricePerHourUsd
  }

  const api = options.client ?? new AzureClient()
  const location = options.regionOverride ?? AZURE_NCC_H100_REGIONS[0]
  const useSpot = options.spot ?? true

  const keypair = generateRentalKeypair(cr.id)

  // Azure VM names: 1-64 chars, alphanumeric + hyphens, must start
  // with a letter. Computer name (Linux hostname) max 64 chars.
  const vmName = `tokenos-${cr.id.toLowerCase().replace(/[^a-z0-9-]/g, '')}`.slice(0, 60)
  const resourceGroup = options.resourceGroupOverride ?? `tokenos-rental-${cr.id.slice(0, 12)}`

  let providerInstanceId: string
  try {
    const result = await api.createInstance({
      name: vmName,
      resourceGroup,
      location,
      vmSize: resolvedVmSize,
      sshPublicKey: keypair.publicKeyOpenssh,
      adminUsername: 'azureuser',
      ...(options.osDiskSizeGb !== undefined ? { osDiskSizeGb: options.osDiskSizeGb } : {}),
      ...(options.imageOverride !== undefined ? { imageReference: options.imageOverride } : {}),
      spot: useSpot,
    })
    providerInstanceId = result.vmName
  } catch (err) {
    // First attempt likely surfaces quota (429 too many requests),
    // capacity (SkuNotAvailable), or networking (NIC must exist
    // first). The current adapter assumes a NIC will be auto-created
    // by Azure templates which is NOT correct for direct REST; first
    // failure will tell us we need to create the NIC + VNet first.
    throw new AzureProvisionError(
      `Azure createInstance failed for ${resolvedVmSize} in ${location}: ${(err as Error).message}`,
      err,
    )
  }

  const encryptedPrivKey = encryptPrivateKey(keypair.privateKeyPem)
  const row = await prisma.externalRental.create({
    data: {
      computeRequestId: cr.id,
      provider: 'AZURE',
      providerInstanceId,
      providerSshKeyId: null,
      providerInstanceType: resolvedVmSize,
      providerRegion: `${location}:${resourceGroup}`,
      status: 'PENDING',
      sshHost: null,
      sshUsername: 'azureuser',
      sshPublicKey: keypair.publicKeyOpenssh,
      sshPrivateKeyEnc: encryptedPrivKey,
      providerPricePerHourUsd: snapshotPricePerHour,
    },
    select: { id: true },
  })

  return {
    externalRentalId: row.id,
    providerInstanceId,
    providerInstanceType: resolvedVmSize,
    providerRegion: location,
    providerPricePerHourUsd: snapshotPricePerHour,
  }
}

/**
 * Poll Azure for one rental's status. Updates ExternalRental.status +
 * sshHost (publicIp) + launchedAt as appropriate.
 */
export async function pollAzureRentalStatus(
  prisma: PrismaClient,
  externalRentalId: string,
  client?: AzureClient,
): Promise<AzureVm | null> {
  const row = await prisma.externalRental.findUnique({
    where: { id: externalRentalId },
  })
  if (!row) {
    throw new AzureProvisionError(`ExternalRental ${externalRentalId} not found`)
  }
  if (row.status === 'CLOSED' || row.status === 'FAILED') {
    return null
  }

  // We packed "<location>:<resourceGroup>" into providerRegion at
  // provision time. Split here to recover both pieces.
  const [location, resourceGroup] = (row.providerRegion ?? '').split(':')
  if (!location || !resourceGroup) {
    throw new AzureProvisionError(
      `ExternalRental ${externalRentalId} providerRegion missing location:resourceGroup format`,
    )
  }

  const api = client ?? new AzureClient()
  let vm: AzureVm
  try {
    vm = await api.getInstance(resourceGroup, row.providerInstanceId)
  } catch (err) {
    if (err instanceof AzureApiError && err.statusCode === 404) {
      await prisma.externalRental.update({
        where: { id: externalRentalId },
        data: {
          status: 'CLOSED',
          terminatedAt: new Date(),
          lastNote: 'Azure returned 404 on getInstance; presumed terminated',
        },
      })
      return null
    }
    throw err
  }

  const newStatus = mapAzureStatus(vm.status)
  const updates: Record<string, unknown> = { status: newStatus, lastError: null }
  if (newStatus === 'ACTIVE' && !row.launchedAt) {
    updates.launchedAt = new Date()
  }
  if (vm.publicIp && row.sshHost !== vm.publicIp) {
    updates.sshHost = vm.publicIp
  }
  if (newStatus === 'CLOSED' && !row.terminatedAt) {
    updates.terminatedAt = new Date()
  }
  await prisma.externalRental.update({
    where: { id: externalRentalId },
    data: updates,
  })
  return vm
}

/**
 * Terminate the Azure VM and mark the ExternalRental row CLOSED.
 * Safe to call multiple times (Azure DELETE is idempotent on 404).
 */
export async function terminateAzureRental(
  prisma: PrismaClient,
  externalRentalId: string,
  reason: string,
  client?: AzureClient,
): Promise<void> {
  const row = await prisma.externalRental.findUnique({
    where: { id: externalRentalId },
  })
  if (!row) {
    throw new AzureProvisionError(`ExternalRental ${externalRentalId} not found`)
  }
  if (row.status === 'CLOSED') return

  const [location, resourceGroup] = (row.providerRegion ?? '').split(':')
  if (!location || !resourceGroup) {
    throw new AzureProvisionError(
      `ExternalRental ${externalRentalId} providerRegion missing location:resourceGroup format`,
    )
  }

  const api = client ?? new AzureClient()

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
    await api.deleteInstance(resourceGroup, row.providerInstanceId)
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

function mapAzureStatus(
  s: AzureVmStatus,
): 'PENDING' | 'ACTIVE' | 'CLOSING' | 'CLOSED' | 'FAILED' {
  switch (s) {
    case 'creating':
    case 'updating':
    case 'starting':
      return 'PENDING'
    case 'running':
      return 'ACTIVE'
    case 'stopping':
    case 'deallocating':
    case 'deleting':
      return 'CLOSING'
    case 'stopped':
    case 'deallocated':
      return 'CLOSED'
    case 'failed':
      return 'FAILED'
    default:
      return 'PENDING'
  }
}
