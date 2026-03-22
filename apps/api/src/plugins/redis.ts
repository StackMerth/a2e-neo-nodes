// Redis Plugin for Fastify
// Provides Redis connection for caching and BullMQ

import type { FastifyInstance, FastifyPluginCallback } from 'fastify'
import fp from 'fastify-plugin'
import Redis from 'ioredis'

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis
  }
}

const redisPlugin: FastifyPluginCallback = async (fastify: FastifyInstance) => {
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379'
  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  })

  redis.on('error', (err) => {
    fastify.log.error({ err }, 'Redis connection error')
  })

  redis.on('connect', () => {
    fastify.log.info('Redis connected')
  })

  fastify.decorate('redis', redis)

  fastify.addHook('onClose', async () => {
    await redis.quit()
  })
}

export default fp(redisPlugin, {
  name: 'redis',
})
