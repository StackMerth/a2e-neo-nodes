// A²E API Server
// Main entry point for the Arbitrage & Orchestration Engine API

import Fastify from 'fastify'
import { prismaPlugin, redisPlugin, authPlugin, corsPlugin } from './plugins'
import {
  healthRoutes,
  nodeRoutes,
  jobRoutes,
  routeRoutes,
  rateRoutes,
  configRoutes,
  statsRoutes,
} from './routes'
import { setupWebSocket } from './websocket'
import {
  createRateFetcherQueue,
  createRateFetcherWorker,
  scheduleRateFetcher,
} from './jobs/rate-fetcher'
import {
  createNodeHealthQueue,
  createNodeHealthWorker,
  scheduleNodeHealthChecker,
} from './jobs/node-health'

const server = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport:
      process.env.NODE_ENV === 'development'
        ? {
            target: 'pino-pretty',
            options: { colorize: true },
          }
        : undefined,
  },
})

async function start() {
  try {
    // Register plugins
    await server.register(corsPlugin)
    await server.register(prismaPlugin)
    await server.register(redisPlugin)
    await server.register(authPlugin)

    // Setup WebSocket server
    setupWebSocket(server)

    // Register routes
    await server.register(healthRoutes)
    await server.register(nodeRoutes)
    await server.register(jobRoutes)
    await server.register(routeRoutes)
    await server.register(rateRoutes)
    await server.register(configRoutes)
    await server.register(statsRoutes)

    // Setup BullMQ queues and workers
    const redisConnection = server.redis as unknown as import('bullmq').ConnectionOptions
    const rateFetcherQueue = createRateFetcherQueue(redisConnection)
    const nodeHealthQueue = createNodeHealthQueue(redisConnection)

    createRateFetcherWorker({
      redis: redisConnection,
      prisma: server.prisma,
      io: server.io,
    })

    createNodeHealthWorker({
      redis: redisConnection,
      prisma: server.prisma,
      io: server.io,
    })

    // Schedule jobs
    await scheduleRateFetcher(rateFetcherQueue)
    await scheduleNodeHealthChecker(nodeHealthQueue)

    // Start server
    const port = parseInt(process.env.PORT ?? '3001', 10)
    const host = process.env.HOST ?? '0.0.0.0'

    await server.listen({ port, host })
    server.log.info(`A²E API running at http://${host}:${port}`)
    server.log.info(`WebSocket server ready at ws://${host}:${port}/socket.io`)

  } catch (err) {
    server.log.error(err)
    process.exit(1)
  }
}

// Graceful shutdown
const shutdown = async (signal: string) => {
  server.log.info(`Received ${signal}, shutting down gracefully...`)
  await server.close()
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

start()
