/**
 * Admin-side ZK-UBI routes.
 *
 * Two responsibilities:
 *   1. Operator opt-in lifecycle (admin can force-opt-in or
 *      suspend an operator who broke ToS).
 *   2. Simulator endpoints that drive the full ZK-UBI flow against
 *      synthetic events. Lets us test the operator dashboard,
 *      ledger, and payout split without a live Boundless deploy.
 *
 * Routes:
 *   POST /v1/admin/ubi/opt-in           — force-opt-in a node
 *   POST /v1/admin/ubi/opt-out          — set status=OPTED_OUT
 *   POST /v1/admin/ubi/simulate/proof   — inject a synthetic accepted proof
 *   POST /v1/admin/ubi/simulate/epoch   — roll up to a UbiEarning row
 *   POST /v1/admin/ubi/simulate/purge   — wipe simulator-tagged rows
 *   GET  /v1/admin/ubi/status           — overview: opt-ins, recent proofs, earnings
 *
 * All routes admin-gated via the plugin's preHandler hook.
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  simulateOptIn,
  simulateProofAccepted,
  simulateEpochClose,
  purgeSimulatorRows,
} from '../services/ubi/simulator.js'

const optInSchema = z.object({
  nodeId: z.string().min(1),
  protocol: z.enum(['BOUNDLESS', 'SUCCINCT', 'BITTENSOR', 'FILECOIN_C2', 'ALEO', 'STARKNET']).default('BOUNDLESS'),
})

const simulateProofSchema = z.object({
  nodeId: z.string().min(1),
  // Default: ~$1 worth of ETH per proof at the placeholder $3,500
  // /ETH spot. Override with a feeWei string to test bigger / smaller
  // proofs. Hex or decimal both accepted.
  feeWei: z.string().optional(),
  imageId: z.string().optional(),
  // Inject N proofs in one call; defaults to 1.
  count: z.number().int().min(1).max(100).default(1),
})

const simulateEpochSchema = z.object({
  nodeId: z.string().min(1),
})

export async function adminUbiRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate)
  fastify.addHook('preHandler', fastify.requireRole('ADMIN'))

  fastify.post('/v1/admin/ubi/opt-in', async (request, reply) => {
    const parsed = optInSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'validation_error',
        message: parsed.error.errors[0]?.message ?? 'invalid input',
      })
    }
    const result = await simulateOptIn(
      { prisma: fastify.prisma },
      { nodeId: parsed.data.nodeId, protocol: parsed.data.protocol },
    )
    reply.send({ ok: true, ...result })
  })

  fastify.post('/v1/admin/ubi/opt-out', async (request, reply) => {
    const parsed = optInSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'validation_error',
        message: parsed.error.errors[0]?.message ?? 'invalid input',
      })
    }
    const updated = await fastify.prisma.nodeUbiOptIn.updateMany({
      where: {
        nodeId: parsed.data.nodeId,
        protocol: parsed.data.protocol,
        status: 'ACTIVE',
      },
      data: { status: 'OPTED_OUT', optedOutAt: new Date() },
    })
    reply.send({ ok: true, optedOutCount: updated.count })
  })

  fastify.post('/v1/admin/ubi/simulate/proof', async (request, reply) => {
    const parsed = simulateProofSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'validation_error',
        message: parsed.error.errors[0]?.message ?? 'invalid input',
      })
    }
    const results: Array<{ accrued: boolean; reason?: string }> = []
    for (let i = 0; i < parsed.data.count; i++) {
      const res = await simulateProofAccepted(
        { prisma: fastify.prisma },
        {
          nodeId: parsed.data.nodeId,
          feeWei: parsed.data.feeWei,
          imageId: parsed.data.imageId,
        },
      )
      results.push(res)
    }
    const accrued = results.filter((r) => r.accrued).length
    reply.send({
      ok: true,
      requested: parsed.data.count,
      accrued,
      skipped: results.length - accrued,
      sample: results.slice(0, 5),
    })
  })

  fastify.post('/v1/admin/ubi/simulate/epoch', async (request, reply) => {
    const parsed = simulateEpochSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'validation_error',
        message: parsed.error.errors[0]?.message ?? 'invalid input',
      })
    }
    const result = await simulateEpochClose(
      { prisma: fastify.prisma },
      { nodeId: parsed.data.nodeId },
    )
    reply.send({ ok: true, ...result })
  })

  fastify.post('/v1/admin/ubi/simulate/purge', async (_request, reply) => {
    const result = await purgeSimulatorRows({ prisma: fastify.prisma })
    reply.send({ ok: true, ...result })
  })

  fastify.get('/v1/admin/ubi/status', async (_request, reply) => {
    const [
      activeOptInsByProtocol,
      recentProofs,
      recentEarnings,
      protocolSummary,
    ] = await Promise.all([
      fastify.prisma.nodeUbiOptIn.groupBy({
        by: ['protocol'],
        where: { status: 'ACTIVE' },
        _count: { _all: true },
      }),
      fastify.prisma.ubiProof.findMany({
        orderBy: { acceptedAt: 'desc' },
        take: 25,
        select: {
          id: true,
          nodeId: true,
          protocol: true,
          aggregator: true,
          externalProofId: true,
          status: true,
          grossUsd: true,
          acceptedAt: true,
        },
      }),
      fastify.prisma.ubiEarning.findMany({
        orderBy: { periodEnd: 'desc' },
        take: 25,
        select: {
          id: true,
          nodeId: true,
          nodeRunnerId: true,
          protocol: true,
          periodStart: true,
          periodEnd: true,
          grossUsd: true,
          operatorUsd: true,
          platformUsd: true,
          status: true,
        },
      }),
      fastify.prisma.ubiProof.groupBy({
        by: ['protocol', 'status'],
        _count: { _all: true },
        _sum: { grossUsd: true },
      }),
    ])

    reply.send({
      ok: true,
      activeOptIns: activeOptInsByProtocol,
      recentProofs,
      recentEarnings,
      protocolSummary,
    })
  })
}
