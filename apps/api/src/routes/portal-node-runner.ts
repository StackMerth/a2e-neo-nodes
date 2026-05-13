import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  calculateUptimeEarnings,
  getDailyUptimeBreakdown,
} from '../services/earnings/uptime-calculator.js'
import { createNotification } from '../services/notification/service.js'

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

    // Pending payout: earnings not yet withdrawn or in-flight
    const totalEarnings = earningsAgg._sum.earnings ?? 0
    const totalWithdrawn = withdrawnAgg._sum.amount ?? 0
    const pendingWithdrawal = pendingWithdrawalsAgg._sum.amount ?? 0
    const pendingPayout = Math.max(0, totalEarnings - totalWithdrawn - pendingWithdrawal)

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
  })

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

    const updated = await fastify.prisma.nodeRunner.update({
      where: { id: nr.id },
      data: parsed.data,
    })

    reply.send({ nodeRunner: updated })
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
    H100: 2500, H200: 3125, B200: 5250, B300: 7500, GB300: 9000,
  }

  const deploySchema = z.object({
    gpuTier: z.enum(['H100', 'H200', 'B200', 'B300', 'GB300']),
    nodeCount: z.number().int().min(1).max(5).default(1),
    txHash: z.string().min(1, 'Transaction hash is required'),
    cryptoAmount: z.number().positive().optional(),
    cryptoCurrency: z.string().default('SOL'),
    deploymentNote: z.string().max(500).optional(),
  })

  /**
   * POST /v1/portal/node-runner/deploy — Request a new node deployment
   */
  fastify.post('/v1/portal/node-runner/deploy', async (request, reply) => {
    let nr = await getNodeRunnerForUser(fastify, request.user!.userId)

    // Auto-create NodeRunner profile if user doesn't have one
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

    const parsed = deploySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', message: parsed.error.errors.map(e => e.message).join(', ') })
    }

    const { gpuTier, nodeCount, txHash, cryptoAmount, cryptoCurrency, deploymentNote } = parsed.data
    const unitPrice = GPU_PRICING[gpuTier] ?? 2500
    const totalAmount = unitPrice * nodeCount

    // Test mode: any txHash starting with 'test_' bypasses payment verification
    const isTestTx = txHash.startsWith('test_')

    const investment = await fastify.prisma.investment.create({
      data: {
        nodeRunnerId: nr.id,
        amount: totalAmount,
        currency: 'USD',
        nodeCount,
        gpuTier: gpuTier as import('@a2e/database').GpuTier,
        txHash: isTestTx ? `TEST:${txHash}` : txHash,
        txConfirmed: true,
        cryptoAmount,
        cryptoCurrency,
        deploymentNote,
        status: 'DEPLOYMENT_REQUESTED',
        confirmedAt: new Date(),
        deploymentRequestedAt: new Date(),
      },
    })

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

    reply.code(201).send({
      id: investment.id,
      gpuTier: investment.gpuTier,
      nodeCount: investment.nodeCount,
      amount: investment.amount,
      status: investment.status,
      txHash: investment.txHash,
      createdAt: investment.createdAt.toISOString(),
    })
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

    reply.send({ deployment, provisionStatus, node })
  })
}
