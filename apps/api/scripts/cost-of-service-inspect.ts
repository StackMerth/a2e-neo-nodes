/**
 * Track 5 / M0.1 — cost-of-service inspector.
 *
 * Test helper. Two modes:
 *
 *   pnpm --filter @a2e/api cost:inspect
 *     -> list every seeded GpuCostBaseline + the GLOBAL PowerRate, and
 *        show the resolved $/hour for each SKU.
 *
 *   pnpm --filter @a2e/api cost:inspect <nodeId> <durationSeconds>
 *     -> compute the cost-of-service for a real node id over the given
 *        duration. Useful for manually verifying the M0.3 / M0.4
 *        retrofits before flipping REVENUE_SPLIT_ENABLED.
 *
 * Example:
 *   pnpm --filter @a2e/api cost:inspect cmh3xy7g80000aabbccddee 3600
 *     -> "Node cmh3... over 3600s costs $1.574 (H100_80GB / GLOBAL)"
 */
import { prisma } from '@a2e/database'
import { computeCostOfService } from '../src/services/revenue/cost-of-service.js'

async function main(): Promise<void> {
  const [nodeId, durationStr] = process.argv.slice(2)

  if (nodeId && durationStr) {
    const durationSeconds = parseFloat(durationStr)
    if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
      throw new Error(`invalid duration: ${durationStr}`)
    }
    const result = await computeCostOfService(prisma, {
      nodeId,
      durationSeconds,
    })
    console.log(`Node ${nodeId}`)
    console.log(`  SKU resolved:   ${result.gpuSku}`)
    console.log(`  Region:         ${result.region}`)
    console.log(`  Electricity/h:  $${result.electricityHourly.toFixed(4)}`)
    console.log(`  HW amort/h:     $${result.hardwareAmortHourly.toFixed(4)}`)
    console.log(`  Bandwidth/h:    $${result.bandwidthCostHourly.toFixed(4)}`)
    console.log(`  Overhead/h:     $${result.overheadHourly.toFixed(4)}`)
    console.log(`  TOTAL/h:        $${result.totalHourly.toFixed(4)}`)
    console.log(`  Duration:       ${durationSeconds}s (${(durationSeconds / 3600).toFixed(4)}h)`)
    console.log(`  Cost USD:       $${result.totalUsd.toFixed(4)}`)
    return
  }

  const baselines = await prisma.gpuCostBaseline.findMany({
    orderBy: { totalCostHourlyGlobal: 'desc' },
  })
  const rates = await prisma.powerRate.findMany({
    orderBy: { region: 'asc' },
  })

  console.log(`Power rates (${rates.length}):`)
  for (const r of rates) {
    console.log(`  ${r.region.padEnd(10)} $${r.usdPerKwh.toFixed(4)}/kWh${r.isActive ? '' : '  [inactive]'}`)
  }
  console.log()
  console.log(`GPU cost baselines (${baselines.length}):`)
  console.log(`  ${'SKU'.padEnd(28)} ${'family'.padEnd(11)} ${'kWh'.padEnd(6)} ${'amort'.padEnd(7)} ${'bw'.padEnd(6)} ${'ovh'.padEnd(6)} ${'TOTAL @ GLOBAL'}`)
  for (const b of baselines) {
    console.log(
      `  ${b.gpuSku.padEnd(28)} ${b.gpuFamily.padEnd(11)} ${b.kwhDraw.toFixed(2).padEnd(6)} $${b.hardwareAmortHourly.toFixed(3).padEnd(6)} $${b.bandwidthCostHourly.toFixed(2).padEnd(5)} $${b.overheadHourly.toFixed(2).padEnd(5)} $${b.totalCostHourlyGlobal.toFixed(3)}/h${b.isActive ? '' : '  [inactive]'}`,
    )
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
