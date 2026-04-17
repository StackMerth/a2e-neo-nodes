import { Queue, Worker, type ConnectionOptions } from 'bullmq'
import type { PrismaClient } from '@a2e/database'
import { calculateUptimeEarnings } from '../services/earnings/uptime-calculator'

const QUEUE_NAME = 'earnings-rollup'

export function createEarningsRollupQueue(connection: ConnectionOptions): Queue {
  return new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      removeOnComplete: 50,
      removeOnFail: 20,
    },
  })
}

export function createEarningsRollupWorker(options: {
  redis: ConnectionOptions
  prisma: PrismaClient
}): Worker {
  const { redis, prisma } = options

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      const now = new Date()
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())

      // Find all online nodes with a node runner
      const nodes = await prisma.node.findMany({
        where: {
          status: { in: ['ONLINE', 'DEGRADED'] },
          nodeRunnerId: { not: null },
          pendingDeletion: false,
        },
        select: { id: true, gpuTier: true, nodeRunnerId: true, customRatePerHour: true },
      })

      if (nodes.length === 0) {
        return { calculated: 0 }
      }

      let updated = 0

      for (const node of nodes) {
        try {
          // Calculate uptime earnings for today so far
          const uptimeData = await calculateUptimeEarnings(
            prisma, node.id, todayStart, now
          )

          if (uptimeData && uptimeData.earnings > 0) {
            // Upsert today's earning record for this node (INTERNAL market)
            await prisma.earning.upsert({
              where: {
                nodeId_date_market: {
                  nodeId: node.id,
                  date: todayStart,
                  market: 'INTERNAL',
                },
              },
              create: {
                nodeId: node.id,
                date: todayStart,
                market: 'INTERNAL',
                gpuSeconds: Math.floor(uptimeData.uptimeHours * 3600),
                earnings: uptimeData.earnings,
                jobCount: 0,
              },
              update: {
                gpuSeconds: Math.floor(uptimeData.uptimeHours * 3600),
                earnings: uptimeData.earnings,
              },
            })
            updated++
          }
        } catch (error) {
          console.error(`[earnings-rollup] Failed for node ${node.id}:`, error)
        }
      }

      console.log(`[earnings-rollup] Updated ${updated}/${nodes.length} nodes`)
      return { calculated: updated, total: nodes.length }
    },
    {
      connection: redis,
      concurrency: 1,
    }
  )

  worker.on('completed', (job) => {
    // Silent - runs every 5 minutes
  })

  worker.on('failed', (job, err) => {
    console.error(`[earnings-rollup] Job failed:`, err.message)
  })

  return worker
}

export function scheduleEarningsRollup(queue: Queue) {
  // Run every 5 minutes
  queue.add('rollup', {}, {
    repeat: { every: 5 * 60 * 1000 },
  })
  console.log('[earnings-rollup] Scheduled to run every 5 minutes')
}
