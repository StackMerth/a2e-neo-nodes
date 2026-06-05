/**
 * Probe-only diagnostic for the capacity-first allocator.
 *
 * Runs probeAllProviders() for a given (tier, gpuCount) without
 * submitting an actual ComputeRequest. Useful for verifying which
 * suppliers are configured + have stock BEFORE spending real
 * balance on a rental.
 *
 * Usage on Render API shell:
 *
 *   pnpm --filter @a2e/api exec tsx scripts/probe-capacity.ts H100
 *   pnpm --filter @a2e/api exec tsx scripts/probe-capacity.ts L40S 1
 *   pnpm --filter @a2e/api exec tsx scripts/probe-capacity.ts RTX_4090 1
 *   pnpm --filter @a2e/api exec tsx scripts/probe-capacity.ts H200 1 --confidential
 *
 * Prints two sections:
 *   1. SORTED — providers WITH capacity, cheapest first. This is the
 *      order the live allocator would try them.
 *   2. DEBUG — full set including providers ruled out, with reasons
 *      (not_configured, tier_unmapped, exceeds_per_pod_max,
 *      no_regional_stock, etc.)
 */

import {
  probeAllProviders,
  probeAllProvidersDebug,
} from '../src/services/inbound/capacity-probe'
import type { GpuTier } from '@a2e/database'

const VALID_TIERS: GpuTier[] = [
  'H100',
  'H200',
  'L40S',
  'B200',
  'B300',
  'GB300',
  'OTHER',
  'CONSUMER',
  'RTX_4090',
  'RTX_3090',
]

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const tierArg = args[0]
  const countArg = args[1]
  const confidential = args.includes('--confidential')

  if (!tierArg || !VALID_TIERS.includes(tierArg as GpuTier)) {
    console.error(`Usage: probe-capacity.ts <TIER> [gpuCount] [--confidential]`)
    console.error(`Valid tiers: ${VALID_TIERS.join(', ')}`)
    process.exit(1)
  }

  const tier = tierArg as GpuTier
  const gpuCount = countArg ? parseInt(countArg, 10) : 1
  if (!Number.isFinite(gpuCount) || gpuCount < 1 || gpuCount > 8) {
    console.error(`gpuCount must be 1-8, got "${countArg}"`)
    process.exit(1)
  }

  console.log()
  console.log(`Probing ${gpuCount}x ${tier}${confidential ? ' (confidential)' : ''}`)
  console.log('='.repeat(70))
  console.log()

  // Live sort that the allocator would actually use.
  const sorted = await probeAllProviders(tier, gpuCount, {
    preferConfidential: confidential,
  })

  console.log('SORTED (allocator order — cheapest first):')
  console.log()
  if (sorted.length === 0) {
    console.log('  (none)')
    console.log('  -> request would stay PENDING with SEARCHING_CAPACITY')
    console.log('     allocator re-probes every 10s')
  } else {
    for (const q of sorted) {
      console.log(
        `  ${q.provider.padEnd(12)} $${q.pricePerHourUsd.toFixed(2)}/h/GPU` +
        `  -> $${(q.pricePerHourUsd * gpuCount * 24).toFixed(2)}/day for ${gpuCount}x`,
      )
    }
    const winner = sorted[0]
    if (winner) {
      console.log()
      console.log(`  WINNER: ${winner.provider} @ $${winner.pricePerHourUsd.toFixed(2)}/h`)
    }
  }
  console.log()

  // Full set with reasons.
  const debug = await probeAllProvidersDebug(tier, gpuCount, {
    preferConfidential: confidential,
  })

  console.log('DEBUG (all probes — why each was kept or filtered):')
  console.log()
  for (const q of debug) {
    if (q.hasCapacity) {
      console.log(
        `  ${q.provider.padEnd(12)} OK     $${q.pricePerHourUsd.toFixed(2)}/h`,
      )
    } else {
      console.log(
        `  ${q.provider.padEnd(12)} SKIP   ${q.reasonNoCapacity ?? '(unknown)'}`,
      )
    }
  }
  console.log()

  // Required env hints when nothing's available.
  if (sorted.length === 0) {
    console.log('Likely fixes:')
    if (!confidential) {
      console.log('  - LAMBDA_API_KEY        (Lambda Labs)')
      console.log('  - RUNPOD_API_KEY        (RunPod)')
    }
    console.log('  - IONET_ALLOCATOR_ENABLED=true + IONET_API_KEY    (io.net)')
    console.log('  - PHALA_ALLOCATOR_ENABLED=true + PHALA_API_KEY    (Phala, confidential)')
    console.log('  - VOLTAGEGPU_ALLOCATOR_ENABLED=true + VOLTAGEGPU_API_KEY  (confidential)')
    console.log('  - SSH_KEY_ENCRYPTION_KEY (always required for provisioning)')
    console.log()
  }
}

main()
  .catch((err) => {
    console.error('probe-capacity failed:', err)
    process.exit(1)
  })
