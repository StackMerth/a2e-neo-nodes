/**
 * T5g — internal (GpuTier, gpuCount) -> io.net hardware deploy_id mapping.
 *
 * io.net's catalog has distinct SKUs per GPU count within a family
 * (gpu_1x_h100, gpu_2x_h100, 8H100.80S.176V, etc.). Mapping is keyed
 * by (tier, count) so multi-GPU rentals route to the right SKU.
 *
 * Populated from the live /hardware catalog dump 2026-06-03:
 *   - Cheapest viable SKU picked per (tier, count); US-region
 *     preferred where available, FI/FR/PL otherwise
 *   - RTX_4090 only available as 8x bundle ($3.92/h) — no 1x/2x/4x
 *     SKU exists; we only register the 8x mapping
 *   - RTX_3090, GB300, CONSUMER, OTHER: not carried by io.net
 *   - H200: no 8x SKU available; max 4x
 *
 * Returns null for unmapped (tier, count) — allocator skips io.net
 * and falls through to WAITING_ON_CAPACITY.
 *
 * CATALOG DRIFT: io.net rotates SKUs frequently. Verified once
 * (2026-06-03 morning) and again the same day, 1L40S.20V had been
 * dropped and replaced with a plain "L40S" deploy_id. The
 * orchestrator's listHardware-and-verify step at provision time
 * catches stale entries (returns "io.net has no hardware with
 * deploy_id X") so requests don't silently fail — they just bypass
 * io.net for that tier until the mapping gets updated. Re-run
 * `pnpm --filter @a2e/api ionet:inspect --raw` periodically and
 * refresh this file.
 */

import type { GpuTier } from '@a2e/database'

export interface IoNetTierMapping {
  /**
   * io.net deploy_id (string like "gpu_1x_h100" or "8B300.240V").
   * Verified 2026-06-03 against live API.
   */
  hardwareId: string
  /** Pretty label for logs / admin UI. */
  label: string
  /** GPU count this SKU provides (must match the requested count). */
  gpusPerVm: number
  /** Default location for this SKU (io.net region code). */
  defaultLocation: string
  /** Per-hour rate snapshotted at mapping time; live rate fetched on provision. */
  approxPricePerHourUsd: number
}

/**
 * Nested map: tier -> gpuCount -> mapping. Populated from the live
 * catalog. When io.net adds new SKUs, add entries here; when SKUs
 * change deploy_id, update here. The orchestrator's listHardware
 * call verifies the SKU is still in the catalog at provision time.
 */
const MAPPING: Partial<Record<GpuTier, Partial<Record<number, IoNetTierMapping>>>> = {
  H100: {
    1: {
      hardwareId: 'gpu_1x_h100',
      label: 'H100 80GB (1x)',
      gpusPerVm: 1,
      defaultLocation: 'US',
      approxPricePerHourUsd: 2.6,
    },
    2: {
      hardwareId: 'gpu_2x_h100',
      label: 'H100 80GB (2x)',
      gpusPerVm: 2,
      defaultLocation: 'US',
      approxPricePerHourUsd: 5.21,
    },
    8: {
      hardwareId: '8H100.80S.176V',
      label: 'H100 80GB SXM (8x, 176 vCPU)',
      gpusPerVm: 8,
      defaultLocation: 'FI',
      approxPricePerHourUsd: 27.88,
    },
  },
  H200: {
    1: {
      hardwareId: 'gpu_1x_h200_nvl',
      label: 'H200 141GB NVL (1x)',
      gpusPerVm: 1,
      defaultLocation: 'US',
      approxPricePerHourUsd: 3.79,
    },
    2: {
      hardwareId: 'gpu_2x_h200_nvl',
      label: 'H200 141GB NVL (2x)',
      gpusPerVm: 2,
      defaultLocation: 'US',
      approxPricePerHourUsd: 7.58,
    },
    4: {
      hardwareId: 'gpu_4x_h200_nvl',
      label: 'H200 141GB NVL (4x)',
      gpusPerVm: 4,
      defaultLocation: 'US',
      approxPricePerHourUsd: 15.16,
    },
    // No 8x H200 in io.net's catalog as of 2026-06-03.
  },
  B200: {
    1: {
      hardwareId: '1B200.30V',
      label: 'B200 180GB (1x)',
      gpusPerVm: 1,
      defaultLocation: 'FI',
      approxPricePerHourUsd: 7.13,
    },
    8: {
      hardwareId: '8B200.240V',
      label: 'B200 180GB (8x, 240 vCPU)',
      gpusPerVm: 8,
      defaultLocation: 'FI',
      approxPricePerHourUsd: 52.04,
    },
  },
  B300: {
    1: {
      hardwareId: '1B300.30V',
      label: 'B300 288GB (1x)',
      gpusPerVm: 1,
      defaultLocation: 'FI',
      approxPricePerHourUsd: 8.74,
    },
    2: {
      hardwareId: '2B300.60V',
      label: 'B300 288GB (2x)',
      gpusPerVm: 2,
      defaultLocation: 'FI',
      approxPricePerHourUsd: 16.61,
    },
    8: {
      hardwareId: '8B300.240V',
      label: 'B300 288GB (8x, 240 vCPU)',
      gpusPerVm: 8,
      defaultLocation: 'FI',
      approxPricePerHourUsd: 63.86,
    },
  },
  L40S: {
    1: {
      // io.net dropped 1L40S.20V (FI, $1.73, 20 vCPU) from the
      // catalog between 2026-06-03 morning + evening probes. The
      // replacement deploy_id is simply "L40S" (FR/PL, $1.70, 8
      // vCPU/96GB RAM — smaller box than the old SKU). Note that
      // multiple SKU rows can share the same deploy_id with
      // different regions; we pick FR as the default location and
      // io.net resolves to whichever has capacity.
      hardwareId: 'L40S',
      label: 'L40S 48GB (1x)',
      gpusPerVm: 1,
      defaultLocation: 'FR',
      approxPricePerHourUsd: 1.7,
    },
    2: {
      hardwareId: 'L40Sx2',
      label: 'L40S 48GB (2x)',
      gpusPerVm: 2,
      // L40Sx2 exists in both FR and PL at $3.40/h. Pick FR for
      // primary; allocator will fall through if region unavailable.
      defaultLocation: 'FR',
      approxPricePerHourUsd: 3.4,
    },
    4: {
      hardwareId: 'L40Sx4',
      label: 'L40S 48GB (4x)',
      gpusPerVm: 4,
      defaultLocation: 'US',
      approxPricePerHourUsd: 5.8,
    },
    8: {
      hardwareId: 'L40Sx8',
      label: 'L40S 48GB (8x)',
      gpusPerVm: 8,
      defaultLocation: 'US',
      approxPricePerHourUsd: 11.6,
    },
  },
  RTX_4090: {
    // Only 8x bundle available — io.net doesn't carry 1x/2x/4x RTX 4090.
    8: {
      hardwareId: 'RTX4090x8',
      label: 'RTX 4090 24GB (8x)',
      gpusPerVm: 8,
      defaultLocation: 'US',
      approxPricePerHourUsd: 3.92,
    },
  },
  // RTX_3090 / GB300 / CONSUMER / OTHER: io.net doesn't carry these
  // in its current catalog (2026-06-03). Allocator skips io.net for
  // these tiers.
}

/**
 * Lookup the io.net SKU for an internal (tier, count) combo.
 * Returns null when io.net doesn't carry that specific combination.
 */
export function ioNetTypeForTier(
  tier: GpuTier,
  gpuCount: number,
): IoNetTierMapping | null {
  return MAPPING[tier]?.[gpuCount] ?? null
}

/**
 * Whether (tier, gpuCount) maps to a single io.net VM SKU. Same as
 * ioNetTypeForTier returning non-null since every mapped SKU is
 * exactly the requested GPU count. Multi-VM clusters via
 * replica_count are out of scope for T5g Phase 1.
 */
export function fitsSingleIoNetVm(tier: GpuTier, gpuCount: number): boolean {
  return ioNetTypeForTier(tier, gpuCount) !== null
}
