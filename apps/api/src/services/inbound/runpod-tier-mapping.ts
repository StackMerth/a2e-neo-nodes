/**
 * T5e — internal GpuTier -> RunPod gpuTypeId mapping.
 *
 * Pure lookup. RunPod identifies GPU types by literal strings like
 * "NVIDIA H100 80GB HBM3" or "NVIDIA RTX A6000". The allocator passes
 * (cr.gpuTier, cr.gpuCount) and gets back the RunPod gpu type id our
 * provisioning call should request.
 *
 * RunPod's gpu type ids match the displayName from /gputypes. They
 * tend to be stable across years (Nvidia SKU names don't change), so
 * this table doesn't need frequent updates unless RunPod adds a new
 * SKU we want to map.
 *
 * gpusPerInstance: RunPod (unlike Lambda) doesn't bundle GPUs into
 * fixed-density boxes — you specify the gpuCount per pod. So
 * fitsSingleRunPodPod treats any count up to RunPod's per-pod max
 * (typically 8) as valid for the mapped SKU.
 *
 * Consumer-tier mapping (RTX_4090 etc.) is supported on RunPod's
 * COMMUNITY tier; unlike Lambda which only ships datacenter GPUs.
 * Useful when buyers want cheap inference compute.
 */

import type { GpuTier } from '@a2e/database'

export interface RunPodTierMapping {
  /** Exact id RunPod's API expects. Comes from /gputypes displayName. */
  gpuTypeId: string
  /** Pretty label for logs / admin UI. */
  label: string
  /** Maximum gpuCount RunPod supports per pod for this SKU. */
  maxGpusPerPod: number
}

// IDs verified against RunPod's GraphQL gpuTypes catalog on 2026-06-02
// during T5e dry-runs. Format is 'NVIDIA <displayName>' for datacenter
// SKUs, 'NVIDIA GeForce <model>' for consumer. RunPod's id field is
// what createPod expects in gpuTypeIds; displayName is what their
// console shows. Re-verify with `runpod:inspect --raw` if a mapping
// stops resolving (RunPod occasionally renames SKUs).
const MAPPING: Partial<Record<GpuTier, RunPodTierMapping>> = {
  H100: {
    // Verified id during A4000 dry-run lookup: H100 SXM -> this id.
    // RunPod treats SXM as the canonical H100 chassis; PCIe and NVL
    // are separate displayNames.
    gpuTypeId: 'NVIDIA H100 80GB HBM3',
    label: 'H100 SXM',
    maxGpusPerPod: 8,
  },
  H200: {
    // Real id is 'NVIDIA H200 NVL' (NOT 'NVIDIA H200'). Verified
    // during H200 NVL dry-run lookup. Without the 'NVL' suffix
    // RunPod's API would have returned 'gpu type not found'.
    gpuTypeId: 'NVIDIA H200 NVL',
    label: 'H200 NVL',
    maxGpusPerPod: 8,
  },
  B200: {
    gpuTypeId: 'NVIDIA B200',
    label: 'B200',
    maxGpusPerPod: 8,
  },
  L40S: {
    gpuTypeId: 'NVIDIA L40S',
    label: 'L40S',
    maxGpusPerPod: 8,
  },
  // Consumer tiers — RunPod's COMMUNITY tier carries these. Cheaper
  // than datacenter SKUs at the cost of less reliability. Useful for
  // dev / inference workloads where preemption is acceptable. IDs
  // pulled from the catalog (`NVIDIA GeForce RTX <model>` format).
  RTX_4090: {
    gpuTypeId: 'NVIDIA GeForce RTX 4090',
    label: 'RTX 4090',
    maxGpusPerPod: 8,
  },
  RTX_3090: {
    gpuTypeId: 'NVIDIA GeForce RTX 3090',
    label: 'RTX 3090',
    maxGpusPerPod: 8,
  },
  // B300 / GB300: not yet generally available on RunPod as of 2026-06.
  // Add when RunPod surfaces them in /gputypes.
}

/**
 * Return the RunPod gpu type id that matches the requested GpuTier,
 * or null when RunPod doesn't carry the SKU. Callers branch on null
 * to skip the RunPod fallback for that request.
 */
export function runPodTypeForTier(tier: GpuTier): RunPodTierMapping | null {
  return MAPPING[tier] ?? null
}

/**
 * Whether (tier, gpuCount) fits in a single RunPod pod.
 * RunPod supports arbitrary 1-8 gpuCount per pod on most SKUs, so
 * unless the request exceeds maxGpusPerPod for the mapped SKU, it
 * fits.
 */
export function fitsSingleRunPodPod(tier: GpuTier, gpuCount: number): boolean {
  const m = MAPPING[tier]
  if (!m) return false
  return gpuCount >= 1 && gpuCount <= m.maxGpusPerPod
}
