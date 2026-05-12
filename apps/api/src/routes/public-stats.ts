/**
 * M5.10: public Explorer-style network stats + scrapeable inventory feeds.
 *
 * GET /v1/public/stats
 *   Real-time network snapshot. Honest aggregations of what the DB
 *   says right now: nodes online by tier, distinct operators, lifetime
 *   compute minutes served, lifetime CO2 emitted, regional spread.
 *
 * GET /v1/public/listings.json
 *   Same shape as /v1/public/listings, served as application/json with
 *   an explicit filename Content-Disposition so devs can wget/curl it
 *   into a file directly.
 *
 * GET /v1/public/listings.csv
 *   Same data, flattened to CSV. One row per (operator, gpuTier, region)
 *   listing. Comma-quoted to be Excel-safe.
 *
 * Caching: stats are slow-moving, so we set Cache-Control with a 30s
 * max-age and stale-while-revalidate so Vercel/edge caches can serve
 * hot. The listings feeds use 60s to match the catalog page.
 *
 * Privacy: same redaction as the catalog. No walletAddresses, no
 * internal node IDs, only operator slugs + display names.
 */

import type { FastifyInstance } from 'fastify'
import type { GpuTier, NodeStatus } from '@a2e/database'
import { GPU_TIER_CONFIG, dailyToHourly } from '@a2e/shared'

const HEARTBEAT_FRESH_MS = 2 * 60 * 1000

const STATS_SCHEMA = {
  tags: ['Public'],
  summary: 'Network-wide stats snapshot',
  description: 'Honest live aggregations of nodes online, operators, lifetime usage, and regional spread. Cached 30 seconds at the edge.',
  response: {
    200: { type: 'object' },
  },
}

const LISTINGS_FEED_SCHEMA_JSON = {
  tags: ['Public'],
  summary: 'Inventory feed (JSON)',
  description: 'Full current catalog as a single JSON document, served with a Content-Disposition filename so curl/wget grab a file directly.',
  response: { 200: { type: 'object' } },
}

const LISTINGS_FEED_SCHEMA_CSV = {
  tags: ['Public'],
  summary: 'Inventory feed (CSV)',
  description: 'Full current catalog as comma-separated values. One row per (operator, gpuTier, region) aggregation.',
}

export async function publicStatsRoutes(fastify: FastifyInstance) {
  fastify.get('/v1/public/stats', { schema: STATS_SCHEMA }, async (request, reply) => {
    const now = new Date()
    const heartbeatFloor = new Date(now.getTime() - HEARTBEAT_FRESH_MS)

    // Online nodes by tier (idle + busy both count; the stats page is
    // about network capacity, not bookable inventory)
    const onlineByTier = await fastify.prisma.node.groupBy({
      by: ['gpuTier'],
      where: {
        status: 'ONLINE' as NodeStatus,
        lastHeartbeat: { gte: heartbeatFloor },
        nodeRunner: { isNot: null },
      },
      _count: { _all: true },
    })

    // Region distribution among online nodes
    const regionRows = await fastify.prisma.node.groupBy({
      by: ['region'],
      where: {
        status: 'ONLINE' as NodeStatus,
        lastHeartbeat: { gte: heartbeatFloor },
        nodeRunner: { isNot: null },
      },
      _count: { _all: true },
    })

    // Operator count (distinct, only counting those with at least one
    // node currently online)
    const onlineRunners = await fastify.prisma.node.findMany({
      where: {
        status: 'ONLINE' as NodeStatus,
        lastHeartbeat: { gte: heartbeatFloor },
        nodeRunner: { isNot: null },
      },
      select: { nodeRunnerId: true },
      distinct: ['nodeRunnerId'],
    })

    // Lifetime rentals + compute minutes + CO2 (across ACTIVE + COMPLETED)
    const lifetime = await fastify.prisma.computeRequest.aggregate({
      where: { status: { in: ['ACTIVE', 'COMPLETED'] } },
      _count: { _all: true },
      _sum: { minutesUsed: true, co2Grams: true },
    })

    // Cheapest retail ($/hr) per tier from GPU_TIER_CONFIG. The catalog
    // route uses this same source, so the numbers line up.
    const topPricesByTier: Array<{ gpuTier: GpuTier; ratePerHour: number; ratePerMinute: number }> = []
    for (const tier of ['H100', 'H200', 'B200', 'B300', 'GB300'] as GpuTier[]) {
      const ratePerHour = Number(dailyToHourly(GPU_TIER_CONFIG[tier].retailRate).toFixed(4))
      topPricesByTier.push({
        gpuTier: tier,
        ratePerHour,
        ratePerMinute: Number((ratePerHour / 60).toFixed(5)),
      })
    }

    reply.header('Cache-Control', 'public, max-age=30, stale-while-revalidate=60')
    return reply.send({
      timestamp: now.toISOString(),
      totalNodesOnline: onlineByTier.reduce((s, r) => s + r._count._all, 0),
      totalOperatorsOnline: onlineRunners.length,
      totalRentalsLifetime: lifetime._count._all,
      totalComputeMinutesLifetime: lifetime._sum.minutesUsed ?? 0,
      totalCo2GramsLifetime: Number((lifetime._sum.co2Grams ?? 0).toFixed(2)),
      nodesByTier: onlineByTier.map(r => ({ gpuTier: r.gpuTier, count: r._count._all })),
      regionDistribution: regionRows.map(r => ({ region: r.region ?? 'UNSPECIFIED', count: r._count._all })),
      topPricesByTier,
    })
  })

  fastify.get('/v1/public/listings.json', { schema: LISTINGS_FEED_SCHEMA_JSON }, async (request, reply) => {
    const listings = await fetchListingsFeed(fastify)
    reply.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=120')
    reply.header('Content-Disposition', 'attachment; filename="a2e-listings.json"')
    return reply.send({ generatedAt: new Date().toISOString(), count: listings.length, listings })
  })

  fastify.get('/v1/public/listings.csv', { schema: LISTINGS_FEED_SCHEMA_CSV }, async (request, reply) => {
    const listings = await fetchListingsFeed(fastify)
    const lines = [
      'operatorSlug,operatorName,reputationTier,reputationScore,gpuTier,region,availableCount,ratePerHourUsd,ratePerMinuteUsd,lastHeartbeat',
      ...listings.map(l => [
        l.operatorSlug,
        csvField(l.operatorName),
        l.reputationTier,
        l.reputationScore.toFixed(1),
        l.gpuTier,
        csvField(l.region ?? ''),
        String(l.availableCount),
        l.ratePerHour.toFixed(4),
        l.ratePerMinute.toFixed(5),
        l.lastHeartbeat,
      ].join(',')),
    ]
    reply.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=120')
    reply.header('Content-Type', 'text/csv; charset=utf-8')
    reply.header('Content-Disposition', 'attachment; filename="a2e-listings.csv"')
    return reply.send(lines.join('\n'))
  })
}

// CSV field escaping: wrap in double quotes if the value contains a
// comma, quote, or newline, and double up any embedded quotes.
function csvField(s: string): string {
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

interface ListingRow {
  operatorSlug: string
  operatorName: string
  reputationTier: 'BRONZE' | 'SILVER' | 'GOLD' | 'PLATINUM'
  reputationScore: number
  gpuTier: GpuTier
  region: string | null
  availableCount: number
  ratePerHour: number
  ratePerMinute: number
  lastHeartbeat: string
}

async function fetchListingsFeed(fastify: FastifyInstance): Promise<ListingRow[]> {
  const now = new Date()
  const heartbeatFloor = new Date(now.getTime() - HEARTBEAT_FRESH_MS)

  const nodes = await fastify.prisma.node.findMany({
    where: {
      status: 'ONLINE' as NodeStatus,
      currentJobId: null,
      assignedComputeRequestId: null,
      pendingDeletion: false,
      lastHeartbeat: { gte: heartbeatFloor },
      nodeRunner: { isNot: null },
    },
    select: {
      gpuTier: true,
      region: true,
      lastHeartbeat: true,
      customRatePerHour: true,
      nodeRunner: {
        select: { slug: true, name: true, reputationTier: true, reputationScore: true },
      },
    },
  })

  const groups = new Map<string, ListingRow>()
  for (const n of nodes) {
    if (!n.nodeRunner?.slug || !n.nodeRunner.name) continue
    const baseRate = n.gpuTier === 'OTHER'
      ? n.customRatePerHour ?? 0
      : dailyToHourly(GPU_TIER_CONFIG[n.gpuTier].retailRate)
    const ratePerHour = Number(baseRate.toFixed(4))
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
      ratePerHour,
      ratePerMinute: Number((ratePerHour / 60).toFixed(5)),
      lastHeartbeat: n.lastHeartbeat.toISOString(),
    })
  }

  return Array.from(groups.values()).sort((a, b) => a.ratePerHour - b.ratePerHour)
}
