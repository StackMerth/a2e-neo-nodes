/**
 * M5.8 / D3: one-time backfill for ComputeRequest.co2Grams on historical
 * rentals that finished before the meter started writing the column.
 *
 * Uses the same packages/core/carbon-estimator as the live meter, so
 * the backfill math is identical to what new rentals get. For each
 * rental we look up the region from the first allocated node when
 * available; otherwise the estimator falls back to GLOBAL_AVG
 * (intensity 400 g/kWh).
 *
 * Idempotent: only updates rows where co2Grams IS NULL and
 * minutesUsed > 0. Safe to re-run, will just no-op the second time.
 *
 * Run from the Render web shell:
 *   pnpm --filter @a2e/api tsx scripts/backfill-co2.ts
 *
 * Or after `db push` if you have not redeployed yet:
 *   cd apps/api && pnpm tsx scripts/backfill-co2.ts
 */

import { PrismaClient } from '@a2e/database'
import { estimateCo2Grams } from '@a2e/core'

async function main() {
  const prisma = new PrismaClient()

  const rentals = await prisma.computeRequest.findMany({
    where: {
      co2Grams: null,
      minutesUsed: { gt: 0 },
    },
    select: {
      id: true,
      gpuTier: true,
      gpuCount: true,
      minutesUsed: true,
      allocatedNodeIds: true,
    },
  })

  console.log(`[backfill-co2] ${rentals.length} rentals to update`)

  // Batch the region lookups: collect every node id we need in one
  // findMany, then map back per rental.
  const allNodeIds = Array.from(
    new Set(rentals.flatMap(r => r.allocatedNodeIds.slice(0, 1)).filter(Boolean)),
  )
  const nodes = await prisma.node.findMany({
    where: { id: { in: allNodeIds } },
    select: { id: true, region: true },
  })
  const regionByNodeId = new Map(nodes.map(n => [n.id, n.region]))

  let updated = 0
  let totalGrams = 0
  for (const r of rentals) {
    const firstNodeId = r.allocatedNodeIds[0]
    const region = firstNodeId ? regionByNodeId.get(firstNodeId) ?? null : null

    const co2Grams = estimateCo2Grams({
      gpuTier: r.gpuTier,
      gpuCount: r.gpuCount,
      durationMinutes: r.minutesUsed,
      region,
    })
    if (co2Grams <= 0) continue

    await prisma.computeRequest.update({
      where: { id: r.id },
      data: { co2Grams },
    })
    updated += 1
    totalGrams += co2Grams
  }

  console.log(
    `[backfill-co2] done. updated=${updated} totalGrams=${totalGrams.toFixed(2)} ` +
      `totalKg=${(totalGrams / 1000).toFixed(2)}`,
  )

  await prisma.$disconnect()
}

main().catch(err => {
  console.error('[backfill-co2] failed:', err)
  process.exit(1)
})
