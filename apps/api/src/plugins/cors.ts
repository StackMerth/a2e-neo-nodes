// CORS Plugin Configuration
// Configures Cross-Origin Resource Sharing

import type { FastifyInstance, FastifyPluginCallback } from 'fastify'
import fp from 'fastify-plugin'
import cors from '@fastify/cors'

const corsPlugin: FastifyPluginCallback = async (fastify: FastifyInstance) => {
  const allowedOrigins = process.env.CORS_ORIGINS?.split(',') ?? [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002',
    // M3 marketplace dev port
    'http://localhost:3003',
    'https://a2e-admin.stackforgelab.tech',
    'https://a2e-user.stackforgelab.tech',
    'https://compute.tokenos.ai',
    // M3 marketplace production (update with real custom domain when set)
    'https://marketplace.tokenos.ai',
  ]

  await fastify.register(cors, {
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-API-Key', 'Authorization'],
    credentials: true,
  })
}

export default fp(corsPlugin, {
  name: 'cors',
  dependencies: [],
})
