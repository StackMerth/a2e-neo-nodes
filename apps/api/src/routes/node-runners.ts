import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { GpuTier, InvestmentStatus } from '@a2e/database'
import { calculateUptimeEarnings, getDailyUptimeBreakdown, getGpuTierRate } from '../services/earnings/uptime-calculator'
import { notifyInvestmentConfirmed, notifyInvestmentProvisioned } from '../services/notification/service.js'
import { mintInstallTokenForRunner } from './byog.js'

// Schemas
const createNodeRunnerSchema = z.object({
  name: z.string().min(1).max(128),
  email: z.string().email().optional(),
  walletAddress: z.string().min(1).max(128),
})

const createInvestmentSchema = z.object({
  nodeRunnerId: z.string().min(1),
  amount: z.number().positive(),
  currency: z.string().default('USD'),
  cryptoAmount: z.number().positive().optional(),
  cryptoCurrency: z.string().optional(),
  txHash: z.string().optional(),
  gpuTier: z.enum(['H100', 'H200', 'L40S', 'B200', 'B300', 'GB300', 'OTHER', 'CONSUMER', 'RTX_4090', 'RTX_3090']),
})

const confirmInvestmentSchema = z.object({
  txHash: z.string().min(1),
  cryptoAmount: z.number().positive().optional(),
  cryptoCurrency: z.string().optional(),
})

// Admin payout-lock body. lockedUntil = ISO string or null to clear.
// Reason is surfaced to the operator on the locked-payout error message.
const payoutLockSchema = z.object({
  lockedUntil: z.string().datetime().nullable(),
  reason: z.string().max(500).optional(),
})

export async function nodeRunnerRoutes(fastify: FastifyInstance) {
  // ==================== NODE RUNNERS ====================

  // GET /v1/node-runners - List node runners (scoped per role)
  fastify.get(
    '/v1/node-runners',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      // SECURITY (pen-test A1 2026-06-10): the original list endpoint
      // returned every operator's name + email + walletAddress +
      // totalInvested to any authenticated caller (including a fresh
      // free NODE_RUNNER token). Cross-tenant PII leak.
      //
      // Fix: admins see everything (support tooling); non-admins see
      // only their OWN NodeRunner row (filtered by userId). The list
      // shape is unchanged so the existing portal UI still works for
      // each role; non-admin users see a 1-row list of their own
      // record.
      const userId = request.user!.userId
      const isAdmin = request.user!.role === 'ADMIN'

      const where = isAdmin ? {} : { userId }

      const nodeRunners = await fastify.prisma.nodeRunner.findMany({
        where,
        include: {
          nodes: {
            select: { id: true, gpuTier: true, status: true },
          },
          investments: {
            select: { id: true, amount: true, status: true, gpuTier: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      })

      reply.send({
        nodeRunners: nodeRunners.map((nr) => ({
          id: nr.id,
          name: nr.name,
          email: nr.email,
          walletAddress: nr.walletAddress,
          nodeCount: nr.nodes.length,
          totalInvested: nr.investments.reduce((sum, inv) => sum + inv.amount, 0),
          createdAt: nr.createdAt.toISOString(),
        })),
        total: nodeRunners.length,
      })
    }
  )

  // POST /v1/node-runners - Create a node runner
  fastify.post(
    '/v1/node-runners',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const parseResult = createNodeRunnerSchema.safeParse(request.body)

      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: parseResult.error.errors[0]?.message ?? 'Invalid input',
        })
      }

      const { name, email, walletAddress } = parseResult.data

      // Check for existing wallet address
      const existing = await fastify.prisma.nodeRunner.findUnique({
        where: { walletAddress },
      })

      if (existing) {
        return reply.code(409).send({
          error: 'Conflict',
          message: 'Node runner with this wallet address already exists',
        })
      }

      const nodeRunner = await fastify.prisma.nodeRunner.create({
        data: { name, email, walletAddress },
      })

      reply.code(201).send({
        id: nodeRunner.id,
        name: nodeRunner.name,
        email: nodeRunner.email,
        walletAddress: nodeRunner.walletAddress,
        createdAt: nodeRunner.createdAt.toISOString(),
      })
    }
  )

  // GET /v1/node-runners/:id - Get node runner details with ROI
  fastify.get(
    '/v1/node-runners/:id',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const nodeRunner = await fastify.prisma.nodeRunner.findUnique({
        where: { id },
        include: {
          nodes: {
            select: {
              id: true,
              walletAddress: true,
              gpuTier: true,
              status: true,
              createdAt: true,
            },
          },
          investments: true,
        },
      })

      // SECURITY (pen-test A1 2026-06-10): byId previously returned the
      // full financials (totalInvested, totalEarnings, totalPayouts,
      // netPosition, ROI) + email + walletAddress + payoutLockReason +
      // investment txHashes for ENUMERABLE foreign ids. Non-admin
      // callers must only see their own row. Return 404 (not 403) for
      // foreign ids so the response is indistinguishable from a row
      // that doesn't exist — no existence oracle.
      const userId = request.user!.userId
      const isAdmin = request.user!.role === 'ADMIN'
      if (!nodeRunner || (!isAdmin && nodeRunner.userId !== userId)) {
        return reply.code(404).send({ error: 'Node runner not found' })
      }

      // Calculate total invested
      const totalInvested = nodeRunner.investments.reduce((sum, inv) => sum + inv.amount, 0)

      // Calculate total earnings from all nodes
      let totalEarnings = 0
      const nodeEarnings: {
        nodeId: string
        gpuTier: string
        uptimeHours: number
        earnings: number
      }[] = []

      for (const node of nodeRunner.nodes) {
        const earnings = await calculateUptimeEarnings(
          fastify.prisma,
          node.id,
          node.createdAt,
          new Date()
        )

        if (earnings) {
          totalEarnings += earnings.earnings
          nodeEarnings.push({
            nodeId: node.id,
            gpuTier: node.gpuTier,
            uptimeHours: earnings.uptimeHours,
            earnings: earnings.earnings,
          })
        }
      }

      // Get total payouts (completed settlements)
      const completedSettlements = await fastify.prisma.settlement.findMany({
        where: {
          nodeId: { in: nodeRunner.nodes.map((n) => n.id) },
          status: 'COMPLETED',
        },
        select: { amount: true },
      })

      const totalPayouts = completedSettlements.reduce((sum, s) => sum + s.amount, 0)

      // Calculate ROI
      const netEarnings = totalEarnings - totalInvested
      const roiPercentage = totalInvested > 0 ? (netEarnings / totalInvested) * 100 : 0
      const pendingPayout = totalEarnings - totalPayouts

      reply.send({
        id: nodeRunner.id,
        name: nodeRunner.name,
        email: nodeRunner.email,
        walletAddress: nodeRunner.walletAddress,
        createdAt: nodeRunner.createdAt.toISOString(),

        // Payout lock (admin hard-hold during disputes). Both fields
        // are null in the steady state. When lockedUntil is in the
        // future, the worker + Withdraw Now refuse payouts for this
        // operator.
        payoutLockUntil: nodeRunner.payoutLockUntil?.toISOString() ?? null,
        payoutLockReason: nodeRunner.payoutLockReason ?? null,

        // Financial summary
        financials: {
          totalInvested: Math.round(totalInvested * 100) / 100,
          totalEarnings: Math.round(totalEarnings * 100) / 100,
          totalPayouts: Math.round(totalPayouts * 100) / 100,
          pendingPayout: Math.round(pendingPayout * 100) / 100,
          netPosition: Math.round(netEarnings * 100) / 100,
          roiPercentage: Math.round(roiPercentage * 100) / 100,
        },

        // Nodes owned
        nodes: nodeRunner.nodes.map((n) => ({
          id: n.id,
          gpuTier: n.gpuTier,
          status: n.status,
          createdAt: n.createdAt.toISOString(),
        })),

        // Node earnings breakdown
        nodeEarnings,

        // Investment history
        investments: nodeRunner.investments.map((inv) => ({
          id: inv.id,
          amount: inv.amount,
          currency: inv.currency,
          cryptoAmount: inv.cryptoAmount,
          cryptoCurrency: inv.cryptoCurrency,
          txHash: inv.txHash,
          gpuTier: inv.gpuTier,
          status: inv.status,
          createdAt: inv.createdAt.toISOString(),
          confirmedAt: inv.confirmedAt?.toISOString() ?? null,
          provisionedAt: inv.provisionedAt?.toISOString() ?? null,
        })),
      })
    }
  )

  // GET /v1/node-runners/:id/roi - Detailed ROI breakdown
  fastify.get(
    '/v1/node-runners/:id/roi',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const { days = '30' } = request.query as { days?: string }

      const nodeRunner = await fastify.prisma.nodeRunner.findUnique({
        where: { id },
        include: {
          nodes: { select: { id: true, gpuTier: true, createdAt: true } },
          investments: { select: { amount: true, createdAt: true, status: true } },
        },
      })

      // SECURITY (pen-test A1 2026-06-10): ROI breakdown surfaces
      // operator financials (investment totals, earnings history, ROI
      // trajectory) which is the same PII class as the byId route. Same
      // owner-or-admin gate, same 404-not-403 to avoid existence oracle.
      const userId = request.user!.userId
      const isAdmin = request.user!.role === 'ADMIN'
      if (!nodeRunner || (!isAdmin && nodeRunner.userId !== userId)) {
        return reply.code(404).send({ error: 'Node runner not found' })
      }

      // Get daily breakdown for all nodes
      const dailyBreakdown: Map<string, { uptimeHours: number; earnings: number }> = new Map()

      for (const node of nodeRunner.nodes) {
        const daily = await getDailyUptimeBreakdown(fastify.prisma, node.id, parseInt(days, 10))

        for (const day of daily) {
          const existing = dailyBreakdown.get(day.date) ?? { uptimeHours: 0, earnings: 0 }
          existing.uptimeHours += day.uptimeHours
          existing.earnings += day.earnings
          dailyBreakdown.set(day.date, existing)
        }
      }

      // Convert to array
      const dailyData = Array.from(dailyBreakdown.entries())
        .map(([date, data]) => ({
          date,
          uptimeHours: Math.round(data.uptimeHours * 100) / 100,
          earnings: Math.round(data.earnings * 100) / 100,
        }))
        .sort((a, b) => a.date.localeCompare(b.date))

      // Calculate cumulative totals
      const totalInvested = nodeRunner.investments.reduce((sum, inv) => sum + inv.amount, 0)
      const totalEarnings = dailyData.reduce((sum, d) => sum + d.earnings, 0)
      const totalUptimeHours = dailyData.reduce((sum, d) => sum + d.uptimeHours, 0)

      // Project future earnings (based on average daily)
      const avgDailyEarnings = dailyData.length > 0 ? totalEarnings / dailyData.length : 0
      const daysToBreakeven = avgDailyEarnings > 0 ? Math.ceil((totalInvested - totalEarnings) / avgDailyEarnings) : null
      const projectedMonthlyEarnings = avgDailyEarnings * 30
      const projectedYearlyEarnings = avgDailyEarnings * 365

      reply.send({
        nodeRunnerId: nodeRunner.id,
        period: {
          days: parseInt(days, 10),
          start: dailyData[0]?.date ?? null,
          end: dailyData[dailyData.length - 1]?.date ?? null,
        },

        summary: {
          totalInvested: Math.round(totalInvested * 100) / 100,
          totalEarnings: Math.round(totalEarnings * 100) / 100,
          totalUptimeHours: Math.round(totalUptimeHours * 100) / 100,
          avgDailyEarnings: Math.round(avgDailyEarnings * 100) / 100,
          roiPercentage: totalInvested > 0 ? Math.round(((totalEarnings - totalInvested) / totalInvested) * 10000) / 100 : 0,
        },

        projections: {
          daysToBreakeven: daysToBreakeven && daysToBreakeven > 0 ? daysToBreakeven : null,
          projectedMonthlyEarnings: Math.round(projectedMonthlyEarnings * 100) / 100,
          projectedYearlyEarnings: Math.round(projectedYearlyEarnings * 100) / 100,
        },

        daily: dailyData,
      })
    }
  )

  // GET /v1/node-runners/wallet/:walletAddress - Get node runner by wallet (for portal login)
  fastify.get(
    '/v1/node-runners/wallet/:walletAddress',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { walletAddress } = request.params as { walletAddress: string }

      const nodeRunner = await fastify.prisma.nodeRunner.findUnique({
        where: { walletAddress },
        select: {
          id: true,
          name: true,
          email: true,
          walletAddress: true,
        },
      })

      if (!nodeRunner) {
        return reply.code(404).send({ error: 'Node runner not found' })
      }

      reply.send(nodeRunner)
    }
  )

  // PATCH /v1/node-runners/:id - Update node runner
  fastify.patch(
    '/v1/node-runners/:id',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const { name, email, walletAddress } = request.body as {
        name?: string
        email?: string
        walletAddress?: string
      }

      const existing = await fastify.prisma.nodeRunner.findUnique({
        where: { id },
      })

      if (!existing) {
        return reply.code(404).send({ error: 'Node runner not found' })
      }

      // Check wallet address uniqueness if changing
      if (walletAddress && walletAddress !== existing.walletAddress) {
        const walletExists = await fastify.prisma.nodeRunner.findUnique({
          where: { walletAddress },
        })
        if (walletExists) {
          return reply.code(409).send({
            error: 'Conflict',
            message: 'Another node runner with this wallet address already exists',
          })
        }
      }

      const updated = await fastify.prisma.nodeRunner.update({
        where: { id },
        data: {
          ...(name && { name }),
          ...(email !== undefined && { email: email || null }),
          ...(walletAddress && { walletAddress }),
        },
      })

      reply.send({
        id: updated.id,
        name: updated.name,
        email: updated.email,
        walletAddress: updated.walletAddress,
        updatedAt: updated.updatedAt.toISOString(),
      })
    }
  )

  // DELETE /v1/node-runners/:id - Delete node runner
  fastify.delete(
    '/v1/node-runners/:id',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const existing = await fastify.prisma.nodeRunner.findUnique({
        where: { id },
        include: {
          nodes: { select: { id: true } },
          investments: { where: { status: { not: 'CANCELLED' } }, select: { id: true } },
        },
      })

      if (!existing) {
        return reply.code(404).send({ error: 'Node runner not found' })
      }

      // Prevent deletion if they have active nodes
      if (existing.nodes.length > 0) {
        return reply.code(400).send({
          error: 'Cannot Delete',
          message: `Node runner has ${existing.nodes.length} active node(s). Remove nodes first.`,
        })
      }

      // Prevent deletion if they have non-cancelled investments
      if (existing.investments.length > 0) {
        return reply.code(400).send({
          error: 'Cannot Delete',
          message: `Node runner has ${existing.investments.length} active investment(s). Cancel investments first.`,
        })
      }

      await fastify.prisma.nodeRunner.delete({
        where: { id },
      })

      reply.code(204).send()
    }
  )

  // ==================== INVESTMENTS ====================

  // POST /v1/investments - Record a new investment
  //
  // SECURITY (N-2, 2026-06-13 HIGH): the previous implementation
  // stamped `status: txHash ? 'PAID' : 'PENDING'` from the
  // client-supplied txHash with no verification, no role check, and
  // no ownership check. A buyer token + foreign nodeRunnerId +
  // fabricated txHash returned 201 status=PAID for any amount.
  // Same forgery class as the A9/B3 deploy/rent fixes; never
  // back-ported to this route.
  //
  // Hardened to mirror the deploy/rent flow:
  //   - authenticate (was there)
  //   - require ADMIN role (this is a back-office record path; buyers
  //     don't book investments via this endpoint, the deploy/checkout
  //     flow does)
  //   - verify USDC on-chain via verifyUsdcDeposit (for USDC payments)
  //   - claim txHash in the global ConsumedTxHash ledger (N-5)
  //   - leave status PENDING when no on-chain proof
  fastify.post(
    '/v1/investments',
    {
      preHandler: [fastify.authenticate, fastify.requireRole('ADMIN')],
    },
    async (request, reply) => {
      const parseResult = createInvestmentSchema.safeParse(request.body)

      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: parseResult.error.errors[0]?.message ?? 'Invalid input',
        })
      }

      const { nodeRunnerId, amount, currency, cryptoAmount, cryptoCurrency, txHash, gpuTier } = parseResult.data

      // Verify node runner exists
      const nodeRunner = await fastify.prisma.nodeRunner.findUnique({
        where: { id: nodeRunnerId },
      })

      if (!nodeRunner) {
        return reply.code(404).send({ error: 'Node runner not found' })
      }

      // If a txHash is supplied, verify it on chain (USDC) and claim
      // it in the global ConsumedTxHash ledger before marking PAID.
      // Stale / synthetic / dev-test hashes that pass the prefix
      // bypass in non-prod still go through the verifier so the
      // status reflects real verification state.
      let verifiedPaid = false
      let senderWallet: string | null = null
      let observedAmountUsd = amount
      if (txHash && (cryptoCurrency ?? 'USDC').toUpperCase() === 'USDC') {
        const { getSolanaConfig, verifyUsdcDeposit } = await import(
          '../services/payment/solana.js'
        )
        const solanaConfig = await getSolanaConfig(fastify.prisma)
        const verification = await verifyUsdcDeposit(
          solanaConfig,
          txHash,
          amount,
        )
        if (!verification.verified) {
          return reply.code(402).send({
            error: 'Payment Required',
            message:
              verification.error ??
              'Could not verify USDC payment on-chain.',
            submittedTxHash: txHash,
            expectedAmountUsd: amount,
          })
        }
        verifiedPaid = true
        senderWallet = verification.sender ?? null
        observedAmountUsd = verification.observedAmountUsd ?? amount

        // Claim globally (N-5).
        try {
          await fastify.prisma.consumedTxHash.create({
            data: {
              txHash,
              consumedFor: 'INVESTMENT_USDC',
              consumedByUserId: request.user?.userId ?? null,
              senderWallet,
              observedAmountUsd,
            },
          })
        } catch (consumeErr) {
          const e = consumeErr as { code?: string }
          if (e?.code === 'P2002') {
            return reply.code(409).send({
              error: 'tx_hash_already_consumed',
              message: 'This deposit has already been claimed.',
              submittedTxHash: txHash,
            })
          }
          throw consumeErr
        }
      }

      const investment = await fastify.prisma.investment.create({
        data: {
          nodeRunnerId,
          amount,
          currency,
          cryptoAmount,
          cryptoCurrency,
          txHash,
          gpuTier: gpuTier as GpuTier,
          status: verifiedPaid ? 'PAID' : 'PENDING',
          confirmedAt: verifiedPaid ? new Date() : null,
        },
      })

      reply.code(201).send({
        id: investment.id,
        nodeRunnerId: investment.nodeRunnerId,
        amount: investment.amount,
        currency: investment.currency,
        gpuTier: investment.gpuTier,
        status: investment.status,
        txHash: investment.txHash,
        createdAt: investment.createdAt.toISOString(),
      })
    }
  )

  // POST /v1/investments/:id/confirm - Confirm payment received
  //
  // SECURITY (N-2 follow-on, 2026-06-13): same forgery class as the
  // create route. Now gated on ADMIN and verifies USDC on-chain
  // (with global ConsumedTxHash claim) before flipping status to PAID.
  fastify.post(
    '/v1/investments/:id/confirm',
    {
      preHandler: [fastify.authenticate, fastify.requireRole('ADMIN')],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const parseResult = confirmInvestmentSchema.safeParse(request.body)

      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: parseResult.error.errors[0]?.message ?? 'Invalid input',
        })
      }

      const { txHash, cryptoAmount, cryptoCurrency } = parseResult.data

      const investment = await fastify.prisma.investment.findUnique({
        where: { id },
      })

      if (!investment) {
        return reply.code(404).send({ error: 'Investment not found' })
      }

      if (investment.status !== 'PENDING') {
        return reply.code(400).send({
          error: 'Invalid Status',
          message: `Investment is ${investment.status}, cannot confirm`,
        })
      }

      // Verify USDC payment on chain + claim globally.
      if ((cryptoCurrency ?? 'USDC').toUpperCase() === 'USDC') {
        const { getSolanaConfig, verifyUsdcDeposit } = await import(
          '../services/payment/solana.js'
        )
        const solanaConfig = await getSolanaConfig(fastify.prisma)
        const verification = await verifyUsdcDeposit(
          solanaConfig,
          txHash,
          investment.amount,
        )
        if (!verification.verified) {
          return reply.code(402).send({
            error: 'Payment Required',
            message: verification.error ?? 'Could not verify USDC payment on-chain.',
            submittedTxHash: txHash,
            expectedAmountUsd: investment.amount,
          })
        }
        try {
          await fastify.prisma.consumedTxHash.create({
            data: {
              txHash,
              consumedFor: 'INVESTMENT_USDC',
              consumedByUserId: request.user?.userId ?? null,
              senderWallet: verification.sender ?? null,
              observedAmountUsd: verification.observedAmountUsd ?? investment.amount,
            },
          })
        } catch (consumeErr) {
          const e = consumeErr as { code?: string }
          if (e?.code === 'P2002') {
            return reply.code(409).send({
              error: 'tx_hash_already_consumed',
              message: 'This deposit has already been claimed.',
              submittedTxHash: txHash,
            })
          }
          throw consumeErr
        }
      }

      const updated = await fastify.prisma.investment.update({
        where: { id },
        data: {
          status: 'PAID',
          txHash,
          txConfirmed: true,
          cryptoAmount,
          cryptoCurrency,
          confirmedAt: new Date(),
        },
      })

      // Send notification to node runner
      void notifyInvestmentConfirmed(id)

      reply.send({
        id: updated.id,
        status: updated.status,
        txHash: updated.txHash,
        confirmedAt: updated.confirmedAt?.toISOString(),
      })
    }
  )

  // POST /v1/investments/:id/link-node - Link investment to a provisioned node
  fastify.post(
    '/v1/investments/:id/link-node',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const { nodeId } = request.body as { nodeId: string }

      if (!nodeId) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: 'nodeId is required',
        })
      }

      const investment = await fastify.prisma.investment.findUnique({
        where: { id },
        include: { nodeRunner: true },
      })

      if (!investment) {
        return reply.code(404).send({ error: 'Investment not found' })
      }

      if (investment.status !== 'PAID') {
        return reply.code(400).send({
          error: 'Invalid Status',
          message: 'Investment must be PAID before linking to a node',
        })
      }

      const node = await fastify.prisma.node.findUnique({
        where: { id: nodeId },
      })

      if (!node) {
        return reply.code(404).send({ error: 'Node not found' })
      }

      // Link node to node runner and update investment
      await fastify.prisma.$transaction([
        fastify.prisma.node.update({
          where: { id: nodeId },
          data: { nodeRunnerId: investment.nodeRunnerId },
        }),
        fastify.prisma.investment.update({
          where: { id },
          data: {
            status: 'PROVISIONED',
            nodeId,
            provisionedAt: new Date(),
          },
        }),
      ])

      // Send notification to node runner
      void notifyInvestmentProvisioned(id)

      reply.send({
        investmentId: id,
        nodeId,
        nodeRunnerId: investment.nodeRunnerId,
        status: 'PROVISIONED',
        message: 'Node linked to investment successfully',
      })
    }
  )

  // POST /v1/investments/:id/cancel - Cancel a pending investment
  fastify.post(
    '/v1/investments/:id/cancel',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const investment = await fastify.prisma.investment.findUnique({
        where: { id },
      })

      if (!investment) {
        return reply.code(404).send({ error: 'Investment not found' })
      }

      if (investment.status !== 'PENDING') {
        return reply.code(400).send({
          error: 'Invalid Status',
          message: `Cannot cancel investment with status ${investment.status}. Only PENDING investments can be cancelled.`,
        })
      }

      const updated = await fastify.prisma.investment.update({
        where: { id },
        data: { status: 'CANCELLED' },
      })

      reply.send({
        id: updated.id,
        status: updated.status,
        message: 'Investment cancelled successfully',
      })
    }
  )

  // POST /v1/investments/:id/regenerate-install-token - Admin: mint a
  // fresh BYOG install token for this deployment. Used when the
  // auto-minted token was consumed by the wrong machine, expired, or
  // never created (legacy rows pre-auto-mint). Returns the new
  // installCommand the admin can copy-and-run.
  fastify.post(
    '/v1/investments/:id/regenerate-install-token',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const investment = await fastify.prisma.investment.findUnique({
        where: { id },
        select: { id: true, nodeRunnerId: true, status: true },
      })
      if (!investment) {
        return reply.code(404).send({ error: 'Investment not found' })
      }
      // Only mint for deployments still waiting on hardware. Past
      // PROVISIONED / CANCELLED there's no use case.
      if (
        investment.status !== 'DEPLOYMENT_REQUESTED' &&
        investment.status !== 'PAID' &&
        investment.status !== 'DEPLOYING'
      ) {
        return reply.code(400).send({
          error: 'Invalid Status',
          message: `Cannot regenerate install token for status ${investment.status}.`,
        })
      }

      const minted = await mintInstallTokenForRunner(fastify.prisma, {
        nodeRunnerId: investment.nodeRunnerId,
      })
      await fastify.prisma.investment.update({
        where: { id },
        data: { installToken: minted.token },
      })

      reply.send({
        id,
        installToken: minted.token,
        installCommand: minted.installCommand,
        expiresAt: minted.expiresAt.toISOString(),
      })
    }
  )

  // GET /v1/investments - List all investments
  fastify.get(
    '/v1/investments',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { status, nodeRunnerId } = request.query as {
        status?: InvestmentStatus
        nodeRunnerId?: string
      }

      const where: Record<string, unknown> = {}
      if (status) where.status = status
      if (nodeRunnerId) where.nodeRunnerId = nodeRunnerId

      const investments = await fastify.prisma.investment.findMany({
        where,
        include: {
          nodeRunner: { select: { name: true, walletAddress: true } },
        },
        orderBy: { createdAt: 'desc' },
      })

      const installApiBase = process.env.A2E_API_URL || 'https://a2e-api.onrender.com'
      reply.send({
        investments: investments.map((inv) => ({
          id: inv.id,
          nodeRunnerName: inv.nodeRunner.name,
          walletAddress: inv.nodeRunner.walletAddress,
          amount: inv.amount,
          currency: inv.currency,
          cryptoAmount: inv.cryptoAmount,
          cryptoCurrency: inv.cryptoCurrency,
          txHash: inv.txHash,
          gpuTier: inv.gpuTier,
          status: inv.status,
          nodeId: inv.nodeId,
          createdAt: inv.createdAt.toISOString(),
          confirmedAt: inv.confirmedAt?.toISOString() ?? null,
          provisionedAt: inv.provisionedAt?.toISOString() ?? null,
          // Auto-minted BYOG install token + ready-to-run curl command
          // so the admin can copy it from the dashboard when provisioning
          // a procured server. Rebuilt server-side so install-script
          // delivery can swap without touching the admin client.
          installToken: inv.installToken,
          installCommand: inv.installToken
            ? `curl -fsSL ${installApiBase}/v1/byog/install?token=${inv.installToken} | bash`
            : null,
        })),
        total: investments.length,
      })
    }
  )

  // PATCH /v1/node-runners/:id/payout-lock — admin-applied hard hold
  // on this operator's payouts. While lockedUntil is in the future,
  // the settlement worker skips them entirely AND Withdraw Now returns
  // 403 with the lockedUntil + reason so the operator sees what's
  // happening. Used by support during buyer disputes / fraud probes.
  fastify.patch(
    '/v1/node-runners/:id/payout-lock',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const parsed = payoutLockSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: parsed.error.errors[0]?.message ?? 'Invalid input',
        })
      }

      const existing = await fastify.prisma.nodeRunner.findUnique({
        where: { id },
        select: { id: true },
      })
      if (!existing) {
        return reply.code(404).send({ error: 'Node runner not found' })
      }

      const updated = await fastify.prisma.nodeRunner.update({
        where: { id },
        data: {
          payoutLockUntil: parsed.data.lockedUntil ? new Date(parsed.data.lockedUntil) : null,
          // Clear the reason when the lock is cleared so a future
          // lock starts with a fresh note rather than an old one.
          payoutLockReason: parsed.data.lockedUntil ? parsed.data.reason ?? null : null,
        },
        select: {
          id: true,
          payoutLockUntil: true,
          payoutLockReason: true,
        },
      })

      reply.send({
        nodeRunnerId: updated.id,
        lockedUntil: updated.payoutLockUntil?.toISOString() ?? null,
        reason: updated.payoutLockReason,
      })
    }
  )
}
