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
} from './lambda-adapter.js'
import { lambdaTypeForTier, fitsSingleLambdaInstance } from './tier-mapping.js'
import {
  RunPodClient,
  isRunPodConfigured,
} from './runpod-adapter.js'
import { runPodTypeForTier, fitsSingleRunPodPod } from './runpod-tier-mapping.js'
import { isPhalaConfigured } from './phala-adapter.js'
import { phalaTypeForTier, fitsSinglePhalaCvm } from './phala-tier-mapping.js'
import { isIoNetConfigured } from './ionet-adapter.js'
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
} from './vastai-adapter.js'
import {
  vastAiTypeForTier,
  fitsSingleVastAiHost,
} from './vastai-tier-mapping.js'

export type ProviderKey =
  | 'LAMBDA'
  | 'RUNPOD'
  | 'PHALA'
  | 'IONET'
  | 'VOLTAGEGPU'
  | 'VASTAI'

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
    B200: 5.99,
    L40S: 1.10,
  },
  RUNPOD: {
    H100: 1.99,
    H200: 3.99,
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
    // Peer-marketplace pricing — consumer cards are the headline; H100
    // and L40S are secondary. Numbers from console.vast.ai live catalog
    // snapshot 2026-06; verified-host filter applied. These are
    // baseline static guidance — the live listOffers call returns the
    // actual cheapest-verified host's dph_total which overrides.
    RTX_4090: 0.32,
    RTX_3090: 0.20,
    L40S: 0.85,
    H100: 1.79,
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
  const candidates: ProviderKey[] = opts.preferConfidential
    ? ['PHALA', 'VOLTAGEGPU']
    : isVastAiAllocatorEnabled()
      ? ['LAMBDA', 'RUNPOD', 'PHALA', 'IONET', 'VOLTAGEGPU', 'VASTAI']
      : ['LAMBDA', 'RUNPOD', 'PHALA', 'IONET', 'VOLTAGEGPU']

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
  const candidates: ProviderKey[] = opts.preferConfidential
    ? ['PHALA', 'VOLTAGEGPU']
    : isVastAiAllocatorEnabled()
      ? ['LAMBDA', 'RUNPOD', 'PHALA', 'IONET', 'VOLTAGEGPU', 'VASTAI']
      : ['LAMBDA', 'RUNPOD', 'PHALA', 'IONET', 'VOLTAGEGPU']

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
      // 0.95 cutoff was empirically too strict — live snapshot
      // 2026-06-06 showed it zeroing the entire 1x RTX 4090 pool.
      // The verified filter (set in listOffers' defaults) already
      // anchors quality at the host level; reliability is the second
      // line of defense rather than the primary gate.
      reliability2: { gte: 0.85 },
    })
    if (offers.length === 0) {
      return noCapacity('VASTAI', 'no_verified_offers')
    }
    // listOffers sorts by dph_total ascending so offers[0] is cheapest.
    return {
      provider: 'VASTAI',
      pricePerHourUsd: offers[0]?.dphTotal ?? price,
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
