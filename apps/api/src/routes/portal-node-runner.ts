import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { TaxIdType } from '@a2e/database'
import {
  calculateUptimeEarnings,
  getDailyUptimeBreakdown,
} from '../services/earnings/uptime-calculator.js'
import { calculateForecast } from '../services/earnings/forecast.js'
import * as pricing from '../services/pricing/operator-rate.js'
import { createNotification } from '../services/notification/service.js'
import { generateTaxYearCsv } from '../services/reports/tax-csv.js'
import {
  createOperatorDeployCheckoutSession,
  isStripeConfigured,
  createConnectAccount,
  createConnectOnboardingLink,
  getConnectAccountStatus,
  createConnectTransfer,
} from '../services/payment/stripe.js'
import { debitBalance, InsufficientBalanceError } from '../services/balance/balance-service.js'
import { mintInstallTokenForRunner } from './byog.js'
import { getSolanaConfig, verifyUsdcDeposit } from '../services/payment/solana.js'

const PORTAL_URL = process.env.PORTAL_URL?.trim() || 'https://user.tokenos.ai'

/**
 * Helper: get the NodeRunner profile for the authenticated user, or 404
 */
async function getNodeRunnerForUser(fastify: FastifyInstance, userId: string) {
  const nodeRunner = await fastify.prisma.nodeRunner.findUnique({
    where: { userId },
  })
  return nodeRunner
}

/**
 * Helper: verify a node belongs to the authenticated user's NodeRunner
 */
async function verifyNodeOwnership(fastify: FastifyInstance, nodeId: string, nodeRunnerId: string) {
  const node = await fastify.prisma.node.findFirst({
    where: { id: nodeId, nodeRunnerId },
  })
  return node
}

export async function portalNodeRunnerRoutes(fastify: FastifyInstance) {
  // All routes require authentication + NODE_RUNNER or ADMIN role
  fastify.addHook('preHandler', fastify.authenticate)
  fastify.addHook('preHandler', fastify.requireRole('NODE_RUNNER', 'ADMIN'))

  // ===================================================================
  // PROFILE
  // ===================================================================

  /**
   * GET /v1/portal/node-runner/profile
   */
  fastify.get('/v1/portal/node-runner/profile', async (request, reply) => {
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) {
      return reply.code(404).send({ error: 'No node runner profile found. Complete onboarding first.' })
    }

    const nodeCount = await fastify.prisma.node.count({ where: { nodeRunnerId: nr.id } })
    const investmentCount = await fastify.prisma.investment.count({ where: { nodeRunnerId: nr.id } })

    reply.send({
      id: nr.id,
      name: nr.name,
      email: nr.email,
      walletAddress: nr.walletAddress,
      payoutThreshold: nr.payoutThreshold,
      payoutFrequency: nr.payoutFrequency,
      payoutDayOfWeek: nr.payoutDayOfWeek,
      payoutDayOfMonth: nr.payoutDayOfMonth,
      nodeCount,
      investmentCount,
      createdAt: nr.createdAt,
      // C3 wave 2: surfaced so the payout-settings page can render the
      // weekly digest opt-out checkbox in its current state.
      digestOptedOut: nr.digestOptedOut,
    })
  })

  // ===================================================================
  // DASHBOARD
  // ===================================================================

  /**
   * GET /v1/portal/node-runner/dashboard
   */
  fastify.get('/v1/portal/node-runner/dashboard', async (request, reply) => {
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) {
      return reply.code(404).send({ error: 'No node runner profile found' })
    }

    const nodes = await fastify.prisma.node.findMany({
      where: { nodeRunnerId: nr.id },
      select: {
        id: true, status: true, gpuTier: true, lastHeartbeat: true, currentJobId: true,
        assignedComputeRequestId: true,
      },
    })

    const nodeIds = nodes.map(n => n.id)
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const weekStart = new Date(todayStart.getTime() - 7 * 86400000)
    const monthStart = new Date(todayStart.getTime() - 30 * 86400000)

    // Earnings aggregations
    const [earningsToday, earningsWeek, earningsMonth, earningsAllTime] = await Promise.all([
      fastify.prisma.earning.aggregate({ where: { nodeId: { in: nodeIds }, date: { gte: todayStart } }, _sum: { earnings: true } }),
      fastify.prisma.earning.aggregate({ where: { nodeId: { in: nodeIds }, date: { gte: weekStart } }, _sum: { earnings: true } }),
      fastify.prisma.earning.aggregate({ where: { nodeId: { in: nodeIds }, date: { gte: monthStart } }, _sum: { earnings: true } }),
      fastify.prisma.earning.aggregate({ where: { nodeId: { in: nodeIds } }, _sum: { earnings: true } }),
    ])

    // Job stats
    const [jobsCompleted, jobsRunning] = await Promise.all([
      fastify.prisma.job.count({ where: { nodeId: { in: nodeIds }, status: 'COMPLETED' } }),
      fastify.prisma.job.count({ where: { nodeId: { in: nodeIds }, status: 'RUNNING' } }),
    ])

    // Settlements (payouts)
    const totalPaid = await fastify.prisma.settlement.aggregate({
      where: { nodeId: { in: nodeIds }, status: 'COMPLETED' },
      _sum: { amount: true },
    })

    const onlineCount = nodes.filter(n => n.status === 'ONLINE').length
    const uptimePercent = nodes.length > 0 ? Math.round((onlineCount / nodes.length) * 100) : 0

    const nodesInUse = nodes.filter(n => n.assignedComputeRequestId !== null).length

    // How many of this runner's nodes are currently listed on an external market
    const nodesExternallyListed = nodeIds.length === 0 ? 0 : await fastify.prisma.node.count({
      where: {
        id: { in: nodeIds },
        externalDeployments: {
          some: { status: { in: ['PENDING', 'ACTIVE', 'TERMINATING'] } },
        },
      },
    })

    // 30-day per-day earnings breakdown for the "Earnings, last 30 days"
    // bar chart on /dashboard. The chart reads data.dailyEarnings from
    // this exact endpoint's response. Without this field the chart
    // silently falls back to a zero-filled placeholder, even when the
    // Earning table is populated (which is the bug the earnings-
    // consolidator finally surfaced — rows existed but the chart was
    // sourcing the wrong key).
    const dailyEarningsRows = nodeIds.length === 0
      ? []
      : await fastify.prisma.earning.findMany({
          where: { nodeId: { in: nodeIds }, date: { gte: monthStart } },
          select: { date: true, earnings: true },
        })
    const dayMap = new Map<string, number>()
    for (let i = 29; i >= 0; i--) {
      const d = new Date(todayStart.getTime() - i * 86400000)
      dayMap.set(d.toISOString().slice(0, 10), 0)
    }
    for (const e of dailyEarningsRows) {
      const key = new Date(e.date).toISOString().slice(0, 10)
      if (dayMap.has(key)) {
        dayMap.set(key, (dayMap.get(key) ?? 0) + e.earnings)
      }
    }
    const dailyEarnings = Array.from(dayMap.entries()).map(([date, amount]) => ({
      date, amount,
    }))

    reply.send({
      earnings: {
        today: earningsToday._sum.earnings ?? 0,
        week: earningsWeek._sum.earnings ?? 0,
        month: earningsMonth._sum.earnings ?? 0,
        allTime: earningsAllTime._sum.earnings ?? 0,
      },
      nodes: {
        total: nodes.length,
        online: onlineCount,
        offline: nodes.filter(n => n.status === 'OFFLINE').length,
        maintenance: nodes.filter(n => n.status === 'MAINTENANCE' || n.status === 'PAUSED').length,
        inUse: nodesInUse,
        externallyListed: nodesExternallyListed,
      },
      jobs: {
        completed: jobsCompleted,
        running: jobsRunning,
      },
      totalPaidOut: totalPaid._sum.amount ?? 0,
      uptimePercent,
      dailyEarnings,
    })
  })

  // ===================================================================
  // OPERATOR ANALYTICS
  // Consolidated "me-data" for the dashboard right rail and analytics
  // section. Single round-trip so the dashboard does not have to make
  // 5+ parallel calls on initial paint.
  // ===================================================================

  /**
   * GET /v1/portal/node-runner/operator-stats
   *
   * Returns the operator's payout-side and reputation analytics:
   *   - pendingPayout      : available - already earned but not yet withdrawn
   *   - capitalDeployed    : sum of investments (cost basis)
   *   - leaderboardRank    : 1-indexed rank by reputationScore (1 = top)
   *   - totalRanked        : count of node-runners scored (denominator)
   *   - uptimeStreak       : consecutive days with at least one heartbeat
   *   - payoutCalendar     : 30-day array of {date, amount}
   *   - perNodeEarnings    : array of {nodeId, label, earnings} for last 30d
   *   - recentPayouts      : last 5 settlements (Settlement rows)
   */
  fastify.get('/v1/portal/node-runner/operator-stats', async (request, reply) => {
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) {
      return reply.code(404).send({ error: 'No node runner profile found' })
    }

    const nodes = await fastify.prisma.node.findMany({
      where: { nodeRunnerId: nr.id },
      select: { id: true, gpuTier: true, customGpuModel: true, assignedComputeRequestId: true },
    })
    const nodeIds = nodes.map(n => n.id)
    const nodeLabel = (n: { id: string; gpuTier: string; customGpuModel: string | null }) =>
      n.customGpuModel || `${n.gpuTier} (${n.id.slice(0, 6)})`

    // Build upcomingPayouts from active rentals on owned nodes. Per-node
    // expected payout = yieldFloor.ratePerDay * durationDays (the
    // guaranteed minimum operator yield documented for each tier). True
    // settlement amount can exceed this if the rental sold above the
    // floor; we surface the floor as a conservative honest estimate
    // labeled "~" in the UI.
    const assignedRequestIds = Array.from(new Set(
      nodes.map(n => n.assignedComputeRequestId).filter((id): id is string => !!id)
    ))
    const [activeRequests, yieldFloors] = await Promise.all([
      assignedRequestIds.length === 0
        ? Promise.resolve([] as Array<{ id: string; gpuTier: string; gpuCount: number; durationDays: number; totalCost: number; expiresAt: Date | null; status: string }>)
        : fastify.prisma.computeRequest.findMany({
            where: { id: { in: assignedRequestIds }, status: 'ACTIVE' },
            select: { id: true, gpuTier: true, gpuCount: true, durationDays: true, totalCost: true, expiresAt: true, status: true },
          }),
      fastify.prisma.yieldFloor.findMany({ select: { gpuTier: true, ratePerDay: true } }),
    ])
    const yieldByTier = new Map<string, number>()
    for (const yf of yieldFloors) yieldByTier.set(yf.gpuTier, yf.ratePerDay)
    const reqById = new Map(activeRequests.map(r => [r.id, r]))

    const upcomingPayouts: Array<{
      completesAt: string
      expectedAmount: number
      gpuTier: string
      nodeId: string
      requestId: string
    }> = []
    for (const n of nodes) {
      if (!n.assignedComputeRequestId) continue
      const r = reqById.get(n.assignedComputeRequestId)
      if (!r || !r.expiresAt) continue
      const floor = yieldByTier.get(r.gpuTier) ?? 0
      // Per-node expected payout: yield floor times rental duration. Tier
      // floor is already per-node-per-day, so no division by gpuCount.
      const expectedAmount = floor > 0
        ? floor * r.durationDays
        : r.totalCost / Math.max(1, r.gpuCount)
      upcomingPayouts.push({
        completesAt: r.expiresAt.toISOString(),
        expectedAmount: Number(expectedAmount.toFixed(2)),
        gpuTier: r.gpuTier,
        nodeId: n.id,
        requestId: r.id,
      })
    }
    upcomingPayouts.sort((a, b) => a.completesAt.localeCompare(b.completesAt))

    // Fleet composition: how many nodes per GPU tier (independent of
    // whether they have earnings in the last 30d, so the Node Status
    // Mix card always has something to show even on a brand-new operator).
    const tierMap = new Map<string, number>()
    for (const n of nodes) {
      tierMap.set(n.gpuTier, (tierMap.get(n.gpuTier) ?? 0) + 1)
    }
    const nodesByTier = Array.from(tierMap.entries())
      .map(([gpuTier, count]) => ({ gpuTier, count }))
      .sort((a, b) => b.count - a.count)

    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const thirtyDayStart = new Date(todayStart.getTime() - 30 * 86400000)

    // Run aggregations in parallel
    const [
      earningsAgg,
      withdrawnAgg,
      pendingWithdrawalsAgg,
      investmentsAgg,
      higherRanked,
      totalRanked,
      perNodeEarningsRows,
      dailyEarnings30d,
      recentPayouts,
      recentHeartbeats,
    ] = await Promise.all([
      nodeIds.length === 0
        ? Promise.resolve({ _sum: { earnings: 0 } as { earnings: number | null } })
        : fastify.prisma.earning.aggregate({
            where: { nodeId: { in: nodeIds } },
            _sum: { earnings: true },
          }),
      fastify.prisma.withdrawalRequest.aggregate({
        where: { nodeRunnerId: nr.id, status: 'COMPLETED' },
        _sum: { amount: true },
      }),
      fastify.prisma.withdrawalRequest.aggregate({
        where: { nodeRunnerId: nr.id, status: { in: ['PENDING', 'APPROVED', 'PROCESSING'] } },
        _sum: { amount: true },
      }),
      fastify.prisma.investment.aggregate({
        where: { nodeRunnerId: nr.id },
        _sum: { amount: true },
      }),
      fastify.prisma.nodeRunner.count({
        where: { reputationScore: { gt: nr.reputationScore } },
      }),
      fastify.prisma.nodeRunner.count(),
      nodeIds.length === 0
        ? Promise.resolve([] as { nodeId: string; _sum: { earnings: number | null } }[])
        : fastify.prisma.earning.groupBy({
            by: ['nodeId'],
            where: { nodeId: { in: nodeIds }, date: { gte: thirtyDayStart } },
            _sum: { earnings: true },
          }),
      nodeIds.length === 0
        ? Promise.resolve([] as { date: Date; earnings: number }[])
        : fastify.prisma.earning.findMany({
            where: { nodeId: { in: nodeIds }, date: { gte: thirtyDayStart } },
            select: { date: true, earnings: true },
          }),
      fastify.prisma.settlement.findMany({
        where: { nodeId: { in: nodeIds }, status: 'COMPLETED' },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true, amount: true, status: true, txHash: true, createdAt: true,
          nodeId: true,
        },
      }),
      nodeIds.length === 0
        ? Promise.resolve([] as { timestamp: Date }[])
        : fastify.prisma.heartbeat.findMany({
            where: {
              nodeId: { in: nodeIds },
              timestamp: { gte: new Date(todayStart.getTime() - 60 * 86400000) },
            },
            select: { timestamp: true },
            orderBy: { timestamp: 'desc' },
          }),
    ])

    // Pending payout (= "available right now to withdraw"). Source from
    // the same live heartbeat-based engine the Payouts Settings page
    // uses, so this card always matches the Available tile shown there.
    // Previously we computed this from Earning rollups, which lag the
    // heartbeat-based truth and confused operators when both numbers
    // disagreed.
    const totalEarnings = earningsAgg._sum.earnings ?? 0
    const totalWithdrawn = withdrawnAgg._sum.amount ?? 0
    const pendingWithdrawal = pendingWithdrawalsAgg._sum.amount ?? 0
    const { getOperatorBalanceBreakdown } = await import(
      '../services/settlement/engine.js'
    )
    const balance = await getOperatorBalanceBreakdown(fastify.prisma, nr.id)
    const pendingPayout = balance.available

    const capitalDeployed = investmentsAgg._sum.amount ?? 0

    const leaderboardRank = higherRanked + 1

    // Build 30-day payout calendar (one cell per day). Only accumulate
    // into days that are inside the 30-day window so an out-of-range
    // Earning row (the date>=thirtyDayStart query is inclusive of the
    // start boundary plus a tz fudge) can't add a stray 31st bucket.
    const dayMap = new Map<string, number>()
    for (let i = 29; i >= 0; i--) {
      const d = new Date(todayStart.getTime() - i * 86400000)
      dayMap.set(d.toISOString().slice(0, 10), 0)
    }
    for (const e of dailyEarnings30d) {
      const key = new Date(e.date).toISOString().slice(0, 10)
      if (dayMap.has(key)) {
        dayMap.set(key, (dayMap.get(key) ?? 0) + e.earnings)
      }
    }
    const payoutCalendar = Array.from(dayMap.entries()).map(([date, amount]) => ({
      date, amount,
    }))

    // Per-node earnings: bind by-node sums to readable labels
    const nodeById = new Map(nodes.map(n => [n.id, n]))
    const perNodeEarnings = perNodeEarningsRows
      .map(row => {
        const n = nodeById.get(row.nodeId)
        return {
          nodeId: row.nodeId,
          label: n ? nodeLabel(n) : row.nodeId.slice(0, 6),
          gpuTier: n?.gpuTier ?? 'UNKNOWN',
          earnings: row._sum.earnings ?? 0,
        }
      })
      .sort((a, b) => b.earnings - a.earnings)

    // Uptime streak: consecutive days (going back from today, inclusive)
    // where at least one heartbeat from any owned node landed.
    const heartbeatDays = new Set<string>()
    for (const hb of recentHeartbeats) {
      heartbeatDays.add(new Date(hb.timestamp).toISOString().slice(0, 10))
    }
    let uptimeStreak = 0
    for (let i = 0; i < 60; i++) {
      const d = new Date(todayStart.getTime() - i * 86400000).toISOString().slice(0, 10)
      if (heartbeatDays.has(d)) uptimeStreak++
      else break
    }

    reply.send({
      pendingPayout,
      capitalDeployed,
      leaderboardRank,
      totalRanked,
      reputationScore: nr.reputationScore,
      reputationTier: nr.reputationTier,
      uptimeStreak,
      payoutCalendar,
      perNodeEarnings,
      recentPayouts,
      nodesByTier,
      upcomingPayouts,
    })
  })

  // ===================================================================
  // NODES
  // ===================================================================

  /**
   * GET /v1/portal/node-runner/nodes
   */
  fastify.get('/v1/portal/node-runner/nodes', async (request, reply) => {
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) {
      return reply.code(404).send({ error: 'No node runner profile found' })
    }

    const nodes = await fastify.prisma.node.findMany({
      where: { nodeRunnerId: nr.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, walletAddress: true, gpuTier: true, nodeType: true, status: true,
        region: true, agentVersion: true, currentJobId: true, lastHeartbeat: true,
        customGpuModel: true, customRatePerHour: true, createdAt: true,
        assignedComputeRequestId: true,
        externalDeployments: {
          where: { status: { in: ['PENDING', 'ACTIVE', 'TERMINATING'] } },
          select: { id: true, market: true, status: true, ratePerHour: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    })

    const nodesWithUsage = nodes.map(node => ({
      ...node,
      isInUse: node.assignedComputeRequestId !== null,
    }))

    reply.send({ nodes: nodesWithUsage })
  })

  /**
   * GET /v1/portal/node-runner/nodes/:id
   */
  fastify.get('/v1/portal/node-runner/nodes/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    const node = await verifyNodeOwnership(fastify, id, nr.id)
    if (!node) return reply.code(404).send({ error: 'Node not found' })

    const fullNode = await fastify.prisma.node.findUnique({
      where: { id },
      include: {
        heartbeats: { orderBy: { timestamp: 'desc' }, take: 50 },
        jobs: { orderBy: { createdAt: 'desc' }, take: 20, select: {
          id: true, status: true, market: true, earnings: true, durationSeconds: true, createdAt: true, completedAt: true,
        }},
      },
    })

    // Calculate uptime earnings for this node (last 30 days)
    const now = new Date()
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000)
    const uptimeEarnings = await calculateUptimeEarnings(
      fastify.prisma, id, thirtyDaysAgo, now
    )

    reply.send({ node: fullNode, uptimeEarnings })
  })

  const updateNodeSchema = z.object({
    status: z.enum(['PAUSED', 'MAINTENANCE', 'ONLINE']).optional(),
    // C2 wave 2: operator-declared residential-IP marker. Surfaced as
    // a "Home GPU" badge on the marketplace so buyers know this host
    // is on a home/residential connection (no static IP, behind NAT,
    // possibly lower SLA). Self-declared; no geolocation check.
    isResidential: z.boolean().optional(),
  })

  /**
   * PATCH /v1/portal/node-runner/nodes/:id — pause/resume/maintenance
   */
  fastify.patch('/v1/portal/node-runner/nodes/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    const node = await verifyNodeOwnership(fastify, id, nr.id)
    if (!node) return reply.code(404).send({ error: 'Node not found' })

    const parsed = updateNodeSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', message: parsed.error.errors.map(e => e.message).join(', ') })
    }

    const updated = await fastify.prisma.node.update({
      where: { id },
      data: parsed.data,
    })

    reply.send({ node: updated })
  })

  /**
   * GET /v1/portal/node-runner/nodes/:id/rate
   *
   * #7 operator-set pricing: return the current effective rate for
   * the node + the allowed band so the per-node Pricing card can
   * render slider min/max + a "market baseline" anchor.
   */
  fastify.get('/v1/portal/node-runner/nodes/:id/rate', async (request, reply) => {
    const { id } = request.params as { id: string }
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })
    const node = await verifyNodeOwnership(fastify, id, nr.id)
    if (!node) return reply.code(404).send({ error: 'Node not found' })

    const [effective, band] = await Promise.all([
      pricing.getEffectiveRate(fastify.prisma, node),
      pricing.getRateBand(fastify.prisma, node.gpuTier).catch(() => null),
    ])

    reply.send({
      gpuTier: node.gpuTier,
      effective,
      band,
      operatorRatePerHour: node.operatorRatePerHour,
      operatorRatePerDay: node.operatorRatePerDay,
      operatorRateUpdatedAt: node.operatorRateUpdatedAt,
    })
  })

  /**
   * PATCH /v1/portal/node-runner/nodes/:id/rate
   *
   * #7 operator-set pricing: write the operator-chosen rate after
   * validating it sits inside the YieldFloor-derived band. Pass
   * `ratePerHour: null` to clear the override and revert to the
   * YieldFloor default.
   */
  const setRateSchema = z.object({
    ratePerHour: z.number().positive().nullable(),
  })
  fastify.patch('/v1/portal/node-runner/nodes/:id/rate', async (request, reply) => {
    const { id } = request.params as { id: string }
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })
    const node = await verifyNodeOwnership(fastify, id, nr.id)
    if (!node) return reply.code(404).send({ error: 'Node not found' })

    const parsed = setRateSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', message: parsed.error.errors.map(e => e.message).join(', ') })
    }

    try {
      const result = await pricing.validateAndSetOperatorRate(
        fastify.prisma,
        id,
        parsed.data.ratePerHour,
      )
      reply.send({ success: true, ...result })
    } catch (e) {
      if (e instanceof pricing.RateOutOfBandError) {
        return reply.code(400).send({
          error: 'out_of_band',
          message: e.message,
          band: e.band,
        })
      }
      reply.code(500).send({ error: 'set_rate_failed', message: e instanceof Error ? e.message : 'unknown' })
    }
  })

  /**
   * DELETE /v1/portal/node-runner/nodes/:id — deregister
   */
  fastify.delete('/v1/portal/node-runner/nodes/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    const node = await verifyNodeOwnership(fastify, id, nr.id)
    if (!node) return reply.code(404).send({ error: 'Node not found' })

    // Mark for deletion (agent will receive UNINSTALL on next heartbeat)
    await fastify.prisma.node.update({
      where: { id },
      data: { pendingDeletion: true, status: 'OFFLINE' },
    })

    reply.send({ success: true, message: 'Node marked for removal' })
  })

  /**
   * POST /v1/portal/node-runner/nodes/pause-all — Pause all online nodes
   */
  fastify.post('/v1/portal/node-runner/nodes/pause-all', async (request, reply) => {
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    const result = await fastify.prisma.node.updateMany({
      where: { nodeRunnerId: nr.id, status: 'ONLINE' },
      data: { status: 'PAUSED' },
    })

    reply.send({ success: true, count: result.count, message: `${result.count} node${result.count !== 1 ? 's' : ''} paused` })
  })

  /**
   * POST /v1/portal/node-runner/nodes/resume-all — Resume all paused nodes
   */
  fastify.post('/v1/portal/node-runner/nodes/resume-all', async (request, reply) => {
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    const result = await fastify.prisma.node.updateMany({
      where: { nodeRunnerId: nr.id, status: 'PAUSED' },
      data: { status: 'ONLINE' },
    })

    reply.send({ success: true, count: result.count, message: `${result.count} node${result.count !== 1 ? 's' : ''} resumed` })
  })

  // ===================================================================
  // EARNINGS
  // ===================================================================

  const earningsQuerySchema = z.object({
    period: z.enum(['day', 'week', 'month', 'all']).default('month'),
  })

  /**
   * GET /v1/portal/node-runner/earnings
   */
  fastify.get('/v1/portal/node-runner/earnings', async (request, reply) => {
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    const parsed = earningsQuerySchema.safeParse(request.query)
    const period = parsed.success ? parsed.data.period : 'month'

    const nodeIds = (await fastify.prisma.node.findMany({
      where: { nodeRunnerId: nr.id }, select: { id: true },
    })).map(n => n.id)

    if (nodeIds.length === 0) {
      return reply.send({ earnings: [], total: 0, byMarket: {}, byNode: {} })
    }

    const now = new Date()
    let since: Date
    switch (period) {
      case 'day': since = new Date(now.getTime() - 86400000); break
      case 'week': since = new Date(now.getTime() - 7 * 86400000); break
      case 'all': since = new Date(0); break
      default: since = new Date(now.getTime() - 30 * 86400000)
    }

    const earnings = await fastify.prisma.earning.findMany({
      where: { nodeId: { in: nodeIds }, date: { gte: since } },
      orderBy: { date: 'desc' },
    })

    const total = earnings.reduce((sum, e) => sum + e.earnings, 0)

    // Group by market
    const byMarket: Record<string, number> = {}
    for (const e of earnings) {
      byMarket[e.market] = (byMarket[e.market] ?? 0) + e.earnings
    }

    // Group by node
    const byNode: Record<string, number> = {}
    for (const e of earnings) {
      byNode[e.nodeId] = (byNode[e.nodeId] ?? 0) + e.earnings
    }

    reply.send({ earnings, total, byMarket, byNode })
  })

  const earningsHistorySchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(50),
    nodeId: z.string().optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })

  /**
   * GET /v1/portal/node-runner/earnings/history
   */
  fastify.get('/v1/portal/node-runner/earnings/history', async (request, reply) => {
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    const parsed = earningsHistorySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', message: parsed.error.errors.map(e => e.message).join(', ') })
    }
    const { page, limit, nodeId, from, to } = parsed.data

    const nodeIds = (await fastify.prisma.node.findMany({
      where: { nodeRunnerId: nr.id }, select: { id: true },
    })).map(n => n.id)

    const where: Record<string, unknown> = {
      nodeId: nodeId && nodeIds.includes(nodeId) ? nodeId : { in: nodeIds },
    }
    if (from || to) {
      where.date = {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(to) } : {}),
      }
    }

    const [earnings, total] = await Promise.all([
      fastify.prisma.earning.findMany({
        where, orderBy: { date: 'desc' }, skip: (page - 1) * limit, take: limit,
      }),
      fastify.prisma.earning.count({ where }),
    ])

    reply.send({ earnings, total, page, limit, pages: Math.ceil(total / limit) })
  })

  /**
   * C3 wave 2: GET /v1/portal/node-runner/earnings/forecast?days=30
   *
   * Forward-looking projection from the last 7 days of earnings. Used
   * by the operator dashboard forecast card and the weekly digest
   * email so the two views never disagree. See
   * services/earnings/forecast.ts for the math + cold-start handling.
   */
  const forecastQuerySchema = z.object({
    days: z.coerce.number().min(1).max(365).default(30),
  })

  fastify.get('/v1/portal/node-runner/earnings/forecast', async (request, reply) => {
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    const parsed = forecastQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', message: parsed.error.errors.map(e => e.message).join(', ') })
    }

    const forecast = await calculateForecast(fastify.prisma, nr.id, parsed.data.days)
    reply.send(forecast)
  })

  // ===================================================================
  // PAYOUTS
  // ===================================================================

  const payoutsQuerySchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(20),
    status: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED']).optional(),
  })

  /**
   * GET /v1/portal/node-runner/payouts
   */
  fastify.get('/v1/portal/node-runner/payouts', async (request, reply) => {
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    const parsed = payoutsQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error' })
    }
    const { page, limit, status } = parsed.data

    const nodeIds = (await fastify.prisma.node.findMany({
      where: { nodeRunnerId: nr.id }, select: { id: true },
    })).map(n => n.id)

    const where: Record<string, unknown> = { nodeId: { in: nodeIds } }
    if (status) where.status = status

    const [settlements, total] = await Promise.all([
      fastify.prisma.settlement.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit,
      }),
      fastify.prisma.settlement.count({ where }),
    ])

    reply.send({ payouts: settlements, total, page, limit, pages: Math.ceil(total / limit) })
  })

  // ===================================================================
  // SETTINGS
  // ===================================================================

  const settingsSchema = z.object({
    name: z.string().min(1).max(100).optional(),
    email: z.string().email().optional(),
    walletAddress: z.string().min(32).max(64).optional(),
    payoutThreshold: z.number().min(1).max(100000).optional(),
    payoutFrequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']).optional(),
    payoutDayOfWeek: z.number().int().min(0).max(6).optional(),
    payoutDayOfMonth: z.number().int().min(1).max(28).optional(),
    // Payout-mode feature: lets operators hold rewards on the platform.
    // AUTO is the legacy default; MANUAL skips auto-payout entirely;
    // SCHEDULED holds until payoutScheduledAt then fires once. The
    // settlement engine + scheduler enforce the actual lifecycle.
    payoutMode: z.enum(['AUTO', 'MANUAL', 'SCHEDULED']).optional(),
    payoutScheduledAt: z.string().datetime().nullable().optional(),
    // C3 wave 2: opt out of the weekly digest email (forecast +
    // uptime warnings). Defaults to false (digest on) for new operators.
    digestOptedOut: z.boolean().optional(),
  }).refine(
    (data) =>
      data.payoutMode !== 'SCHEDULED' || data.payoutScheduledAt != null,
    { message: 'payoutScheduledAt is required when payoutMode is SCHEDULED', path: ['payoutScheduledAt'] },
  )

  /**
   * PATCH /v1/portal/node-runner/settings
   */
  fastify.patch('/v1/portal/node-runner/settings', async (request, reply) => {
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    const parsed = settingsSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', message: parsed.error.errors.map(e => e.message).join(', ') })
    }

    // Check wallet uniqueness if changing
    if (parsed.data.walletAddress && parsed.data.walletAddress !== nr.walletAddress) {
      const existing = await fastify.prisma.nodeRunner.findUnique({
        where: { walletAddress: parsed.data.walletAddress },
      })
      if (existing) {
        return reply.code(409).send({ error: 'Wallet address already in use' })
      }
    }

    // payoutScheduledAt arrives as an ISO string from the form; Prisma
    // needs a Date object. Other fields pass through unchanged.
    const { payoutScheduledAt, ...rest } = parsed.data
    const updateData: Record<string, unknown> = { ...rest }
    if (payoutScheduledAt !== undefined) {
      updateData.payoutScheduledAt = payoutScheduledAt ? new Date(payoutScheduledAt) : null
    }
    // Switching out of SCHEDULED nulls the date so a future toggle back
    // to SCHEDULED requires picking a fresh date.
    if (parsed.data.payoutMode && parsed.data.payoutMode !== 'SCHEDULED') {
      updateData.payoutScheduledAt = null
    }

    const updated = await fastify.prisma.nodeRunner.update({
      where: { id: nr.id },
      data: updateData,
    })

    reply.send({ nodeRunner: updated })
  })

  // ===================================================================
  // PAYOUT MODE — read current mode + computed platform balance, and
  // the "Withdraw now" trigger that bypasses any MANUAL/SCHEDULED hold.
  // ===================================================================

  /**
   * GET /v1/portal/node-runner/payouts/mode
   * Returns: { mode, scheduledAt, available, pending, nextUnlockAt,
   *   cooldownHours, platformBalance (alias of available) }
   */
  fastify.get('/v1/portal/node-runner/payouts/mode', async (request, reply) => {
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    const { getOperatorBalanceBreakdown } = await import('../services/settlement/engine.js')
    const breakdown = await getOperatorBalanceBreakdown(fastify.prisma, nr.id)

    reply.send({
      mode: nr.payoutMode,
      scheduledAt: nr.payoutScheduledAt?.toISOString() ?? null,
      available: breakdown.available,
      pending: breakdown.pending,
      nextUnlockAt: breakdown.nextUnlockAt,
      cooldownHours: breakdown.cooldownHours,
      // Lifetime internal-spend total — already subtracted from
      // `available`. Surfaced separately so the UI can show "spent
      // on rentals" alongside the withdrawable balance.
      spent: breakdown.spent,
      // platformBalance keeps the existing key name so older client
      // versions don't break. New UI reads `available`.
      platformBalance: breakdown.available,
    })
  })

  /**
   * GET /v1/portal/node-runner/internal-spends
   *
   * Recent InternalSpend rows for this operator (rentals paid from
   * platform balance). Powers the "Internal spend" panel on the
   * payouts page so operators see where their balance went without
   * having to dig into compute requests.
   */
  fastify.get('/v1/portal/node-runner/internal-spends', async (request, reply) => {
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    const spends = await fastify.prisma.internalSpend.findMany({
      where: { nodeRunnerId: nr.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        // Cherry-pick the rental fields the panel renders so we never
        // ship sshPassword / sshSessionToken / sshPubKey to the wire.
        // Prisma's `include` doesn't accept `select` directly here,
        // so we ride the relation and the UI ignores fields it doesn't
        // know about. Done via a follow-up findMany for clarity.
      },
    })

    // Fetch the rentals in one round-trip; map by id.
    const requestIds = spends.map((s) => s.computeRequestId)
    const requests = requestIds.length
      ? await fastify.prisma.computeRequest.findMany({
          where: { id: { in: requestIds } },
          select: {
            id: true,
            gpuTier: true,
            gpuCount: true,
            durationDays: true,
            status: true,
            totalCost: true,
            requestedAt: true,
            completedAt: true,
          },
        })
      : []
    const byId = new Map(requests.map((r) => [r.id, r]))

    reply.send({
      spends: spends.map((s) => ({
        id: s.id,
        computeRequestId: s.computeRequestId,
        amount: s.amount,
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
        rental: byId.get(s.computeRequestId) ?? null,
      })),
      total: spends.length,
    })
  })

  // Solana base58 wallet address: 32-44 chars, only base58 chars.
  // Validated client-side too; this is the server-side gate.
  const SOLANA_ADDR_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

  const withdrawNowSchema = z.object({
    // Per-withdraw destination. If omitted, falls back to the
    // operator's saved walletAddress. Optional 'save' flag persists
    // the new address back to the profile.
    walletAddress: z.string().regex(SOLANA_ADDR_REGEX).optional(),
    saveWallet: z.boolean().optional(),
  })

  /**
   * POST /v1/portal/node-runner/payouts/withdraw-now
   *
   * SECURITY (pen-test 2026-06-09 follow-up): previously this endpoint
   * directly called processPayment for every unpaid settlement, moving
   * real USDC from the treasury to the operator-supplied wallet with
   * no admin approval. Pen tester's clean attack path: free account
   * -> forge $X earnings -> set payout wallet -> withdraw-now -> funds
   * land in attacker wallet. Self-pay primitive.
   *
   * Behavior now: this endpoint runs all the same pre-flight checks
   * (email verification, admin hard-hold, balance calculation,
   * spend-adjusted cap) but instead of executing the payment it
   * creates a WithdrawalRequest row with status=PENDING. An admin
   * must approve via PATCH /v1/admin/withdrawals/:id/approve (ADMIN-
   * gated per Patch #2 from the 2026-06-09 push) before any funds
   * move. All withdrawal paths now flow through human-in-the-loop.
   *
   * If the operator was on SCHEDULED, the manual withdraw still
   * consumes that intent and flips them back to AUTO so the next
   * scheduler tick doesn't fire on top of the pending request.
   */
  fastify.post('/v1/portal/node-runner/payouts/withdraw-now', async (request, reply) => {
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    const parsed = withdrawNowSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: parsed.error.errors[0]?.message ?? 'Invalid input',
      })
    }

    // Email-verification gate. Soft-gate design: operators can sign in,
    // view their dashboard, install the PWA, etc. without verifying.
    // But payout withdrawals require a verified email so we have a
    // trusted channel for refund disputes, fraud alerts, and 1099 tax
    // documents. Resend verification from /payouts/settings if needed.
    const user = await fastify.prisma.user.findUnique({
      where: { id: request.user!.userId },
      select: { emailVerified: true, email: true },
    })
    if (!user?.emailVerified) {
      return reply.code(403).send({
        error: 'Email not verified',
        message: user?.email
          ? `Verify ${user.email} before withdrawing. Check your inbox or resend the verification email from /payouts/settings.`
          : 'Verify your email before withdrawing.',
        requiresEmailVerification: true,
      })
    }

    // Admin hard-hold check. Returns the unlock timestamp so the UI
    // can render a clear countdown / reason instead of a generic 403.
    if (nr.payoutLockUntil && nr.payoutLockUntil > new Date()) {
      return reply.code(403).send({
        error: 'Payouts locked',
        message: nr.payoutLockReason ?? 'Payouts are administratively locked',
        lockedUntil: nr.payoutLockUntil.toISOString(),
      })
    }

    const destinationWallet = parsed.data.walletAddress ?? nr.walletAddress

    const { calculateOperatorSettlements, createSettlement, markSettlementProcessing, markSettlementCompleted, markSettlementFailed, clearScheduledPayout, getOperatorBalanceBreakdown } =
      await import('../services/settlement/engine.js')
    const { getSolanaConfig, processPayment } = await import('../services/payment/solana.js')

    const rawCalcs = await calculateOperatorSettlements(fastify.prisma, nr.id, new Date())
    if (rawCalcs.length === 0) {
      return reply.code(409).send({
        error: 'No balance',
        message: 'No unpaid earnings available to withdraw',
      })
    }

    // Cap total payout at the spend-adjusted available balance.
    // calculateOperatorSettlements works per-node off raw uptime; it
    // does not know about InternalSpend. Without this clamp an
    // operator who's spent $X internally would still get the full
    // pre-spend amount wired to their wallet on Withdraw Now. We
    // re-scale every calc proportionally so each node gets a
    // truthful share of the actual withdrawable amount.
    const breakdown = await getOperatorBalanceBreakdown(fastify.prisma, nr.id)
    const rawTotal = rawCalcs.reduce((sum, c) => sum + c.amount, 0)
    const calcs = rawTotal > breakdown.available && rawTotal > 0
      ? rawCalcs.map((c) => ({
          ...c,
          amount: Math.max(0, (c.amount / rawTotal) * breakdown.available),
        }))
      : rawCalcs

    // After scaling, anything below the per-settlement floor (0.01)
    // would round to zero on the wire — drop those rows so we don't
    // create empty settlements.
    const payableCalcs = calcs.filter((c) => c.amount >= 0.01)
    if (payableCalcs.length === 0) {
      return reply.code(409).send({
        error: 'No balance',
        message: 'Available balance is zero after internal spend',
      })
    }

    // SECURITY: create ONE WithdrawalRequest with the total payable
    // amount instead of firing N processPayment calls. Status=PENDING
    // (the schema default). Admin must approve via /v1/admin/withdrawals
    // /:id/approve before any funds move on chain. The per-node
    // Settlement rows are NOT created here; the existing approval
    // pipeline handles that downstream.
    const totalAmount = Number(
      payableCalcs.reduce((sum, c) => sum + c.amount, 0).toFixed(2),
    )
    if (totalAmount <= 0) {
      return reply.code(409).send({
        error: 'No balance',
        message: 'Withdrawable amount is zero after spend-adjustment',
      })
    }

    const withdrawal = await fastify.prisma.withdrawalRequest.create({
      data: {
        nodeRunnerId: nr.id,
        amount: totalAmount,
        walletAddress: destinationWallet,
        payoutMethod: 'SOLANA',
      },
    })

    // Persist the new wallet to the profile if the operator opted in.
    // Safe to do even though the withdrawal hasn't paid yet; this is
    // the operator's own saved-wallet preference, not the payment
    // destination (which is already snapshot on the WithdrawalRequest
    // row above).
    if (parsed.data.walletAddress && parsed.data.saveWallet && parsed.data.walletAddress !== nr.walletAddress) {
      try {
        await fastify.prisma.nodeRunner.update({
          where: { id: nr.id },
          data: { walletAddress: parsed.data.walletAddress },
        })
      } catch {
        // Wallet uniqueness collision — ignore. The request still
        // exists; saving the new address is a nice-to-have.
      }
    }

    // If the operator was on SCHEDULED, the manual withdraw consumes
    // the scheduled-payout intent. Flip them back to AUTO so the next
    // scheduler tick doesn't fire on top of the pending request.
    if (nr.payoutMode === 'SCHEDULED') {
      await clearScheduledPayout(fastify.prisma, nr.id)
    }

    // Notification: PENDING admin approval, not "Sent". Deep-link to
    // the withdrawals page so the operator sees a real status.
    const walletShort = `${destinationWallet.slice(0, 6)}...${destinationWallet.slice(-4)}`
    void createNotification(
      request.user!.userId,
      'WITHDRAWAL_REQUESTED',
      `Withdrawal of $${totalAmount.toFixed(2)} pending approval`,
      `Your request for $${totalAmount.toFixed(2)} to ${walletShort} has been submitted. An admin will review and approve before funds move.`,
      '/payouts',
    )

    reply.code(202).send({
      withdrawalId: withdrawal.id,
      status: withdrawal.status,
      amount: totalAmount,
      destinationWallet,
      modeResetToAuto: nr.payoutMode === 'SCHEDULED',
      message: 'Withdrawal request submitted. An admin will review before funds move.',
    })
  })

  /**
   * T3.2.1b — POST /v1/portal/node-runner/payouts/withdraw-now-stripe
   *
   * Stripe-rail equivalent of withdraw-now. Operator's full unpaid
   * balance lands as ONE Stripe Transfer to their connected Express
   * account; Stripe then pays out to their bank on its normal cadence
   * (usually next business day). Per-node Settlement rows still get
   * created so reporting / tax CSVs stay node-attributed; they share
   * the same stripeTransferId.
   *
   * Requires:
   *   - Email verified (same gate as Solana withdraw-now)
   *   - No active admin payout lock
   *   - NodeRunner.stripeConnectStatus === 'READY' (operator finished
   *     Stripe Express onboarding)
   *
   * Idempotency: stripe.transfers.create uses a per-batch key so a
   * page retry can't double-transfer.
   */
  fastify.post('/v1/portal/node-runner/payouts/withdraw-now-stripe', async (request, reply) => {
    if (!isStripeConfigured()) {
      return reply.code(503).send({ error: 'stripe_not_configured' })
    }
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    // Mirror the Solana withdraw-now gates exactly so the two flows
    // have parity.
    const user = await fastify.prisma.user.findUnique({
      where: { id: request.user!.userId },
      select: { emailVerified: true, email: true },
    })
    if (!user?.emailVerified) {
      return reply.code(403).send({
        error: 'Email not verified',
        message: user?.email
          ? `Verify ${user.email} before withdrawing.`
          : 'Verify your email before withdrawing.',
        requiresEmailVerification: true,
      })
    }
    if (nr.payoutLockUntil && nr.payoutLockUntil > new Date()) {
      return reply.code(403).send({
        error: 'Payouts locked',
        message: nr.payoutLockReason ?? 'Payouts are administratively locked',
        lockedUntil: nr.payoutLockUntil.toISOString(),
      })
    }

    // Stripe Connect must be ready before we can transfer.
    if (!nr.stripeConnectAccountId || nr.stripeConnectStatus !== 'READY') {
      return reply.code(400).send({
        error: 'stripe_connect_not_ready',
        message:
          'Finish Stripe onboarding before withdrawing to bank. Visit Payouts → Connect Stripe.',
      })
    }

    const {
      calculateOperatorSettlements,
      createSettlement,
      markSettlementProcessing,
      markSettlementCompleted,
      markSettlementFailed,
      clearScheduledPayout,
      getOperatorBalanceBreakdown,
    } = await import('../services/settlement/engine.js')

    const rawCalcs = await calculateOperatorSettlements(fastify.prisma, nr.id, new Date())
    if (rawCalcs.length === 0) {
      return reply.code(409).send({ error: 'No balance', message: 'No unpaid earnings available to withdraw' })
    }

    const breakdown = await getOperatorBalanceBreakdown(fastify.prisma, nr.id)
    const rawTotal = rawCalcs.reduce((sum, c) => sum + c.amount, 0)
    const calcs = rawTotal > breakdown.available && rawTotal > 0
      ? rawCalcs.map((c) => ({
          ...c,
          amount: Number((c.amount * (breakdown.available / rawTotal)).toFixed(6)),
        }))
      : rawCalcs

    const totalAmount = Number(calcs.reduce((sum, c) => sum + c.amount, 0).toFixed(2))
    if (totalAmount <= 0) {
      return reply.code(409).send({ error: 'No balance', message: 'Withdrawable amount is zero after spend-adjustment' })
    }

    // SECURITY (pen-test 2026-06-09 follow-up): identical change to the
    // Solana withdraw-now path above. This endpoint used to call
    // createConnectTransfer directly, moving real USD from the platform
    // balance to the operator's Stripe Connect account with no admin
    // approval. The pen tester's contained-proof attack works on this
    // rail too (forge earnings -> withdraw-now-stripe -> $ lands in
    // attacker's connected Stripe account).
    //
    // Behavior now: create ONE WithdrawalRequest with payoutMethod=
    // STRIPE_CONNECT, status=PENDING. Admin must approve via the
    // ADMIN-gated /v1/admin/withdrawals/:id/approve flow before any
    // transfer fires. No Settlement rows created here; the approval
    // pipeline handles that downstream.
    const withdrawal = await fastify.prisma.withdrawalRequest.create({
      data: {
        nodeRunnerId: nr.id,
        amount: totalAmount,
        walletAddress: '', // Stripe path; destination is Stripe Connect account
        payoutMethod: 'STRIPE_CONNECT',
      },
    })

    if (nr.payoutMode === 'SCHEDULED') {
      await clearScheduledPayout(fastify.prisma, nr.id)
    }

    void createNotification(
      nr.userId ?? request.user!.userId,
      'WITHDRAWAL_REQUESTED',
      `Withdrawal of $${totalAmount.toFixed(2)} pending approval`,
      `Your Stripe withdrawal of $${totalAmount.toFixed(2)} has been submitted. An admin will review and approve before the transfer is sent to your bank.`,
      '/payouts',
    )

    reply.code(202).send({
      withdrawalId: withdrawal.id,
      status: withdrawal.status,
      amount: totalAmount,
      payoutMethod: 'STRIPE_CONNECT',
      modeResetToAuto: nr.payoutMode === 'SCHEDULED',
      message: 'Withdrawal request submitted. An admin will review before funds move.',
    })
  })

  // ===================================================================
  // JOBS
  // ===================================================================

  const jobsQuerySchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(20),
    status: z.enum(['PENDING', 'ROUTING', 'ASSIGNED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']).optional(),
    nodeId: z.string().optional(),
  })

  /**
   * GET /v1/portal/node-runner/jobs
   */
  fastify.get('/v1/portal/node-runner/jobs', async (request, reply) => {
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    const parsed = jobsQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error' })
    }
    const { page, limit, status, nodeId } = parsed.data

    const nodeIds = (await fastify.prisma.node.findMany({
      where: { nodeRunnerId: nr.id }, select: { id: true },
    })).map(n => n.id)

    const where: Record<string, unknown> = {
      nodeId: nodeId && nodeIds.includes(nodeId) ? nodeId : { in: nodeIds },
    }
    if (status) where.status = status

    const [jobs, total] = await Promise.all([
      fastify.prisma.job.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit,
        include: { routingLog: true },
      }),
      fastify.prisma.job.count({ where }),
    ])

    reply.send({ jobs, total, page, limit, pages: Math.ceil(total / limit) })
  })

  /**
   * GET /v1/portal/node-runner/jobs/:id
   */
  fastify.get('/v1/portal/node-runner/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    const nodeIds = (await fastify.prisma.node.findMany({
      where: { nodeRunnerId: nr.id }, select: { id: true },
    })).map(n => n.id)

    const job = await fastify.prisma.job.findFirst({
      where: { id, nodeId: { in: nodeIds } },
      include: { routingLog: true, node: { select: { id: true, gpuTier: true, walletAddress: true } } },
    })

    if (!job) return reply.code(404).send({ error: 'Job not found' })

    reply.send({ job })
  })

  // ===================================================================
  // INVESTMENTS
  // ===================================================================

  /**
   * GET /v1/portal/node-runner/investments
   */
  fastify.get('/v1/portal/node-runner/investments', async (request, reply) => {
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    const investments = await fastify.prisma.investment.findMany({
      where: { nodeRunnerId: nr.id },
      orderBy: { createdAt: 'desc' },
    })

    reply.send({ investments })
  })

  // ===================================================================
  // DEPLOYMENT REQUESTS
  // ===================================================================

  const GPU_PRICING: Record<string, number> = {
    H100: 2500, H200: 3125, L40S: 750, B200: 5250, B300: 7500, GB300: 9000,
  }

  const deploySchema = z.object({
    gpuTier: z.enum(['H100', 'H200', 'L40S', 'B200', 'B300', 'GB300', 'CONSUMER', 'RTX_4090', 'RTX_3090']),
    nodeCount: z.number().int().min(1).max(5).default(1),
    // Payment source. USDC default keeps existing on-chain path working.
    // BUYER_BALANCE debits the operator's pre-loaded credit (same wallet
    // the buyer side uses for rentals — unified balance) and generates
    // a synthetic BAL:<investmentId> txHash so the Investment row stays
    // identifiable in audits.
    paymentSource: z.enum(['USDC', 'BUYER_BALANCE']).default('USDC'),
    // txHash only required for USDC payments. BUYER_BALANCE rentals
    // omit it; server generates BAL:<id> post-insert.
    txHash: z.string().min(1).optional(),
    cryptoAmount: z.number().positive().optional(),
    cryptoCurrency: z.string().default('SOL'),
    deploymentNote: z.string().max(500).optional(),
  }).refine(
    d => d.paymentSource !== 'USDC' || (d.txHash && d.txHash.length > 0),
    { message: 'txHash is required for USDC payments', path: ['txHash'] },
  )

  /**
   * POST /v1/portal/node-runner/deploy — Request a new node deployment
   */
  fastify.post('/v1/portal/node-runner/deploy', async (request, reply) => {
    // SECURITY (A8, 2026-06-11): validate the request body BEFORE
    // touching DB. The previous flow created the operator NodeRunner
    // profile as a side-effect of any /deploy hit, then validated; a
    // POST {} would 400 but leave an orphan operator profile. That
    // profile was the no-payment primitive for the A7 fake-GPU
    // flooding chain (claim BYOG token + heartbeat without ever
    // funding a deployment). Validate first, then create.
    const parsed = deploySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', message: parsed.error.errors.map(e => e.message).join(', ') })
    }

    let nr = await getNodeRunnerForUser(fastify, request.user!.userId)

    // Auto-create NodeRunner profile if user doesn't have one. Safe to
    // do here because the body has already validated above; a 400
    // never reaches this point so orphan profiles can't be minted.
    if (!nr) {
      const user = await fastify.prisma.user.findUnique({ where: { id: request.user!.userId } })
      if (!user) return reply.code(404).send({ error: 'User not found' })

      nr = await fastify.prisma.nodeRunner.create({
        data: {
          name: user.email?.split('@')[0] ?? 'Node Runner',
          email: user.email,
          walletAddress: user.walletAddress ?? `pending-${user.id}`,
          userId: user.id,
        },
      })
    }

    const { gpuTier, nodeCount, txHash, cryptoAmount, cryptoCurrency, deploymentNote, paymentSource } = parsed.data
    const unitPrice = GPU_PRICING[gpuTier] ?? 2500
    const totalAmount = unitPrice * nodeCount
    const userId = request.user!.userId

    let investment
    if (paymentSource === 'BUYER_BALANCE') {
      // Mirror the buyer-compute BUYER_BALANCE path: create placeholder
      // Investment, debit the balance (which writes the SPEND_DEPLOYMENT
      // ledger entry), then flip the txHash to BAL:<id>. The debit is
      // transactional inside the service; on InsufficientBalanceError
      // we delete the orphan Investment so state stays clean.
      const placeholder = await fastify.prisma.investment.create({
        data: {
          nodeRunnerId: nr.id,
          amount: totalAmount,
          currency: 'USD',
          nodeCount,
          gpuTier: gpuTier as import('@a2e/database').GpuTier,
          txHash: 'BAL:PENDING',
          txConfirmed: true,
          deploymentNote,
          status: 'DEPLOYMENT_REQUESTED',
          confirmedAt: new Date(),
          deploymentRequestedAt: new Date(),
        },
      })
      try {
        await debitBalance(fastify.prisma, {
          userId,
          amountUsd: totalAmount,
          type: 'SPEND_DEPLOYMENT',
          description: `Deploy ${nodeCount}x ${gpuTier} node`,
          referenceId: placeholder.id,
        })
      } catch (err) {
        await fastify.prisma.investment.delete({ where: { id: placeholder.id } })
        if (err instanceof InsufficientBalanceError) {
          return reply.code(402).send({
            error: 'Payment Required',
            message: err.message,
            required: err.requestedAmount,
            available: err.currentBalance,
            topupHint: 'Top up at /balance.',
          })
        }
        throw err
      }
      investment = await fastify.prisma.investment.update({
        where: { id: placeholder.id },
        data: { txHash: `BAL:${placeholder.id}` },
      })
    } else {
      // USDC path. The txHash MUST be verified end-to-end:
      //   - exists + finalized
      //   - credits AT LEAST totalAmount in USDC to the treasury wallet
      // This closes pen-test finding A2E_AUTOPAYOUT_DRAIN step 2 where
      // a bogus txHash like '1'*88 forged a paid $2500/unit deployment
      // with txConfirmed=true. Test/dev fast-paths preserved inside
      // verifyUsdcDeposit (DEV_/test_ prefixes auto-verify).
      const isTestTx = txHash!.startsWith('test_')
      const solanaConfig = await getSolanaConfig(fastify.prisma)
      const verification = await verifyUsdcDeposit(solanaConfig, txHash!, totalAmount)
      if (!verification.verified) {
        return reply.code(400).send({
          error: 'tx_unverified',
          message: verification.error ?? 'Transaction could not be verified on-chain.',
          required: totalAmount,
          observed: verification.observedAmountUsd ?? 0,
        })
      }

      investment = await fastify.prisma.investment.create({
        data: {
          nodeRunnerId: nr.id,
          amount: totalAmount,
          currency: 'USD',
          nodeCount,
          gpuTier: gpuTier as import('@a2e/database').GpuTier,
          txHash: isTestTx ? `TEST:${txHash}` : txHash!,
          txConfirmed: true,
          cryptoAmount,
          cryptoCurrency,
          deploymentNote,
          status: 'DEPLOYMENT_REQUESTED',
          confirmedAt: new Date(),
          deploymentRequestedAt: new Date(),
        },
      })
    }

    // Notify all admin users about the new deployment request
    const adminUsers = await fastify.prisma.user.findMany({
      where: { role: 'ADMIN' },
      select: { id: true },
    })
    for (const admin of adminUsers) {
      void createNotification(
        admin.id,
        'DEPLOYMENT_REQUESTED',
        'New Deployment Request',
        `${nr.name} requested ${nodeCount}x ${gpuTier} node deployment ($${totalAmount}).`,
      )
    }

    // Auto-mint a BYOG install token + persist it on the Investment.
    // Self-serve fast path: operator immediately sees the curl one-liner
    // on the deployment detail page, no admin gate. Best-effort: if the
    // mint fails (e.g. transient DB issue), the Investment row still
    // exists and admin can fall back to the manual /v1/byog/issue-token
    // endpoint to recover.
    let installCommand: string | null = null
    try {
      const minted = await mintInstallTokenForRunner(fastify.prisma, {
        nodeRunnerId: nr.id,
      })
      await fastify.prisma.investment.update({
        where: { id: investment.id },
        data: { installToken: minted.token },
      })
      installCommand = minted.installCommand
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[deploy] auto-mint install token failed for investment', investment.id, err)
    }

    reply.code(201).send({
      id: investment.id,
      gpuTier: investment.gpuTier,
      nodeCount: investment.nodeCount,
      amount: investment.amount,
      status: investment.status,
      txHash: investment.txHash,
      installCommand,
      createdAt: investment.createdAt.toISOString(),
    })
  })

  /**
   * POST /v1/portal/node-runner/deploy/stripe/checkout
   *
   * Card-payment alternative to the on-chain deploy path. Computes the
   * same per-node price (GPU_PRICING * nodeCount) and creates a Stripe
   * Hosted Checkout session. The webhooks-stripe handler creates the
   * Investment row after Stripe confirms payment server-side; we don't
   * pre-create one here, so a cancelled checkout leaves nothing to
   * clean up.
   */
  const deployStripeSchema = z.object({
    gpuTier: z.enum(['H100', 'H200', 'L40S', 'B200', 'B300', 'GB300', 'CONSUMER', 'RTX_4090', 'RTX_3090']),
    nodeCount: z.number().int().min(1).max(5).default(1),
    deploymentNote: z.string().max(500).optional(),
  })

  fastify.post('/v1/portal/node-runner/deploy/stripe/checkout', async (request, reply) => {
    if (!isStripeConfigured()) {
      return reply.code(503).send({
        error: 'stripe_not_configured',
        message: 'Card payments are not available. Use the on-chain payment option instead.',
      })
    }

    let nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) {
      const user = await fastify.prisma.user.findUnique({ where: { id: request.user!.userId } })
      if (!user) return reply.code(404).send({ error: 'User not found' })
      nr = await fastify.prisma.nodeRunner.create({
        data: {
          name: user.email?.split('@')[0] ?? 'Node Runner',
          email: user.email,
          walletAddress: user.walletAddress ?? `pending-${user.id}`,
          userId: user.id,
        },
      })
    }

    const parsed = deployStripeSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', message: parsed.error.errors.map(e => e.message).join(', ') })
    }

    const { gpuTier, nodeCount, deploymentNote } = parsed.data
    const unitPrice = GPU_PRICING[gpuTier] ?? 2500
    const totalAmount = unitPrice * nodeCount

    const user = await fastify.prisma.user.findUnique({
      where: { id: request.user!.userId },
      select: { email: true },
    })

    try {
      const session = await createOperatorDeployCheckoutSession({
        userId: request.user!.userId,
        nodeRunnerId: nr.id,
        email: user?.email ?? null,
        amountUsd: totalAmount,
        gpuTier,
        nodeCount,
        deploymentNote: deploymentNote ?? null,
        successUrl: `${PORTAL_URL}/deploy?stripe=success`,
        cancelUrl: `${PORTAL_URL}/deploy?stripe=cancelled`,
      })
      reply.send({ id: session.id, url: session.url })
    } catch (e) {
      reply.code(500).send({
        error: 'stripe_session_failed',
        message: e instanceof Error ? e.message : 'Failed to create Stripe session',
      })
    }
  })

  /**
   * GET /v1/portal/node-runner/deployments — List deployment requests
   */
  fastify.get('/v1/portal/node-runner/deployments', async (request, reply) => {
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    const deployments = await fastify.prisma.investment.findMany({
      where: {
        nodeRunnerId: nr.id,
        status: { in: ['DEPLOYMENT_REQUESTED', 'DEPLOYING', 'PROVISIONED'] },
      },
      orderBy: { createdAt: 'desc' },
    })

    reply.send({ deployments })
  })

  /**
   * GET /v1/portal/node-runner/deployments/:id — Deployment detail
   */
  fastify.get('/v1/portal/node-runner/deployments/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    const deployment = await fastify.prisma.investment.findFirst({
      where: { id, nodeRunnerId: nr.id },
    })
    if (!deployment) return reply.code(404).send({ error: 'Deployment not found' })

    // If provisioning is in progress, get the ProvisionJob status
    let provisionStatus = null
    if (deployment.provisionJobId) {
      provisionStatus = await fastify.prisma.provisionJob.findUnique({
        where: { id: deployment.provisionJobId },
        select: { status: true, currentStep: true, totalSteps: true, currentAction: true, error: true },
      })
    }

    // If provisioned, get the node details
    let node = null
    if (deployment.nodeId) {
      node = await fastify.prisma.node.findUnique({
        where: { id: deployment.nodeId },
        select: { id: true, status: true, gpuTier: true, lastHeartbeat: true, agentVersion: true },
      })
    }

    // If the auto-mint at payment time captured a BYOG token, rebuild
    // the curl one-liner from it so the frontend can show it directly.
    // Rebuilt server-side so we can swap install-script delivery in
    // future (CDN, mirror, etc.) without touching the client.
    const installApiBase = process.env.A2E_API_URL || 'https://a2e-api.onrender.com'
    const installCommand = deployment.installToken
      ? `curl -fsSL ${installApiBase}/v1/byog/install?token=${deployment.installToken} | bash`
      : null

    reply.send({ deployment, provisionStatus, node, installCommand })
  })

  // ===================================================================
  // C7 wave 1: TAX / 1099 EXPORT
  // ===================================================================

  /**
   * GET /v1/portal/node-runner/tax-info
   * Returns the operator's tax-form data (or empty strings if W-9 has
   * never been submitted). taxId is returned MASKED for read paths;
   * the full value lives in the DB column.
   */
  fastify.get('/v1/portal/node-runner/tax-info', async (request, reply) => {
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    const last4 = nr.taxId ? nr.taxId.replace(/\D/g, '').slice(-4) : ''
    reply.send({
      legalName: nr.legalName ?? '',
      taxIdType: nr.taxIdType ?? null,
      taxIdLast4: last4,                            // for read-back display only
      taxIdSubmitted: Boolean(nr.taxId),
      taxAddress: nr.taxAddress ?? '',
      taxJurisdiction: nr.taxJurisdiction ?? 'US',
      w9SubmittedAt: nr.w9SubmittedAt?.toISOString() ?? null,
    })
  })

  const taxInfoSchema = z.object({
    legalName: z.string().min(1).max(120),
    taxIdType: z.enum(['SSN', 'EIN']),
    // Loose validation: 9 digits with optional dashes. Accepts the
    // common SSN format (XXX-XX-XXXX) and EIN format (XX-XXXXXXX) plus
    // raw 9-digit input.
    taxId: z.string().regex(/^\d{3}-?\d{2}-?\d{4}$|^\d{2}-?\d{7}$|^\d{9}$/, 'TIN must be 9 digits, with or without dashes'),
    taxAddress: z.string().min(1).max(500),
    taxJurisdiction: z.string().length(2).default('US'),
  })

  /**
   * PATCH /v1/portal/node-runner/tax-info
   * Save (or update) the operator's W-9 / tax-form data. On success
   * sets w9SubmittedAt = now() so the tax-year CSV header reflects
   * that the operator self-attested.
   */
  fastify.patch('/v1/portal/node-runner/tax-info', async (request, reply) => {
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    const parsed = taxInfoSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: parsed.error.errors.map((e) => e.message).join(', '),
      })
    }
    const data = parsed.data

    const updated = await fastify.prisma.nodeRunner.update({
      where: { id: nr.id },
      data: {
        legalName: data.legalName,
        taxId: data.taxId,
        taxIdType: data.taxIdType as TaxIdType,
        taxAddress: data.taxAddress,
        taxJurisdiction: data.taxJurisdiction,
        w9SubmittedAt: new Date(),
      },
    })

    reply.send({
      ok: true,
      w9SubmittedAt: updated.w9SubmittedAt?.toISOString() ?? null,
    })
  })

  /**
   * GET /v1/portal/node-runner/tax/year/:year
   * Download a CSV with the operator's per-month earnings for the
   * given tax year, pre-filled with W-9 fields if submitted. Suitable
   * for handing to a CPA for 1099-MISC prep. 400 if year is in the
   * future; 404 if the operator has no completed settlements in that
   * year (avoids downloading a blank CSV).
   */
  // ===================================================================
  // C4 wave 1: BENCHMARK TRIGGER (operator → API → agent)
  // ===================================================================

  /**
   * POST /v1/portal/node-runner/nodes/:id/benchmark
   *
   * Operator clicks "Run Benchmark" on /nodes/<id>. We verify the
   * node belongs to them, write a Config row with key
   * `benchmark:request:<nodeId>` (one-shot flag), and return 202.
   * The agent picks up the action on its next heartbeat (≤30s), runs
   * the benchmark, and reports back via /v1/nodes/:id/benchmark/result
   * which clears the flag.
   *
   * Rate-limited via the lastBenchmarkAt column: if a benchmark
   * completed less than 5 minutes ago, return 429 to discourage
   * accidental double-clicks. Set BENCHMARK_COOLDOWN_MS env to tune.
   */
  fastify.post<{ Params: { id: string } }>(
    '/v1/portal/node-runner/nodes/:id/benchmark',
    async (request, reply) => {
      const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
      if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

      const { id } = request.params
      const node = await verifyNodeOwnership(fastify, id, nr.id)
      if (!node) return reply.code(404).send({ error: 'Node not found or not owned by you' })

      // Cooldown — accidental double-click protection. 5 min default.
      const cooldownMs = Number(process.env.BENCHMARK_COOLDOWN_MS ?? 5 * 60 * 1000)
      if (node.lastBenchmarkAt && Date.now() - node.lastBenchmarkAt.getTime() < cooldownMs) {
        const waitSec = Math.ceil((cooldownMs - (Date.now() - node.lastBenchmarkAt.getTime())) / 1000)
        return reply.code(429).send({
          error: 'Cooldown',
          message: `Last benchmark ran less than ${Math.round(cooldownMs / 60000)} min ago. Try again in ${waitSec}s.`,
        })
      }

      // Write the one-shot Config flag. Upsert with empty string value
      // = use the agent's default image. Future: store an image tag
      // override here for canary deployments.
      await fastify.prisma.config.upsert({
        where: { key: `benchmark:request:${id}` },
        create: { key: `benchmark:request:${id}`, value: '' },
        update: { value: '' },
      })

      return reply.code(202).send({
        nodeId: id,
        message: 'Benchmark queued. Agent will run on next heartbeat (~30s); result lands within ~2-5 min depending on first-time image pull.',
      })
    },
  )

  fastify.get<{ Params: { year: string } }>(
    '/v1/portal/node-runner/tax/year/:year',
    async (request, reply) => {
      const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
      if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

      const year = parseInt(request.params.year, 10)
      const thisYear = new Date().getUTCFullYear()
      if (!Number.isFinite(year) || year < 2020 || year > thisYear) {
        return reply.code(400).send({
          error: 'Invalid year',
          message: `Year must be between 2020 and ${thisYear}`,
        })
      }

      const { csv, operatorName, total } = await generateTaxYearCsv(
        fastify.prisma,
        nr.id,
        { year },
      )

      if (total === 0) {
        return reply.code(404).send({
          error: 'No earnings',
          message: `No completed settlements found for tax year ${year}`,
        })
      }

      const safeOperator = operatorName.toLowerCase().replace(/[^a-z0-9]/g, '-')
      reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${safeOperator}-tax-${year}.csv"`)
        .send(csv)
    },
  )

  // ===================================================================
  // T3.2: Stripe Connect — operator USD payouts to bank
  // ===================================================================
  // Three endpoints:
  //   POST /v1/portal/node-runner/stripe/connect/onboard
  //     Creates a Connect Express account if the operator doesn't have
  //     one, then returns a one-time hosted onboarding URL. The
  //     operator completes KYC + bank info on Stripe's side and
  //     returns to the portal. Re-callable: if the operator's
  //     onboarding lapsed, this regenerates a fresh link against the
  //     same account.
  //   GET /v1/portal/node-runner/stripe/connect/status
  //     Polls Stripe for the current state of the operator's account.
  //     Returns details_submitted + transfers capability + payouts
  //     enabled, so the UI can show "Connect Stripe", "Finish
  //     onboarding", or "Ready to receive USD".
  //   POST /v1/portal/node-runner/stripe/connect/disconnect
  //     Clears the operator's Connect account id from our row. Stripe-
  //     side account is left in place (operator can keep it / use it
  //     elsewhere); we just stop using it for payouts.

  fastify.post('/v1/portal/node-runner/stripe/connect/onboard', async (request, reply) => {
    if (!isStripeConfigured()) {
      return reply.code(503).send({ error: 'stripe_not_configured', message: 'Card payouts are not enabled on this deploy.' })
    }
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    const user = await fastify.prisma.user.findUnique({
      where: { id: nr.userId ?? '' },
      select: { email: true },
    })
    const emailForStripe = user?.email ?? nr.email

    let accountId = nr.stripeConnectAccountId
    try {
      if (!accountId) {
        const { id } = await createConnectAccount({ email: emailForStripe })
        accountId = id
        await fastify.prisma.nodeRunner.update({
          where: { id: nr.id },
          data: { stripeConnectAccountId: accountId, stripeConnectStatus: 'CREATED' },
        })
      }

      const PORTAL = process.env.PORTAL_URL ?? 'https://user.tokenos.ai'
      const { url } = await createConnectOnboardingLink({
        accountId,
        returnUrl: `${PORTAL}/node-runner/payouts?stripe_connect=success`,
        refreshUrl: `${PORTAL}/node-runner/payouts?stripe_connect=refresh`,
      })
      return reply.send({ accountId, onboardingUrl: url })
    } catch (err) {
      fastify.log.error({ err, nodeRunnerId: nr.id }, 'stripe connect onboard failed')
      return reply.code(500).send({ error: 'stripe_connect_failed', message: (err as Error).message })
    }
  })

  fastify.get('/v1/portal/node-runner/stripe/connect/status', async (request, reply) => {
    if (!isStripeConfigured()) {
      return reply.send({ configured: false })
    }
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })

    if (!nr.stripeConnectAccountId) {
      return reply.send({
        configured: true,
        connected: false,
      })
    }

    try {
      const status = await getConnectAccountStatus(nr.stripeConnectAccountId)
      const summary = status.transfersActive && status.payoutsEnabled
        ? 'READY'
        : status.detailsSubmitted
          ? 'PENDING_REVIEW'
          : 'CREATED'
      // Keep our cached status field in sync with Stripe-side reality
      // so admin dashboards + payout flows can branch without an extra
      // round trip on every check.
      if (summary !== nr.stripeConnectStatus) {
        await fastify.prisma.nodeRunner.update({
          where: { id: nr.id },
          data: { stripeConnectStatus: summary },
        })
      }
      return reply.send({
        configured: true,
        connected: true,
        accountId: nr.stripeConnectAccountId,
        summary,
        detailsSubmitted: status.detailsSubmitted,
        transfersActive: status.transfersActive,
        payoutsEnabled: status.payoutsEnabled,
        requirementsCurrentlyDue: status.requirementsCurrentlyDue,
      })
    } catch (err) {
      fastify.log.error({ err, nodeRunnerId: nr.id }, 'stripe connect status failed')
      return reply.code(500).send({ error: 'stripe_status_failed', message: (err as Error).message })
    }
  })

  fastify.post('/v1/portal/node-runner/stripe/connect/disconnect', async (request, reply) => {
    const nr = await getNodeRunnerForUser(fastify, request.user!.userId)
    if (!nr) return reply.code(404).send({ error: 'No node runner profile found' })
    await fastify.prisma.nodeRunner.update({
      where: { id: nr.id },
      data: { stripeConnectAccountId: null, stripeConnectStatus: null },
    })
    return reply.send({ ok: true })
  })
}
