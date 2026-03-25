import type { FastifyInstance } from 'fastify'
import {
  generateCSV,
  earningsColumns,
  settlementsColumns,
  jobsColumns,
  nodesColumns,
  type EarningsCSVRow,
  type SettlementsCSVRow,
  type JobsCSVRow,
  type NodesCSVRow,
} from '../services/reports/csv-generator'
import {
  generateStatementHTML,
  generateInvoiceHTML,
  type StatementData,
} from '../services/reports/pdf-generator'

export async function reportsRoutes(fastify: FastifyInstance) {
  // GET /v1/reports/earnings/csv - Earnings CSV export
  fastify.get(
    '/v1/reports/earnings/csv',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { startDate, endDate, nodeId } = request.query as {
        startDate?: string
        endDate?: string
        nodeId?: string
      }

      const where: Record<string, unknown> = {}
      if (nodeId) where.nodeId = nodeId
      if (startDate || endDate) {
        where.date = {}
        if (startDate) (where.date as Record<string, Date>).gte = new Date(startDate)
        if (endDate) (where.date as Record<string, Date>).lte = new Date(endDate)
      }

      const earnings = await fastify.prisma.earning.findMany({
        where,
        include: { node: { select: { walletAddress: true, gpuTier: true } } },
        orderBy: { date: 'desc' },
      })

      const rows: EarningsCSVRow[] = earnings.map((e) => ({
        date: e.date.toISOString().split('T')[0] as string,
        nodeId: e.nodeId,
        walletAddress: e.node.walletAddress,
        gpuTier: e.node.gpuTier,
        market: e.market,
        earnings: e.earnings,
        gpuHours: Math.round((e.gpuSeconds / 3600) * 100) / 100,
        jobCount: e.jobCount,
      }))

      const csv = generateCSV(rows, earningsColumns)

      reply
        .header('Content-Type', 'text/csv')
        .header(
          'Content-Disposition',
          `attachment; filename="earnings-${new Date().toISOString().split('T')[0]}.csv"`
        )
        .send(csv)
    }
  )

  // GET /v1/reports/settlements/csv - Settlements CSV export
  fastify.get(
    '/v1/reports/settlements/csv',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { startDate, endDate, nodeId, status } = request.query as {
        startDate?: string
        endDate?: string
        nodeId?: string
        status?: string
      }

      const where: Record<string, unknown> = {}
      if (nodeId) where.nodeId = nodeId
      if (status) where.status = status
      if (startDate || endDate) {
        where.createdAt = {}
        if (startDate) (where.createdAt as Record<string, Date>).gte = new Date(startDate)
        if (endDate) (where.createdAt as Record<string, Date>).lte = new Date(endDate)
      }

      const settlements = await fastify.prisma.settlement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
      })

      const rows: SettlementsCSVRow[] = settlements.map((s) => ({
        id: s.id,
        nodeId: s.nodeId,
        walletAddress: s.walletAddress,
        amount: s.amount,
        currency: s.currency,
        status: s.status,
        jobCount: s.jobCount,
        periodStart: s.periodStart.toISOString().split('T')[0] as string,
        periodEnd: s.periodEnd.toISOString().split('T')[0] as string,
        txHash: s.txHash ?? '',
        createdAt: s.createdAt.toISOString(),
        processedAt: s.processedAt?.toISOString() ?? '',
      }))

      const csv = generateCSV(rows, settlementsColumns)

      reply
        .header('Content-Type', 'text/csv')
        .header(
          'Content-Disposition',
          `attachment; filename="settlements-${new Date().toISOString().split('T')[0]}.csv"`
        )
        .send(csv)
    }
  )

  // GET /v1/reports/jobs/csv - Jobs CSV export
  fastify.get(
    '/v1/reports/jobs/csv',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { startDate, endDate, nodeId, status, market } = request.query as {
        startDate?: string
        endDate?: string
        nodeId?: string
        status?: string
        market?: string
      }

      const where: Record<string, unknown> = {}
      if (nodeId) where.nodeId = nodeId
      if (status) where.status = status
      if (market) where.market = market
      if (startDate || endDate) {
        where.requestedAt = {}
        if (startDate) (where.requestedAt as Record<string, Date>).gte = new Date(startDate)
        if (endDate) (where.requestedAt as Record<string, Date>).lte = new Date(endDate)
      }

      const jobs = await fastify.prisma.job.findMany({
        where,
        orderBy: { requestedAt: 'desc' },
        take: 10000,
      })

      const rows: JobsCSVRow[] = jobs.map((j) => ({
        id: j.id,
        deploymentId: j.deploymentId,
        nodeId: j.nodeId ?? '',
        gpuTier: j.gpuTier,
        market: j.market ?? '',
        status: j.status,
        ratePerHour: j.ratePerHour ?? 0,
        durationSeconds: j.durationSeconds ?? 0,
        earnings: j.earnings ?? 0,
        requestedAt: j.requestedAt.toISOString(),
        completedAt: j.completedAt?.toISOString() ?? '',
      }))

      const csv = generateCSV(rows, jobsColumns)

      reply
        .header('Content-Type', 'text/csv')
        .header(
          'Content-Disposition',
          `attachment; filename="jobs-${new Date().toISOString().split('T')[0]}.csv"`
        )
        .send(csv)
    }
  )

  // GET /v1/reports/nodes/csv - Nodes CSV export
  fastify.get(
    '/v1/reports/nodes/csv',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { status, gpuTier } = request.query as {
        status?: string
        gpuTier?: string
      }

      const where: Record<string, unknown> = {}
      if (status) where.status = status
      if (gpuTier) where.gpuTier = gpuTier

      const nodes = await fastify.prisma.node.findMany({
        where,
        include: {
          earnings: {
            select: { earnings: true, jobCount: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      })

      const rows: NodesCSVRow[] = nodes.map((n) => {
        const totals = n.earnings.reduce(
          (acc, e) => ({
            earnings: acc.earnings + e.earnings,
            jobs: acc.jobs + e.jobCount,
          }),
          { earnings: 0, jobs: 0 }
        )

        return {
          id: n.id,
          walletAddress: n.walletAddress,
          gpuTier: n.gpuTier,
          nodeType: n.nodeType,
          status: n.status,
          region: n.region ?? '',
          totalEarnings: Math.round(totals.earnings * 100) / 100,
          totalJobs: totals.jobs,
          createdAt: n.createdAt.toISOString(),
          lastHeartbeat: n.lastHeartbeat.toISOString(),
        }
      })

      const csv = generateCSV(rows, nodesColumns)

      reply
        .header('Content-Type', 'text/csv')
        .header(
          'Content-Disposition',
          `attachment; filename="nodes-${new Date().toISOString().split('T')[0]}.csv"`
        )
        .send(csv)
    }
  )

  // GET /v1/reports/statement/:nodeId - Generate statement HTML (can be converted to PDF)
  fastify.get(
    '/v1/reports/statement/:nodeId',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { nodeId } = request.params as { nodeId: string }
      const { startDate, endDate, days = '30' } = request.query as {
        startDate?: string
        endDate?: string
        days?: string
      }

      const node = await fastify.prisma.node.findUnique({
        where: { id: nodeId },
        select: { id: true, walletAddress: true, gpuTier: true },
      })

      if (!node) {
        return reply.code(404).send({ error: 'Node not found' })
      }

      let dateFrom = startDate ? new Date(startDate) : new Date()
      if (!startDate) {
        dateFrom.setDate(dateFrom.getDate() - parseInt(days, 10))
        dateFrom.setHours(0, 0, 0, 0)
      }
      const dateTo = endDate ? new Date(endDate) : new Date()

      const [earnings, settlements] = await Promise.all([
        fastify.prisma.earning.findMany({
          where: {
            nodeId,
            date: { gte: dateFrom, lte: dateTo },
          },
          orderBy: { date: 'desc' },
        }),
        fastify.prisma.settlement.findMany({
          where: {
            nodeId,
            createdAt: { gte: dateFrom, lte: dateTo },
          },
          orderBy: { createdAt: 'desc' },
        }),
      ])

      const totals = earnings.reduce(
        (acc, e) => ({
          earnings: acc.earnings + e.earnings,
          gpuSeconds: acc.gpuSeconds + e.gpuSeconds,
          jobs: acc.jobs + e.jobCount,
        }),
        { earnings: 0, gpuSeconds: 0, jobs: 0 }
      )

      const data: StatementData = {
        nodeId: node.id,
        walletAddress: node.walletAddress,
        gpuTier: node.gpuTier,
        periodStart: dateFrom.toISOString().split('T')[0] as string,
        periodEnd: dateTo.toISOString().split('T')[0] as string,
        totalEarnings: Math.round(totals.earnings * 100) / 100,
        totalJobs: totals.jobs,
        totalGpuHours: Math.round((totals.gpuSeconds / 3600) * 100) / 100,
        settlements: settlements.map((s) => ({
          id: s.id,
          amount: s.amount,
          status: s.status,
          txHash: s.txHash ?? undefined,
          processedAt: s.processedAt?.toISOString().split('T')[0],
        })),
        dailyEarnings: earnings.map((e) => ({
          date: e.date.toISOString().split('T')[0] as string,
          market: e.market,
          earnings: e.earnings,
          jobCount: e.jobCount,
        })),
      }

      const html = generateStatementHTML(data)

      reply.header('Content-Type', 'text/html').send(html)
    }
  )

  // GET /v1/reports/summary - Financial summary report
  fastify.get(
    '/v1/reports/summary',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { startDate, endDate, days = '30' } = request.query as {
        startDate?: string
        endDate?: string
        days?: string
      }

      let dateFrom = startDate ? new Date(startDate) : new Date()
      if (!startDate) {
        dateFrom.setDate(dateFrom.getDate() - parseInt(days, 10))
        dateFrom.setHours(0, 0, 0, 0)
      }
      const dateTo = endDate ? new Date(endDate) : new Date()

      const [earningsAgg, costsAgg, settlementsAgg, jobsCount, nodesCount] = await Promise.all([
        fastify.prisma.earning.aggregate({
          where: { date: { gte: dateFrom, lte: dateTo } },
          _sum: { earnings: true, gpuSeconds: true, jobCount: true },
        }),
        fastify.prisma.infrastructureCost.aggregate({
          where: { periodStart: { gte: dateFrom }, periodEnd: { lte: dateTo } },
          _sum: { amount: true },
        }),
        fastify.prisma.settlement.aggregate({
          where: { createdAt: { gte: dateFrom, lte: dateTo }, status: 'COMPLETED' },
          _sum: { amount: true },
          _count: true,
        }),
        fastify.prisma.job.count({
          where: { requestedAt: { gte: dateFrom, lte: dateTo } },
        }),
        fastify.prisma.node.count({
          where: { status: 'ONLINE' },
        }),
      ])

      const revenue = earningsAgg._sum.earnings ?? 0
      const costs = costsAgg._sum.amount ?? 0
      const settled = settlementsAgg._sum.amount ?? 0

      reply.send({
        period: {
          start: dateFrom.toISOString().split('T')[0],
          end: dateTo.toISOString().split('T')[0],
        },
        revenue: {
          total: Math.round(revenue * 100) / 100,
          gpuHours: Math.round(((earningsAgg._sum.gpuSeconds ?? 0) / 3600) * 100) / 100,
          jobCount: earningsAgg._sum.jobCount ?? 0,
        },
        costs: {
          total: Math.round(costs * 100) / 100,
        },
        profit: {
          gross: Math.round((revenue - costs) * 100) / 100,
          margin: revenue > 0 ? Math.round(((revenue - costs) / revenue) * 10000) / 100 : 0,
        },
        settlements: {
          completed: settlementsAgg._count,
          amount: Math.round(settled * 100) / 100,
        },
        activity: {
          totalJobs: jobsCount,
          activeNodes: nodesCount,
        },
      })
    }
  )
}
