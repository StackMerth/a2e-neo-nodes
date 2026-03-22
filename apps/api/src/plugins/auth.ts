// API Key Authentication Plugin
// Validates X-API-Key header on protected routes

import type { FastifyInstance, FastifyPluginCallback, FastifyRequest, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}

const authPlugin: FastifyPluginCallback = async (fastify: FastifyInstance) => {
  const validApiKey = process.env.API_KEY ?? 'a2e-dev-key-2026'

  async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    const apiKey = request.headers['x-api-key']

    if (!apiKey || apiKey !== validApiKey) {
      reply.code(401).send({
        error: 'Unauthorized',
        message: 'Invalid or missing API key',
      })
      return
    }
  }

  fastify.decorate('authenticate', authenticate)
}

export default fp(authPlugin, {
  name: 'auth',
})
