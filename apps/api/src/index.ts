import Fastify from 'fastify'
import './types' // Type augmentations
import { prismaPlugin, redisPlugin, authPlugin, corsPlugin, overflowRegistryPlugin } from './plugins'
import errorHandlerPlugin from './plugins/error-handler'
import {
  healthRoutes,
  nodeRoutes,
  jobRoutes,
  routeRoutes,
  rateRoutes,
  configRoutes,
  statsRoutes,
  authRoutes,
  earningsRoutes,
  costsRoutes,
  settlementsRoutes,
  paymentsRoutes,
  reportsRoutes,
  agentRoutes,
  provisionRoutes,
  releasesRoutes,
  nodeRunnerRoutes,
  auditRoutes,
  portalAuthRoutes,
  portalNodeRunnerRoutes,
  portalNotificationRoutes,
  adminDeploymentRoutes,
  buyerComputeRoutes,
  adminComputeRoutes,
  portalWithdrawalRoutes,
  adminWithdrawalRoutes,
  buyerBillingRoutes,
  buyerApiKeyRoutes,
  adminSmtpRoutes,
  externalRoutes,
} from './routes'
import { setupWebSocket } from './websocket'
import { setNotificationSocket } from './services/notification/service.js'
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
import {
  createJobProcessorQueue,
  createJobProcessorWorker,
} from './jobs/job-processor'
import {
  createSettlementSchedulerQueue,
  createSettlementRetryQueue,
  createSettlementSchedulerWorker,
  createSettlementRetryWorker,
  scheduleSettlementChecker,
} from './jobs/settlement-scheduler'
import {
  createProvisionQueue,
  createProvisionWorker,
} from './jobs/provision-processor'
import {
  createReconciliationQueue,
  createReconciliationWorker,
  scheduleReconciliation,
} from './jobs/reconciliation-scheduler'
import {
  createEarningsRollupQueue,
  createEarningsRollupWorker,
  scheduleEarningsRollup,
} from './jobs/earnings-rollup'
import {
  createHeartbeatRetentionQueue,
  createHeartbeatRetentionWorker,
  scheduleHeartbeatRetention,
  createRateHistoryRetentionQueue,
  createRateHistoryRetentionWorker,
  scheduleRateHistoryRetention,
} from './jobs/retention'

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
    // Register error handler first for consistent error responses
    await server.register(errorHandlerPlugin)

    await server.register(corsPlugin)
    await server.register(prismaPlugin)
    await server.register(redisPlugin)
    await server.register(authPlugin)
    await server.register(overflowRegistryPlugin)

    const socketServer = setupWebSocket(server)
    setNotificationSocket(socketServer)

    await server.register(healthRoutes)
    await server.register(authRoutes)
    await server.register(nodeRoutes)
    await server.register(jobRoutes)
    await server.register(routeRoutes)
    await server.register(rateRoutes)
    await server.register(configRoutes)
    await server.register(statsRoutes)
    await server.register(earningsRoutes)
    await server.register(costsRoutes)
    await server.register(settlementsRoutes)
    await server.register(paymentsRoutes)
    await server.register(reportsRoutes)
    await server.register(agentRoutes)
    await server.register(provisionRoutes)
    await server.register(releasesRoutes)
    await server.register(nodeRunnerRoutes)
    await server.register(auditRoutes)
    await server.register(portalAuthRoutes)
    await server.register(portalNodeRunnerRoutes)
    await server.register(portalNotificationRoutes)
    await server.register(adminDeploymentRoutes)
    await server.register(buyerComputeRoutes)
    await server.register(adminComputeRoutes)
    await server.register(portalWithdrawalRoutes)
    await server.register(adminWithdrawalRoutes)
    await server.register(buyerBillingRoutes)
    await server.register(buyerApiKeyRoutes)
    await server.register(adminSmtpRoutes)
    await server.register(externalRoutes)

    const redisConnection = server.redis as unknown as import('bullmq').ConnectionOptions
    const rateFetcherQueue = createRateFetcherQueue(redisConnection)
    const nodeHealthQueue = createNodeHealthQueue(redisConnection)
    const jobProcessorQueue = createJobProcessorQueue(redisConnection)
    const settlementSchedulerQueue = createSettlementSchedulerQueue(redisConnection)
    const settlementRetryQueue = createSettlementRetryQueue(redisConnection)

    const provisionQueue = createProvisionQueue(redisConnection)
    const reconciliationQueue = createReconciliationQueue(redisConnection)
    const earningsRollupQueue = createEarningsRollupQueue(redisConnection)

    // Decorate server with queues for routes to access
    server.decorate('jobQueue', jobProcessorQueue)
    server.decorate('provisionQueue', provisionQueue)

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

    createJobProcessorWorker({
      redis: redisConnection,
      prisma: server.prisma,
      io: server.io,
    })

    // Settlement scheduler and retry workers
    createSettlementSchedulerWorker(redisConnection, server.prisma)
    createSettlementRetryWorker(redisConnection, server.prisma)

    // Provision worker
    createProvisionWorker({
      redis: redisConnection,
      prisma: server.prisma,
      io: server.io,
    })

    // Reconciliation worker
    createReconciliationWorker(redisConnection, server.prisma)

    // Earnings rollup worker (calculates uptime earnings every 5 minutes)
    createEarningsRollupWorker({ redis: redisConnection, prisma: server.prisma })
    scheduleEarningsRollup(earningsRollupQueue)

    // M1 retention workers: purge old Heartbeat and MarketRateHistory rows
    // daily so Postgres growth stays bounded under sustained traffic.
    const heartbeatRetentionQueue = createHeartbeatRetentionQueue(redisConnection)
    const rateHistoryRetentionQueue = createRateHistoryRetentionQueue(redisConnection)
    createHeartbeatRetentionWorker({ redis: redisConnection, prisma: server.prisma })
    createRateHistoryRetentionWorker({ redis: redisConnection, prisma: server.prisma })
    await scheduleHeartbeatRetention(heartbeatRetentionQueue)
    await scheduleRateHistoryRetention(rateHistoryRetentionQueue)

    await scheduleRateFetcher(rateFetcherQueue)
    await scheduleReconciliation(reconciliationQueue, 5)
    await scheduleNodeHealthChecker(nodeHealthQueue)
    await scheduleSettlementChecker(60)
    server.log.info('Job processor queue initialized')
    server.log.info('Settlement scheduler initialized (checks hourly when enabled)')
    server.log.info('Provision worker initialized')
    server.log.info('Reconciliation scheduler initialized (runs every 5 minutes)')
    server.log.info('Earnings rollup initialized (runs every 5 minutes)')

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

const shutdown = async (signal: string) => {
  server.log.info(`Received ${signal}, shutting down gracefully...`)
  await server.close()
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

start()
