// Health Check Routes
// Basic and detailed health status endpoints

import type { FastifyInstance } from 'fastify'

export async function healthRoutes(fastify: FastifyInstance) {
  // Basic health check (no auth required)
  fastify.get('/health', async () => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    }
  })

  // Detailed health check with dependency status
  fastify.get(
    '/health/detailed',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const health: {
        status: 'ok' | 'degraded' | 'down'
        timestamp: string
        services: {
          database: { status: string; latency?: number; error?: string }
          redis: { status: string; latency?: number; error?: string }
        }
      } = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        services: {
          database: { status: 'unknown' },
          redis: { status: 'unknown' },
        },
      }

      // Check database
      try {
        const dbStart = Date.now()
        await fastify.prisma.$queryRaw`SELECT 1`
        health.services.database = {
          status: 'ok',
          latency: Date.now() - dbStart,
        }
      } catch (err) {
        health.services.database = {
          status: 'down',
          error: err instanceof Error ? err.message : 'Unknown error',
        }
        health.status = 'degraded'
      }

      // Check Redis
      try {
        const redisStart = Date.now()
        await fastify.redis.ping()
        health.services.redis = {
          status: 'ok',
          latency: Date.now() - redisStart,
        }
      } catch (err) {
        health.services.redis = {
          status: 'down',
          error: err instanceof Error ? err.message : 'Unknown error',
        }
        health.status = 'degraded'
      }

      // Overall status
      if (health.services.database.status === 'down' && health.services.redis.status === 'down') {
        health.status = 'down'
      }

      const statusCode = health.status === 'ok' ? 200 : health.status === 'degraded' ? 503 : 500
      reply.code(statusCode).send(health)
    }
  )
}
