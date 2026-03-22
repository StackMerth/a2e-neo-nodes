// CORS Plugin Configuration
// Configures Cross-Origin Resource Sharing

import type { FastifyInstance, FastifyPluginCallback } from 'fastify'
import fp from 'fastify-plugin'
import cors from '@fastify/cors'

const corsPlugin: FastifyPluginCallback = async (fastify: FastifyInstance) => {
  const allowedOrigins = process.env.CORS_ORIGINS?.split(',') ?? [
    'http://localhost:3000',
    'http://localhost:3001',
    'https://a2e.byredstone.com',
    'https://compute.tokenos.ai',
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
