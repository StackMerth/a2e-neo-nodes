/**
 * T5g — Mapping between TokenOS internal GpuTier + count and the GCP
 * machine-type id we provision through the Compute Engine REST API.
 *
 * Phase 1 covers a3-highgpu-1g only (1 x H100 80GB Confidential).
 * GCP confidential A3 is single-GPU at this tier today — multi-GPU
 * confidential A3 (a3-megagpu-8g etc.) doesn't exist as a public SKU
 * yet, so multi-GPU H100 requests cascade through to Phala
 * (h200.8x.large) or io.net once their confidential allow-list lands.
 *
 * Pricing snapshot 2026-06-04 (subject to GCP rotation — verify at
 * provision time via the live billing API or accept the lock-in
 * snapshot in ExternalRental.providerPricePerHourUsd):
 *   a3-highgpu-1g  on-demand  ~$10.98/h blended (from a3-highgpu-8g rate)
 *   a3-highgpu-1g  spot       ~$3.69/h per GPU
 *
 * The adapter defaults to spot for the cost win. Add a `requireOnDemand`
 * flag to the request when an enterprise buyer needs no-preemption.
 */

import type { GpuTier } from '@a2e/database'

export interface GcpTierMapping {
  /** GCP machine type short id, e.g. "a3-highgpu-1g". */
  machineType: string
  /** Human-readable label for inspect / debug output. */
  label: string
  /** Number of GPUs this machine type provides. */
  gpuCount: number
  /** Approximate spot price per hour USD (reference only — actual
   *  rate snapshot happens at provision time). */
  spotPricePerHourUsd: number
  /** Approximate on-demand price per hour USD. */
  onDemandPricePerHourUsd: number
}

/**
 * Lookup table for (GpuTier, gpuCount) -> GCP machine type.
 *
 * NOTE: confidential A3 only ships in single-GPU (a3-highgpu-1g)
 * configuration as of 2026-06-04. Requests for 2x, 4x, or 8x H100 in
 * confidential mode return null here so the allocator skips GCP for
 * those configurations.
 */
const TIER_TABLE: Record<string, GcpTierMapping> = {
  'H100_x1': {
    machineType: 'a3-highgpu-1g',
    label: 'a3-highgpu-1g (1x H100 80GB TDX+CC)',
    gpuCount: 1,
    spotPricePerHourUsd: 3.69,
    onDemandPricePerHourUsd: 10.98,
  },
}

export function gcpMachineTypeForTier(
  tier: GpuTier,
  gpuCount: number,
): GcpTierMapping | null {
  return TIER_TABLE[`${tier}_x${gpuCount}`] ?? null
}

/**
 * Whether the request fits inside a single confidential A3 instance.
 * Multi-GPU confidential A3 doesn't exist yet so this always returns
 * false for gpuCount > 1.
 */
export function fitsSingleGcpA3(tier: GpuTier, gpuCount: number): boolean {
  return Boolean(gcpMachineTypeForTier(tier, gpuCount))
}

/**
 * Phase 1 tier coverage summary for inspect-style output.
 */
export function gcpTierCoverageSummary(): string[] {
  return Object.entries(TIER_TABLE).map(([k, v]) => `${k.padEnd(10)} -> ${v.label}`)
}
