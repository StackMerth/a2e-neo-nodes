/**
 * Diagnostic: show Vast.ai's catalog state for our mapped tiers.
 *
 * Use when probe-capacity reports VASTAI no_verified_offers and we
 * need to understand: is it a real supply gap, a too-strict
 * reliability filter, or a mapping mismatch (wrong gpu_name string)?
 *
 * For each tier we map, this script runs listOffers with progressively
 * relaxed filters and reports how many offers come back at each step.
 * The output points at the root cause:
 *
 *   - "0 at relax=none, 0 at relax=verified, 0 at relax=all"
 *       Vast.ai has no listings matching this gpu_name. Likely a
 *       tier-mapping bug (wrong string).
 *
 *   - "0 at relax=none, 50 at relax=verified, 200 at relax=all"
 *       The hosts exist but reliability filter is killing them.
 *       Lower minReliability in vastai-tier-mapping or provision.
 *
 *   - "10 at relax=none, 200 at relax=verified, 500 at relax=all"
 *       Plenty of supply — probably a transient. Try probe again.
 *
 * Render API shell:
 *   pnpm --filter @a2e/api exec tsx scripts/inspect-vastai-catalog.ts
 */

import { VastAiClient, isVastAiConfigured } from '../src/services/inbound/vastai-adapter.js'
import { vastAiTypeForTier } from '../src/services/inbound/vastai-tier-mapping.js'
import type { GpuTier } from '@a2e/database'

const TIERS_TO_CHECK: GpuTier[] = [
  'RTX_4090',
  'RTX_3090',
  'L40S',
  'H100',
]

async function main(): Promise<void> {
  if (!isVastAiConfigured()) {
    console.error('VASTAI_API_KEY not set on this shell; cannot inspect.')
    process.exit(1)
  }
  const client = new VastAiClient()

  console.log()
  console.log('Vast.ai catalog inspection — per-tier supply at three filter levels.')
  console.log('='.repeat(75))
  console.log()
  console.log(
    `${'tier'.padEnd(10)} ${'count'.padEnd(8)}`
    + `  none      verified  all       cheapest`,
  )
  console.log(
    `${'----'.padEnd(10)} ${'-----'.padEnd(8)}`
    + `  --------  --------  --------  --------`,
  )

  for (const tier of TIERS_TO_CHECK) {
    for (const count of [1, 2, 4, 8] as const) {
      const mapping = vastAiTypeForTier(tier, count)
      if (!mapping) {
        // Skip un-mapped (tier, count) combos quietly.
        continue
      }

      // Three filter levels — sequential with 2.5s sleeps between
      // calls. Vast.ai's REST API rate-limits aggressively (5 reqs
      // per ~10s window, observed 2026-06-06 with a 429 storm during
      // an earlier parallel fan-out). Sequential keeps us under it
      // while still walking the entire tier matrix in ~2 minutes.
      const prod = await client.listOffers({
        gpu_name: { eq: mapping.gpuName },
        num_gpus: { eq: mapping.gpusPerHost },
        reliability2: { gte: 0.95 },
      })
      await sleep(2500)
      const verifiedOnly = await client.listOffers({
        gpu_name: { eq: mapping.gpuName },
        num_gpus: { eq: mapping.gpusPerHost },
      })
      await sleep(2500)
      const all = await client.listOffers({
        gpu_name: { eq: mapping.gpuName },
        num_gpus: { eq: mapping.gpusPerHost },
        verified: { eq: false }, // explicitly DON'T filter to verified
      })
      await sleep(2500)

      const cheapestAll = all[0]?.dphTotal
      const cheapestStr = typeof cheapestAll === 'number'
        ? `$${cheapestAll.toFixed(3)}/h`
        : '-'

      console.log(
        `${tier.padEnd(10)} ${(`${count}x`).padEnd(8)}`
        + `  ${String(prod.length).padEnd(8)}`
        + `  ${String(verifiedOnly.length).padEnd(8)}`
        + `  ${String(all.length + verifiedOnly.length).padEnd(8)}`
        + `  ${cheapestStr}`,
      )
    }
  }

  console.log()
  console.log('Reading the columns:')
  console.log('  "none"      = our production filter (verified + reliability >= 0.95)')
  console.log('  "verified"  = only the verified flag, no reliability cutoff')
  console.log('  "all"       = no filters; total catalog size for that SKU')
  console.log('  "cheapest"  = lowest dph_total found in the no-filter set')
  console.log()
  console.log('Diagnosis hints:')
  console.log('  all=0           : tier mapping uses wrong gpu_name string — fix vastai-tier-mapping.ts')
  console.log('  all>0, none=0   : reliability filter too strict — lower minReliability in provision')
  console.log('  all>>verified   : large unverified pool; verified subset legitimately small for this SKU')
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

main().catch((err) => {
  console.error('inspect-vastai-catalog failed:', err)
  process.exit(1)
})
