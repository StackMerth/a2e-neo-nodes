import { Queue, Worker, Job as BullJob } from 'bullmq'
import type { PrismaClient, GpuTier, JobStatus, Market } from '@a2e/database'
import type { Server as SocketServer } from 'socket.io'
import { RoutingEngine } from '@a2e/core'
import { GPU_TIER_CONFIG, dailyToHourly } from '@a2e/shared'

const QUEUE_NAME = 'job-processor'
const MAX_RETRIES = 3

interface JobProcessorDeps {
  redis: import('bullmq').ConnectionOptions
  prisma: PrismaClient
  io: SocketServer
}

interface JobPayload {
  jobId: string
  deploymentId: string
  gpuTier: GpuTier
  hasInternalDemand: boolean
  preferredNodeId?: string
}

export function createJobProcessorQueue(redis: import('bullmq').ConnectionOptions) {
  return new Queue<JobPayload>(QUEUE_NAME, {
    connection: redis,
    defaultJobOptions: {
      attempts: MAX_RETRIES,
      backoff: {
        type: 'exponential',
        delay: 5000,
      },
      removeOnComplete: 100,
      removeOnFail: 50,
    },
  })
}

export function createJobProcessorWorker(deps: JobProcessorDeps) {
  const { redis, prisma, io } = deps

  const worker = new Worker<JobPayload>(
    QUEUE_NAME,
    async (bullJob: BullJob<JobPayload>) => {
      const { jobId, deploymentId, gpuTier, hasInternalDemand, preferredNodeId } = bullJob.data

      // Get the job from database
      const job = await prisma.job.findUnique({ where: { id: jobId } })
      if (!job) {
        throw new Error(`Job ${jobId} not found`)
      }

      // Skip if already processed
      if (job.status !== 'PENDING' && job.status !== 'ROUTING') {
        return { skipped: true, reason: `Job already in status ${job.status}` }
      }

      // Update status to ROUTING
      await prisma.job.update({
        where: { id: jobId },
        data: { status: 'ROUTING' as JobStatus },
      })

      // Get rates and yield floor from database
      const rates = await getRatesFromCache(prisma, gpuTier)
      const yieldFloor = await getYieldFloor(prisma, gpuTier)

      // Create inline implementations for routing engine
      const rateProvider = {
        getRates: async () => rates,
        refreshRates: async () => {},
      }

      const yieldFloorConfig = {
        getFloor: () => yieldFloor,
        setFloor: () => {},
      }

      const routingEngine = new RoutingEngine({
        rateProvider,
        yieldFloorConfig,
      })

      // Get routing decision
      const decision = await routingEngine.route({
        gpuTier,
        hasInternalDemand,
        deploymentId,
      })

      // Find best available node for this job
      const assignedNode = await findBestNode(prisma, gpuTier, preferredNodeId)

      // Log routing decision
      await prisma.routingLog.create({
        data: {
          jobId,
          selectedMarket: decision.market as Market,
          selectedRate: decision.ratePerHour,
          internalRate: rates.internal.ratePerHour,
          akashRate: rates.akash.available ? rates.akash.ratePerHour : null,
          ionetRate: rates.ionet.available ? rates.ionet.ratePerHour : null,
          vastaiRate: rates.vastai.available ? rates.vastai.ratePerHour : null,
          yieldFloor: yieldFloor.ratePerHour,
          yieldFloorApplied: decision.yieldFloorApplied,
          reason: decision.reason,
          decisionTimeMs: 0,
        },
      })

      // Update job with routing decision and node assignment
      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: 'ASSIGNED' as JobStatus,
          market: decision.market as Market,
          ratePerHour: decision.ratePerHour,
          nodeId: assignedNode?.id ?? null,
          routedAt: new Date(),
        },
      })

      // Emit WebSocket event
      io.emit('job:routed', {
        jobId,
        deploymentId,
        market: decision.market,
        rate: decision.ratePerHour,
        nodeId: assignedNode?.id ?? null,
        reason: decision.reason,
      })

      return {
        jobId,
        market: decision.market,
        rate: decision.ratePerHour,
        nodeId: assignedNode?.id ?? null,
      }
    },
    {
      connection: redis,
      concurrency: 10,
    }
  )

  worker.on('completed', (job, result) => {
    if (result && !result.skipped) {
      console.log(`Job ${job.data.jobId} routed to ${result.market} at $${result.rate}/hr`)
    }
  })

  worker.on('failed', async (job, err) => {
    if (!job) return

    const { jobId } = job.data
    const attemptsMade = job.attemptsMade

    console.error(`Job ${jobId} failed (attempt ${attemptsMade}/${MAX_RETRIES}):`, err.message)

    // Update retry count in database
    await prisma.job.update({
      where: { id: jobId },
      data: {
        retryCount: attemptsMade,
        errorMessage: err.message,
        status: attemptsMade >= MAX_RETRIES ? ('FAILED' as JobStatus) : ('PENDING' as JobStatus),
      },
    })

    // Emit failure event
    io.emit('job:failed', {
      jobId,
      error: err.message,
      attemptsMade,
      willRetry: attemptsMade < MAX_RETRIES,
    })
  })

  return worker
}

/**
 * Get rates from database cache
 */
async function getRatesFromCache(
  prisma: PrismaClient,
  gpuTier: GpuTier
): Promise<{
  internal: { ratePerHour: number; ratePerDay: number; available: boolean; fetchedAt: Date }
  akash: { ratePerHour: number; ratePerDay: number; available: boolean; fetchedAt: Date }
  ionet: { ratePerHour: number; ratePerDay: number; available: boolean; fetchedAt: Date }
  vastai: { ratePerHour: number; ratePerDay: number; available: boolean; fetchedAt: Date }
}> {
  const tierConfig = GPU_TIER_CONFIG[gpuTier]
  const now = new Date()

  // Internal rate from config
  const internal = {
    ratePerHour: dailyToHourly(tierConfig.retailRate),
    ratePerDay: tierConfig.retailRate,
    available: true,
    fetchedAt: now,
  }

  // Try to get external rates from database
  const [akashRate, ionetRate, vastaiRate, akashConfig, ionetConfig, vastaiConfig] = await Promise.all([
    prisma.marketRate.findUnique({
      where: { market_gpuTier: { market: 'AKASH', gpuTier } },
    }),
    prisma.marketRate.findUnique({
      where: { market_gpuTier: { market: 'IONET', gpuTier } },
    }),
    prisma.marketRate.findUnique({
      where: { market_gpuTier: { market: 'VASTAI', gpuTier } },
    }),
    prisma.marketConfig.findUnique({ where: { market: 'AKASH' } }),
    prisma.marketConfig.findUnique({ where: { market: 'IONET' } }),
    prisma.marketConfig.findUnique({ where: { market: 'VASTAI' } }),
  ])

  const akash = {
    ratePerHour: akashRate?.ratePerHour ?? 0,
    ratePerDay: akashRate?.ratePerDay ?? 0,
    available: akashRate?.available === true && akashConfig?.enabled !== false,
    fetchedAt: akashRate?.fetchedAt ?? now,
  }

  const ionet = {
    ratePerHour: ionetRate?.ratePerHour ?? 0,
    ratePerDay: ionetRate?.ratePerDay ?? 0,
    available: ionetRate?.available === true && ionetConfig?.enabled !== false,
    fetchedAt: ionetRate?.fetchedAt ?? now,
  }

  const vastai = {
    ratePerHour: vastaiRate?.ratePerHour ?? 0,
    ratePerDay: vastaiRate?.ratePerDay ?? 0,
    available: vastaiRate?.available === true && vastaiConfig?.enabled !== false,
    fetchedAt: vastaiRate?.fetchedAt ?? now,
  }

  return { internal, akash, ionet, vastai }
}

/**
 * Get yield floor from database or config
 */
async function getYieldFloor(
  prisma: PrismaClient,
  gpuTier: GpuTier
): Promise<{ ratePerHour: number; ratePerDay: number }> {
  // Check for custom floor in database
  const customFloor = await prisma.yieldFloor.findUnique({
    where: { gpuTier },
  })

  if (customFloor) {
    return {
      ratePerHour: customFloor.ratePerHour,
      ratePerDay: customFloor.ratePerDay,
    }
  }

  // Fall back to cost floor from config
  const tierConfig = GPU_TIER_CONFIG[gpuTier]
  return {
    ratePerHour: dailyToHourly(tierConfig.costFloor),
    ratePerDay: tierConfig.costFloor,
  }
}

/**
 * Find the best available node for a job based on GPU tier
 * Selection criteria:
 * 1. Must match GPU tier
 * 2. Must be ONLINE
 * 3. Prefer nodes with fewer active jobs (load balancing)
 * 4. Prefer nodes with recent heartbeat
 */
async function findBestNode(
  prisma: PrismaClient,
  gpuTier: GpuTier,
  preferredNodeId?: string
): Promise<{ id: string; walletAddress: string } | null> {
  // If preferred node specified and available, use it
  if (preferredNodeId) {
    const preferred = await prisma.node.findFirst({
      where: {
        id: preferredNodeId,
        gpuTier,
        status: 'ONLINE',
      },
      select: { id: true, walletAddress: true },
    })
    if (preferred) return preferred
  }

  // Find all online nodes of this tier with job counts
  const nodes = await prisma.node.findMany({
    where: {
      gpuTier,
      status: 'ONLINE',
    },
    select: {
      id: true,
      walletAddress: true,
      lastHeartbeat: true,
      _count: {
        select: {
          jobs: {
            where: {
              status: { in: ['ASSIGNED', 'RUNNING'] },
            },
          },
        },
      },
    },
    orderBy: [
      { lastHeartbeat: 'desc' }, // Most recent heartbeat first
    ],
  })

  if (nodes.length === 0) return null

  // Sort by active job count (ascending) to load balance
  nodes.sort((a, b) => a._count.jobs - b._count.jobs)

  const bestNode = nodes[0]
  if (!bestNode) return null

  return { id: bestNode.id, walletAddress: bestNode.walletAddress }
}

/**
 * Submit a job to the processing queue
 */
export async function submitJobToQueue(
  queue: Queue<JobPayload>,
  jobData: {
    jobId: string
    deploymentId: string
    gpuTier: GpuTier
    hasInternalDemand?: boolean
    preferredNodeId?: string
  }
) {
  const payload: JobPayload = {
    jobId: jobData.jobId,
    deploymentId: jobData.deploymentId,
    gpuTier: jobData.gpuTier,
    hasInternalDemand: jobData.hasInternalDemand ?? false,
    preferredNodeId: jobData.preferredNodeId,
  }

  await queue.add(`process-${jobData.jobId}`, payload, {
    priority: 1, // Normal priority
  })

  return payload
}

/**
 * Requeue a failed job for retry
 */
export async function requeueJob(
  queue: Queue<JobPayload>,
  prisma: PrismaClient,
  jobId: string
): Promise<boolean> {
  const job = await prisma.job.findUnique({ where: { id: jobId } })

  if (!job) return false
  if (job.retryCount >= MAX_RETRIES) return false
  if (job.status !== 'FAILED') return false

  // Reset status and requeue
  await prisma.job.update({
    where: { id: jobId },
    data: { status: 'PENDING' as JobStatus },
  })

  await submitJobToQueue(queue, {
    jobId: job.id,
    deploymentId: job.deploymentId,
    gpuTier: job.gpuTier,
    hasInternalDemand: false,
  })

  return true
}
