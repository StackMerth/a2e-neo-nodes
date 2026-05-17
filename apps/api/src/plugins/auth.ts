// Authentication Plugin
// Supports:
//   - X-API-Key: admin global key, node-specific keys, buyer API keys
//   - Authorization: Bearer <JWT>
//       Portal users (role NODE_RUNNER, COMPUTE_BUYER) -> authType='user'
//       Admin (role ADMIN, issued by /v1/auth/login)   -> authType='admin'
//
// As of M1.4 the admin JWT uses the same scheme as portal users (signed
// by services/auth/jwt). The plugin distinguishes admin from regular
// users by inspecting payload.role, so the same verifyAccessToken call
// covers both cases.

import type { FastifyInstance, FastifyPluginCallback, FastifyRequest, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'
import { verifyAccessToken, type AccessTokenPayload } from '../services/auth/jwt.js'
import { isBuyerApiKey, verifyApiKey } from '../services/apikey/manager.js'
import type { UserRole } from '@a2e/database'

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
    requireRole: (...roles: UserRole[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
  interface FastifyRequest {
    authType?: 'admin' | 'node' | 'provision' | 'user'
    authNodeId?: string
    authProvisionId?: string
    user?: AccessTokenPayload
  }
}

const authPlugin: FastifyPluginCallback = async (fastify: FastifyInstance) => {
  const adminApiKey = process.env.API_KEY ?? 'a2e-dev-key-2026'

  /**
   * Main authenticate decorator — checks X-API-Key or Bearer token
   */
  async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    // Bearer token first. One verifier handles all roles: payload.role
    // distinguishes admin from compute buyer / node runner.
    const authHeader = request.headers.authorization
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7)
      try {
        const payload = verifyAccessToken(token)
        if (payload.role === 'ADMIN') {
          request.authType = 'admin'
          request.user = payload
        } else {
          request.authType = 'user'
          request.user = payload
        }
        return
      } catch {
        // Token invalid / expired / not a JWT. Fall through to X-API-Key.
      }
    }

    // Try X-API-Key (admin/node)
    const apiKey = request.headers['x-api-key'] as string | undefined

    if (!apiKey) {
      reply.code(401).send({
        error: 'Unauthorized',
        message: 'Missing authentication',
      })
      return
    }

    // Check admin API key
    if (apiKey === adminApiKey) {
      request.authType = 'admin'
      return
    }

    // Check node-specific API key
    if (apiKey.startsWith('a2e-node-')) {
      const node = await fastify.prisma.node.findUnique({
        where: { apiKey },
        select: { id: true },
      })

      if (node) {
        request.authType = 'node'
        request.authNodeId = node.id
        return
      }

      // Check pending provision jobs
      const provisionJob = await fastify.prisma.provisionJob.findUnique({
        where: { apiKey },
        select: { id: true, status: true },
      })

      if (provisionJob && provisionJob.status !== 'COMPLETED' && provisionJob.status !== 'FAILED') {
        request.authType = 'provision'
        request.authProvisionId = provisionJob.id
        return
      }
    }

    // Check buyer API key
    if (isBuyerApiKey(apiKey)) {
      const result = await verifyApiKey(apiKey)
      if (result) {
        request.authType = 'user'
        request.user = { userId: result.userId, role: result.role, type: 'access' }
        return
      }
    }

    reply.code(401).send({
      error: 'Unauthorized',
      message: 'Invalid credentials',
    })
  }

  /**
   * Role-based access control middleware factory.
   * Admin API key always passes (backward compat for dashboard).
   *
   * Dual-identity: the schema's isBuyer / isNodeRunner / isAdmin flags
   * (User model) can grant access even when the legacy `role` claim
   * doesn't match. The fast path checks role from the JWT alone; the
   * slow path falls back to a DB lookup of the flags. This is exactly
   * what the schema comment says day-to-day capability checks should
   * do, and unblocks users who signed up as one role and later opted
   * into a second one (e.g. operator opts in to buy compute).
   */
  function requireRole(...roles: UserRole[]) {
    return async function (request: FastifyRequest, reply: FastifyReply) {
      // Admin API key bypasses role check (existing dashboard auth)
      if (request.authType === 'admin') {
        return
      }

      // User must be authenticated via JWT
      if (request.authType !== 'user' || !request.user) {
        reply.code(403).send({
          error: 'Forbidden',
          message: 'Insufficient permissions',
        })
        return
      }

      // Fast path: legacy role claim matches — no DB hit.
      if (roles.includes(request.user.role)) {
        return
      }

      // Slow path: check dual-identity flags. Map each required role
      // to its corresponding boolean column. CUSTOMER is treated as
      // an alias of COMPUTE_BUYER (legacy seed data).
      const flagFor: Partial<Record<UserRole, 'isBuyer' | 'isNodeRunner' | 'isAdmin'>> = {
        COMPUTE_BUYER: 'isBuyer',
        CUSTOMER: 'isBuyer',
        NODE_RUNNER: 'isNodeRunner',
        ADMIN: 'isAdmin',
      }
      const flagsNeeded = roles
        .map((r) => flagFor[r])
        .filter((f): f is 'isBuyer' | 'isNodeRunner' | 'isAdmin' => Boolean(f))

      if (flagsNeeded.length > 0) {
        const user = await fastify.prisma.user.findUnique({
          where: { id: request.user.userId },
          select: { isBuyer: true, isNodeRunner: true, isAdmin: true },
        })
        if (user && flagsNeeded.some((f) => user[f])) {
          return
        }
      }

      reply.code(403).send({
        error: 'Forbidden',
        message: `Required role: ${roles.join(' or ')}`,
      })
    }
  }

  fastify.decorate('authenticate', authenticate)
  fastify.decorate('requireRole', requireRole)
}

export default fp(authPlugin, {
  name: 'auth',
  dependencies: ['prisma'],
})
