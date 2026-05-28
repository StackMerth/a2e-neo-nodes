import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { GpuTier, NodeType, NodeStatus } from '@a2e/database'

/*
 * Launch-blocker #1 — BYOG one-liner install flow.
 *
 *   1. Operator clicks "+ Add Node" in the portal → POST /v1/byog/issue-token
 *      mints a one-shot InstallToken and returns the curl one-liner.
 *
 *   2. Operator copies the one-liner and runs it on their GPU machine:
 *         curl https://api.tokenos.ai/v1/byog/install?token=xxx | bash
 *      The install route (no auth) returns the install.sh content with the
 *      token, API URL, and region pre-substituted.
 *
 *   3. The install script detects GPU/system specs and calls POST
 *      /v1/byog/claim with the install token in the body. The route:
 *         - validates the token (exists, not expired, not consumed)
 *         - creates a Node row owned by the operator who minted the token
 *         - generates a permanent node-specific API key (a2e-node-…)
 *         - marks the InstallToken as consumed (one-shot)
 *         - returns {nodeId, apiKey, region} for the agent to persist
 *
 *   4. The node-agent then heartbeats to /v1/nodes/:nodeId/heartbeat using
 *      the permanent apiKey, same as any other BYOG node.
 *
 * Vendor flow (Akash/IO.net/Vast.ai) is wholly separate and never touches
 * any of these routes.
 */

const API_URL_DEFAULT = 'https://a2e-api.onrender.com'
const TOKEN_TTL_DAYS = 7

// install.sh lives in the node-agent workspace. Depending on whether the
// API process is launched from the repo root or from apps/api, the
// relative path differs. The first existing path wins. We also support
// an env-var override (A2E_INSTALL_SCRIPT_PATH) for non-standard layouts.
const INSTALL_SCRIPT_CANDIDATES = [
  process.env.A2E_INSTALL_SCRIPT_PATH,
  path.resolve(__dirname, '../../../node-agent/scripts/install.sh'),
  path.resolve(process.cwd(), 'apps/node-agent/scripts/install.sh'),
  path.resolve(process.cwd(), '../node-agent/scripts/install.sh'),
].filter((p): p is string => Boolean(p))

const REGION_REGEX = /^(US-WEST|US-EAST|EU|APAC|SA|OC)$/

const issueTokenSchema = z.object({
  region: z.string().regex(REGION_REGEX).optional(),
})

const claimSchema = z.object({
  installToken: z.string().min(16).max(64),
  specs: z.object({
    gpuTier: z.enum(['H100', 'H200', 'L40S', 'B200', 'B300', 'GB300', 'OTHER', 'CONSUMER', 'RTX_4090', 'RTX_3090']),
    gpuModel: z.string().optional(),
    gpuCount: z.number().optional(),
    gpuVram: z.number().optional(),
    gpuDriver: z.string().optional(),
    cudaVersion: z.string().optional(),
    hostname: z.string().optional(),
    os: z.string().optional(),
    osVersion: z.string().optional(),
    totalMemory: z.number().optional(),
    diskAvailable: z.number().optional(),
    totalCpus: z.number().optional(),
    dockerVersion: z.string().optional(),
    agentVersion: z.string().optional(),
  }),
})

function makeToken(): string {
  // 24 random bytes → 32 base64url chars. Plenty of entropy and stays
  // safe in URL query strings.
  return crypto.randomBytes(24).toString('base64url')
}

function makeNodeApiKey(): string {
  // Matches the `a2e-node-` prefix convention at nodes.ts:107 so the
  // existing X-API-Key handler recognizes it as a node-specific key.
  return `a2e-node-${crypto.randomBytes(20).toString('base64url')}`
}

function apiUrl(): string {
  return process.env.A2E_API_URL || API_URL_DEFAULT
}

/**
 * Reusable token-mint. Used by the manual `/v1/byog/issue-token`
 * endpoint AND by the operator deploy flow (USDC + BUYER_BALANCE +
 * Stripe), which auto-mints a token at payment-confirm so the
 * operator gets the curl one-liner without an admin gate.
 *
 * Returns the token + the ready-to-run install command + expiry.
 * Caller is responsible for surfacing those to the operator.
 */
export async function mintInstallTokenForRunner(
  prisma: import('@a2e/database').PrismaClient,
  args: { nodeRunnerId: string; region?: string },
): Promise<{ token: string; installCommand: string; expiresAt: Date }> {
  const token = makeToken()
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000)
  await prisma.installToken.create({
    data: {
      token,
      nodeRunnerId: args.nodeRunnerId,
      region: args.region,
      expiresAt,
    },
  })
  const installCommand = `curl -fsSL ${apiUrl()}/v1/byog/install?token=${token} | bash`
  return { token, installCommand, expiresAt }
}

export async function byogRoutes(fastify: FastifyInstance) {
  // -------------------------------------------------------------------
  // 1. Operator mints a one-shot install token from the portal.
  // -------------------------------------------------------------------
  fastify.post(
    '/v1/byog/issue-token',
    {
      preHandler: [fastify.authenticate, fastify.requireRole('NODE_RUNNER', 'ADMIN')],
    },
    async (request, reply) => {
      const parsed = issueTokenSchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: parsed.error.errors[0]?.message ?? 'Invalid input',
        })
      }

      const userId = request.user!.userId
      const nodeRunner = await fastify.prisma.nodeRunner.findUnique({
        where: { userId },
      })
      if (!nodeRunner) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'No node runner profile. Complete onboarding first.',
        })
      }

      const result = await mintInstallTokenForRunner(fastify.prisma, {
        nodeRunnerId: nodeRunner.id,
        region: parsed.data.region,
      })

      reply.code(201).send({
        token: result.token,
        installCommand: result.installCommand,
        expiresAt: result.expiresAt.toISOString(),
      })
    }
  )

  // -------------------------------------------------------------------
  // 2. Public install endpoint. Returns the install.sh with the token,
  //    API URL, and region pre-substituted as bash variables at the
  //    top of the file. No auth; the token IS the auth.
  // -------------------------------------------------------------------
  fastify.get<{ Querystring: { token?: string } }>(
    '/v1/byog/install',
    async (request, reply) => {
      const token = request.query.token?.trim()
      if (!token) {
        return reply
          .code(400)
          .type('text/plain')
          .send('# Missing ?token= query param.\nexit 1\n')
      }

      const row = await fastify.prisma.installToken.findUnique({
        where: { token },
      })
      if (!row) {
        return reply
          .code(404)
          .type('text/plain')
          .send('# Install token not found.\nexit 1\n')
      }
      if (row.consumedAt) {
        return reply
          .code(410)
          .type('text/plain')
          .send('# Install token already consumed.\nexit 1\n')
      }
      if (row.expiresAt < new Date()) {
        return reply
          .code(410)
          .type('text/plain')
          .send('# Install token expired; mint a fresh one from the portal.\nexit 1\n')
      }

      let scriptBody: string | null = null
      for (const candidate of INSTALL_SCRIPT_CANDIDATES) {
        try {
          scriptBody = await readFile(candidate, 'utf8')
          break
        } catch {
          // try the next candidate
        }
      }
      if (!scriptBody) {
        request.log.error(
          { candidates: INSTALL_SCRIPT_CANDIDATES },
          '[byog] install.sh not found in any candidate path'
        )
        return reply
          .code(500)
          .type('text/plain')
          .send('# install.sh not bundled with this deploy.\nexit 1\n')
      }

      // Inject the token + API URL + region as exported bash variables at
      // the top of the script. The script reads them and runs non-
      // interactively when they're set.
      const header = [
        '#!/usr/bin/env bash',
        `export INSTALL_TOKEN=${JSON.stringify(token)}`,
        `export A2E_API_URL=${JSON.stringify(apiUrl())}`,
        row.region ? `export A2E_REGION=${JSON.stringify(row.region)}` : '',
      ]
        .filter(Boolean)
        .join('\n')

      // Strip any existing shebang from the original script so our
      // injected header sits at line 1.
      const bodyWithoutShebang = scriptBody.replace(/^#!.*\n/, '')

      reply
        .code(200)
        .type('text/x-shellscript')
        .send(`${header}\n\n${bodyWithoutShebang}`)
    }
  )

  // -------------------------------------------------------------------
  // 3. Install script calls this with the token + detected specs.
  //    Validates the token, creates the Node row, issues a permanent
  //    api key, marks the token consumed.
  // -------------------------------------------------------------------
  fastify.post('/v1/byog/claim', async (request, reply) => {
    const parsed = claimSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: parsed.error.errors[0]?.message ?? 'Invalid input',
        details: parsed.error.errors,
      })
    }

    const { installToken, specs } = parsed.data

    const tokenRow = await fastify.prisma.installToken.findUnique({
      where: { token: installToken },
    })
    if (!tokenRow) {
      return reply.code(404).send({
        error: 'Not Found',
        message: 'Install token not found',
      })
    }
    if (tokenRow.consumedAt) {
      return reply.code(410).send({
        error: 'Gone',
        message: 'Install token already consumed',
      })
    }
    if (tokenRow.expiresAt < new Date()) {
      return reply.code(410).send({
        error: 'Gone',
        message: 'Install token expired',
      })
    }

    // Build a wallet identifier for the node. NodeRunner already owns a
    // Solana wallet; nodes underneath them get a synthetic identifier
    // derived from the hostname + a random suffix so multiple installs
    // on the same hostname don't collide on Node.walletAddress.
    const walletAddress = `byog-${specs.hostname ?? 'node'}-${crypto.randomBytes(4).toString('hex')}`
    const apiKey = makeNodeApiKey()

    // Atomic: create the Node and flip the InstallToken in one transaction
    // so we never leak a Node row with no consumer or a "consumed" token
    // without a Node.
    const node = await fastify.prisma.$transaction(async (tx) => {
      const created = await tx.node.create({
        data: {
          walletAddress,
          gpuTier: specs.gpuTier as GpuTier,
          nodeType: 'BYOG' as NodeType,
          region: tokenRow.region,
          nodeRunnerId: tokenRow.nodeRunnerId,
          apiKey,
          agentVersion: specs.agentVersion,
          status: 'ONLINE' as NodeStatus,
          lastHeartbeat: new Date(),
        },
      })

      await tx.installToken.update({
        where: { id: tokenRow.id },
        data: {
          consumedAt: new Date(),
          consumedByNodeId: created.id,
        },
      })

      return created
    })

    fastify.io?.emit('node:registered', {
      id: node.id,
      walletAddress: node.walletAddress,
      gpuTier: node.gpuTier,
      status: node.status,
      source: 'byog',
      timestamp: new Date().toISOString(),
    })

    reply.code(201).send({
      nodeId: node.id,
      apiKey,
      region: node.region,
    })
  })

  // -------------------------------------------------------------------
  // Admin install-token management. Lists every token the operator
  // pool has minted plus its lifecycle state, and offers a revoke
  // button for the typo case (wrong operator, leaked URL, expired
  // ad-hoc support session). Revoke is a soft kill — we set
  // expiresAt to the past rather than deleting the row, so the FK to
  // the resulting Node (consumedByNodeId) stays intact and the audit
  // trail is preserved.
  // -------------------------------------------------------------------
  fastify.get(
    '/v1/admin/install-tokens',
    {
      preHandler: [fastify.authenticate, fastify.requireRole('ADMIN')],
    },
    async (request, reply) => {
      const tokens = await fastify.prisma.installToken.findMany({
        orderBy: { createdAt: 'desc' },
        take: 200,
        include: {
          nodeRunner: { select: { id: true, name: true, email: true } },
        },
      })

      const now = Date.now()
      const rows = tokens.map((t) => {
        const expired = t.expiresAt.getTime() < now
        const consumed = !!t.consumedAt
        // Surface a single status string so the UI can stamp a badge
        // without re-deriving it. ACTIVE = mintable URL still works.
        const status: 'ACTIVE' | 'CONSUMED' | 'EXPIRED' = consumed
          ? 'CONSUMED'
          : expired
            ? 'EXPIRED'
            : 'ACTIVE'
        return {
          id: t.id,
          token: t.token,
          region: t.region,
          createdAt: t.createdAt.toISOString(),
          expiresAt: t.expiresAt.toISOString(),
          consumedAt: t.consumedAt?.toISOString() ?? null,
          consumedByNodeId: t.consumedByNodeId,
          status,
          nodeRunner: t.nodeRunner,
        }
      })

      reply.send({
        tokens: rows,
        counts: {
          active: rows.filter((r) => r.status === 'ACTIVE').length,
          consumed: rows.filter((r) => r.status === 'CONSUMED').length,
          expired: rows.filter((r) => r.status === 'EXPIRED').length,
          total: rows.length,
        },
      })
    }
  )

  fastify.delete<{ Params: { id: string } }>(
    '/v1/admin/install-tokens/:id',
    {
      preHandler: [fastify.authenticate, fastify.requireRole('ADMIN')],
    },
    async (request, reply) => {
      const { id } = request.params
      const row = await fastify.prisma.installToken.findUnique({ where: { id } })
      if (!row) {
        return reply.code(404).send({ error: 'Not Found', message: 'Install token not found' })
      }
      if (row.consumedAt) {
        // No revoke after claim — the node is already alive. Admin
        // should pause/delete the resulting node instead.
        return reply.code(409).send({
          error: 'Conflict',
          message: 'Token already consumed. Revoke the node instead.',
          consumedByNodeId: row.consumedByNodeId,
        })
      }

      // Soft revoke: expire the token immediately. The install route
      // already rejects expired tokens with a "mint a fresh one"
      // message, so this is the cheapest possible kill switch.
      const updated = await fastify.prisma.installToken.update({
        where: { id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      })

      reply.send({
        id: updated.id,
        revoked: true,
        expiresAt: updated.expiresAt.toISOString(),
      })
    }
  )
}
