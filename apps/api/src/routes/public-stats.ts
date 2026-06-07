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

// Important: do NOT declare a `response` schema with `type: 'object'`
// and no `properties` here. Fastify's response serializer treats that
// as "object with zero allowed properties" and strips the body to {}.
// These endpoints return rich nested data, so we omit the response
// schema entirely; OpenAPI still documents the route via the tag,
// summary, and description below.
const STATS_SCHEMA = {
  tags: ['Public'],
  summary: 'Network-wide stats snapshot',
  description: 'Honest live aggregations of nodes online, operators, lifetime usage, and regional spread. Cached 30 seconds at the edge.',
}

const LISTINGS_FEED_SCHEMA_JSON = {
  tags: ['Public'],
  summary: 'Inventory feed (JSON)',
  description: 'Full current catalog as a single JSON document, served with a Content-Disposition filename so curl/wget grab a file directly.',
}

const LISTINGS_FEED_SCHEMA_CSV = {
  tags: ['Public'],
  summary: 'Inventory feed (CSV)',
  description: 'Full current catalog as comma-separated values. One row per (operator, gpuTier, region) aggregation.',
}

const NETWORK_ANALYTICS_SCHEMA = {
  tags: ['Public'],
  summary: 'Network analytics + projections',
  description: 'Daily revenue, monthly performance, projections (3 months forward), returns-vs-cost, node-runner + power-user growth, rate history + table. Cached 60s.',
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
    for (const tier of ['H100', 'H200', 'A100', 'L40S', 'B200', 'B300', 'GB300', 'CONSUMER', 'RTX_4090', 'RTX_3090'] as GpuTier[]) {
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

  fastify.get('/v1/public/network-analytics', { schema: NETWORK_ANALYTICS_SCHEMA }, async (request, reply) => {
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const day30 = new Date(todayStart.getTime() - 30 * 86400000)
    const day60 = new Date(todayStart.getTime() - 60 * 86400000)
    const day90 = new Date(todayStart.getTime() - 90 * 86400000)
    const month6Start = new Date(todayStart.getFullYear(), todayStart.getMonth() - 5, 1)
    const week12Start = new Date(todayStart.getTime() - 12 * 7 * 86400000)

    const [
      earnings60d,
      monthlyEarnings,
      monthlyPayouts,
      monthlyBuyerSpend,
      nodeRunners,
      computeRequestsByUser,
      capitalDeployedAgg,
      totalEarningsAgg,
      rateHistoryRows,
    ] = await Promise.all([
      fastify.prisma.earning.findMany({
        where: { date: { gte: day60 } },
        select: { date: true, earnings: true, gpuSeconds: true },
      }),
      fastify.prisma.earning.findMany({
        where: { date: { gte: month6Start } },
        select: { date: true, earnings: true },
      }),
      fastify.prisma.settlement.findMany({
        where: { status: 'COMPLETED', createdAt: { gte: month6Start } },
        select: { createdAt: true, amount: true },
      }),
      fastify.prisma.computeRequest.findMany({
        where: {
          status: { in: ['ACTIVE', 'COMPLETED'] },
          requestedAt: { gte: month6Start },
        },
        select: { requestedAt: true, totalCost: true, accruedCost: true },
      }),
      fastify.prisma.nodeRunner.findMany({
        where: { createdAt: { gte: day90 } },
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      fastify.prisma.computeRequest.groupBy({
        by: ['userId'],
        where: { status: { in: ['ACTIVE', 'COMPLETED'] }, requestedAt: { gte: week12Start } },
        _sum: { totalCost: true, accruedCost: true },
        _max: { requestedAt: true },
      }),
      fastify.prisma.investment.aggregate({ _sum: { amount: true } }),
      fastify.prisma.earning.aggregate({ _sum: { earnings: true } }),
      fastify.prisma.marketRateHistory.findMany({
        where: { fetchedAt: { gte: day60 } },
        select: { gpuTier: true, ratePerHour: true, fetchedAt: true },
        orderBy: { fetchedAt: 'asc' },
      }),
    ])

    // ---------- Daily Network Revenue (last 30 days) ----------
    const dayKey = (d: Date) => d.toISOString().slice(0, 10)
    const dailyMap = new Map<string, number>()
    for (let i = 29; i >= 0; i--) {
      dailyMap.set(dayKey(new Date(todayStart.getTime() - i * 86400000)), 0)
    }
    for (const e of earnings60d) {
      const k = dayKey(new Date(e.date))
      if (dailyMap.has(k)) dailyMap.set(k, (dailyMap.get(k) ?? 0) + e.earnings)
    }
    const dailyRevenue = Array.from(dailyMap.entries()).map(([date, revenue]) => ({ date, revenue }))

    // ---------- Monthly Financial Performance (last 6 months) ----------
    const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const monthBuckets = new Map<string, { revenue: number; payouts: number; buyerSpend: number }>()
    for (let i = 5; i >= 0; i--) {
      const d = new Date(todayStart.getFullYear(), todayStart.getMonth() - i, 1)
      monthBuckets.set(monthKey(d), { revenue: 0, payouts: 0, buyerSpend: 0 })
    }
    for (const e of monthlyEarnings) {
      const k = monthKey(new Date(e.date))
      const b = monthBuckets.get(k)
      if (b) b.revenue += e.earnings
    }
    for (const s of monthlyPayouts) {
      const k = monthKey(new Date(s.createdAt))
      const b = monthBuckets.get(k)
      if (b) b.payouts += s.amount
    }
    for (const c of monthlyBuyerSpend) {
      const k = monthKey(new Date(c.requestedAt))
      const b = monthBuckets.get(k)
      if (b) b.buyerSpend += (c.accruedCost ?? 0) > 0 ? (c.accruedCost ?? 0) : c.totalCost
    }
    const monthlyPerformance = Array.from(monthBuckets.entries()).map(([month, v]) => ({
      month,
      revenue: Number(v.revenue.toFixed(2)),
      payouts: Number(v.payouts.toFixed(2)),
      buyerSpend: Number(v.buyerSpend.toFixed(2)),
    }))

    // ---------- Projections (3 months forward) ----------
    const last30Revenue = dailyRevenue.reduce((s, r) => s + r.revenue, 0)
    const prior30Revenue = earnings60d
      .filter(e => {
        const d = new Date(e.date)
        return d < day30 && d >= day60
      })
      .reduce((s, e) => s + e.earnings, 0)
    const dailyRunRate = last30Revenue / 30
    const growthFactor = prior30Revenue > 0 ? last30Revenue / prior30Revenue : 1
    const monthlyGrowthPct = growthFactor === 1 ? 0 : (growthFactor - 1) * 100

    const projections = {
      daily: {
        current: Number(dailyRunRate.toFixed(2)),
        projected: Number((dailyRunRate * growthFactor).toFixed(2)),
        growthPct: Number(monthlyGrowthPct.toFixed(1)),
      },
      weekly: {
        current: Number((dailyRunRate * 7).toFixed(2)),
        projected: Number((dailyRunRate * 7 * growthFactor).toFixed(2)),
        growthPct: Number(monthlyGrowthPct.toFixed(1)),
      },
      monthly: {
        current: Number((dailyRunRate * 30).toFixed(2)),
        projected: Number((dailyRunRate * 30 * growthFactor).toFixed(2)),
        growthPct: Number(monthlyGrowthPct.toFixed(1)),
      },
    }

    const monthlyProjectionGrowth: Array<{ month: string; projected: number }> = []
    let cumulative = dailyRunRate * 30
    for (let i = 1; i <= 3; i++) {
      cumulative = cumulative * growthFactor
      const d = new Date(todayStart.getFullYear(), todayStart.getMonth() + i, 1)
      monthlyProjectionGrowth.push({ month: monthKey(d), projected: Number(cumulative.toFixed(2)) })
    }

    // ---------- Returns vs Cost ----------
    const totalCostBasis = capitalDeployedAgg._sum.amount ?? 0
    const totalEarnings = totalEarningsAgg._sum.earnings ?? 0
    const monthlyAvgEarnings = last30Revenue
    const recoupRatio = totalCostBasis > 0 ? totalEarnings / totalCostBasis : 0
    const remainingToBreakEven = Math.max(0, totalCostBasis - totalEarnings)
    const breakEvenMonths = monthlyAvgEarnings > 0 ? remainingToBreakEven / monthlyAvgEarnings : null

    const returnsVsCost = {
      totalCostBasis: Number(totalCostBasis.toFixed(2)),
      totalEarnings: Number(totalEarnings.toFixed(2)),
      recoupRatio: Number(recoupRatio.toFixed(3)),
      monthlyAvgEarnings: Number(monthlyAvgEarnings.toFixed(2)),
      breakEvenMonths: breakEvenMonths === null ? null : Number(breakEvenMonths.toFixed(1)),
    }

    // ---------- Node-Runner Growth (cumulative over last 90 days) ----------
    const priorRunners = await fastify.prisma.nodeRunner.count({ where: { createdAt: { lt: day90 } } })
    let runningCount = priorRunners
    const noderunnerGrowthMap = new Map<string, number>()
    for (let i = 89; i >= 0; i--) {
      noderunnerGrowthMap.set(dayKey(new Date(todayStart.getTime() - i * 86400000)), runningCount)
    }
    for (const nr of nodeRunners) {
      runningCount += 1
      const k = dayKey(new Date(nr.createdAt))
      const keys = Array.from(noderunnerGrowthMap.keys())
      const startIdx = keys.indexOf(k)
      if (startIdx === -1) continue
      for (let i = startIdx; i < keys.length; i++) {
        const dayK = keys[i]
        if (dayK) noderunnerGrowthMap.set(dayK, runningCount)
      }
    }
    const noderunnerGrowth = Array.from(noderunnerGrowthMap.entries()).map(([date, total]) => ({ date, total }))

    // ---------- Power User Expansion (weekly, last 12 weeks) ----------
    const POWER_USER_THRESHOLD_USD = 100
    const powerUserWeeks = new Map<string, number>()
    for (let i = 11; i >= 0; i--) {
      const d = new Date(todayStart.getTime() - i * 7 * 86400000)
      powerUserWeeks.set(dayKey(d), 0)
    }
    for (const u of computeRequestsByUser) {
      const accrued = u._sum?.accruedCost ?? 0
      const total = u._sum?.totalCost ?? 0
      const spend = accrued > 0 ? accrued : total
      if (spend < POWER_USER_THRESHOLD_USD) continue
      const lastReq = u._max?.requestedAt ?? null
      if (!lastReq) continue
      const last = new Date(lastReq)
      const diffDays = Math.floor((todayStart.getTime() - last.getTime()) / 86400000)
      const weekIndex = Math.min(11, Math.floor(diffDays / 7))
      const bucketDate = dayKey(new Date(todayStart.getTime() - weekIndex * 7 * 86400000))
      if (powerUserWeeks.has(bucketDate)) {
        powerUserWeeks.set(bucketDate, (powerUserWeeks.get(bucketDate) ?? 0) + 1)
      }
    }
    const powerUsers = Array.from(powerUserWeeks.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }))

    // ---------- Node Rate History (last 60 days, by tier) ----------
    const rateMap = new Map<string, Map<string, number[]>>()
    for (const r of rateHistoryRows) {
      const tierBucket = rateMap.get(r.gpuTier) ?? new Map<string, number[]>()
      const k = dayKey(new Date(r.fetchedAt))
      const arr = tierBucket.get(k) ?? []
      arr.push(r.ratePerHour)
      tierBucket.set(k, arr)
      rateMap.set(r.gpuTier, tierBucket)
    }
    const rateHistory: Record<string, Array<{ date: string; ratePerHour: number }>> = {}
    for (const [tier, perDay] of rateMap.entries()) {
      rateHistory[tier] = Array.from(perDay.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, rates]) => ({
          date,
          ratePerHour: Number((rates.reduce((s, x) => s + x, 0) / rates.length).toFixed(4)),
        }))
    }

    // ---------- Rate Table (current snapshot per tier with 30d stats) ----------
    const rateTable: Array<{
      gpuTier: string
      current: number
      median30d: number
      min30d: number
      max30d: number
      deltaPct30d: number
    }> = []
    for (const tier of ['H100', 'H200', 'A100', 'L40S', 'B200', 'B300', 'GB300', 'CONSUMER', 'RTX_4090', 'RTX_3090'] as GpuTier[]) {
      const last30 = rateHistoryRows.filter(r => {
        return r.gpuTier === tier && new Date(r.fetchedAt) >= day30
      })
      const current = Number(dailyToHourly(GPU_TIER_CONFIG[tier].retailRate).toFixed(4))
      if (last30.length === 0) {
        rateTable.push({
          gpuTier: tier, current, median30d: current, min30d: current, max30d: current, deltaPct30d: 0,
        })
        continue
      }
      const rates = last30.map(r => r.ratePerHour).sort((a, b) => a - b)
      const median = rates[Math.floor(rates.length / 2)] ?? current
      const min = rates[0] ?? current
      const max = rates[rates.length - 1] ?? current
      const first = last30[0]
      const earliest = first ? first.ratePerHour : current
      const deltaPct = earliest > 0 ? ((current - earliest) / earliest) * 100 : 0
      rateTable.push({
        gpuTier: tier,
        current,
        median30d: Number(median.toFixed(4)),
        min30d: Number(min.toFixed(4)),
        max30d: Number(max.toFixed(4)),
        deltaPct30d: Number(deltaPct.toFixed(2)),
      })
    }

    reply.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=120')
    return reply.send({
      timestamp: now.toISOString(),
      dailyRevenue,
      monthlyPerformance,
      projections,
      monthlyProjectionGrowth,
      returnsVsCost,
      noderunnerGrowth,
      powerUsers,
      rateHistory,
      rateTable,
    })
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
