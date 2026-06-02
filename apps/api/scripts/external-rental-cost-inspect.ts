/**
 * T6 — ExternalRental cost / settlement inspector.
 *
 * For every CLOSED rental, show:
 *   - actual runtime (launchedAt -> terminatedAt)
 *   - estimated provider cost (runtime * providerPricePerHourUsd)
 *   - buyer's charged amount (sum of SPEND_RENTAL on the request id)
 *   - platform margin (buyer charged - provider estimate)
 *
 * Used to spot-check that LAMBDA and RUNPOD rentals are settling
 * correctly, and that the platform is collecting margin in line
 * with expectations. Doesn't write any data — pure analytics.
 *
 *   pnpm --filter @a2e/api external-rental:inspect           # last 20 closed
 *   pnpm --filter @a2e/api external-rental:inspect --provider RUNPOD
 *   pnpm --filter @a2e/api external-rental:inspect --all     # include OPEN too
 */

import { prisma } from '@a2e/database'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const providerIdx = args.indexOf('--provider')
  const providerFilter = providerIdx >= 0 ? args[providerIdx + 1] : null
  const wantAll = args.includes('--all')

  const where: Record<string, unknown> = {}
  if (providerFilter) where.provider = providerFilter
  if (!wantAll) where.status = 'CLOSED'

  const rentals = await prisma.externalRental.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 20,
  })

  if (rentals.length === 0) {
    console.log('No ExternalRental rows match the filters.')
    return
  }

  console.log(`Found ${rentals.length} ExternalRental row(s)${providerFilter ? ` (provider=${providerFilter})` : ''}:`)
  console.log()

  let totalProviderEstimate = 0
  let totalBuyerCharged = 0

  for (const r of rentals) {
    const launched = r.launchedAt
    const terminated = r.terminatedAt
    const runtimeMs = launched && terminated ? terminated.getTime() - launched.getTime() : 0
    const runtimeHours = runtimeMs / 3_600_000
    const providerEstimate = runtimeHours * r.providerPricePerHourUsd

    // Sum buyer-side debits keyed on this rental's ComputeRequest.
    const buyerDebits = await prisma.balanceTransaction.findMany({
      where: {
        referenceId: r.computeRequestId,
        type: 'SPEND_RENTAL',
      },
      select: { amountUsd: true },
    })
    // amountUsd is stored as negative on debits; flip sign for display.
    const buyerCharged = buyerDebits.reduce((sum, t) => sum + Math.abs(t.amountUsd), 0)

    totalProviderEstimate += providerEstimate
    totalBuyerCharged += buyerCharged

    console.log(`ExternalRental ${r.id}`)
    console.log(`  provider:                ${r.provider} (${r.providerInstanceType})`)
    console.log(`  region:                  ${r.providerRegion}`)
    console.log(`  status:                  ${r.status}`)
    console.log(`  launched:                ${launched?.toISOString() ?? '(not yet)'}`)
    console.log(`  terminated:              ${terminated?.toISOString() ?? '(still open)'}`)
    console.log(`  runtime:                 ${runtimeMs > 0 ? `${(runtimeMs / 60_000).toFixed(2)} min` : '(no runtime)'}`)
    console.log(`  provider price:          $${r.providerPricePerHourUsd.toFixed(2)}/h`)
    console.log(`  provider estimate:       $${providerEstimate.toFixed(4)} (runtime * price)`)
    console.log(`  buyer charged:           $${buyerCharged.toFixed(4)} (${buyerDebits.length} SPEND_RENTAL row${buyerDebits.length === 1 ? '' : 's'})`)
    const margin = buyerCharged - providerEstimate
    const marginPct = providerEstimate > 0 ? (margin / providerEstimate) * 100 : 0
    console.log(`  platform margin:         $${margin.toFixed(4)}  ${providerEstimate > 0 ? `(${marginPct.toFixed(1)}%)` : ''}`)
    if (r.lastError) console.log(`  lastError:               ${r.lastError}`)
    console.log()
  }

  console.log('---')
  console.log(`Totals across ${rentals.length} rentals:`)
  console.log(`  provider estimate sum:   $${totalProviderEstimate.toFixed(4)}`)
  console.log(`  buyer charged sum:       $${totalBuyerCharged.toFixed(4)}`)
  const totalMargin = totalBuyerCharged - totalProviderEstimate
  console.log(`  net platform margin:     $${totalMargin.toFixed(4)}`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
