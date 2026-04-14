// Authentication Plugin
// Supports: X-API-Key (admin/node), Authorization: Bearer JWT (portal users)

import type { FastifyInstance, FastifyPluginCallback, FastifyRequest, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'
import { verifyAccessToken, type AccessTokenPayload } from '../services/auth/jwt.js'
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
    // Try Bearer token first (portal users)
    const authHeader = request.headers.authorization
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7)
      try {
        const payload = verifyAccessToken(token)
        request.authType = 'user'
        request.user = payload
        return
      } catch {
        // Token invalid/expired — fall through to try API key
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
