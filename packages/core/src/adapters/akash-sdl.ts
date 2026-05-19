/**
 * Akash SDL (Service Definition Language) generator.
 *
 * SDL is the manifest Akash providers use to spin up a deployment. We render
 * it as YAML from a typed input. Single-service deployment per node, single
 * GPU, NVIDIA only. The pricing block sets the *maximum* bid the wallet will
 * accept — providers below this bid amount in their pricing — so we want it
 * generous enough to attract bids but not so high we pay way over market.
 */

import yaml from 'js-yaml'
import type { GpuTier } from '@a2e/shared'

export interface SdlInput {
  /** Caller-side identifier; used as the SDL service name. */
  nodeId: string
  /** Which GPU class to request. */
  gpuTier: GpuTier
  /** Container image to run. Default: a small CUDA-ready PyTorch image. */
  image?: string
  /**
   * Maximum bid we will accept, in uakt per block (~6 seconds).
   * If unset, picks a per-tier default that's roughly 1.5× expected market.
   */
  maxBidUaktPerBlock?: number
  /** CPU units (1 unit = 1 vCPU). Default 8. */
  cpuUnits?: number
  /** Memory size, e.g. "32Gi". Default "32Gi". */
  memorySize?: string
  /** Storage size, e.g. "100Gi". Default "100Gi". */
  storageSize?: string
}

/**
 * Akash GPU model identifiers as understood by provider attribute matching.
 * Keep these aligned with what real providers advertise on-chain.
 */
const GPU_TIER_TO_AKASH_MODEL: Record<GpuTier, string> = {
  H100: 'h100',
  H200: 'h200',
  B200: 'b200',
  B300: 'b300',
  GB300: 'gb300',
  OTHER: 'rtx', // Generic fallback — picks up any RTX-class GPU on Akash
  // C2 wave 2: consumer tiers aren't first-class on Akash's attribute
  // matching (their providers advertise datacenter inventory). Map to
  // generic 'rtx' so a stray INFERENCE deployment that overflows to
  // Akash still produces a buildable SDL; in practice the allocator
  // shouldn't route these externally — the consumer-tier filter
  // keeps them on internal inventory.
  RTX_4090: 'rtx-4090',
  RTX_3090: 'rtx-3090',
  CONSUMER: 'rtx',
}

/**
 * Per-tier bid ceiling in uakt-per-block. ~600 blocks/hour. At $3.50/AKT,
 * 5000 uakt/block ≈ $10.50/hour. These leave generous headroom — they're a
 * cap, not a target — so canary bids actually clear, while preventing wildly
 * overpriced providers from winning.
 */
const DEFAULT_MAX_BID_UAKT: Record<GpuTier, number> = {
  H100: 5000,
  H200: 8000,
  B200: 12000,
  B300: 18000,
  GB300: 22000,
  OTHER: 3000,
  // C2 wave 2: consumer tiers are cheap; cap the bid low so a stray
  // overflow deployment never spends more than ~$2/hr on Akash.
  RTX_4090: 1500,
  RTX_3090: 1000,
  CONSUMER: 800,
}

const DEFAULT_IMAGE = 'pytorch/pytorch:2.1.0-cuda12.1-cudnn8-runtime'

interface SdlDocument {
  version: string
  services: Record<string, unknown>
  profiles: {
    compute: Record<string, unknown>
    placement: Record<string, unknown>
  }
  deployment: Record<string, unknown>
}

/**
 * Build a deterministic SDL document for the requested deployment. Returns
 * both the parsed object (handy for tests) and the YAML string ready to
 * submit to MsgCreateDeployment.
 */
export function buildSdl(input: SdlInput): { document: SdlDocument; yaml: string } {
  const {
    nodeId,
    gpuTier,
    image = DEFAULT_IMAGE,
    maxBidUaktPerBlock = DEFAULT_MAX_BID_UAKT[gpuTier],
    cpuUnits = 8,
    memorySize = '32Gi',
    storageSize = '100Gi',
  } = input

  const serviceName = sanitiseServiceName(nodeId)
  const gpuModel = GPU_TIER_TO_AKASH_MODEL[gpuTier]

  const document: SdlDocument = {
    version: '2.0',
    services: {
      [serviceName]: {
        image,
        expose: [
          {
            port: 22,
            as: 22,
            to: [{ global: true }],
          },
        ],
      },
    },
    profiles: {
      compute: {
        [serviceName]: {
          resources: {
            cpu: { units: cpuUnits },
            memory: { size: memorySize },
            storage: { size: storageSize },
            gpu: {
              units: 1,
              attributes: {
                vendor: {
                  nvidia: [{ model: gpuModel }],
                },
              },
            },
          },
        },
      },
      placement: {
        akash: {
          pricing: {
            [serviceName]: {
              denom: 'uakt',
              amount: maxBidUaktPerBlock,
            },
          },
        },
      },
    },
    deployment: {
      [serviceName]: {
        akash: {
          profile: serviceName,
          count: 1,
        },
      },
    },
  }

  return {
    document,
    yaml: yaml.dump(document, { lineWidth: 120, noRefs: true }),
  }
}

/**
 * Akash SDL service names must be lowercase alphanumeric with hyphens, no
 * underscores, max ~63 chars. Our internal nodeIds are CUIDs which are
 * already lowercase alphanumeric — but we trim defensively.
 */
function sanitiseServiceName(nodeId: string): string {
  const cleaned = nodeId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '')
  // Akash service names start with a letter
  const withLetterPrefix = /^[a-z]/.test(cleaned) ? cleaned : `n-${cleaned}`
  return withLetterPrefix.slice(0, 63)
}
