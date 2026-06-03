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
 * BEST-GUESS skeleton. Real offer ids unknown until /offers responds.
 * After first inspect, populate this with actual hardwareId strings
 * from the live catalog.
 */
const MAPPING: Partial<Record<GpuTier, Partial<Record<number, VoltageGpuTierMapping>>>> = {
  H100: {
    1: {
      hardwareId: 'h100', // VERIFY: probably "h100", "h100-1x", or numeric id
      label: 'H100 80GB Confidential (1x)',
      gpusPerVm: 1,
      defaultRegion: 'EU',
      approxPricePerHourUsd: 2.77,
    },
    // Multi-GPU H100: add entries after inspect surfaces them.
  },
  H200: {
    1: {
      hardwareId: 'h200',
      label: 'H200 141GB Confidential (1x)',
      gpusPerVm: 1,
      defaultRegion: 'EU',
      approxPricePerHourUsd: 4.07,
    },
  },
  B200: {
    1: {
      hardwareId: 'b200',
      label: 'B200 192GB Confidential (1x)',
      gpusPerVm: 1,
      defaultRegion: 'EU',
      approxPricePerHourUsd: 0, // TBD per pricing page
    },
  },
  // L40S / RTX / etc. — not VoltageGPU's focus (they're confidential-only).
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
