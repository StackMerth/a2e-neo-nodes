/**
 * Internal-tier to TensorDock GPU model mapping.
 *
 * TensorDock's GPU model strings follow a lowercase-hyphen convention:
 *   h100-sxm5-80gb, h100-pcie-80gb
 *   h200-sxm5-141gb (when present)
 *   a100-sxm4-80gb, a100-pcie-80gb, a100-sxm4-40gb
 *   l40s-pcie-48gb
 *   geforcertx4090-pcie-24gb
 *   geforcertx3090-pcie-24gb
 *   b200-sxm6-180gb (rare)
 *
 * Rather than hard-code exact strings (TensorDock's catalog rotates as
 * hosts join/leave), we keep a SUBSTRING-MATCH allowlist per tier. The
 * probe walks /stock/list, filters by these substrings, sums
 * available_now, and picks the cheapest matching SKU. This survives
 * naming-convention drift across single hosts.
 *
 * Source for the patterns: caguiclajmg/tensordock-cli source + the
 * alx/tensordock_deploy GitHub script's gpu_model examples.
 *
 * gpusPerHost caps reflect what single-host SKUs typically expose. A
 * buyer requesting 8x H100 routes correctly only when TensorDock has
 * an 8-card host (rare); other counts fall through to next provider.
 */

import type { GpuTier } from '@a2e/database'

export interface TensorDockTierMapping {
  /** Substrings (lowercase) that identify GPU model strings on TensorDock for this tier. */
  modelTokens: string[]
  /** Optional sub-class hint for display only (e.g. "H100 SXM5"). */
  label: string
  /** Per-host max GPU count we'll accept. TensorDock rarely sells more than 8 in one box. */
  gpusPerHostMax: number
  /** Sensible vCPU default per GPU. Overridable per-deploy. */
  vcpusPerGpu: number
  /** RAM in GB per GPU. Overridable per-deploy. */
  ramGbPerGpu: number
  /** Storage in GB per host (fixed; storage scales with deploy not GPU count). */
  storageGb: number
  /** Approx $/hr per GPU reference; live price comes from /stock/list. */
  approxPricePerGpuHourUsd: number
}

const MAPPING: Partial<Record<GpuTier, TensorDockTierMapping>> = {
  H100: {
    modelTokens: ['h100'],
    label: 'H100 80GB',
    gpusPerHostMax: 8,
    vcpusPerGpu: 16,
    ramGbPerGpu: 64,
    storageGb: 200,
    approxPricePerGpuHourUsd: 2.50,
  },
  H200: {
    // Less common on TensorDock today; mapping defensive in case
    // hosts start listing h200 SKUs as they roll out.
    modelTokens: ['h200'],
    label: 'H200 141GB',
    gpusPerHostMax: 8,
    vcpusPerGpu: 16,
    ramGbPerGpu: 80,
    storageGb: 200,
    approxPricePerGpuHourUsd: 3.50,
  },
  A100: {
    modelTokens: ['a100'],
    label: 'A100 80GB',
    gpusPerHostMax: 8,
    vcpusPerGpu: 12,
    ramGbPerGpu: 48,
    storageGb: 200,
    approxPricePerGpuHourUsd: 1.50,
  },
  L40S: {
    modelTokens: ['l40s'],
    label: 'L40S 48GB',
    gpusPerHostMax: 8,
    vcpusPerGpu: 8,
    ramGbPerGpu: 32,
    storageGb: 200,
    approxPricePerGpuHourUsd: 1.10,
  },
  B200: {
    modelTokens: ['b200'],
    label: 'B200 180GB',
    gpusPerHostMax: 8,
    vcpusPerGpu: 24,
    ramGbPerGpu: 96,
    storageGb: 200,
    approxPricePerGpuHourUsd: 6.00,
  },
  RTX_4090: {
    // GeForce prefix matters: TensorDock's marketplace catalog
    // distinguishes consumer cards via the geforce* family.
    modelTokens: ['geforcertx4090', 'rtx4090', 'rtx_4090'],
    label: 'RTX 4090 24GB',
    gpusPerHostMax: 8,
    vcpusPerGpu: 6,
    ramGbPerGpu: 24,
    storageGb: 200,
    approxPricePerGpuHourUsd: 0.40,
  },
  RTX_3090: {
    modelTokens: ['geforcertx3090', 'rtx3090', 'rtx_3090'],
    label: 'RTX 3090 24GB',
    gpusPerHostMax: 8,
    vcpusPerGpu: 6,
    ramGbPerGpu: 24,
    storageGb: 200,
    approxPricePerGpuHourUsd: 0.30,
  },
  // CONSUMER catchall: matches any rtx* model TensorDock sells.
  // The probe falls back to this when the buyer requests CONSUMER tier
  // without specifying a card.
  CONSUMER: {
    modelTokens: ['rtx', 'geforce'],
    label: 'Consumer NVIDIA',
    gpusPerHostMax: 8,
    vcpusPerGpu: 4,
    ramGbPerGpu: 16,
    storageGb: 100,
    approxPricePerGpuHourUsd: 0.30,
  },
  // B300 / GB300: not yet observed in TensorDock catalog. Leave
  // unmapped so the probe returns tier_unmapped instead of false
  // positives.
}

export function tensorDockTypeForTier(tier: GpuTier): TensorDockTierMapping | null {
  return MAPPING[tier] ?? null
}

/**
 * Whether (tier, count) maps to a single TensorDock host. TensorDock
 * sells single-host inventory only (no cross-host clusters via this
 * adapter), so requested count must be <= per-host max.
 */
export function fitsSingleTensorDockHost(tier: GpuTier, gpuCount: number): boolean {
  const m = MAPPING[tier]
  if (!m) return false
  return gpuCount > 0 && gpuCount <= m.gpusPerHostMax
}

/**
 * Test if a stock model string from /stock/list matches a tier's
 * substring allowlist. Case-insensitive comparison.
 */
export function stockMatchesTier(modelString: string, tier: GpuTier): boolean {
  const m = MAPPING[tier]
  if (!m) return false
  const lower = modelString.toLowerCase()
  return m.modelTokens.some((tok) => lower.includes(tok.toLowerCase()))
}
