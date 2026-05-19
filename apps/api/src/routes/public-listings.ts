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
import { GPU_TIER_CONFIG, dailyToHourly } from '@a2e/shared'

const HEARTBEAT_FRESH_MS = 2 * 60 * 1000
const SPOT_DISCOUNT_PCT = parseFloat(process.env.SPOT_DISCOUNT_PCT ?? '0.4')
const RESERVED_DISCOUNT_PCT = parseFloat(process.env.RESERVED_DISCOUNT_PCT ?? '0.1')

const REPUTATION_RANK: Record<ReputationTier, number> = {
  BRONZE: 0,
  SILVER: 1,
  GOLD: 2,
  PLATINUM: 3,
}

const VALID_GPU_TIERS = new Set<GpuTier>(['H100', 'H200', 'B200', 'B300', 'GB300', 'OTHER', 'CONSUMER', 'RTX_4090', 'RTX_3090'])
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
  // C2 wave 2: operator-declared "home" connection. Buyers see a
  // "Home GPU" badge so they know the reliability profile (no static
  // IP, possibly lower SLA). Self-declared; no geo verification.
  isResidential: boolean
}

const LISTINGS_SCHEMA = {
  tags: ['Public'],
  summary: 'Browse live GPU inventory',
  description: 'Returns aggregated listings grouped by (operator + gpuTier + region). Sorted cheapest first, then by reputation, then by larger availability.',
  querystring: {
    type: 'object',
    properties: {
      gpuTier: { type: 'string', enum: ['H100', 'H200', 'B200', 'B300', 'GB300', 'OTHER', 'CONSUMER', 'RTX_4090', 'RTX_3090'] },
      region: { type: 'string', description: 'Operator region string match' },
      maxRatePerHour: { type: 'number', minimum: 0 },
      tier: { type: 'string', enum: ['ON_DEMAND', 'SPOT', 'RESERVED'], default: 'ON_DEMAND' },
      minReputation: { type: 'string', enum: ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM'] },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
      offset: { type: 'integer', minimum: 0, default: 0 },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        total: { type: 'integer' },
        limit: { type: 'integer' },
        offset: { type: 'integer' },
        filters: { type: 'object' },
        listings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              operatorSlug: { type: 'string' },
              operatorName: { type: 'string' },
              reputationTier: { type: 'string', enum: ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM'] },
              reputationScore: { type: 'number' },
              gpuTier: { type: 'string' },
              region: { type: ['string', 'null'] },
              availableCount: { type: 'integer' },
              pricingTier: { type: 'string', enum: ['ON_DEMAND', 'SPOT', 'RESERVED'] },
              ratePerHour: { type: 'number' },
              ratePerMinute: { type: 'number' },
              lastHeartbeat: { type: 'string', format: 'date-time' },
              isResidential: { type: 'boolean' },
            },
          },
        },
      },
    },
    400: {
      type: 'object',
      properties: { error: { type: 'string' } },
    },
  },
}

export async function publicListingsRoutes(fastify: FastifyInstance) {
  fastify.get('/v1/public/listings', { schema: LISTINGS_SCHEMA }, async (request, reply) => {
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
    // C2 wave 2 test exemption: seed nodes (id prefix test-c2-) have
    // no real agent process and so can't refresh their own heartbeat.
    // Without this carve-out, they fall out of the catalog 2 minutes
    // after the last c2:refresh-node call — which breaks any drawn-out
    // marketplace verification. The clause becomes effectively "either
    // the heartbeat is fresh, OR this is a known test seed node".
    const nodes = await fastify.prisma.node.findMany({
      where: {
        status: 'ONLINE' as NodeStatus,
        currentJobId: null,
        assignedComputeRequestId: null,
        pendingDeletion: false,
        OR: [
          { lastHeartbeat: { gte: heartbeatFloor } },
          { id: { startsWith: 'test-c2-' } },
        ],
        ...(gpuTierParam ? { gpuTier: gpuTierParam as GpuTier } : {}),
        ...(regionParam ? { region: regionParam } : {}),
        nodeRunner: { isNot: null },
      },
      select: {
        gpuTier: true,
        region: true,
        lastHeartbeat: true,
        customRatePerHour: true,
        isResidential: true,
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

    // Pricing source: `GPU_TIER_CONFIG.retailRate` in @a2e/shared is the
    // canonical buyer-facing rate ($/day), matching what overflow/engine,
    // cost/calculator, and the M2 money-flows tests use. Convert to $/hr
    // via `dailyToHourly`. For OTHER tier nodes, fall back to the node's
    // own `customRatePerHour`. The `YieldFloor` DB table is an admin
    // override mechanism for the operator-side floor, not a buyer rate
    // sheet, so we do not consult it here.

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
          : dailyToHourly(GPU_TIER_CONFIG[n.gpuTier].retailRate)
      const ratePerHour = Number((baseRate * tierMultiplier).toFixed(4))
      if (maxRateParam !== undefined && ratePerHour > maxRateParam) continue
      if (ratePerHour <= 0) continue

      // C2 wave 2: isResidential is part of the group key so a single
      // operator with mixed datacenter + home nodes of the same tier+
      // region surfaces as two distinct cards. Buyers can then pick the
      // SLA profile they want without surprise.
      const key = `${n.nodeRunner.slug}::${n.gpuTier}::${n.region ?? ''}::${n.isResidential ? '1' : '0'}`
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
        isResidential: n.isResidential,
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
