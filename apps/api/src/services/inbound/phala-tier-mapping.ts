/**
 * T5f — internal GpuTier -> Phala instance_type_id mapping.
 *
 * Verified against the Phala /api/v1/instance-types catalog
 * (2026-06-02). Phala currently offers H200 GPU SKUs only — no H100,
 * B200, B300, or L40S yet. Add mappings here as Phala expands their
 * GPU fleet.
 *
 * IDs are the literal Phala SKU strings from the /instance-types
 * response (e.g. "h200.small"). Passed verbatim to /cvms/workload
 * as instance_type_id.
 *
 * gpusPerInstance follows Phala's naming: small = 1x, 16xlarge = 8x.
 * The fitsSinglePhalaInstance check uses this to skip Phala when a
 * buyer wants more GPUs than a single CVM can hold.
 *
 * Consumer tiers (RTX_4090 / RTX_3090): NOT supported on Phala.
 * Their TEE primitives target datacenter cards (H200 specifically
 * has H100 CC mode). Consumer GPUs don't have the firmware support
 * for confidential compute.
 */

import type { GpuTier } from '@a2e/database'

export interface PhalaTierMapping {
  /** Exact Phala instance_type_id passed to /cvms/workload. */
  instanceTypeId: string
  /** Pretty label for logs / admin UI. */
  label: string
  /** Number of GPUs this SKU provides. */
  gpusPerInstance: number
}

const MAPPING: Partial<Record<GpuTier, PhalaTierMapping>> = {
  // H200 1x: single GPU box for small workloads / single-GPU
  // inference. $4.80/h verified 2026-06-02.
  H200: {
    instanceTypeId: 'h200.small',
    label: 'H200 SXM 141GB (1x)',
    gpusPerInstance: 1,
  },
  // No H100 / B200 / B300 / L40S — Phala doesn't carry them yet.
  // When a buyer asks for these tiers, the allocator skips Phala
  // and falls through to the next supplier (Lambda or RunPod).
}

/**
 * Lookup variant for multi-GPU requests. When a buyer wants 8x H200,
 * route to h200.8x.large (the better-provisioned 192 vCPU / 1.5TB
 * RAM box). The lighter h200.16xlarge is the same price but worse
 * specs, so we never pick it.
 *
 * Returns null when Phala doesn't have a SKU matching (tier, count).
 * Caller falls through to next supplier.
 */
export function phalaTypeForTier(
  tier: GpuTier,
  gpuCount: number,
): PhalaTierMapping | null {
  // Multi-GPU H200 special case: 8x box exists at fixed pricing.
  if (tier === 'H200' && gpuCount === 8) {
    return {
      instanceTypeId: 'h200.8x.large',
      label: 'H200 SXM 141GB (8x, 192 vCPU)',
      gpusPerInstance: 8,
    }
  }

  // Anything other than exactly 1 or 8 H200 = no Phala SKU. Future
  // Phala adds (2x, 4x H200, H100, B200) would slot in here.
  const m = MAPPING[tier]
  if (!m) return null
  if (gpuCount !== m.gpusPerInstance) return null
  return m
}

/**
 * Whether (tier, gpuCount) fits in a single Phala CVM. Mostly a
 * convenience wrapper — Phala doesn't support multi-CVM clusters
 * for a single rental yet, so anything that doesn't fit one SKU
 * exactly is rejected.
 */
export function fitsSinglePhalaCvm(tier: GpuTier, gpuCount: number): boolean {
  return phalaTypeForTier(tier, gpuCount) !== null
}
