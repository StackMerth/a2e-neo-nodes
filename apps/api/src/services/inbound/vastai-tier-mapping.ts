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
 * As of 2026-06-07 (verified via scripts/inspect-vastai-datacenter-skus.ts):
 *   - RTX 4090: 96 listings catalog-wide, 64 verified+reliable (1x cheapest)
 *   - RTX 3090: 83 listings, 37 verified+reliable
 *   - L40S: 12 listings, 7 verified+reliable at 1x, 1 at 8x
 *   - A100 PCIE: 3 verified; A100 SXM4: 5 verified (NOT exposed as internal
 *     tier today; add to GpuTier enum if buyer demand emerges)
 *   - H100 NVL: 2 verified (1x AND 2x) at $2.58/h - canonical 1x SKU
 *   - H100 SXM: 2 verified (1x, 2x) at $2.67/h - mapped to 8x slot for when
 *     server bundles appear (no current 8x supply)
 *   - H200 NVL: 2 verified (1x) at $3.66/h - canonical 1x H200
 *   - H200: 2 verified (1x) at $3.75/h - mapped to 8x slot for SXM bundles
 *   - B200: 1 verified (1x) at $4.38/h
 * Tiers Vast.ai does NOT carry as of this snapshot: B300, GB300 (still
 * route to Lambda / RunPod / Phala).
 *
 * Naming quirk: Vast.ai's `eq` operator on gpu_name is exact-match, and
 * the strings differ subtly from datacenter conventions. EARLIER WRONG
 * STRINGS (pre-2026-06-07) that returned all=0: 'H100 PCIE', 'H100 SXM5'.
 * CORRECT STRINGS verified via the datacenter inspector: 'H100 NVL',
 * 'H100 SXM', 'H200 NVL', 'H200', 'B200'. Re-run inspect-vastai-
 * datacenter-skus.ts quarterly to catch Vast.ai renames.
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
  A100: {
    1: {
      // A100 PCIE 80GB - 3 verified hosts in 2026-06-07 snapshot at
      // $0.563/h. Vast.ai's cheapest verified A100 SKU.
      gpuName: 'A100 PCIE',
      label: 'A100 PCIe 80GB (1x)',
      gpusPerHost: 1,
      approxPricePerHourUsd: 0.56,
    },
    2: {
      // A100 PCIE 2x: appears in catalog occasionally; price ~linear.
      gpuName: 'A100 PCIE',
      label: 'A100 PCIe 80GB (2x)',
      gpusPerHost: 2,
      approxPricePerHourUsd: 1.12,
    },
    4: {
      // 4x A100 SXM4 (server bundles); occasional supply.
      gpuName: 'A100 SXM4',
      label: 'A100 SXM4 80GB (4x)',
      gpusPerHost: 4,
      approxPricePerHourUsd: 4.66,
    },
    8: {
      // 8x A100 SXM4 server bundles; 5 verified hosts at $1.16/GPU.
      gpuName: 'A100 SXM4',
      label: 'A100 SXM4 80GB (8x)',
      gpusPerHost: 8,
      approxPricePerHourUsd: 9.30,
    },
  },
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
      // Vast.ai's catalog (verified 2026-06-07) carries 'H100 NVL' as
      // the dominant 1x H100 SKU, NOT 'H100 PCIE' as previously mapped.
      // H100 NVL = NVLink-bridged H100 with 94GB HBM3, performance
      // between PCIe and SXM5. Earlier 'H100 PCIE' string returned
      // all=0 because the form-factor isn't currently in the catalog.
      gpuName: 'H100 NVL',
      label: 'H100 NVL 94GB (1x)',
      gpusPerHost: 1,
      approxPricePerHourUsd: 2.58,
    },
    2: {
      // 2x H100 NVL supply confirmed in the catalog snapshot 2026-06-07.
      gpuName: 'H100 NVL',
      label: 'H100 NVL 94GB (2x)',
      gpusPerHost: 2,
      approxPricePerHourUsd: 5.0,
    },
    8: {
      // 'H100 SXM' not 'H100 SXM5'. Vast.ai's string omits the
      // generation suffix. No 8x supply in current snapshot but mapped
      // so the probe catches future 8x server bundles when they
      // appear (Vast.ai does carry occasional 8x H100 SXM stations).
      gpuName: 'H100 SXM',
      label: 'H100 SXM 80GB (8x)',
      gpusPerHost: 8,
      approxPricePerHourUsd: 13.20,
    },
  },
  H200: {
    1: {
      // Two SKUs with 1x H200 supply in the 2026-06-07 snapshot:
      // 'H200 NVL' at $3.66/h (2 verified) and raw 'H200' at $3.75/h
      // (2 verified). NVL is cheaper so it wins the price-ascending
      // sort; map 1x to NVL.
      gpuName: 'H200 NVL',
      label: 'H200 NVL 141GB (1x)',
      gpusPerHost: 1,
      approxPricePerHourUsd: 3.66,
    },
    8: {
      // 8x H200 server bundles are typically SXM (the raw 'H200'
      // string Vast.ai uses for SXM form factor). No 8x supply yet
      // but mapped for when bundles appear.
      gpuName: 'H200',
      label: 'H200 SXM 141GB (8x)',
      gpusPerHost: 8,
      approxPricePerHourUsd: 28.0,
    },
  },
  B200: {
    1: {
      // 1 verified 1x B200 at $4.38/h in the 2026-06-07 snapshot.
      // Genuinely rare on Vast.ai today but mapped so we catch it
      // when supply expands.
      gpuName: 'B200',
      label: 'B200 192GB (1x)',
      gpusPerHost: 1,
      approxPricePerHourUsd: 4.38,
    },
  },
  // B300 / GB300 / CONSUMER / OTHER deliberately omitted.
  // Allocator skips Vast.ai for those tiers and falls through to the
  // next provider in the cascade (probably RunPod / Lambda / Phala).
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
