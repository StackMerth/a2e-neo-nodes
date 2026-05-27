/**
 * Test helper — bump a node-runner's reputationScore + tier so their
 * nodes win allocator tiebreaks during testing. The compute-allocator
 * sort chain ranks by reputation BEFORE price, so without this, any
 * seed operator with a non-trivial reputation (e.g. seed-noderunner-1
 * sits at 24.15) will beat a freshly-created test operator (default 0
 * or 10) regardless of how cheap their nodes are priced.
 *
 * Usage (Render API service Shell):
 *
 *   cd /opt/render/project/src
 *
 *   # Bump every node-runner whose owning user has the given email
 *   pnpm --filter @a2e/api noderunner:bump-reputation -- asad@m.com
 *
 *   # Or pick by node-runner id directly
 *   pnpm --filter @a2e/api noderunner:bump-reputation -- cmp1xs0ai0001m69ovimus5gh
 *
 *   # Choose a score (default 95 → PLATINUM-equivalent for tiebreak)
 *   pnpm --filter @a2e/api noderunner:bump-reputation -- asad@m.com --score 99
 *
 * Idempotent. Touches only reputationScore + reputationTier.
 */

import { PrismaClient, type ReputationTier } from '@a2e/database'

const prisma = new PrismaClient()

function tierForScore(score: number): ReputationTier {
  if (score >= 90) return 'PLATINUM'
  if (score >= 75) return 'GOLD'
  if (score >= 60) return 'SILVER'
  return 'BRONZE'
}

async function main() {
  const args = process.argv.slice(2).filter(a => a !== '--')
  const scoreIdx = args.indexOf('--score')
  const score = scoreIdx >= 0 ? parseFloat(args[scoreIdx + 1] ?? '95') : 95
  // Bug fix: when --score is absent, scoreIdx is -1 and (scoreIdx + 1)
  // is 0 — which then accidentally excluded args[0] as "the score
  // value". Only treat scoreIdx + 1 as a value slot when --score was
  // actually passed.
  const target = args.find((a, i) =>
    !a.startsWith('--') && (scoreIdx < 0 || i !== scoreIdx + 1),
  )

  if (!target) {
    console.error('Usage:')
    console.error('  pnpm --filter @a2e/api noderunner:bump-reputation -- <email-or-noderunnerId> [--score N]')
    process.exit(1)
  }

  if (!Number.isFinite(score) || score < 0 || score > 100) {
    console.error(`Invalid --score "${score}". Must be 0-100.`)
    process.exit(1)
  }

  const tier = tierForScore(score)

  const looksLikeEmail = target.includes('@')
  const whereClause = looksLikeEmail
    ? { user: { email: target } }
    : { id: target }

  const before = await prisma.nodeRunner.findMany({
    where: whereClause,
    select: { id: true, reputationScore: true, reputationTier: true, user: { select: { email: true } } },
  })

  if (before.length === 0) {
    console.log(`No node-runner found matching "${target}".`)
    return
  }

  console.log(`Bumping ${before.length} node-runner(s) → score=${score}, tier=${tier}`)
  for (const nr of before) {
    console.log(`  ${nr.id}  (${nr.user.email})  before: tier=${nr.reputationTier} score=${nr.reputationScore}`)
  }

  await prisma.nodeRunner.updateMany({
    where: whereClause,
    data: { reputationScore: score, reputationTier: tier },
  })

  console.log('')
  console.log(`✅ Updated. Next allocator tick will use the new reputation.`)
  console.log('NOTE: the nightly reputation-recompute job will overwrite this back to whatever')
  console.log('      the formula produces. Use just for testing then let it normalize.')
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
