/**
 * T5a — internal GpuTier -> Lambda Labs instance type mapping.
 *
 * Pure lookup table. The allocator passes (cr.gpuTier, cr.gpuCount)
 * and gets back the Lambda instance type name that matches the SKU
 * the buyer asked for, plus a list of acceptable regions if the
 * caller doesn't care.
 *
 * Lambda's instance-type names follow a stable pattern:
 *   gpu_{count}x_{model}{_variant?}
 *   gpu_1x_h100_pcie, gpu_8x_h100_sxm5, gpu_1x_h200, gpu_8x_b200, ...
 *
 * For our marketplace tiers we pick the type that buyers most
 * commonly mean:
 *   H100  -> 8x H100 SXM5 (highest density, what serious training
 *            workloads want — single-GPU H100s are typically
 *            dev/inference, not what enterprise buyers come for)
 *   H200  -> 8x H200 SXM5
 *   B200  -> 8x B200
 *   B300  -> 8x B300 (when available; same pattern)
 *   GB300 -> NVL72 superchip
 *   L40S  -> 1x L40S (inference / mid-tier; multi-GPU rare on Lambda)
 *   RTX_* -> not available on Lambda (consumer cards aren't sold);
 *            allocator must skip Lambda fallback for consumer tiers
 *
 * Multi-node clusters: if cr.gpuCount > 8, the allocator should
 * provision multiple Lambda instances (one per 8-GPU shard) and treat
 * them as a cluster. Out of scope for T5a — single-instance only.
 *
 * If Lambda renames an instance type or adds new SKUs, update the
 * table here; the allocator falls back to "no Lambda match available"
 * automatically when there's no mapping.
 */

import type { GpuTier } from '@a2e/database'

export interface TierMapping {
  /** Lambda's instance_type_name (passed verbatim to launchInstance). */
  instanceTypeName: string
  /** Pretty label for logs / admin UI. */
  label: string
  /** Maximum cr.gpuCount this mapping satisfies (1 for single-GPU; 8 for 8x boxes). */
  gpusPerInstance: number
}

const MAPPING: Partial<Record<GpuTier, TierMapping>> = {
  H100: {
    instanceTypeName: 'gpu_8x_h100_sxm5',
    label: '8x H100 SXM5',
    gpusPerInstance: 8,
  },
  H200: {
    instanceTypeName: 'gpu_8x_h200',
    label: '8x H200',
    gpusPerInstance: 8,
  },
  B200: {
    instanceTypeName: 'gpu_8x_b200',
    label: '8x B200',
    gpusPerInstance: 8,
  },
  B300: {
    instanceTypeName: 'gpu_8x_b300',
    label: '8x B300',
    gpusPerInstance: 8,
  },
  GB300: {
    instanceTypeName: 'gpu_gb300_nvl72',
    label: 'GB300 NVL72',
    gpusPerInstance: 72,
  },
  L40S: {
    instanceTypeName: 'gpu_1x_l40s',
    label: '1x L40S',
    gpusPerInstance: 1,
  },
  // Consumer tiers (CONSUMER, RTX_4090, RTX_3090) deliberately omitted.
  // Lambda doesn't sell consumer GPUs; the allocator falls back to
  // staying PENDING for those tiers when no internal supply exists.
}

/**
 * Return the Lambda instance type that matches the requested GpuTier,
 * or null when Lambda doesn't carry the SKU (consumer tiers, or a tier
 * we haven't mapped yet). Callers branch on null to skip the Lambda
 * fallback for that request.
 */
export function lambdaTypeForTier(tier: GpuTier): TierMapping | null {
  return MAPPING[tier] ?? null
}

/**
 * Whether a given tier + gpuCount combination can be served by a SINGLE
 * Lambda instance (vs. requiring a multi-instance cluster which T5b+
 * will eventually handle). Returns false when the buyer wants more
 * GPUs than one Lambda box provides.
 */
export function fitsSingleLambdaInstance(tier: GpuTier, gpuCount: number): boolean {
  const m = MAPPING[tier]
  if (!m) return false
  return gpuCount <= m.gpusPerInstance
}
