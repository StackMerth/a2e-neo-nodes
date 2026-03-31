// API Key Authentication Plugin
// Validates X-API-Key header on protected routes
// Supports both admin API key and node-specific API keys

import type { FastifyInstance, FastifyPluginCallback, FastifyRequest, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
  interface FastifyRequest {
    authType?: 'admin' | 'node' | 'provision'
    authNodeId?: string
    authProvisionId?: string
  }
}

const authPlugin: FastifyPluginCallback = async (fastify: FastifyInstance) => {
  const adminApiKey = process.env.API_KEY ?? 'a2e-dev-key-2026'

  async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    const apiKey = request.headers['x-api-key'] as string | undefined

    if (!apiKey) {
      reply.code(401).send({
        error: 'Unauthorized',
        message: 'Missing API key',
      })
      return
    }

    // Check admin API key first
    if (apiKey === adminApiKey) {
      request.authType = 'admin'
      return
    }

    // Check if it's a node-specific API key
    if (apiKey.startsWith('a2e-node-')) {
      // Check against registered nodes
      const node = await fastify.prisma.node.findUnique({
        where: { apiKey },
        select: { id: true },
      })

      if (node) {
        request.authType = 'node'
        request.authNodeId = node.id
        return
      }

      // Check against pending provision jobs (for initial registration)
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
      message: 'Invalid API key',
    })
  }

  fastify.decorate('authenticate', authenticate)
}

export default fp(authPlugin, {
  name: 'auth',
  dependencies: ['prisma'],
})
