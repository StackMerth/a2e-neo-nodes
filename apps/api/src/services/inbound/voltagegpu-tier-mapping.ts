/**
 * T5h — internal (GpuTier, gpuCount) -> VoltageGPU offer id mapping.
 *
 * Populated AFTER first `pnpm --filter @a2e/api voltagegpu:inspect`
 * run reveals the actual offer ids from /offers. The skeleton below
 * is BEST-GUESS based on common naming conventions; iterate the
 * hardwareId values after empirical verification.
 *
 * VoltageGPU's published catalog (per 2026-06-03 pricing page):
 *   - H100 confidential: $2.77/h
 *   - H200 confidential: $4.07/h
 *   - B200 confidential: listed (rate TBD)
 *
 * Multi-GPU SKUs probably exist (their integration shape mirrors
 * io.net) — populate after inspect surfaces them.
 *
 * Returns null for unmapped (tier, count); allocator skips
 * VoltageGPU and falls through to WAITING_ON_CAPACITY.
 */

import type { GpuTier } from '@a2e/database'

export interface VoltageGpuTierMapping {
  /** VoltageGPU offer id passed to createPod. */
  hardwareId: string
  /** Pretty label for logs / admin UI. */
  label: string
  /** GPU count this SKU provides. */
  gpusPerVm: number
  /** Default region (EU only as of 2026-06-03). */
  defaultRegion: string
  /** Per-hour USD rate snapshotted at mapping time. */
  approxPricePerHourUsd: number
}

/**
 * Verified against live catalog 2026-06-03 via voltagegpu:inspect.
 * VoltageGPU uses resource_name strings of the form
 * "{gpu}-{size}" where size is small=1x, medium=2x, large=4x,
 * xlarge=8x. All EU, all confidential, all live.
 *
 * Prices are slightly above the original research-page numbers
 * (e.g. H100 1x is $3.75 not $2.77) — they show p_min/p_max
 * dynamic pricing so actual rate varies. We snapshot live price
 * at provision time via listOffers.
 */
const MAPPING: Partial<Record<GpuTier, Partial<Record<number, VoltageGpuTierMapping>>>> = {
  H100: {
    1: {
      hardwareId: 'h100-small',
      label: 'H100 80GB Confidential (1x)',
      gpusPerVm: 1,
      defaultRegion: 'EU',
      approxPricePerHourUsd: 3.75,
    },
    2: {
      hardwareId: 'h100-medium',
      label: 'H100 80GB Confidential (2x)',
      gpusPerVm: 2,
      defaultRegion: 'EU',
      approxPricePerHourUsd: 7.5,
    },
    4: {
      hardwareId: 'h100-large',
      label: 'H100 80GB Confidential (4x)',
      gpusPerVm: 4,
      defaultRegion: 'EU',
      approxPricePerHourUsd: 15.0,
    },
    // No H100 8x in current VoltageGPU catalog.
  },
  H200: {
    1: {
      hardwareId: 'h200-small',
      label: 'H200 141GB Confidential (1x)',
      gpusPerVm: 1,
      defaultRegion: 'EU',
      approxPricePerHourUsd: 4.94,
    },
    2: {
      hardwareId: 'h200-medium',
      label: 'H200 141GB Confidential (2x)',
      gpusPerVm: 2,
      defaultRegion: 'EU',
      approxPricePerHourUsd: 9.87,
    },
    4: {
      hardwareId: 'h200-large',
      label: 'H200 141GB Confidential (4x)',
      gpusPerVm: 4,
      defaultRegion: 'EU',
      approxPricePerHourUsd: 19.74,
    },
    // VERIFY: 8x H200 is $39.48/h in catalog; resource_name
    // pattern suggests "h200-xlarge" but unconfirmed until first
    // create or until inspect surfaces it explicitly.
    8: {
      hardwareId: 'h200-xlarge',
      label: 'H200 141GB Confidential (8x)',
      gpusPerVm: 8,
      defaultRegion: 'EU',
      approxPricePerHourUsd: 39.48,
    },
  },
  B200: {
    1: {
      hardwareId: 'b200-small',
      label: 'B200 192GB Confidential (1x)',
      gpusPerVm: 1,
      defaultRegion: 'EU',
      approxPricePerHourUsd: 7.95,
    },
    2: {
      hardwareId: 'b200-medium',
      label: 'B200 192GB Confidential (2x)',
      gpusPerVm: 2,
      defaultRegion: 'EU',
      approxPricePerHourUsd: 15.9,
    },
    4: {
      hardwareId: 'b200-large',
      label: 'B200 192GB Confidential (4x)',
      gpusPerVm: 4,
      defaultRegion: 'EU',
      approxPricePerHourUsd: 31.8,
    },
    // VERIFY: 8x B200 is $63.60/h in catalog; resource_name
    // pattern suggests "b200-xlarge".
    8: {
      hardwareId: 'b200-xlarge',
      label: 'B200 192GB Confidential (8x)',
      gpusPerVm: 8,
      defaultRegion: 'EU',
      approxPricePerHourUsd: 63.6,
    },
  },
  // L40S / RTX / B300 / etc. — VoltageGPU is H100/H200/B200 only.
}

/** Lookup VoltageGPU offer for an internal (tier, count). */
export function voltageGpuTypeForTier(
  tier: GpuTier,
  gpuCount: number,
): VoltageGpuTierMapping | null {
  return MAPPING[tier]?.[gpuCount] ?? null
}

/**
 * Whether (tier, gpuCount) fits in a single VoltageGPU pod.
 * Multi-pod clusters are out of scope for Phase 1.
 */
export function fitsSingleVoltageGpuPod(tier: GpuTier, gpuCount: number): boolean {
  return voltageGpuTypeForTier(tier, gpuCount) !== null
}
