/**
 * M3 / C1: reputation scorer (daily worker).
 *
 * Recomputes every NodeRunner's reputationScore + reputationTier from
 * three transparent inputs:
 *
 *   1. Uptime%      over the last 30d  (weight 60)
 *   2. Avg rating   over the last 30d  (weight 25, only APPROVED ratings)
 *   3. Completed-job count             (weight 15, log-scaled to 100)
 *
 * Each input is normalized to [0,1] then weighted; final score is in
 * [0,100]. Tier mapping:
 *
 *   PLATINUM >= 90
 *   GOLD     >= 80
 *   SILVER   >= 60
 *   BRONZE   <  60
 *
 * Why this formula:
 *   - Uptime is the dominant signal because it's the operator's primary
 *     promise (your GPU is reachable when buyers want it).
 *   - Ratings are second because they capture buyer experience that
 *     uptime can't (was the host responsive, did the GPU actually work
 *     well, etc.).
 *   - Job count is third and log-scaled so a brand-new operator with
 *     5 perfect rentals isn't dwarfed by a long-tenured operator with
 *     1000 rentals — but volume still counts as a tiebreak.
 *
 * All weights and tier thresholds are env-tunable so the operator can
 * dial the curve without redeploying. See the constants below.
 *
 * Cadence: daily (24h). Reputation is a slow-moving signal; a tighter
 * cadence would just churn DB writes for the same outcome.
 *
 * Manual trigger: `pnpm --filter @a2e/api reputation:recompute` (added
 * to package.json scripts so the operator can re-run after a buyer
 * completes a marquee rental).
 */

import { Queue, Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { PrismaClient, ReputationTier } from '@a2e/database'
import { calculateNodeUptime } from '../services/earnings/uptime-calculator.js'

const QUEUE_NAME = 'reputation-scorer'
const TICK_INTERVAL_MS = parseInt(process.env.REPUTATION_TICK_MS ?? `${24 * 60 * 60 * 1000}`, 10)

// Weighting (sums to 100). Override via env if you want to dial.
const W_UPTIME = parseFloat(process.env.REPUTATION_W_UPTIME ?? '60')
const W_RATING = parseFloat(process.env.REPUTATION_W_RATING ?? '25')
const W_VOLUME = parseFloat(process.env.REPUTATION_W_VOLUME ?? '15')

// Volume normalization knee point. log10(jobs+1) / log10(VOLUME_KNEE+1)
// → 1.0 when jobs == VOLUME_KNEE. Default 100 means "100 completed jobs
// gets full credit on the volume axis."
const VOLUME_KNEE = parseFloat(process.env.REPUTATION_VOLUME_KNEE ?? '100')

// Tier thresholds. score >= threshold maps to that tier or higher.
const TIER_PLATINUM = parseFloat(process.env.REPUTATION_TIER_PLATINUM ?? '90')
const TIER_GOLD     = parseFloat(process.env.REPUTATION_TIER_GOLD     ?? '80')
const TIER_SILVER   = parseFloat(process.env.REPUTATION_TIER_SILVER   ?? '60')

// Window for uptime + rating averaging. 30d matches "what have you
// done for me lately" — long-stale signals shouldn't dominate.
const SCORE_WINDOW_DAYS = parseInt(process.env.REPUTATION_WINDOW_DAYS ?? '30', 10)

interface ScorerDeps {
  redis: ConnectionOptions
  prisma: PrismaClient
}

export function createReputationScorerQueue(connection: ConnectionOptions): Queue {
  return new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 30 },
      removeOnFail: { count: 100 },
    },
  })
}

export function createReputationScorerWorker(deps: ScorerDeps): Worker {
  return new Worker(
    QUEUE_NAME,
    async () => {
      await runReputationScorerTick(deps.prisma)
    },
    {
      connection: deps.redis,
      concurrency: 1,
    },
  )
}

export async function scheduleReputationScorer(queue: Queue): Promise<void> {
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key)
  }
  await queue.add('tick', {}, { repeat: { every: TICK_INTERVAL_MS } })
}

// ---------------------------------------------------------------------------
// Core scoring logic — exported for tests + manual trigger
// ---------------------------------------------------------------------------

export interface ScoreBreakdown {
  nodeRunnerId: string
  uptimeFraction: number     // 0-1
  avgRating: number          // 0-5 (raw stars; 0 if no ratings)
  ratingCount: number
  completedJobs: number
  components: {
    uptime: number           // weighted contribution
    rating: number
    volume: number
  }
  score: number              // 0-100
  tier: ReputationTier
}

export function tierForScore(score: number): ReputationTier {
  if (score >= TIER_PLATINUM) return 'PLATINUM'
  if (score >= TIER_GOLD)     return 'GOLD'
  if (score >= TIER_SILVER)   return 'SILVER'
  return 'BRONZE'
}

export async function scoreOneRunner(
  prisma: PrismaClient,
  nodeRunnerId: string,
  windowDays: number = SCORE_WINDOW_DAYS,
): Promise<ScoreBreakdown> {
  const periodEnd = new Date()
  const periodStart = new Date(periodEnd.getTime() - windowDays * 86400000)
  const windowSeconds = windowDays * 86400

  // 1. Uptime: average across all of this runner's nodes.
  const nodes = await prisma.node.findMany({
    where: { nodeRunnerId },
    select: { id: true },
  })
  let uptimeFraction = 0
  if (nodes.length > 0) {
    const uptimes = await Promise.all(
      nodes.map(n => calculateNodeUptime(prisma, n.id, periodStart, periodEnd)),
    )
    const totalUptimeSec = uptimes.reduce((a, b) => a + b, 0)
    const totalPossibleSec = nodes.length * windowSeconds
    uptimeFraction = totalPossibleSec > 0 ? totalUptimeSec / totalPossibleSec : 0
  }

  // 2. Average APPROVED rating in the window.
  const ratingAgg = await prisma.rating.aggregate({
    where: {
      nodeRunnerId,
      moderationStatus: 'APPROVED',
      createdAt: { gte: periodStart },
    },
    _avg: { score: true },
    _count: { score: true },
  })
  const avgRating = ratingAgg._avg.score ?? 0
  const ratingCount = ratingAgg._count.score

  // 3. Completed-job count (lifetime, not windowed — volume is volume).
  // We count ComputeRequests in COMPLETED status that ran on a node owned
  // by this runner. Cheapest approximation: count Job rows linked to
  // this runner's nodes with status COMPLETED.
  const completedJobs = await prisma.job.count({
    where: {
      node: { nodeRunnerId },
      status: 'COMPLETED',
    },
  })

  // Normalize each axis to [0,1]
  const uptimeNorm = clamp01(uptimeFraction)
  const ratingNorm = clamp01(avgRating / 5)
  const volumeNorm = clamp01(
    Math.log10(completedJobs + 1) / Math.log10(VOLUME_KNEE + 1),
  )

  const componentUptime = W_UPTIME * uptimeNorm
  const componentRating = W_RATING * ratingNorm
  const componentVolume = W_VOLUME * volumeNorm
  const score = Number((componentUptime + componentRating + componentVolume).toFixed(2))

  return {
    nodeRunnerId,
    uptimeFraction,
    avgRating,
    ratingCount,
    completedJobs,
    components: {
      uptime: Number(componentUptime.toFixed(2)),
      rating: Number(componentRating.toFixed(2)),
      volume: Number(componentVolume.toFixed(2)),
    },
    score,
    tier: tierForScore(score),
  }
}

export async function runReputationScorerTick(prisma: PrismaClient): Promise<void> {
  const runners = await prisma.nodeRunner.findMany({ select: { id: true } })

  for (const runner of runners) {
    try {
      const breakdown = await scoreOneRunner(prisma, runner.id)
      await prisma.nodeRunner.update({
        where: { id: runner.id },
        data: {
          reputationScore: breakdown.score,
          reputationTier: breakdown.tier,
          lastScoreUpdate: new Date(),
        },
      })
      // eslint-disable-next-line no-console
      console.log(
        `[reputation-scorer] ${runner.id}: score=${breakdown.score} tier=${breakdown.tier} ` +
          `(uptime=${(breakdown.uptimeFraction * 100).toFixed(1)}% ` +
          `rating=${breakdown.avgRating.toFixed(2)}*${breakdown.ratingCount} ` +
          `jobs=${breakdown.completedJobs})`,
      )
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[reputation-scorer] failed for ${runner.id}:`, err)
    }
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}
