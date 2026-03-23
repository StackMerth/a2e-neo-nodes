import { Queue, Worker, Job, type ConnectionOptions } from 'bullmq'
import type { PrismaClient, GpuTier, Market } from '@a2e/database'
import { AkashAdapter, IONetAdapter } from '@a2e/core'
import type { Server as SocketServer } from 'socket.io'

const GPU_TIERS: GpuTier[] = ['H100', 'H200', 'B200', 'B300', 'GB300']
const QUEUE_NAME = 'rate-fetcher'

export interface RateFetcherDeps {
  redis: ConnectionOptions
  prisma: PrismaClient
  io?: SocketServer
}

export function createRateFetcherQueue(redis: ConnectionOptions): Queue {
  return new Queue(QUEUE_NAME, {
    connection: redis,
    defaultJobOptions: {
      removeOnComplete: 100,
      removeOnFail: 50,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5000,
      },
    },
  })
}

export function createRateFetcherWorker(deps: RateFetcherDeps): Worker {
  const { redis, prisma, io } = deps

  const akashAdapter = new AkashAdapter()
  const ionetAdapter = new IONetAdapter()

  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const jobLogger = {
        info: (msg: string, data?: object) => console.log(`[rate-fetcher] ${msg}`, data ?? ''),
        error: (msg: string, err?: unknown) => console.error(`[rate-fetcher] ${msg}`, err),
      }

      jobLogger.info('Starting rate fetch job', { jobId: job.id })

      const results: Array<{
        market: Market
        gpuTier: GpuTier
        ratePerHour: number
        ratePerDay: number
        available: boolean
      }> = []

      for (const gpuTier of GPU_TIERS) {
        if (akashAdapter.isEnabled()) {
          try {
            const akashRate = await akashAdapter.getRate(gpuTier)
            results.push({
              market: 'AKASH',
              gpuTier,
              ratePerHour: akashRate.ratePerHour,
              ratePerDay: akashRate.ratePerDay,
              available: akashRate.available,
            })
          } catch (err) {
            jobLogger.error(`Failed to fetch Akash rate for ${gpuTier}`, err)
          }
        }

        if (ionetAdapter.isEnabled()) {
          try {
            const ionetRate = await ionetAdapter.getRate(gpuTier)
            results.push({
              market: 'IONET',
              gpuTier,
              ratePerHour: ionetRate.ratePerHour,
              ratePerDay: ionetRate.ratePerDay,
              available: ionetRate.available,
            })
          } catch (err) {
            jobLogger.error(`Failed to fetch IO.net rate for ${gpuTier}`, err)
          }
        }
      }

      for (const rate of results) {
        await prisma.marketRate.upsert({
          where: {
            market_gpuTier: {
              market: rate.market,
              gpuTier: rate.gpuTier,
            },
          },
          update: {
            ratePerHour: rate.ratePerHour,
            ratePerDay: rate.ratePerDay,
            available: rate.available,
            fetchedAt: new Date(),
          },
          create: {
            market: rate.market,
            gpuTier: rate.gpuTier,
            ratePerHour: rate.ratePerHour,
            ratePerDay: rate.ratePerDay,
            available: rate.available,
          },
        })

        await prisma.marketRateHistory.create({
          data: {
            market: rate.market,
            gpuTier: rate.gpuTier,
            ratePerHour: rate.ratePerHour,
            ratePerDay: rate.ratePerDay,
          },
        })

        io?.emit('rate:updated', {
          market: rate.market,
          gpuTier: rate.gpuTier,
          ratePerHour: rate.ratePerHour,
          ratePerDay: rate.ratePerDay,
          timestamp: new Date().toISOString(),
        })
      }

      jobLogger.info('Rate fetch completed', { ratesUpdated: results.length })

      return { ratesUpdated: results.length }
    },
    {
      connection: redis,
      concurrency: 1,
    }
  )

  worker.on('completed', (job: Job) => {
    console.log(`[rate-fetcher] Job ${job.id} completed`)
  })

  worker.on('failed', (job: Job | undefined, err: Error) => {
    console.error(`[rate-fetcher] Job ${job?.id} failed:`, err.message)
  })

  return worker
}

export async function scheduleRateFetcher(queue: Queue): Promise<void> {
  const fetchIntervalMs = parseInt(process.env.RATE_FETCH_INTERVAL_MS ?? '60000', 10)

  // Remove existing repeatable jobs
  const repeatableJobs = await queue.getRepeatableJobs()
  for (const job of repeatableJobs) {
    await queue.removeRepeatableByKey(job.key)
  }

  // Schedule new repeatable job
  await queue.add(
    'fetch-rates',
    {},
    {
      repeat: {
        every: fetchIntervalMs,
      },
    }
  )

  // Also run immediately
  await queue.add('fetch-rates-immediate', {})

  console.log(`[rate-fetcher] Scheduled to run every ${fetchIntervalMs}ms`)
}
