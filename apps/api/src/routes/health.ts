import type { FastifyInstance } from 'fastify'
import { getEmailHealth } from '../services/email/sender.js'

export async function healthRoutes(fastify: FastifyInstance) {
  // Liveness check. Both paths return the same response so Render, load
  // balancers, monitoring tools, and the rest of the v1 API surface can all
  // reach it consistently. /health is the historical Phase 1 path; /v1/health
  // matches the convention used by every other route file.
  const livenessHandler = async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  })

  fastify.get('/health', livenessHandler)
  fastify.get('/v1/health', livenessHandler)

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
          email: ReturnType<typeof getEmailHealth>
        }
      } = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        services: {
          database: { status: 'unknown' },
          redis: { status: 'unknown' },
          email: getEmailHealth(),
        },
      }

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

      if (health.services.database.status === 'down' && health.services.redis.status === 'down') {
        health.status = 'down'
      }

      // Email is non-critical infrastructure — degrade overall status when
      // it's actively failing (≥3 consecutive delivery failures), but treat
      // "unconfigured" as a separate signal that doesn't downgrade health
      // on its own (the platform can still function without email).
      if (health.services.email.status === 'degraded' && health.status === 'ok') {
        health.status = 'degraded'
      }

      const statusCode = health.status === 'ok' ? 200 : health.status === 'degraded' ? 503 : 500
      reply.code(statusCode).send(health)
    }
  )
}
