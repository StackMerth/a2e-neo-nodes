/**
 * Discover the gpu_name strings Vast.ai uses for DATACENTER-class cards
 * (>=70GB VRAM). The general inspect-vastai-gpu-names script samples
 * the cheapest 64 offers, which biases toward consumer cards and
 * misses H100 / H200 / A100 80GB entirely (they cost $1-3/h and get
 * sorted out of the top-64).
 *
 * This script filters at the API layer to gpu_total_ram >= 70000 MB
 * before listing, so we see ONLY datacenter SKUs and their canonical
 * gpu_name strings.
 *
 * Use this whenever inspect-vastai-catalog reports all=0 for a
 * datacenter tier (RTX_4090 / 3090 won't hit this; only H100+ tiers).
 *
 * Render API shell:
 *   pnpm --filter @a2e/api exec tsx scripts/inspect-vastai-datacenter-skus.ts
 */

import { VastAiClient } from '../src/services/inbound/vastai-adapter.js'

interface AggregateEntry {
  count: number
  cheapest: number
  numGpusSeen: Set<number>
}

async function main(): Promise<void> {
  const client = new VastAiClient()

  // gpu_total_ram filter is in MB on Vast.ai's API. 70000 MB = 70 GB
  // excludes consumer (24 GB), keeps A100 40 GB if it exists, plus all
  // 80 GB+ datacenter cards (A100 80GB, H100 80GB, H100 NVL 94GB,
  // H200 141GB, B200 192GB).
  const minGpuRamMb = 70000

  console.log()
  console.log(`Querying Vast.ai for verified offers with gpu_total_ram >= ${minGpuRamMb} MB...`)
  console.log('(Excludes RTX 4090 / 3090 / consumer cards; only datacenter SKUs.)')
  console.log()

  const offers = await client.listOffers({
    gpu_total_ram: { gte: minGpuRamMb },
  })

  console.log(`Found ${offers.length} datacenter offers across the catalog.`)
  console.log()

  if (offers.length === 0) {
    console.log('Vast.ai currently has ZERO verified datacenter-class offers.')
    console.log('This means H100 / H200 / A100 80GB supply is genuinely thin')
    console.log('on Vast.ai right now. Real supply gap, not a SKU mapping bug.')
    console.log()
    return
  }

  const aggregated = new Map<string, AggregateEntry>()
  for (const offer of offers) {
    if (!aggregated.has(offer.gpuName)) {
      aggregated.set(offer.gpuName, {
        count: 0,
        cheapest: Number.POSITIVE_INFINITY,
        numGpusSeen: new Set(),
      })
    }
    const entry = aggregated.get(offer.gpuName)!
    entry.count += 1
    entry.cheapest = Math.min(entry.cheapest, offer.dphTotal)
    entry.numGpusSeen.add(offer.numGpus)
  }

  const sorted = Array.from(aggregated.entries()).sort(
    ([, a], [, b]) => b.count - a.count,
  )

  console.log(`${'gpu_name'.padEnd(28)} count   cheapest      num_gpus seen`)
  console.log(`${'--------'.padEnd(28)} -----   ----------    -------------`)
  for (const [name, entry] of sorted) {
    const counts = Array.from(entry.numGpusSeen).sort((a, b) => a - b).join(',')
    console.log(
      `${name.padEnd(28)} ${String(entry.count).padEnd(6)}  $${entry.cheapest.toFixed(3)}/h     ${counts}`,
    )
  }

  console.log()
  console.log('To update vastai-tier-mapping.ts:')
  console.log('  - Anything containing "H100"   -> H100 tier')
  console.log('  - Anything containing "H200"   -> H200 tier (if mapped)')
  console.log('  - Anything containing "A100"   -> A100 tier (if mapped)')
  console.log('Use the EXACT string above; Vast.ai\'s `eq` operator is exact-match.')
}

main().catch((err) => {
  console.error('inspect-vastai-datacenter-skus failed:', err)
  process.exit(1)
})
