/**
 * Internal GpuTier -> Vast.ai gpu_name + per-pod GPU count mapping.
 *
 * Vast.ai's GPU model strings are SPACE-SEPARATED with conventional
 * SKU naming (e.g. 'RTX 4090', 'A100 PCIE' (uppercase E!), 'A100 SXM4',
 * 'H100 SXM5'). Confirmed against a live catalog snapshot 2026-06-06
 * via scripts/inspect-vastai-gpu-names.ts. The /bundles/ search's `eq`
 * operator does exact-string match so the casing + spacing have to be
 * EXACT — earlier '_'-separated values returned 0 offers because the
 * stored field uses spaces. Re-run inspect-vastai-gpu-names if Vast.ai
 * ever renames a SKU (their format has shifted before).
 *
 * Tiers not present here are intentionally NOT carried by Vast.ai in
 * our cascade — the probe returns hasCapacity=false with
 * reasonNoCapacity='tier_unmapped' for those, allowing other
 * providers to take precedence.
 *
 * As of 2026-06-06, Vast.ai's catalog (verified by browsing
 * console.vast.ai/create) actively carries:
 *   - RTX 4090: hundreds of listings, very reliable supply (the gap-
 *     filler that justifies adding Vast.ai)
 *   - RTX 3090: even more listings than 4090
 *   - L40S: moderate inventory
 *   - L40: occasional inventory (we don't expose this tier internally)
 *   - A100 80GB SXM: moderate, both single and 8x bundles
 *   - H100 SXM5: moderate, mostly 8x bundles
 *   - H100 PCIe: occasional
 *   - H100 NVL: occasional
 * Tiers Vast.ai does NOT typically carry: H200 (extremely rare),
 * B200, B300, GB300. Those keep going to RunPod / Lambda / Phala.
 *
 * Multi-GPU mappings: Vast.ai offers come with a fixed num_gpus per
 * host; we filter on num_gpus={eq:N} at search time. If Vast.ai has
 * no host with the exact GPU count we want, the probe falls through.
 */

import type { GpuTier } from '@a2e/database'

export interface VastAiTierMapping {
  /** Exact string Vast.ai's /bundles/ search expects in gpu_name. */
  gpuName: string
  /** Pretty label for logs / admin UI. */
  label: string
  /** Number of GPUs this offer SKU carries per host. */
  gpusPerHost: number
  /** Per-hour USD price snapshot at mapping time; refreshed via listOffers. */
  approxPricePerHourUsd: number
}

const MAPPING: Partial<Record<GpuTier, Partial<Record<number, VastAiTierMapping>>>> = {
  // CONSUMER TIER — the headline reason we added Vast.ai. Hundreds of
  // hosts at any moment. Per-second billing, verified-host filter
  // (>0.95 reliability) keeps quality high. Cheaper than RunPod
  // community typically.
  RTX_4090: {
    1: {
      gpuName: 'RTX 4090',
      label: 'RTX 4090 24GB (1x)',
      gpusPerHost: 1,
      approxPricePerHourUsd: 0.32,
    },
    2: {
      gpuName: 'RTX 4090',
      label: 'RTX 4090 24GB (2x)',
      gpusPerHost: 2,
      approxPricePerHourUsd: 0.62,
    },
    4: {
      gpuName: 'RTX 4090',
      label: 'RTX 4090 24GB (4x)',
      gpusPerHost: 4,
      approxPricePerHourUsd: 1.20,
    },
    8: {
      gpuName: 'RTX 4090',
      label: 'RTX 4090 24GB (8x)',
      gpusPerHost: 8,
      approxPricePerHourUsd: 2.40,
    },
  },
  RTX_3090: {
    1: {
      gpuName: 'RTX 3090',
      label: 'RTX 3090 24GB (1x)',
      gpusPerHost: 1,
      approxPricePerHourUsd: 0.20,
    },
    2: {
      gpuName: 'RTX 3090',
      label: 'RTX 3090 24GB (2x)',
      gpusPerHost: 2,
      approxPricePerHourUsd: 0.38,
    },
    4: {
      gpuName: 'RTX 3090',
      label: 'RTX 3090 24GB (4x)',
      gpusPerHost: 4,
      approxPricePerHourUsd: 0.72,
    },
    8: {
      gpuName: 'RTX 3090',
      label: 'RTX 3090 24GB (8x)',
      gpusPerHost: 8,
      approxPricePerHourUsd: 1.40,
    },
  },
  // DATACENTER TIER — secondary source. Lambda + RunPod cover these
  // well today but Vast.ai gives us a third option for resilience.
  L40S: {
    1: {
      gpuName: 'L40S',
      label: 'L40S 48GB (1x)',
      gpusPerHost: 1,
      approxPricePerHourUsd: 0.85,
    },
    8: {
      gpuName: 'L40S',
      label: 'L40S 48GB (8x)',
      gpusPerHost: 8,
      approxPricePerHourUsd: 6.40,
    },
  },
  H100: {
    1: {
      // Vast.ai distinguishes H100 PCIE (uppercase E, matching their
      // 'A100 PCIE' convention seen in the live catalog) vs H100 SXM5.
      // Default to PCIE for 1-GPU SKU since SXM is typically only in
      // 8x server bundles.
      gpuName: 'H100 PCIE',
      label: 'H100 PCIe 80GB (1x)',
      gpusPerHost: 1,
      approxPricePerHourUsd: 1.79,
    },
    8: {
      gpuName: 'H100 SXM5',
      label: 'H100 SXM5 80GB (8x)',
      gpusPerHost: 8,
      approxPricePerHourUsd: 13.20,
    },
  },
  // H200 / B200 / B300 / GB300 / CONSUMER / OTHER deliberately omitted.
  // Allocator skips Vast.ai for those tiers and falls through to the
  // next provider in the cascade (probably RunPod or Phala).
}

/**
 * Lookup the Vast.ai SKU for an internal (tier, gpuCount) combo.
 * Returns null when Vast.ai doesn't carry that specific combination —
 * caller (probe / provision) treats null as "skip this provider for
 * this request".
 */
export function vastAiTypeForTier(
  tier: GpuTier,
  gpuCount: number,
): VastAiTierMapping | null {
  return MAPPING[tier]?.[gpuCount] ?? null
}

/**
 * True when Vast.ai's catalog carries the exact (tier, count) combo.
 * Wrapper around vastAiTypeForTier for callers that only need a yes/no.
 */
export function fitsSingleVastAiHost(tier: GpuTier, gpuCount: number): boolean {
  return vastAiTypeForTier(tier, gpuCount) !== null
}
