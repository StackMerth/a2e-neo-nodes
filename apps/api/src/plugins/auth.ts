// Authentication Plugin
// Supports:
//   - X-API-Key: admin global key, node-specific keys, buyer API keys
//   - Authorization: Bearer <portal JWT> for compute buyers and node runners
//   - Authorization: Bearer <admin HMAC token> issued by /v1/auth/login
//
// The admin HMAC path is a Phase 1 carryover. It exists because the
// original /v1/auth/login route generates a custom HMAC-signed token
// instead of a real JWT, and the dashboard uses that token for all
// admin API calls. Recognising it here keeps the dashboard working.
// Unifying admin auth onto proper JWT (with rotation, revocation,
// short-lived access + refresh tokens) is scheduled for M1.

import crypto from 'node:crypto'
import type { FastifyInstance, FastifyPluginCallback, FastifyRequest, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'
import { verifyAccessToken, type AccessTokenPayload } from '../services/auth/jwt.js'
import { isBuyerApiKey, verifyApiKey } from '../services/apikey/manager.js'
import type { UserRole } from '@a2e/database'

/**
 * Verify the legacy admin HMAC token issued by POST /v1/auth/login.
 * Token format: `<base64(JSON payload)>.<base64(HMAC-SHA256 signature)>`.
 * Returns { valid: true } when signature matches and payload.exp is in future.
 */
function verifyAdminHmacToken(token: string): boolean {
  try {
    const [data, signature] = token.split('.')
    if (!data || !signature) return false

    const JWT_SECRET = process.env.JWT_SECRET ?? 'a2e-jwt-secret-change-in-production'
    const expectedSignature = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(data)
      .digest('base64')

    if (signature !== expectedSignature) return false

    const payload = JSON.parse(Buffer.from(data, 'base64').toString()) as { exp?: number }
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return false

    return true
  } catch {
    return false
  }
}

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
    // Try Bearer token first (portal users + admin)
    const authHeader = request.headers.authorization
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7)

      // 1. Portal JWT (compute buyers, node runners)
      try {
        const payload = verifyAccessToken(token)
        request.authType = 'user'
        request.user = payload
        return
      } catch {
        // Not a portal JWT, fall through to admin HMAC check
      }

      // 2. Admin HMAC token issued by /v1/auth/login
      if (verifyAdminHmacToken(token)) {
        request.authType = 'admin'
        return
      }

      // Neither matched, fall through to X-API-Key
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

      if (!roles.includes(request.user.role)) {
        reply.code(403).send({
          error: 'Forbidden',
          message: `Required role: ${roles.join(' or ')}`,
        })
        return
      }
    }
  }

  fastify.decorate('authenticate', authenticate)
  fastify.decorate('requireRole', requireRole)
}

export default fp(authPlugin, {
  name: 'auth',
  dependencies: ['prisma'],
})
