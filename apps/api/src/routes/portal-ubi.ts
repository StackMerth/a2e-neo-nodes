/**
 * Operator-facing ZK-UBI portal routes.
 *
 * Operators see + manage their own nodes' ZK-UBI opt-in state, read
 * their accrued earnings, and trigger the opt-in/opt-out lifecycle.
 *
 * Auth: NODE_RUNNER role (or ADMIN). All routes enforce that the
 * caller owns the NodeRunner whose node they're acting on.
 *
 * Routes:
 *   GET  /v1/portal/ubi/status                     — overview for this operator
 *   GET  /v1/portal/ubi/earnings?cursor&limit      — paginated earnings history
 *   POST /v1/portal/ubi/opt-in                     — body: { nodeId, protocol?, consentVersion }
 *   POST /v1/portal/ubi/opt-out                    — body: { nodeId, protocol? }
 *   GET  /v1/portal/ubi/consent-text/:version      — the current ToS / disclosure text
 *
 * The opt-in path captures the consentVersion the operator accepted
 * so we can re-prompt later if we revise the ToS (e.g. add new
 * slashing exposure disclosure once M2.1 funds the real broker).
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

const UBI_PROTOCOLS = [
  'BOUNDLESS',
  'SUCCINCT',
  'BITTENSOR',
  'FILECOIN_C2',
  'ALEO',
  'STARKNET',
] as const

const optInSchema = z.object({
  nodeId: z.string().min(1),
  protocol: z.enum(UBI_PROTOCOLS).default('BOUNDLESS'),
  // Must match the latest CONSENT_VERSIONS entry for the protocol.
  // Reject if the operator submits an older version (forces a fresh
  // disclosure read).
  consentVersion: z.string().min(1),
  // Optional: operator declares free disk at opt-in. Used by future
  // protocols that need sector storage (Filecoin C2). Boundless
  // ignores it.
  declaredFreeDiskGb: z.number().int().positive().optional(),
})

const optOutSchema = z.object({
  nodeId: z.string().min(1),
  protocol: z.enum(UBI_PROTOCOLS).default('BOUNDLESS'),
})

const earningsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  nodeId: z.string().optional(),
})

/**
 * Consent texts. Bumping the version here forces operators to re-read
 * and re-accept on their next opt-in. Each protocol can ship its own
 * disclosure (Boundless has different slashing exposure than Aleo
 * mining, etc.).
 *
 * The runtime contract: opt-in submits a consentVersion string; the
 * route rejects if it doesn't match the latest version for that
 * protocol. This ensures we have an audit trail of "what the
 * operator was told at the moment they accepted."
 */
const CONSENT_VERSIONS: Record<string, { version: string; text: string }> = {
  BOUNDLESS: {
    version: 'boundless-v1-2026-06-14',
    text: `# ZK-UBI on Boundless — disclosure

By opting in, you authorize this node's idle GPU time to be used for
Boundless (RISC Zero ZKC) proof work when no rental buyer is using
your node. You will earn ZKC + ETH from accepted proofs.

How it works:
  - When your node is idle, our broker dispatches Boundless proof
    work to a Bento agent on your machine.
  - Each accepted proof pays the platform's wallet on Base.
  - The platform takes 5% as a service fee; 95% accrues to your USD
    balance at the spot rate at the moment of acceptance.
  - You can withdraw via the standard withdraw flow.

Risks:
  - Proof work uses GPU power; expect electricity cost.
  - If a Boundless order is locked but our broker fails to deliver
    in time, the platform absorbs the slashing risk. You are NOT
    exposed to direct slashing.
  - ZKC and ETH are volatile; we lock USD value at proof acceptance,
    not at withdraw, so your earned amount in USD is fixed once a
    proof is accepted.

You can opt out at any time. Opt-out takes effect within ~5 minutes
(the next broker dispatch tick).`,
  },
  SUCCINCT: { version: 'succinct-v0-pending', text: 'Succinct adapter not yet deployed.' },
  BITTENSOR: { version: 'bittensor-v0-pending', text: 'Bittensor adapter not yet deployed.' },
  FILECOIN_C2: { version: 'filecoin-v0-pending', text: 'Filecoin C2 not active for ZK-UBI.' },
  ALEO: { version: 'aleo-v0-pending', text: 'Aleo adapter not yet deployed.' },
  STARKNET: { version: 'starknet-v0-pending', text: 'StarkNet adapter not yet deployed.' },
}

export async function portalUbiRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate)
  fastify.addHook('preHandler', fastify.requireRole('NODE_RUNNER', 'ADMIN'))

  /**
   * Resolve the NodeRunner row owned by the authenticated user.
   * Returns null when the user has no NodeRunner attached (which
   * happens for ADMIN users who aren't dual-role).
   */
  async function getCallerNodeRunner(userId: string) {
    return fastify.prisma.nodeRunner.findUnique({
      where: { userId },
      select: { id: true, name: true },
    })
  }

  /**
   * Verify the caller owns the given node. Returns the node row when
   * ownership checks out, null when it doesn't.
   */
  async function getCallerOwnedNode(
    userId: string,
    nodeId: string,
    isAdmin: boolean,
  ) {
    const node = await fastify.prisma.node.findUnique({
      where: { id: nodeId },
      select: {
        id: true,
        nodeRunnerId: true,
        nodeRunner: { select: { userId: true } },
      },
    })
    if (!node) return null
    if (isAdmin) return node
    if (node.nodeRunner?.userId !== userId) return null
    return node
  }

  /**
   * GET /v1/portal/ubi/status — overview for the calling operator.
   *
   * Returns: per-node opt-in state, current consent versions, total
   * accrued earnings (ACCRUED + PAID), recent activity.
   */
  fastify.get('/v1/portal/ubi/status', async (request, reply) => {
    const userId = request.user!.userId
    const isAdmin = request.user!.role === 'ADMIN'

    const nodeRunner = await getCallerNodeRunner(userId)
    if (!nodeRunner) {
      return reply.send({
        ok: true,
        nodeRunner: null,
        nodes: [],
        totals: { accruedUsd: 0, paidUsd: 0 },
        consentVersions: Object.fromEntries(
          Object.entries(CONSENT_VERSIONS).map(([k, v]) => [k, v.version]),
        ),
      })
    }

    // All of this operator's nodes. We list all nodes regardless of
    // opt-in state so the UI can render an "opt in" CTA on nodes the
    // operator hasn't joined yet.
    const nodes = await fastify.prisma.node.findMany({
      where: { nodeRunnerId: nodeRunner.id },
      select: {
        id: true,
        walletAddress: true,
        gpuTier: true,
        status: true,
        ubiOptIns: {
          where: { status: 'ACTIVE' },
          select: {
            id: true,
            protocol: true,
            consentVersion: true,
            optedInAt: true,
          },
          orderBy: { optedInAt: 'desc' },
        },
      },
      orderBy: { id: 'asc' },
    })

    // Sum ACCRUED + PAID across all this operator's earnings rows.
    const earningsAgg = await fastify.prisma.ubiEarning.groupBy({
      by: ['status'],
      where: { nodeRunnerId: nodeRunner.id },
      _sum: { operatorUsd: true },
    })
    const totals = { accruedUsd: 0, paidUsd: 0 }
    for (const row of earningsAgg) {
      const sum = row._sum.operatorUsd ?? 0
      if (row.status === 'ACCRUED') totals.accruedUsd += sum
      if (row.status === 'PAID') totals.paidUsd += sum
    }
    totals.accruedUsd = Math.round(totals.accruedUsd * 10000) / 10000
    totals.paidUsd = Math.round(totals.paidUsd * 10000) / 10000

    // Recent earnings activity (last 10) for the dashboard ticker.
    const recentEarnings = await fastify.prisma.ubiEarning.findMany({
      where: { nodeRunnerId: nodeRunner.id },
      orderBy: { periodEnd: 'desc' },
      take: 10,
      select: {
        id: true,
        nodeId: true,
        protocol: true,
        periodStart: true,
        periodEnd: true,
        operatorUsd: true,
        status: true,
      },
    })

    // ADMIN sees a flag in the response (lets the portal UI surface
    // an "admin override" banner).
    reply.send({
      ok: true,
      isAdmin,
      nodeRunner: { id: nodeRunner.id, name: nodeRunner.name },
      nodes,
      totals,
      recentEarnings,
      consentVersions: Object.fromEntries(
        Object.entries(CONSENT_VERSIONS).map(([k, v]) => [k, v.version]),
      ),
    })
  })

  /**
   * GET /v1/portal/ubi/earnings — paginated earnings history.
   */
  fastify.get('/v1/portal/ubi/earnings', async (request, reply) => {
    const userId = request.user!.userId
    const isAdmin = request.user!.role === 'ADMIN'
    const parsed = earningsQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'validation_error',
        message: parsed.error.errors[0]?.message ?? 'invalid query',
      })
    }

    const nodeRunner = await getCallerNodeRunner(userId)
    if (!nodeRunner) {
      return reply.send({ ok: true, items: [], nextCursor: null })
    }

    // Optional filter to one specific node. Verify ownership.
    if (parsed.data.nodeId) {
      const node = await getCallerOwnedNode(userId, parsed.data.nodeId, isAdmin)
      if (!node) {
        return reply.code(403).send({
          error: 'forbidden',
          message: 'You do not own this node',
        })
      }
    }

    const where = {
      nodeRunnerId: nodeRunner.id,
      ...(parsed.data.nodeId ? { nodeId: parsed.data.nodeId } : {}),
      ...(parsed.data.cursor ? { id: { lt: parsed.data.cursor } } : {}),
    }

    const items = await fastify.prisma.ubiEarning.findMany({
      where,
      orderBy: [{ periodEnd: 'desc' }, { id: 'desc' }],
      take: parsed.data.limit + 1,
      select: {
        id: true,
        nodeId: true,
        protocol: true,
        periodStart: true,
        periodEnd: true,
        grossUsd: true,
        operatorUsd: true,
        platformUsd: true,
        status: true,
        availableAt: true,
        createdAt: true,
      },
    })

    const hasMore = items.length > parsed.data.limit
    const trimmed = hasMore ? items.slice(0, parsed.data.limit) : items
    const nextCursor = hasMore ? trimmed[trimmed.length - 1]?.id ?? null : null

    reply.send({ ok: true, items: trimmed, nextCursor })
  })

  /**
   * POST /v1/portal/ubi/opt-in
   *
   * Caller must own the node. consentVersion must match the latest
   * for the chosen protocol.
   */
  fastify.post('/v1/portal/ubi/opt-in', async (request, reply) => {
    const userId = request.user!.userId
    const isAdmin = request.user!.role === 'ADMIN'
    const parsed = optInSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'validation_error',
        message: parsed.error.errors[0]?.message ?? 'invalid body',
      })
    }

    const node = await getCallerOwnedNode(userId, parsed.data.nodeId, isAdmin)
    if (!node) {
      return reply.code(403).send({
        error: 'forbidden',
        message: 'You do not own this node',
      })
    }

    const expectedConsent = CONSENT_VERSIONS[parsed.data.protocol]
    if (!expectedConsent || expectedConsent.version !== parsed.data.consentVersion) {
      return reply.code(409).send({
        error: 'stale_consent',
        message: `Consent version ${parsed.data.consentVersion} is not the current one. Re-read the disclosure and accept ${expectedConsent?.version ?? 'the latest version'}.`,
        latestVersion: expectedConsent?.version ?? null,
      })
    }

    // Idempotent: existing ACTIVE row for this (node, protocol) wins.
    const existing = await fastify.prisma.nodeUbiOptIn.findFirst({
      where: {
        nodeId: parsed.data.nodeId,
        protocol: parsed.data.protocol,
        status: 'ACTIVE',
      },
      orderBy: { optedInAt: 'desc' },
    })
    if (existing) {
      return reply.send({
        ok: true,
        created: false,
        optInId: existing.id,
        protocol: existing.protocol,
        consentVersion: existing.consentVersion,
      })
    }

    const row = await fastify.prisma.nodeUbiOptIn.create({
      data: {
        nodeId: parsed.data.nodeId,
        protocol: parsed.data.protocol,
        status: 'ACTIVE',
        consentVersion: parsed.data.consentVersion,
        declaredFreeDiskGb: parsed.data.declaredFreeDiskGb,
      },
    })

    reply.send({
      ok: true,
      created: true,
      optInId: row.id,
      protocol: row.protocol,
      consentVersion: row.consentVersion,
    })
  })

  /**
   * POST /v1/portal/ubi/opt-out
   *
   * Flips all ACTIVE rows for the (node, protocol) to OPTED_OUT.
   * Idempotent.
   */
  fastify.post('/v1/portal/ubi/opt-out', async (request, reply) => {
    const userId = request.user!.userId
    const isAdmin = request.user!.role === 'ADMIN'
    const parsed = optOutSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'validation_error',
        message: parsed.error.errors[0]?.message ?? 'invalid body',
      })
    }

    const node = await getCallerOwnedNode(userId, parsed.data.nodeId, isAdmin)
    if (!node) {
      return reply.code(403).send({
        error: 'forbidden',
        message: 'You do not own this node',
      })
    }

    const updated = await fastify.prisma.nodeUbiOptIn.updateMany({
      where: {
        nodeId: parsed.data.nodeId,
        protocol: parsed.data.protocol,
        status: 'ACTIVE',
      },
      data: {
        status: 'OPTED_OUT',
        optedOutAt: new Date(),
      },
    })

    reply.send({ ok: true, optedOutCount: updated.count })
  })

  /**
   * GET /v1/portal/ubi/consent-text/:version
   *
   * Returns the consent text for a specific version. Used by the
   * portal to show the operator what they're accepting at opt-in time.
   * Unknown version returns 404.
   */
  fastify.get<{ Params: { version: string } }>(
    '/v1/portal/ubi/consent-text/:version',
    async (request, reply) => {
      const { version } = request.params
      const match = Object.entries(CONSENT_VERSIONS).find(
        ([, v]) => v.version === version,
      )
      if (!match) {
        return reply.code(404).send({
          error: 'unknown_consent_version',
          message: `No consent text registered for version ${version}`,
        })
      }
      const [protocol, entry] = match
      reply.send({ ok: true, protocol, version: entry.version, text: entry.text })
    },
  )

  /**
   * GET /v1/portal/ubi/consent-current/:protocol
   *
   * Returns the CURRENT consent text for a protocol. Portal calls
   * this when rendering the opt-in prompt.
   */
  fastify.get<{ Params: { protocol: string } }>(
    '/v1/portal/ubi/consent-current/:protocol',
    async (request, reply) => {
      const protocol = request.params.protocol.toUpperCase()
      const entry = CONSENT_VERSIONS[protocol]
      if (!entry) {
        return reply.code(404).send({
          error: 'unknown_protocol',
          message: `No consent registered for protocol ${protocol}`,
        })
      }
      reply.send({
        ok: true,
        protocol,
        version: entry.version,
        text: entry.text,
      })
    },
  )
}
