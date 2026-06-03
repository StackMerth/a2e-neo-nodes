/**
 * T5g — internal GpuTier -> io.net hardware deploy_id mapping.
 *
 * io.net's hardware catalog uses numeric deploy_id values (e.g. 12)
 * which we must populate empirically from the live /hardware
 * response. Run `pnpm --filter @a2e/api ionet:inspect` to see your
 * account's catalog with real deploy_id values, then update the
 * MAPPING constant below.
 *
 * Until populated, every tier returns null and the allocator skips
 * io.net entirely (falls through to WAITING_ON_CAPACITY or the next
 * provider in the cascade).
 *
 * Multi-GPU rentals: io.net uses (hardware_id, gpus_per_vm) pairs
 * per VM. A given deploy_id may have a max gpu count per VM that
 * varies by SKU; fitsSingleIoNetVm() bounds-checks this with
 * maxGpusPerVm. Multi-VM clusters via replica_count are out of
 * scope for Phase 1 (single-VM rentals only).
 */

import type { GpuTier } from '@a2e/database'

export interface IoNetTierMapping {
  /**
   * io.net deploy_id (string like "8B300.240V" — NOT numeric as
   * the public docs suggested; verified 2026-06-03 against live API).
   */
  hardwareId: string
  /** Pretty label for logs / admin UI. */
  label: string
  /** Max GPU count per VM at this SKU. */
  maxGpusPerVm: number
  /** Default location preference (io.net region code, e.g. "US", "FI"). */
  defaultLocation?: string
}

/**
 * EMPTY UNTIL VERIFIED. Populate after running:
 *   pnpm --filter @a2e/api ionet:inspect --raw
 *
 * The output shows each SKU's deploy_id, name, num_cards, and
 * pricePerHour. Match each of our internal GpuTier enum values to
 * the io.net SKU that matches:
 *   H100  -> "H100 80GB SXM5" or similar (deploy_id TBD)
 *   H200  -> "H200 141GB SXM5" or similar (deploy_id TBD)
 *   B200  -> "B200 192GB SXM5" or similar (deploy_id TBD)
 *   L40S  -> "L40S" or similar (deploy_id TBD)
 *   RTX_4090 -> "RTX 4090" or similar (deploy_id TBD)
 *   RTX_3090 -> "RTX 3090" or similar (deploy_id TBD)
 */
const MAPPING: Partial<Record<GpuTier, IoNetTierMapping>> = {
  // Empty intentionally. Populate after ionet:inspect.
}

/**
 * Lookup hardware_id for an internal tier. Returns null when io.net
 * doesn't carry the tier (or MAPPING hasn't been populated yet).
 */
export function ioNetTypeForTier(tier: GpuTier): IoNetTierMapping | null {
  return MAPPING[tier] ?? null
}

/**
 * Whether (tier, gpuCount) fits in a single io.net VM. Multi-VM
 * clusters via replica_count are deferred to Phase 2 of T5g.
 */
export function fitsSingleIoNetVm(tier: GpuTier, gpuCount: number): boolean {
  const m = MAPPING[tier]
  if (!m) return false
  return gpuCount <= m.maxGpusPerVm && gpuCount >= 1
}
