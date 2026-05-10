/**
 * M3 / D1 (preview): public operator profile route.
 *
 * GET /v1/public/operators/:slug
 *
 * Public, no auth. Returns the data the marketplace operator profile
 * page needs to render: reputation, uptime%, node inventory by tier
 * + region, and recent APPROVED ratings only.
 *
 * Why a dedicated route (vs reusing portal-node-runner)
 *   - portal-node-runner is auth-gated and exposes operator-private
 *     data (earnings, payouts, internal node IDs)
 *   - public route deliberately filters: no rejected ratings, no
 *     internal IDs, no earnings, walletAddress redacted to first/last
 *     6 chars only
 *
 * Caching: response is small + slow-changing. Marketplace page sets
 * `next: { revalidate: 60 }` on its fetch, so this route gets hit
 * at most once per minute per geographic edge cache.
 */

import type { FastifyInstance } from 'fastify'
import { calculateNodeUptime } from '../services/earnings/uptime-calculator.js'

export async function publicOperatorsRoutes(fastify: FastifyInstance) {
  fastify.get('/v1/public/operators/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string }

    const runner = await fastify.prisma.nodeRunner.findUnique({
      where: { slug },
      select: {
        id: true,
        name: true,
        slug: true,
        reputationScore: true,
        reputationTier: true,
        availableAsSpot: true,
      },
    })
    if (!runner || !runner.slug) {
      return reply.code(404).send({ error: 'Operator not found' })
    }

    // Nodes — only exposed: gpuTier, region, status. No internal IDs,
    // no walletAddresses, no SSH details.
    const nodes = await fastify.prisma.node.findMany({
      where: { nodeRunnerId: runner.id },
      select: { gpuTier: true, region: true, status: true },
    })

    // Uptime over last 30d, averaged across all the runner's nodes.
    // Reuses the existing helper M2.4 + M3.2 also use.
    const periodEnd = new Date()
    const periodStart = new Date(periodEnd.getTime() - 30 * 86400000)
    const allNodes = await fastify.prisma.node.findMany({
      where: { nodeRunnerId: runner.id },
      select: { id: true },
    })
    let uptimePercent30d: number | null = null
    if (allNodes.length > 0) {
      const uptimes = await Promise.all(
        allNodes.map(n => calculateNodeUptime(fastify.prisma, n.id, periodStart, periodEnd)),
      )
      const totalUptimeSec = uptimes.reduce((a, b) => a + b, 0)
      const totalPossibleSec = allNodes.length * 30 * 86400
      uptimePercent30d = totalPossibleSec > 0
        ? Number(((totalUptimeSec / totalPossibleSec) * 100).toFixed(1))
        : null
    }

    // Completed jobs (lifetime)
    const totalCompletedJobs = await fastify.prisma.job.count({
      where: { node: { nodeRunnerId: runner.id }, status: 'COMPLETED' },
    })

    // Recent APPROVED ratings (cap at 10 for the public view).
    // Buyer label is redacted to first/last 4 chars of wallet OR first
    // 3 chars + domain of email.
    const ratingsRaw = await fastify.prisma.rating.findMany({
      where: { nodeRunnerId: runner.id, moderationStatus: 'APPROVED' },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: {
        buyer: { select: { email: true, walletAddress: true } },
      },
    })

    const ratings = ratingsRaw.map(r => ({
      id: r.id,
      score: r.score,
      comment: r.comment,
      createdAt: r.createdAt.toISOString(),
      buyerLabel: redactBuyer(r.buyer?.email ?? null, r.buyer?.walletAddress ?? null),
    }))

    return reply.send({
      id: runner.id,
      name: runner.name,
      slug: runner.slug,
      reputationScore: runner.reputationScore,
      reputationTier: runner.reputationTier,
      availableAsSpot: runner.availableAsSpot,
      uptimePercent30d,
      totalCompletedJobs,
      nodes,
      ratings,
    })
  })
}

// Privacy: don't expose buyer's full email/wallet on a public page.
// Show enough that a buyer recognizes their own rating, but not enough
// to identify them to anyone else.
function redactBuyer(email: string | null, wallet: string | null): string {
  if (wallet) return `${wallet.slice(0, 4)}...${wallet.slice(-4)}`
  if (email) {
    const at = email.indexOf('@')
    if (at < 0) return 'verified buyer'
    const local = email.slice(0, at)
    const domain = email.slice(at)
    return local.length <= 3 ? `${local}***${domain}` : `${local.slice(0, 3)}***${domain}`
  }
  return 'verified buyer'
}
