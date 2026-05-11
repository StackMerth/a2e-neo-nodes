/**
 * M5.3 / D1: public operator leaderboard.
 *
 * GET /v1/public/leaderboard?tab=reputation&limit=50
 *
 * Public, no auth. Returns the top operators ranked by the requested
 * tab. The "referrers" tab is a placeholder for M5.7 (D2 referral
 * program); until that lands it returns an empty list with a clear
 * shape so the frontend tab can render its empty state without code
 * changes.
 *
 * tab=reputation  (default) -- top operators by reputationScore desc,
 *                  tiebreak by totalCompletedJobs desc
 * tab=referrers   -- M5.7 will populate this with top referral earners
 *
 * Privacy: same redaction rules as the operator profile route. No
 * walletAddresses, no internal IDs, only the operator's public slug +
 * display name.
 */

import type { FastifyInstance } from 'fastify'
import type { ReputationTier } from '@a2e/database'

interface ReputationRow {
  rank: number
  operatorSlug: string
  operatorName: string
  reputationTier: ReputationTier
  reputationScore: number
  totalCompletedJobs: number
  totalNodes: number
}

interface ReferrerRow {
  rank: number
  operatorSlug: string
  operatorName: string
  refereeCount: number
  lifetimeCommission: number
}

export async function publicLeaderboardRoutes(fastify: FastifyInstance) {
  fastify.get('/v1/public/leaderboard', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>
    const tab = (q.tab ?? 'reputation').toLowerCase()
    const limit = Math.max(1, Math.min(100, parseInt(q.limit ?? '50', 10)))

    if (tab === 'reputation') {
      const runners = await fastify.prisma.nodeRunner.findMany({
        where: {
          slug: { not: null },
          name: { not: '' },
        },
        orderBy: [
          { reputationScore: 'desc' },
        ],
        take: limit,
        select: {
          id: true,
          slug: true,
          name: true,
          reputationTier: true,
          reputationScore: true,
        },
      })

      const runnerIds = runners.map(r => r.id)

      // Count nodes per operator. Single batched query, grouped in JS to
      // avoid the typing awkwardness of `_count: { select: { nodes: true } }`
      // on a select-only NodeRunner query.
      const nodesByRunner = await fastify.prisma.node.findMany({
        where: { nodeRunnerId: { in: runnerIds } },
        select: { id: true, nodeRunnerId: true },
      })
      const nodeCountByRunner = new Map<string, number>()
      const nodeIdToRunner = new Map<string, string>()
      for (const node of nodesByRunner) {
        if (!node.nodeRunnerId) continue
        nodeCountByRunner.set(
          node.nodeRunnerId,
          (nodeCountByRunner.get(node.nodeRunnerId) ?? 0) + 1,
        )
        nodeIdToRunner.set(node.id, node.nodeRunnerId)
      }

      // Completed jobs per operator. groupBy on nodeId, then fan out to
      // the runner via nodeIdToRunner.
      const completedByNode = await fastify.prisma.job.groupBy({
        by: ['nodeId'],
        where: {
          status: 'COMPLETED',
          node: { nodeRunnerId: { in: runnerIds } },
        },
        _count: { _all: true },
      })
      const completedByRunner = new Map<string, number>()
      for (const row of completedByNode) {
        if (!row.nodeId) continue
        const runnerId = nodeIdToRunner.get(row.nodeId)
        if (!runnerId) continue
        completedByRunner.set(
          runnerId,
          (completedByRunner.get(runnerId) ?? 0) + row._count._all,
        )
      }

      const rows: ReputationRow[] = []
      for (const r of runners) {
        if (!r.slug) continue
        rows.push({
          rank: rows.length + 1,
          operatorSlug: r.slug,
          operatorName: r.name,
          reputationTier: r.reputationTier,
          reputationScore: Number(r.reputationScore.toFixed(1)),
          totalCompletedJobs: completedByRunner.get(r.id) ?? 0,
          totalNodes: nodeCountByRunner.get(r.id) ?? 0,
        })
      }

      return reply.send({
        tab: 'reputation',
        limit,
        total: rows.length,
        rows,
      })
    }

    if (tab === 'referrers') {
      // M5.7 will populate this. The shape is fixed now so the frontend
      // tab can render its empty state without code changes when the
      // referral worker starts writing rows.
      const rows: ReferrerRow[] = []
      return reply.send({
        tab: 'referrers',
        limit,
        total: 0,
        rows,
        notice: 'Referral leaderboard launches with the operator referral program (M5.7).',
      })
    }

    return reply.code(400).send({ error: `Unknown tab: ${tab}` })
  })
}
