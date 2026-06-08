/**
 * Capacity-first allocator probe.
 *
 * Replaces the old hardcoded "Lambda -> RunPod -> Phala -> io.net ->
 * VoltageGPU" sequential cascade with a parallel capacity check across
 * every enabled provider, then sorts by price ascending and returns
 * the order the allocator should try.
 *
 * Goals (set by the operator after the WAITLISTED loop bit users):
 *   1. Capacity is the FIRST sort key. A provider with capacity at
 *      $5/h beats a provider that's empty at $2/h every time.
 *   2. Among providers with capacity, cheapest wins. If RunPod has
 *      H100 at $2/h and Lambda has H100 at $5/h, RunPod gets it. If
 *      RunPod is empty and Lambda has capacity, Lambda gets it.
 *   3. Never waitlist on no-capacity. The allocator retries every
 *      10s; eventually somebody has supply. The buyer's request stays
 *      PENDING with a "searching for capacity" flag, not "needs
 *      admin approval."
 *
 * Each probe runs with a hard timeout (default 3s) so a slow / down
 * provider can't stall the entire allocator tick. Probes that time
 * out or throw return null (treat as "unknown — skip").
 *
 * Pricing data is currently a static per-(provider, tier) table.
 * Refining to live catalog prices is a follow-up — for v1, the
 * relative ordering of providers is more useful than absolute
 * precision, and the actual price-per-second still gets metered
 * against the buyer's totalCost via per-minute-meter regardless of
 * what the probe estimated.
 */

import type { GpuTier } from '@a2e/database'
import {
  LambdaClient,
  isLambdaConfigured,
  isLambdaAllocatorEnabled,
} from './lambda-adapter.js'
import { lambdaTypeForTier, fitsSingleLambdaInstance } from './tier-mapping.js'
import {
  RunPodClient,
  isRunPodConfigured,
  isRunPodAllocatorEnabled,
} from './runpod-adapter.js'
import { runPodTypeForTier, fitsSingleRunPodPod } from './runpod-tier-mapping.js'
import { isPhalaConfigured, isPhalaAllocatorEnabled } from './phala-adapter.js'
import { phalaTypeForTier, fitsSinglePhalaCvm } from './phala-tier-mapping.js'
import { isIoNetConfigured, isIoNetAllocatorEnabled } from './ionet-adapter.js'
import { ioNetTypeForTier, fitsSingleIoNetVm } from './ionet-tier-mapping.js'
import { isVoltageGpuConfigured } from './voltagegpu-adapter.js'
import {
  voltageGpuTypeForTier,
  fitsSingleVoltageGpuPod,
} from './voltagegpu-tier-mapping.js'
import {
  VastAiClient,
  isVastAiConfigured,
  isVastAiAllocatorEnabled,
  isVastAiHostExcluded,
} from './vastai-adapter.js'
import {
  vastAiTypeForTier,
  fitsSingleVastAiHost,
} from './vastai-tier-mapping.js'
import {
  ShadeFormClient,
  isShadeFormConfigured,
  isShadeFormAllocatorEnabled,
  shadeFormTokenForTier,
  findCheapestShadeFormType,
} from './shadeform-adapter.js'
import {
  TensorDockClient,
  isTensorDockConfigured,
  isTensorDockAllocatorEnabled,
  flattenHostNodes,
} from './tensordock-adapter.js'
import {
  HyperstackClient,
  isHyperstackConfigured,
  isHyperstackAllocatorEnabled,
  hyperstackTokenForTier,
  findCheapestHyperstackFlavor,
} from './hyperstack-adapter.js'
import {
  tensorDockTypeForTier,
  fitsSingleTensorDockHost,
  stockMatchesTier,
} from './tensordock-tier-mapping.js'

export type ProviderKey =
  | 'LAMBDA'
  | 'RUNPOD'
  | 'PHALA'
  | 'IONET'
  | 'VOLTAGEGPU'
  | 'VASTAI'
  | 'SHADEFORM'
  | 'TENSORDOCK'
  | 'HYPERSTACK'

export interface CapacityQuote {
  provider: ProviderKey
  /** Lower = cheaper. USD/hour per GPU. Static for v1; see file doc. */
  pricePerHourUsd: number
  /** true = provider reports stock, hasn't been ruled out by gating. */
  hasCapacity: boolean
  /** Human-readable explanation when hasCapacity is false. */
  reasonNoCapacity?: string
}

const PROBE_TIMEOUT_MS = parseInt(process.env.CAPACITY_PROBE_TIMEOUT_MS ?? '3000', 10)

// Per-tier baseline price guidance. Numbers are rough; precision
// improves when adapters expose live catalog pricing. Keys present
// here are the tiers we map across multiple providers; tiers omitted
// for a given provider mean "no mapping" and the probe returns
// hasCapacity=false with reasonNoCapacity='tier_unmapped'.
//
// Last calibrated 2026-06: Lambda catalog page, RunPod GraphQL
// gpuTypes lowestPrice, VoltageGPU offer list, Phala public schedule,
// io.net catalog. Re-pull when prices drift materially.
const STATIC_PRICES: Record<ProviderKey, Partial<Record<GpuTier, number>>> = {
  LAMBDA: {
    H100: 2.49,
    H200: 3.49,
    A100: 1.29,    // Lambda A100 80GB SXM4 reference rate
    B200: 5.99,
    L40S: 1.10,
  },
  RUNPOD: {
    H100: 1.99,
    H200: 3.99,
    A100: 1.69,    // RunPod A100 80GB SXM secure tier
    B200: 5.49,
    L40S: 0.99,
    RTX_4090: 0.44,
    RTX_3090: 0.34,
  },
  PHALA: {
    // GPU TEE premium; H200 small only as of 2026-06.
    H200: 4.79,
  },
  IONET: {
    H100: 1.87,
    H200: 3.29,
    A100: 1.55,    // io.net A100 80GB internal cloud
    L40S: 0.95,
    RTX_4090: 0.40,
  },
  VOLTAGEGPU: {
    // Confidential compute pricing. CC-capable SKUs only.
    H100: 2.77,
    H200: 3.99,
    B200: 5.79,
  },
  VASTAI: {
    // Peer-marketplace pricing. Consumer cards are the headline; H100 /
    // H200 / B200 secondary. Numbers from inspect-vastai-datacenter-skus
    // snapshot 2026-06-07; verified-host filter applied. These are
    // baseline static guidance only; live listOffers returns the actual
    // cheapest-verified host's dph_total which overrides at probe time.
    RTX_4090: 0.32,
    RTX_3090: 0.20,
    A100: 0.56,    // Vast.ai A100 PCIE 80GB verified, often cheapest
    L40S: 0.85,
    H100: 2.58,
    H200: 3.66,
    B200: 4.38,
  },
  SHADEFORM: {
    // Aggregator. Static prices are the cheapest-cloud reference from
    // the 2026-06-07 inspector snapshot (cents-to-dollars normalized).
    // The probe overrides with the live cheapest-available row at probe
    // time, so these are only fallback. Numbers below all beat the
    // direct adapters for the same tier, which is why Shadeform is in
    // the cascade at all.
    L40S: 0.74,    // latitude L40s_vm
    A100: 1.35,    // hyperstack A100_80G 1x
    H100: 1.66,    // latitude H100_vm 1x
    H200: 3.44,    // digitalocean H200_sxm5 1x
    B200: 6.52,    // verda B200 1x
    RTX_4090: 0.32, // consumer prices not yet observed in catalog; mirror Vast.ai
    RTX_3090: 0.20,
  },
  TENSORDOCK: {
    // Peer-to-peer datacenter+consumer marketplace. Static prices are
    // tier-mapping defaults; the probe overrides with the cheapest live
    // /stock/list match. /stock/list is unauthenticated, so this probe
    // is cheap.
    H100: 2.50,
    H200: 3.50,
    A100: 1.50,
    L40S: 1.10,
    B200: 6.00,
    RTX_4090: 0.40,
    RTX_3090: 0.30,
    CONSUMER: 0.30,
  },
  HYPERSTACK: {
    // Hyperstack (NexGen Cloud) direct. Measured via Shadeform routing
    // on 2026-06-08: A100 80G at $1.35/h, H100 PCIe at ~$2.40/h (after
    // Shadeform markup; direct is ~10-15% cheaper). Probe overrides
    // with live /core/flavors prices when reachable.
    H100: 1.95,
    H200: 3.20,
    A100: 1.35,
    L40S: 1.30,
    B200: 5.80,
  },
}

interface ProbeOptions {
  /** true = filter to TDX/CC-capable providers only. */
  preferConfidential: boolean
  /** Per-provider per-call probe timeout override. */
  timeoutMs?: number
}

/**
 * Run all enabled probes in parallel and return the providers WITH
 * capacity, sorted ascending by static price. Providers that timed
 * out, errored, or have no capacity are excluded.
 *
 * When preferConfidential=true, only Phala + VoltageGPU are probed
 * (the others don't expose Intel TDX / NVIDIA CC). When false, all
 * five are probed.
 */
export async function probeAllProviders(
  tier: GpuTier,
  gpuCount: number,
  opts: ProbeOptions,
): Promise<CapacityQuote[]> {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS

  // Build the candidate set. Confidential filter trims early so we
  // don't waste probe budget on providers we'd reject anyway.
  // VASTAI is included in the non-confidential candidate set ONLY when
  // the operator has explicitly enabled it via VASTAI_ALLOCATOR_ENABLED.
  // The probe still no-ops cheaply via isVastAiAllocatorEnabled() if
  // the flag is off, but skipping it here avoids the Vast.ai HTTP
  // round-trip entirely until rollout is approved.
  const baseCandidates: ProviderKey[] = isVastAiAllocatorEnabled()
    ? ['LAMBDA', 'RUNPOD', 'PHALA', 'IONET', 'VOLTAGEGPU', 'VASTAI']
    : ['LAMBDA', 'RUNPOD', 'PHALA', 'IONET', 'VOLTAGEGPU']
  // Shadeform is conditional on its own config + allocator gate so the
  // probe doesn't waste a slot on it when SHADEFORM_API_KEY is unset.
  if (isShadeFormConfigured() && isShadeFormAllocatorEnabled()) {
    baseCandidates.push('SHADEFORM')
  }
  // TensorDock probe is /stock/list (no auth) so we only gate on the
  // allocator switch, not on configuration. But still skip when key is
  // unset to avoid surfacing supply we can't actually rent.
  if (isTensorDockConfigured() && isTensorDockAllocatorEnabled()) {
    baseCandidates.push('TENSORDOCK')
  }
  // Hyperstack direct (NexGen Cloud). Only probed when both the API key
  // is configured and the allocator gate is on. Goes alongside
  // SHADEFORM; the cascade picks whichever is cheaper at probe time.
  if (isHyperstackConfigured() && isHyperstackAllocatorEnabled()) {
    baseCandidates.push('HYPERSTACK')
  }
  const candidates: ProviderKey[] = opts.preferConfidential
    ? ['PHALA', 'VOLTAGEGPU']
    : baseCandidates

  // Parallel kickoff. Promise.allSettled so one slow / failed probe
  // doesn't take the whole batch down.
  const settled = await Promise.allSettled(
    candidates.map((p) =>
      withTimeout(probeOne(p, tier, gpuCount), timeoutMs).catch(
        (err): CapacityQuote => ({
          provider: p,
          pricePerHourUsd: Number.POSITIVE_INFINITY,
          hasCapacity: false,
          reasonNoCapacity: err instanceof Error ? err.message : 'probe_error',
        }),
      ),
    ),
  )

  // Pull successful resolved values; treat rejections (shouldn't happen
  // since we caught above, but defensively) as no-capacity.
  const quotes: CapacityQuote[] = settled.map((s, i) => {
    if (s.status === 'fulfilled' && s.value) return s.value
    const provider = candidates[i]
    if (!provider) {
      throw new Error('probeAllProviders: candidate index out of range')
    }
    return {
      provider,
      pricePerHourUsd: Number.POSITIVE_INFINITY,
      hasCapacity: false,
      reasonNoCapacity: 'probe_rejected',
    }
  })

  return quotes
    .filter((q) => q.hasCapacity)
    .sort((a, b) => a.pricePerHourUsd - b.pricePerHourUsd)
}

/** Same as probeAllProviders but returns the full set including
 *  no-capacity rows. Used by admin dashboards / debug routes that
 *  want to surface "why didn't X get picked." */
export async function probeAllProvidersDebug(
  tier: GpuTier,
  gpuCount: number,
  opts: ProbeOptions,
): Promise<CapacityQuote[]> {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS
  // VASTAI is included in the non-confidential candidate set ONLY when
  // the operator has explicitly enabled it via VASTAI_ALLOCATOR_ENABLED.
  // The probe still no-ops cheaply via isVastAiAllocatorEnabled() if
  // the flag is off, but skipping it here avoids the Vast.ai HTTP
  // round-trip entirely until rollout is approved.
  const baseCandidates: ProviderKey[] = isVastAiAllocatorEnabled()
    ? ['LAMBDA', 'RUNPOD', 'PHALA', 'IONET', 'VOLTAGEGPU', 'VASTAI']
    : ['LAMBDA', 'RUNPOD', 'PHALA', 'IONET', 'VOLTAGEGPU']
  // Shadeform is conditional on its own config + allocator gate so the
  // probe doesn't waste a slot on it when SHADEFORM_API_KEY is unset.
  if (isShadeFormConfigured() && isShadeFormAllocatorEnabled()) {
    baseCandidates.push('SHADEFORM')
  }
  // TensorDock probe is /stock/list (no auth) so we only gate on the
  // allocator switch, not on configuration. But still skip when key is
  // unset to avoid surfacing supply we can't actually rent.
  if (isTensorDockConfigured() && isTensorDockAllocatorEnabled()) {
    baseCandidates.push('TENSORDOCK')
  }
  // Hyperstack direct (NexGen Cloud). Only probed when both the API key
  // is configured and the allocator gate is on. Goes alongside
  // SHADEFORM; the cascade picks whichever is cheaper at probe time.
  if (isHyperstackConfigured() && isHyperstackAllocatorEnabled()) {
    baseCandidates.push('HYPERSTACK')
  }
  const candidates: ProviderKey[] = opts.preferConfidential
    ? ['PHALA', 'VOLTAGEGPU']
    : baseCandidates

  const settled = await Promise.allSettled(
    candidates.map((p) =>
      withTimeout(probeOne(p, tier, gpuCount), timeoutMs).catch(
        (err): CapacityQuote => ({
          provider: p,
          pricePerHourUsd: Number.POSITIVE_INFINITY,
          hasCapacity: false,
          reasonNoCapacity: err instanceof Error ? err.message : 'probe_error',
        }),
      ),
    ),
  )

  return settled.map((s, i) => {
    if (s.status === 'fulfilled' && s.value) return s.value
    const provider = candidates[i]
    if (!provider) throw new Error('probeAllProvidersDebug: idx out of range')
    return {
      provider,
      pricePerHourUsd: Number.POSITIVE_INFINITY,
      hasCapacity: false,
      reasonNoCapacity: 'probe_rejected',
    }
  })
}

async function probeOne(
  provider: ProviderKey,
  tier: GpuTier,
  gpuCount: number,
): Promise<CapacityQuote> {
  const price = STATIC_PRICES[provider][tier]
  if (price === undefined) {
    return {
      provider,
      pricePerHourUsd: Number.POSITIVE_INFINITY,
      hasCapacity: false,
      reasonNoCapacity: 'tier_unmapped',
    }
  }

  switch (provider) {
    case 'LAMBDA':
      return probeLambda(tier, gpuCount, price)
    case 'RUNPOD':
      return probeRunPod(tier, gpuCount, price)
    case 'PHALA':
      return probePhala(tier, gpuCount, price)
    case 'IONET':
      return probeIoNet(tier, gpuCount, price)
    case 'VOLTAGEGPU':
      return probeVoltageGpu(tier, gpuCount, price)
    case 'VASTAI':
      return probeVastAi(tier, gpuCount, price)
    case 'SHADEFORM':
      return probeShadeForm(tier, gpuCount, price)
    case 'TENSORDOCK':
      return probeTensorDock(tier, gpuCount, price)
    case 'HYPERSTACK':
      return probeHyperstack(tier, gpuCount, price)
  }
}

async function probeHyperstack(
  tier: GpuTier,
  gpuCount: number,
  price: number,
): Promise<CapacityQuote> {
  if (!isHyperstackConfigured()) return noCapacity('HYPERSTACK', 'not_configured')
  if (!isHyperstackAllocatorEnabled()) return noCapacity('HYPERSTACK', 'allocator_disabled')
  if (!hyperstackTokenForTier(tier)) return noCapacity('HYPERSTACK', 'tier_unmapped')
  try {
    const client = new HyperstackClient()
    const cheapest = await findCheapestHyperstackFlavor(client, tier, gpuCount)
    if (!cheapest) return noCapacity('HYPERSTACK', 'no_supply')
    return {
      provider: 'HYPERSTACK',
      pricePerHourUsd: cheapest.pricePerHourUsd > 0 ? cheapest.pricePerHourUsd : price,
      hasCapacity: true,
    }
  } catch (err) {
    return noCapacity('HYPERSTACK', err instanceof Error ? err.message : 'probe_throw')
  }
}

async function probeTensorDock(
  tier: GpuTier,
  gpuCount: number,
  price: number,
): Promise<CapacityQuote> {
  if (!isTensorDockConfigured()) return noCapacity('TENSORDOCK', 'not_configured')
  if (!isTensorDockAllocatorEnabled()) return noCapacity('TENSORDOCK', 'allocator_disabled')
  const mapping = tensorDockTypeForTier(tier)
  if (!mapping) return noCapacity('TENSORDOCK', 'tier_unmapped')
  if (!fitsSingleTensorDockHost(tier, gpuCount)) {
    return noCapacity('TENSORDOCK', 'exceeds_per_host_max')
  }
  try {
    const client = new TensorDockClient()
    const resp = await client.listHostNodes()
    const flat = flattenHostNodes(resp)
    // Match rows whose GPU model string maps to the requested tier
    // AND whose host is online AND has at least gpuCount cards. amount
    // is the per-host pool for this model; we need a single host with
    // >= gpuCount cards installed.
    const candidates = flat.filter(
      (r) =>
        r.online
        && stockMatchesTier(r.gpu_model, tier)
        && r.amount >= gpuCount
        // Host must have at least one free external port; the
        // /client/deploy/single endpoint allocates external_ports from
        // host.networking.ports and 500s when the pool is empty. Some
        // TensorDock hosts are fully booked on ports even when GPU
        // cards show available (observed 2026-06-08 on
        // 04200c8a-... geforcertx3090).
        && r.availableExternalPorts.length > 0,
    )
    if (candidates.length === 0) {
      return noCapacity('TENSORDOCK', 'no_supply_at_count')
    }
    // Per-host price (when surfaced) overrides the static reference.
    const cheapest = candidates
      .filter((c) => typeof c.price === 'number')
      .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))[0]
    const livePrice = cheapest?.price
    return {
      provider: 'TENSORDOCK',
      pricePerHourUsd: livePrice !== undefined
        ? livePrice * gpuCount
        : mapping.approxPricePerGpuHourUsd * gpuCount,
      hasCapacity: true,
    }
  } catch (err) {
    return noCapacity('TENSORDOCK', err instanceof Error ? err.message : 'probe_throw')
  }
}

async function probeShadeForm(
  tier: GpuTier,
  gpuCount: number,
  price: number,
): Promise<CapacityQuote> {
  if (!isShadeFormConfigured()) return noCapacity('SHADEFORM', 'not_configured')
  if (!isShadeFormAllocatorEnabled()) return noCapacity('SHADEFORM', 'allocator_disabled')
  if (!shadeFormTokenForTier(tier)) return noCapacity('SHADEFORM', 'tier_unmapped')
  try {
    const client = new ShadeFormClient()
    // Live catalog query handles the cents-to-dollars conversion +
    // cloud-exclude filter inside findCheapestShadeFormType. The probe
    // just decides if the cheapest is real and surfaces it.
    const cheapest = await findCheapestShadeFormType(client, tier, gpuCount)
    if (!cheapest) return noCapacity('SHADEFORM', 'no_supply')
    return {
      provider: 'SHADEFORM',
      pricePerHourUsd: cheapest.pricePerHourUsd > 0 ? cheapest.pricePerHourUsd : price,
      hasCapacity: true,
    }
  } catch (err) {
    return noCapacity('SHADEFORM', err instanceof Error ? err.message : 'probe_throw')
  }
}

async function probeLambda(
  tier: GpuTier,
  gpuCount: number,
  price: number,
): Promise<CapacityQuote> {
  if (!isLambdaConfigured()) {
    return noCapacity('LAMBDA', 'not_configured')
  }
  if (!isLambdaAllocatorEnabled()) {
    return noCapacity('LAMBDA', 'allocator_disabled')
  }
  const mapping = lambdaTypeForTier(tier)
  if (!mapping) return noCapacity('LAMBDA', 'tier_unmapped')
  if (!fitsSingleLambdaInstance(tier, gpuCount)) {
    return noCapacity('LAMBDA', 'exceeds_per_instance_max')
  }
  try {
    const client = new LambdaClient()
    const types = await client.listInstanceTypes()
    // LambdaInstanceType exposes the API's instance type name as
    // `name`; our tier mapping calls the same value `instanceTypeName`.
    const match = types.find((t) => t.name === mapping.instanceTypeName)
    if (!match || match.regionsAvailable.length === 0) {
      return noCapacity('LAMBDA', 'no_regional_stock')
    }
    return {
      provider: 'LAMBDA',
      pricePerHourUsd: match.pricePerHourUsd ?? price,
      hasCapacity: true,
    }
  } catch (err) {
    return noCapacity('LAMBDA', err instanceof Error ? err.message : 'probe_throw')
  }
}

async function probeRunPod(
  tier: GpuTier,
  gpuCount: number,
  price: number,
): Promise<CapacityQuote> {
  if (!isRunPodConfigured()) {
    return noCapacity('RUNPOD', 'not_configured')
  }
  if (!isRunPodAllocatorEnabled()) {
    return noCapacity('RUNPOD', 'allocator_disabled')
  }
  const mapping = runPodTypeForTier(tier)
  if (!mapping) return noCapacity('RUNPOD', 'tier_unmapped')
  if (!fitsSingleRunPodPod(tier, gpuCount)) {
    return noCapacity('RUNPOD', 'exceeds_per_pod_max')
  }
  try {
    const client = new RunPodClient()
    const gpus = await client.listGpuTypes()
    // mapping.gpuTypeId is the RunPod SKU id (NOT displayName) per
    // runpod-tier-mapping.ts's contract — runpod-provision.ts also
    // matches on .id. Previous version of this probe matched on
    // displayName and silently failed for every tier.
    const match = gpus.find((g) => g.id === mapping.gpuTypeId)
    if (!match) return noCapacity('RUNPOD', 'gpu_type_missing')
    // Check the same stock signals provisioning uses, otherwise the
    // probe reports capacity that the actual createPod call rejects
    // within ms.
    if (!match.hasCurrentStock || match.lowestPricePerHourUsd === null) {
      return noCapacity('RUNPOD', 'no_current_stock')
    }
    return {
      provider: 'RUNPOD',
      pricePerHourUsd: match.lowestPricePerHourUsd ?? price,
      hasCapacity: true,
    }
  } catch (err) {
    return noCapacity('RUNPOD', err instanceof Error ? err.message : 'probe_throw')
  }
}

async function probePhala(
  tier: GpuTier,
  gpuCount: number,
  price: number,
): Promise<CapacityQuote> {
  if (!isPhalaConfigured()) {
    return noCapacity('PHALA', 'not_configured')
  }
  if (!isPhalaAllocatorEnabled()) {
    return noCapacity('PHALA', 'allocator_disabled')
  }
  const mapping = phalaTypeForTier(tier, gpuCount)
  if (!mapping) return noCapacity('PHALA', 'tier_unmapped')
  if (!fitsSinglePhalaCvm(tier, gpuCount)) {
    return noCapacity('PHALA', 'exceeds_per_cvm_max')
  }
  // Phala has no cheap REST capacity probe; rely on tier mapping being
  // populated as the readiness signal. Real availability is enforced
  // at provisioning time and a failure flows to the next provider.
  return {
    provider: 'PHALA',
    pricePerHourUsd: price,
    hasCapacity: true,
  }
}

async function probeIoNet(
  tier: GpuTier,
  gpuCount: number,
  price: number,
): Promise<CapacityQuote> {
  if (!isIoNetConfigured()) {
    return noCapacity('IONET', 'not_configured')
  }
  // Operator-level allocator gate. Mirrors VASTAI_ALLOCATOR_ENABLED:
  // even with a valid API key, the operator can exclude io.net from
  // new-rental allocation via IONET_ALLOCATOR_ENABLED=false. Default
  // true (preserves prior behavior). Useful for head-to-head provider
  // testing or temporary outage exclusion without invalidating
  // existing rentals' API auth.
  if (!isIoNetAllocatorEnabled()) {
    return noCapacity('IONET', 'allocator_disabled')
  }
  const mapping = ioNetTypeForTier(tier, gpuCount)
  if (!mapping) return noCapacity('IONET', 'tier_unmapped')
  if (!fitsSingleIoNetVm(tier, gpuCount)) {
    return noCapacity('IONET', 'exceeds_per_vm_max')
  }
  // Same trade-off as Phala for v1: configuration + mapping is the
  // signal. Live catalog probe can be added when ionet:inspect returns
  // a stable shape.
  return {
    provider: 'IONET',
    pricePerHourUsd: price,
    hasCapacity: true,
  }
}

async function probeVoltageGpu(
  tier: GpuTier,
  gpuCount: number,
  price: number,
): Promise<CapacityQuote> {
  if (!isVoltageGpuConfigured()) {
    return noCapacity('VOLTAGEGPU', 'not_configured')
  }
  const mapping = voltageGpuTypeForTier(tier, gpuCount)
  if (!mapping) return noCapacity('VOLTAGEGPU', 'tier_unmapped')
  if (!fitsSingleVoltageGpuPod(tier, gpuCount)) {
    return noCapacity('VOLTAGEGPU', 'exceeds_per_pod_max')
  }
  return {
    provider: 'VOLTAGEGPU',
    pricePerHourUsd: price,
    hasCapacity: true,
  }
}

async function probeVastAi(
  tier: GpuTier,
  gpuCount: number,
  price: number,
): Promise<CapacityQuote> {
  // Two gates: API key present AND operator explicitly enabled.
  if (!isVastAiConfigured()) return noCapacity('VASTAI', 'not_configured')
  if (!isVastAiAllocatorEnabled()) return noCapacity('VASTAI', 'allocator_disabled')
  const mapping = vastAiTypeForTier(tier, gpuCount)
  if (!mapping) return noCapacity('VASTAI', 'tier_unmapped')
  if (!fitsSingleVastAiHost(tier, gpuCount)) {
    return noCapacity('VASTAI', 'exceeds_per_host_max')
  }
  // Live catalog query. Vast.ai's /bundles/ search is fast (<200ms in
  // testing) and gives us a real "is there a verified host with this
  // SKU right now" signal — much stronger than the static-config
  // signal Phala / io.net / VoltageGPU use. The trade-off is one extra
  // HTTP round-trip per probe; well within the 3s budget.
  try {
    const client = new VastAiClient()
    const offers = await client.listOffers({
      gpu_name: { eq: mapping.gpuName },
      num_gpus: { eq: mapping.gpusPerHost },
      // Reliability filter: 0.85 keeps the legitimately churn-prone
      // hosts out while accepting most of the verified pool. Earlier
      // 0.95 cutoff was empirically too strict (live snapshot
      // 2026-06-06 showed it zeroing the entire 1x RTX 4090 pool).
      // The verified filter (set in listOffers' defaults) already
      // anchors quality at the host level; reliability is the second
      // line of defense rather than the primary gate.
      reliability2: { gte: 0.85 },
    })
    // Geo filter (client-side after the API call because Vast.ai's
    // /bundles/ geolocation query operator is finicky). Default
    // excludes CN/RU/IR/KP where Docker Hub access is unreliable.
    // Rental cmq2vq1nu000 burned 15 hours on a CN host whose layer
    // pull never completed; this filter ensures the probe never picks
    // such a host as the cheapest-with-capacity winner.
    const usableOffers = offers.filter((o) => !isVastAiHostExcluded(o.geolocation))
    if (usableOffers.length === 0) {
      return noCapacity(
        'VASTAI',
        offers.length > 0 ? 'all_offers_in_excluded_regions' : 'no_verified_offers',
      )
    }
    // listOffers sorts by dph_total ascending; the first usable offer
    // post-geo-filter is the cheapest legitimate option.
    return {
      provider: 'VASTAI',
      pricePerHourUsd: usableOffers[0]?.dphTotal ?? price,
      hasCapacity: true,
    }
  } catch (err) {
    return noCapacity('VASTAI', err instanceof Error ? err.message : 'probe_throw')
  }
}

function noCapacity(provider: ProviderKey, reason: string): CapacityQuote {
  return {
    provider,
    pricePerHourUsd: Number.POSITIVE_INFINITY,
    hasCapacity: false,
    reasonNoCapacity: reason,
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`probe_timeout_${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}
