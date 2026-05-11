/**
 * M5.2 / D1: public listings catalog.
 *
 * GET /v1/public/listings
 *
 * Public, no auth. Returns the buyer-facing inventory: every operator's
 * idle ONLINE nodes grouped by (operator + gpuTier + region), with
 * reputation, availability count, and price for the requested pricing
 * tier (ON_DEMAND default, SPOT 40% off, RESERVED 10% off).
 *
 * Query params (all optional):
 *   gpuTier        H100 | H200 | B200 | B300 | GB300
 *   region         string match on Node.region
 *   maxRatePerHour numeric ceiling on the displayed rate
 *   tier           ON_DEMAND (default) | SPOT | RESERVED  -- shapes the price
 *   minReputation  BRONZE | SILVER | GOLD | PLATINUM
 *   limit          1..200 (default 100)
 *   offset         >=0 (default 0)
 *
 * Privacy: no walletAddresses, no internal node IDs, no operator email.
 * Each listing only carries the operator's public slug + display name,
 * which already live on the public operator profile route.
 *
 * Caching: small response, slow-changing. Marketplace page sets
 * `next: { revalidate: 60 }` on its fetch. No Redis cache in the route
 * itself for now; if we see hot traffic later we can wrap in a Redis
 * GET/SET with a 30-60s TTL.
 */

import type { FastifyInstance } from 'fastify'
import type { GpuTier, NodeStatus, ReputationTier } from '@a2e/database'

const HEARTBEAT_FRESH_MS = 2 * 60 * 1000
const SPOT_DISCOUNT_PCT = parseFloat(process.env.SPOT_DISCOUNT_PCT ?? '0.4')
const RESERVED_DISCOUNT_PCT = parseFloat(process.env.RESERVED_DISCOUNT_PCT ?? '0.1')

const REPUTATION_RANK: Record<ReputationTier, number> = {
  BRONZE: 0,
  SILVER: 1,
  GOLD: 2,
  PLATINUM: 3,
}

const VALID_GPU_TIERS = new Set<GpuTier>(['H100', 'H200', 'B200', 'B300', 'GB300', 'OTHER'])
const VALID_PRICING_TIERS = new Set(['ON_DEMAND', 'SPOT', 'RESERVED'])
const VALID_REP_TIERS = new Set<ReputationTier>(['BRONZE', 'SILVER', 'GOLD', 'PLATINUM'])

interface Listing {
  operatorSlug: string
  operatorName: string
  reputationTier: ReputationTier
  reputationScore: number
  gpuTier: GpuTier
  region: string | null
  availableCount: number
  pricingTier: 'ON_DEMAND' | 'SPOT' | 'RESERVED'
  ratePerHour: number
  ratePerMinute: number
  lastHeartbeat: string
}

export async function publicListingsRoutes(fastify: FastifyInstance) {
  fastify.get('/v1/public/listings', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>

    const gpuTierParam = q.gpuTier?.toUpperCase()
    const regionParam = q.region?.trim()
    const maxRateParam = q.maxRatePerHour ? Number(q.maxRatePerHour) : undefined
    const tierParam = (q.tier?.toUpperCase() ?? 'ON_DEMAND') as 'ON_DEMAND' | 'SPOT' | 'RESERVED'
    const minRepParam = q.minReputation?.toUpperCase() as ReputationTier | undefined
    const limit = Math.max(1, Math.min(200, parseInt(q.limit ?? '100', 10)))
    const offset = Math.max(0, parseInt(q.offset ?? '0', 10))

    if (gpuTierParam && !VALID_GPU_TIERS.has(gpuTierParam as GpuTier)) {
      return reply.code(400).send({ error: 'Invalid gpuTier' })
    }
    if (!VALID_PRICING_TIERS.has(tierParam)) {
      return reply.code(400).send({ error: 'Invalid tier (expected ON_DEMAND, SPOT, or RESERVED)' })
    }
    if (minRepParam && !VALID_REP_TIERS.has(minRepParam)) {
      return reply.code(400).send({ error: 'Invalid minReputation' })
    }
    if (maxRateParam !== undefined && (!Number.isFinite(maxRateParam) || maxRateParam < 0)) {
      return reply.code(400).send({ error: 'Invalid maxRatePerHour' })
    }

    const now = new Date()
    const heartbeatFloor = new Date(now.getTime() - HEARTBEAT_FRESH_MS)

    // Hard filter: idle, ONLINE, heartbeat fresh, has an operator,
    // optional gpuTier + region pinpoints. Reputation filter is applied
    // in JS after the join since Prisma's typed filters on enum relation
    // hops are awkward, and we need to rank-compare anyway.
    //
    // Note: we deliberately do NOT filter on `agentVersion: { not: null }`
    // here, even though the auto-allocator does. The catalog is
    // descriptive ("what inventory exists") while the allocator is
    // prescriptive ("which node can I actually deploy onto right now").
    // Seed nodes used for dogfood testing have NULL agentVersion; gating
    // them out of the catalog would make pre-launch verification harder
    // without making the listings any more honest. Real agents will set
    // agentVersion on first heartbeat, so production listings will
    // converge with what the allocator picks anyway.
    const nodes = await fastify.prisma.node.findMany({
      where: {
        status: 'ONLINE' as NodeStatus,
        currentJobId: null,
        assignedComputeRequestId: null,
        pendingDeletion: false,
        lastHeartbeat: { gte: heartbeatFloor },
        ...(gpuTierParam ? { gpuTier: gpuTierParam as GpuTier } : {}),
        ...(regionParam ? { region: regionParam } : {}),
        nodeRunner: { isNot: null },
      },
      select: {
        gpuTier: true,
        region: true,
        lastHeartbeat: true,
        customRatePerHour: true,
        nodeRunner: {
          select: {
            slug: true,
            name: true,
            reputationTier: true,
            reputationScore: true,
          },
        },
      },
    })

    // Yield floor rates keyed by gpuTier; the catalog uses these as the
    // canonical retail price for typed tiers, and Node.customRatePerHour
    // for the OTHER tier rows.
    const yieldFloors = await fastify.prisma.yieldFloor.findMany({
      select: { gpuTier: true, ratePerHour: true },
    })
    const rateByTier = new Map<GpuTier, number>()
    for (const yf of yieldFloors) rateByTier.set(yf.gpuTier, yf.ratePerHour)

    const tierMultiplier =
      tierParam === 'SPOT' ? 1 - SPOT_DISCOUNT_PCT
        : tierParam === 'RESERVED' ? 1 - RESERVED_DISCOUNT_PCT
          : 1

    // Group by (operatorSlug + gpuTier + region) so a runner with 8 idle
    // H100s in US East shows up as one card with availableCount=8, not 8
    // duplicate rows.
    const groups = new Map<string, Listing>()
    for (const n of nodes) {
      if (!n.nodeRunner?.slug || !n.nodeRunner.name) continue
      if (
        minRepParam &&
        REPUTATION_RANK[n.nodeRunner.reputationTier] < REPUTATION_RANK[minRepParam]
      ) {
        continue
      }

      const baseRate =
        n.gpuTier === 'OTHER'
          ? n.customRatePerHour ?? 0
          : rateByTier.get(n.gpuTier) ?? 0
      const ratePerHour = Number((baseRate * tierMultiplier).toFixed(4))
      if (maxRateParam !== undefined && ratePerHour > maxRateParam) continue
      if (ratePerHour <= 0) continue

      const key = `${n.nodeRunner.slug}::${n.gpuTier}::${n.region ?? ''}`
      const existing = groups.get(key)
      if (existing) {
        existing.availableCount += 1
        if (n.lastHeartbeat > new Date(existing.lastHeartbeat)) {
          existing.lastHeartbeat = n.lastHeartbeat.toISOString()
        }
        continue
      }

      groups.set(key, {
        operatorSlug: n.nodeRunner.slug,
        operatorName: n.nodeRunner.name,
        reputationTier: n.nodeRunner.reputationTier,
        reputationScore: Number(n.nodeRunner.reputationScore.toFixed(1)),
        gpuTier: n.gpuTier,
        region: n.region,
        availableCount: 1,
        pricingTier: tierParam,
        ratePerHour,
        ratePerMinute: Number((ratePerHour / 60).toFixed(5)),
        lastHeartbeat: n.lastHeartbeat.toISOString(),
      })
    }

    // Sort: cheapest first (buyer intent), then higher reputation, then
    // larger availability. Pagination after sort.
    const all = Array.from(groups.values()).sort((a, b) => {
      if (a.ratePerHour !== b.ratePerHour) return a.ratePerHour - b.ratePerHour
      const repDelta = REPUTATION_RANK[b.reputationTier] - REPUTATION_RANK[a.reputationTier]
      if (repDelta !== 0) return repDelta
      return b.availableCount - a.availableCount
    })

    const paged = all.slice(offset, offset + limit)

    return reply.send({
      total: all.length,
      limit,
      offset,
      filters: {
        gpuTier: gpuTierParam ?? null,
        region: regionParam ?? null,
        maxRatePerHour: maxRateParam ?? null,
        tier: tierParam,
        minReputation: minRepParam ?? null,
      },
      listings: paged,
    })
  })
}
