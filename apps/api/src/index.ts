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
import { prismaPlugin, redisPlugin, authPlugin, corsPlugin, overflowRegistryPlugin, swaggerPlugin, multipartPlugin } from './plugins'
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
  portalPushRoutes,
  adminDeploymentRoutes,
  buyerComputeRoutes,
  adminComputeRoutes,
  portalWithdrawalRoutes,
  adminWithdrawalRoutes,
  adminBalanceRoutes,
  paymentConfigRoutes,
  inferenceWorkerRoutes,
  inferenceRoutes,
  buyerBillingRoutes,
  buyerBalanceRoutes,
  buyerApiKeyRoutes,
  adminSmtpRoutes,
  externalRoutes,
  webhooksSolanaRoutes,
  webhooksStripeRoutes,
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
import {
  createLambdaPollQueue,
  createLambdaPollWorker,
  scheduleLambdaPoll,
} from './jobs/lambda-poll'
import {
  createLambdaCapacityWatcherQueue,
  createLambdaCapacityWatcherWorker,
  scheduleLambdaCapacityWatcher,
} from './jobs/lambda-capacity-watcher'
import {
  createRunPodPollQueue,
  createRunPodPollWorker,
  scheduleRunPodPoll,
} from './jobs/runpod-poll'
import {
  createRunPodCapacityWatcherQueue,
  createRunPodCapacityWatcherWorker,
  scheduleRunPodCapacityWatcher,
} from './jobs/runpod-capacity-watcher'
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
import {
  createUsageAggregatorQueue,
  createUsageAggregatorWorker,
  scheduleUsageAggregator,
} from './jobs/usage-aggregator'
import {
  createBurnRateAlertsQueue,
  createBurnRateAlertsWorker,
  scheduleBurnRateAlerts,
} from './jobs/burn-rate-alerts'

/**
 * T8a: Better Stack transport opts in when both env vars are set.
 * Falls back to stdout (current behavior) otherwise so production
 * deploys without Better Stack configured behave exactly as before.
 *
 * Transport path uses __dirname so it resolves from dist/index.js at
 * runtime — Pino spawns a worker thread for the transport and
 * requires an absolute, resolvable path.
 */
function buildLoggerTransport() {
  if (process.env.NODE_ENV === 'development') {
    return { target: 'pino-pretty', options: { colorize: true } }
  }
  const ingestUrl = process.env.BETTER_STACK_INGEST_URL?.trim()
  const token = process.env.BETTER_STACK_TOKEN?.trim()
  if (ingestUrl && token) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path') as typeof import('path')
    return {
      target: path.join(__dirname, 'plugins', 'better-stack-transport.js'),
      options: {
        ingestUrl,
        token,
        sourceName: process.env.BETTER_STACK_SOURCE ?? 'tokenosdeai-api',
      },
    }
  }
  return undefined
}

const server = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport: buildLoggerTransport(),
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
    // Multipart support for /v1/audio/transcriptions (E3.3) — Whisper
    // uploads a file alongside form fields. Must register before route
    // handlers so request.file() / request.parts() are available.
    await server.register(multipartPlugin)
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
    await server.register(portalPushRoutes)
    await server.register(adminDeploymentRoutes)
    await server.register(buyerComputeRoutes)
    await server.register(adminComputeRoutes)
    await server.register(portalWithdrawalRoutes)
    await server.register(adminWithdrawalRoutes)
    await server.register(adminBalanceRoutes)
    await server.register(paymentConfigRoutes)
    await server.register(inferenceWorkerRoutes)
    await server.register(inferenceRoutes)
    await server.register(buyerBillingRoutes)
    await server.register(buyerBalanceRoutes)
    await server.register(buyerApiKeyRoutes)
    await server.register(adminSmtpRoutes)
    await server.register(externalRoutes)
    await server.register(webhooksSolanaRoutes)
    // Stripe webhook registers with an encapsulated raw-body parser
    // (needed for signature verification). Encapsulation keeps the
    // override from leaking to other JSON routes.
    await server.register(webhooksStripeRoutes)
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

    // T5b: Lambda status poller. Watches ExternalRental rows the
    // allocator created via the inbound-supply fallback and flips the
    // linked ComputeRequest to ACTIVE once Lambda reports the
    // instance is booted. Cancels + refunds on failed provision.
    // No-op when LAMBDA_API_KEY isn't set.
    const lambdaPollQueue = createLambdaPollQueue(redisConnection)
    createLambdaPollWorker({ redis: redisConnection, prisma: server.prisma, io: server.io })
    await scheduleLambdaPoll(lambdaPollQueue)
    server.log.info('Lambda poll worker initialized (10s tick)')

    // T5e: RunPod status poller. Parallel of T5b for RunPod-provisioned
    // pods. Flips ExternalRental PENDING -> ACTIVE once RunPod reports
    // RUNNING + publicIp, which promotes the linked ComputeRequest to
    // ACTIVE. Cancels + refunds on failed provision. No-op when
    // RUNPOD_API_KEY isn't set.
    const runpodPollQueue = createRunPodPollQueue(redisConnection)
    createRunPodPollWorker({ redis: redisConnection, prisma: server.prisma, io: server.io })
    await scheduleRunPodPoll(runpodPollQueue)
    server.log.info('RunPod poll worker initialized (10s tick)')

    // T5e: RunPod capacity watcher. Mirror of T5d for RunPod's gpu
    // types catalog. Emails admin when watched SKU IDs gain stock.
    // No-op when RUNPOD_CAPACITY_WATCH_IDS is unset, so production
    // deploys without the flag get zero behavior change.
    const runpodCapacityWatcherQueue = createRunPodCapacityWatcherQueue(redisConnection)
    createRunPodCapacityWatcherWorker({ redis: redisConnection })
    await scheduleRunPodCapacityWatcher(runpodCapacityWatcherQueue)
    server.log.info('RunPod capacity watcher initialized (5min tick, env-driven SKU list)')

    // T5d: Lambda capacity watcher. Slow-cadence poller that emails
    // admin when any of the watched SKUs (LAMBDA_CAPACITY_WATCH_SKUS)
    // has capacity. Built so we can ping early testers the moment 8x
    // H100 / B200 boxes (perpetually oversubscribed) open up. No-op
    // when LAMBDA_CAPACITY_WATCH_SKUS is unset, so production deploys
    // without the flag get zero behavior change.
    const lambdaCapacityWatcherQueue = createLambdaCapacityWatcherQueue(redisConnection)
    createLambdaCapacityWatcherWorker({ redis: redisConnection })
    await scheduleLambdaCapacityWatcher(lambdaCapacityWatcherQueue)
    server.log.info('Lambda capacity watcher initialized (5min tick, env-driven SKU list)')

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

    // Track 5 / 3.A — token billing infrastructure. Aggregator rolls
    // TokenUsage into monthly Invoice rows; burn-rate alerts watch
    // for runaway spend. Both are independent of the rest of the
    // system and no-op when no inference activity is happening, so
    // they're safe to register here alongside the other daily jobs.
    const usageAggregatorQueue = createUsageAggregatorQueue(redisConnection)
    createUsageAggregatorWorker({ redis: redisConnection, prisma: server.prisma })
    await scheduleUsageAggregator(usageAggregatorQueue)
    server.log.info('Usage aggregator worker initialized (24h tick) — Track 5 E1')

    const burnRateAlertsQueue = createBurnRateAlertsQueue(redisConnection)
    createBurnRateAlertsWorker({ redis: redisConnection, prisma: server.prisma })
    await scheduleBurnRateAlerts(burnRateAlertsQueue)
    server.log.info('Burn-rate alerts worker initialized (30m tick) — Track 5 E1')

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
