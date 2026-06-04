/**
 * T5h — Mapping between TokenOS internal GpuTier + count and the
 * Azure VM size we provision through the Compute REST API.
 *
 * Phase 1 covers Standard_NCC40ads_H100_v5 only (1 x H100 NVL 94GB
 * confidential, AMD SEV-SNP + Hopper CC). Azure does not currently
 * have a multi-GPU confidential SKU or an H200 / B200 confidential
 * SKU. Multi-GPU requests cascade through to Phala (h200.8x.large)
 * or GCP A3 once those have capacity.
 *
 * Pricing snapshot 2026-06-04 (per Azure pricing calc + 3rd-party
 * trackers — verify at provision):
 *   Standard_NCC40ads_H100_v5 on-demand: ~$6.98/hr
 *   Standard_NCC40ads_H100_v5 spot:      ~$2.19/hr per GPU
 *   Per-second billing, no minimum.
 *
 * Spec: 40 vCPU AMD EPYC Genoa + 320 GiB RAM + 1x H100 NVL 94GB +
 * 800 GiB local temp disk.
 *
 * The adapter defaults to spot for the cost win. Set spot=false
 * when an enterprise buyer needs no-preemption guarantee.
 */

import type { GpuTier } from '@a2e/database'

export interface AzureTierMapping {
  /** Azure VM size short id, e.g. "Standard_NCC40ads_H100_v5". */
  vmSize: string
  /** Human-readable label for inspect / debug output. */
  label: string
  /** Number of GPUs this VM size provides. */
  gpuCount: number
  /** Approximate spot price per hour USD. */
  spotPricePerHourUsd: number
  /** Approximate on-demand price per hour USD. */
  onDemandPricePerHourUsd: number
}

/**
 * Lookup table for (GpuTier, gpuCount) -> Azure VM size.
 *
 * NOTE: Azure confidential H100 only ships in single-GPU (1x H100 NVL
 * 94GB) configuration as of 2026-06-04. Requests for 2x, 4x, or 8x
 * H100 in confidential mode return null here so the allocator skips
 * Azure for those configurations.
 */
const TIER_TABLE: Record<string, AzureTierMapping> = {
  'H100_x1': {
    vmSize: 'Standard_NCC40ads_H100_v5',
    label: 'Standard_NCC40ads_H100_v5 (1x H100 NVL 94GB SEV-SNP+CC)',
    gpuCount: 1,
    spotPricePerHourUsd: 2.19,
    onDemandPricePerHourUsd: 6.98,
  },
}

export function azureVmSizeForTier(
  tier: GpuTier,
  gpuCount: number,
): AzureTierMapping | null {
  return TIER_TABLE[`${tier}_x${gpuCount}`] ?? null
}

/**
 * Whether the request fits inside a single confidential NCCadsH100v5.
 * Multi-GPU confidential not yet available on Azure, so this returns
 * false for gpuCount > 1.
 */
export function fitsSingleAzureNcc(tier: GpuTier, gpuCount: number): boolean {
  return Boolean(azureVmSizeForTier(tier, gpuCount))
}

/**
 * Phase 1 tier coverage summary for inspect-style output.
 */
export function azureTierCoverageSummary(): string[] {
  return Object.entries(TIER_TABLE).map(([k, v]) => `${k.padEnd(10)} -> ${v.label}`)
}
