/**
 * Manual trigger for the M3 reputation scorer.
 *
 * Runs the same scoring logic the daily worker uses, but on-demand
 * instead of waiting for the next 24h tick. Useful when:
 *
 *   - You just approved a batch of ratings and want them reflected on
 *     operator profiles immediately
 *   - You're tuning the REPUTATION_* env weights and want to see the
 *     effect without redeploying and waiting a day
 *   - You're testing the M3 acceptance flow against seeded data
 *
 * Usage:
 *   pnpm --filter @a2e/api reputation:recompute
 *
 * Optional: pass a single nodeRunnerId as an argument to score just
 * that runner (faster for spot-checks).
 *   pnpm --filter @a2e/api reputation:recompute -- <nodeRunnerId>
 *
 * Output: prints the score breakdown to stdout for each runner so you
 * can audit the math without querying the DB afterwards.
 */
import { prisma } from '@a2e/database'
import { scoreOneRunner } from '../src/jobs/reputation-scorer'

async function main() {
  const target = process.argv[2]

  const runners = target
    ? await prisma.nodeRunner.findMany({ where: { id: target }, select: { id: true, name: true } })
    : await prisma.nodeRunner.findMany({ select: { id: true, name: true } })

  if (runners.length === 0) {
    console.log(target ? `No NodeRunner found with id ${target}` : 'No NodeRunners in DB')
    return
  }

  console.log(`Scoring ${runners.length} runner(s)...\n`)

  for (const runner of runners) {
    const breakdown = await scoreOneRunner(prisma, runner.id)
    await prisma.nodeRunner.update({
      where: { id: runner.id },
      data: {
        reputationScore: breakdown.score,
        reputationTier: breakdown.tier,
        lastScoreUpdate: new Date(),
      },
    })

    console.log(`${runner.name} (${runner.id})`)
    console.log(`  uptime:  ${(breakdown.uptimeFraction * 100).toFixed(1)}%  -> +${breakdown.components.uptime.toFixed(2)}`)
    console.log(`  rating:  ${breakdown.avgRating.toFixed(2)}* x ${breakdown.ratingCount}  -> +${breakdown.components.rating.toFixed(2)}`)
    console.log(`  volume:  ${breakdown.completedJobs} jobs  -> +${breakdown.components.volume.toFixed(2)}`)
    console.log(`  total:   ${breakdown.score} (${breakdown.tier})\n`)
  }
}

main()
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
