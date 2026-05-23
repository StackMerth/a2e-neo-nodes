// Sentry must be initialised before any other module that we want
// instrumented. Doing it at the very top ensures Fastify routes,
// Prisma queries, and BullMQ workers are auto-traced.
import * as Sentry from '@sentry/node'
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV ?? 'development',
    // Sample 10% of transactions in production, 100% in dev. Tracing
    // adds latency, so we keep it modest in production. Adjust via
    // SENTRY_TRACES_SAMPLE_RATE env if needed.
    tracesSampleRate: parseFloat(
      process.env.SENTRY_TRACES_SAMPLE_RATE
        ?? (process.env.NODE_ENV === 'production' ? '0.1' : '1.0')
    ),
    // Release tag pulled from RENDER_GIT_COMMIT (Render sets this
    // automatically) so Sentry groups errors by deploy.
    release: process.env.RENDER_GIT_COMMIT ?? undefined,
  })
  console.log('[sentry] Initialised for environment:', process.env.NODE_ENV)
}

import Fastify from 'fastify'
import './types' // Type augmentations
import { prismaPlugin, redisPlugin, authPlugin, corsPlugin, overflowRegistryPlugin, swaggerPlugin } from './plugins'
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
  buyerBalanceRoutes,
  buyerApiKeyRoutes,
  adminSmtpRoutes,
  externalRoutes,
  webhooksSolanaRoutes,
  templateRoutes,
  adminRatingsRoutes,
  publicOperatorsRoutes,
  publicListingsRoutes,
  publicLeaderboardRoutes,
  portalReferralRoutes,
  publicStatsRoutes,
  publicChatRoutes,
  byogRoutes,
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
import {
  createComputeAllocatorQueue,
  createComputeAllocatorWorker,
  scheduleComputeAllocator,
} from './jobs/compute-allocator'
import {
  createPerMinuteMeterQueue,
  createPerMinuteMeterWorker,
  schedulePerMinuteMeter,
} from './jobs/per-minute-meter'
import {
  createRentalExpiryQueue,
  createRentalExpiryWorker,
  scheduleRentalExpiry,
} from './jobs/rental-expiry'
import { createSshSessionReaperWorker } from './jobs/ssh-session-reaper'
import {
  createSeedKeepAliveQueue,
  createSeedKeepAliveWorker,
  scheduleSeedKeepAlive,
  isSeedKeepAliveEnabled,
} from './jobs/seed-keep-alive'
import {
  createReputationScorerQueue,
  createReputationScorerWorker,
  scheduleReputationScorer,
} from './jobs/reputation-scorer'
import {
  createSpotPreemptionQueue,
  createSpotPreemptionWorker,
  scheduleSpotPreemption,
} from './jobs/spot-preemption'
import {
  createReferralCommissionQueue,
  createReferralCommissionWorker,
  scheduleReferralCommission,
} from './jobs/referral-commission'
import {
  createWeeklyDigestQueue,
  createWeeklyDigestWorker,
  scheduleWeeklyDigest,
} from './jobs/weekly-digest'
import {
  createEarningsConsolidatorQueue,
  createEarningsConsolidatorWorker,
  scheduleEarningsConsolidator,
} from './jobs/earnings-consolidator'

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
    // Swagger must register BEFORE the routes so route schemas are
    // picked up into the generated OpenAPI spec. Serves /docs (UI) and
    // /docs/json (raw spec).
    await server.register(swaggerPlugin)

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
    await server.register(buyerBalanceRoutes)
    await server.register(buyerApiKeyRoutes)
    await server.register(adminSmtpRoutes)
    await server.register(externalRoutes)
    await server.register(webhooksSolanaRoutes)
    await server.register(templateRoutes)
    await server.register(adminRatingsRoutes)
    await server.register(publicOperatorsRoutes)
    await server.register(publicListingsRoutes)
    await server.register(publicLeaderboardRoutes)
    await server.register(portalReferralRoutes)
    await server.register(publicStatsRoutes)
    await server.register(publicChatRoutes)
    await server.register(byogRoutes)

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

    // M2 auto-allocator (B1): polls PENDING+txConfirmed compute requests,
    // runs eligibility rules, picks idle nodes, mints ephemeral SSH and
    // transitions to ALLOCATED. Single-flight, 10s tick by default.
    const computeAllocatorQueue = createComputeAllocatorQueue(redisConnection)
    createComputeAllocatorWorker({ redis: redisConnection, prisma: server.prisma, io: server.io })
    await scheduleComputeAllocator(computeAllocatorQueue)
    server.log.info('Compute allocator initialized (10s tick)')

    // M2 per-minute billing meter (B3): rolls elapsed minutes onto each
    // ACTIVE ComputeRequest's minutesUsed + accruedCost so the buyer
    // dashboard ticker stays current. 60s tick. Idempotent.
    const perMinuteMeterQueue = createPerMinuteMeterQueue(redisConnection)
    createPerMinuteMeterWorker({ redis: redisConnection, prisma: server.prisma, io: server.io })
    await schedulePerMinuteMeter(perMinuteMeterQueue)
    server.log.info('Per-minute meter initialized (60s tick)')

    // M2: rental expiry worker — auto-completes ACTIVE rentals when
    // their term passes so nodes don't stay locked forever. 60s tick.
    const rentalExpiryQueue = createRentalExpiryQueue(redisConnection)
    createRentalExpiryWorker({ redis: redisConnection, prisma: server.prisma, io: server.io })
    await scheduleRentalExpiry(rentalExpiryQueue)
    server.log.info('Rental expiry worker initialized (60s tick)')

    // Launch-blocker #2: SSH session reaper. Failsafe for agent-confirmed
    // teardown — force-releases nodes stuck on TERMINATING rentals after
    // 10 min so an offline agent can't lock inventory forever.
    createSshSessionReaperWorker({ redis: redisConnection, prisma: server.prisma })
    server.log.info('SSH session reaper initialized (60s tick, 10min stuck threshold)')

    // Test-only: seed-node keep-alive (env-gated). When
    // SEED_KEEP_ALIVE_ENABLED=1, every 30s bumps every `seed-node-*` row
    // back to ONLINE with a fresh heartbeat so the allocator can keep
    // finding inventory. Replaces the need to leave a Render shell tab
    // open running the legacy --keep-alive-only script. Set the env to
    // anything other than '1' (or unset entirely) to disable in
    // production once real node-agents are providing real heartbeats.
    if (isSeedKeepAliveEnabled()) {
      const seedKeepAliveQueue = createSeedKeepAliveQueue(redisConnection)
      createSeedKeepAliveWorker({ redis: redisConnection, prisma: server.prisma })
      await scheduleSeedKeepAlive(seedKeepAliveQueue)
      server.log.warn('Seed-node keep-alive ENABLED (test-only — disable in production)')
    }

    // M3 reputation scorer (C1): daily worker that recomputes every
    // NodeRunner's reputationScore + reputationTier from uptime,
    // ratings, and completed-job count. Tunable via REPUTATION_*
    // env vars. Manual trigger: `pnpm --filter @a2e/api reputation:recompute`
    const reputationScorerQueue = createReputationScorerQueue(redisConnection)
    createReputationScorerWorker({ redis: redisConnection, prisma: server.prisma })
    await scheduleReputationScorer(reputationScorerQueue)
    server.log.info('Reputation scorer initialized (24h tick)')

    // M3 SPOT preemption (B6): 30s tick. Detects ON_DEMAND demand
    // pressure on a tier and schedules SPOT victims with a 90s grace
    // notice; terminates them when grace expires. Refunds prorated
    // unused minutes. RESERVED rentals are exempt (commitment honored).
    const spotPreemptionQueue = createSpotPreemptionQueue(redisConnection)
    createSpotPreemptionWorker({ redis: redisConnection, prisma: server.prisma, io: server.io })
    await scheduleSpotPreemption(spotPreemptionQueue)
    server.log.info('SPOT preemption worker initialized (30s tick, 90s grace)')

    // M5.7 D2 referral commission: daily worker. Expires elapsed 365d
    // windows, then accrues REFERRAL_COMMISSION_PCT (default 10%) of
    // every referee's daily earnings onto the referrer's Referral row.
    const referralCommissionQueue = createReferralCommissionQueue(redisConnection)
    createReferralCommissionWorker({ redis: redisConnection, prisma: server.prisma })
    await scheduleReferralCommission(referralCommissionQueue)
    server.log.info('Referral commission worker initialized (24h tick, 10% rate)')

    // C3 wave 2: weekly digest. Forecast + uptime warnings per operator.
    // Skipped silently when SMTP is unconfigured. Operators can opt out
    // via NodeRunner.digestOptedOut on the payout settings page.
    const weeklyDigestQueue = createWeeklyDigestQueue(redisConnection)
    createWeeklyDigestWorker({ redis: redisConnection, prisma: server.prisma })
    await scheduleWeeklyDigest(weeklyDigestQueue)
    server.log.info('Weekly digest worker initialized (7d tick)')

    const earningsConsolidatorQueue = createEarningsConsolidatorQueue(redisConnection)
    createEarningsConsolidatorWorker({ redis: redisConnection, prisma: server.prisma })
    await scheduleEarningsConsolidator(earningsConsolidatorQueue)
    server.log.info('Earnings consolidator worker initialized (24h tick)')

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
