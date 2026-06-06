/**
 * One-shot discovery: list every distinct gpu_name string Vast.ai's
 * catalog currently surfaces, so we can update vastai-tier-mapping.ts
 * with the EXACT strings Vast.ai expects in their /bundles/ search.
 *
 * Single API call (no rate-limit risk). Pulls a sample of up to ~300
 * offers across all gpu_names, aggregates by gpu_name + counts, sorts
 * by frequency descending so the most-common SKUs appear first.
 *
 * Vast.ai's gpu_name strings have NOT been stable across their API
 * versions (sometimes 'RTX_4090', sometimes 'RTX 4090', sometimes
 * 'GeForce RTX 4090'). This script gives us ground truth without
 * guessing.
 *
 * Render API shell:
 *   pnpm --filter @a2e/api exec tsx scripts/inspect-vastai-gpu-names.ts
 */

import { VastAiClient, isVastAiConfigured } from '../src/services/inbound/vastai-adapter.js'

async function main(): Promise<void> {
  if (!isVastAiConfigured()) {
    console.error('VASTAI_API_KEY not set on this shell; cannot inspect.')
    process.exit(1)
  }
  const client = new VastAiClient()

  console.log('Pulling a sample of Vast.ai offers (no gpu_name filter)...')
  console.log()

  // No gpu_name filter. We want EVERY SKU represented in the sample
  // so we can see what naming convention Vast.ai uses today.
  // verified=true keeps the noise down (otherwise the unverified pool
  // dominates and may use slightly different naming).
  const offers = await client.listOffers({
    rentable: { eq: true },
  })

  const byName = new Map<string, { count: number; minPrice: number; numGpusSet: Set<number> }>()
  for (const o of offers) {
    const existing = byName.get(o.gpuName)
    if (existing) {
      existing.count += 1
      existing.minPrice = Math.min(existing.minPrice, o.dphTotal)
      existing.numGpusSet.add(o.numGpus)
    } else {
      byName.set(o.gpuName, {
        count: 1,
        minPrice: o.dphTotal,
        numGpusSet: new Set([o.numGpus]),
      })
    }
  }

  const sorted = Array.from(byName.entries()).sort((a, b) => b[1].count - a[1].count)

  console.log(`Found ${offers.length} offers across ${sorted.length} distinct gpu_name values.`)
  console.log()
  console.log(`${'gpu_name'.padEnd(30)} ${'count'.padEnd(6)}  ${'cheapest'.padEnd(10)}  num_gpus seen`)
  console.log(`${'--------'.padEnd(30)} ${'-----'.padEnd(6)}  ${'--------'.padEnd(10)}  -------------`)
  for (const [name, info] of sorted) {
    const gpuCounts = Array.from(info.numGpusSet).sort((a, b) => a - b).join(',')
    console.log(
      `${name.padEnd(30)} ${String(info.count).padEnd(6)}  $${info.minPrice.toFixed(3).padEnd(8)}/h  ${gpuCounts}`,
    )
  }

  console.log()
  console.log('Update vastai-tier-mapping.ts gpuName values to match the exact')
  console.log('strings above. Common SKUs to map:')
  console.log('  - Anything containing "4090"  -> RTX_4090 tier')
  console.log('  - Anything containing "3090"  -> RTX_3090 tier')
  console.log('  - Anything containing "L40S"  -> L40S tier')
  console.log('  - Anything containing "H100"  -> H100 tier (distinguish PCIe vs SXM5)')
}

main().catch((err) => {
  console.error('inspect-vastai-gpu-names failed:', err)
  process.exit(1)
})
