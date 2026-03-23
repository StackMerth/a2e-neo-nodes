import { Queue, Worker, Job, type ConnectionOptions } from 'bullmq'
import type { PrismaClient, NodeStatus } from '@a2e/database'
import type { Server as SocketServer } from 'socket.io'

const QUEUE_NAME = 'node-health'
const DEGRADED_THRESHOLD_MS = 60_000 // 60 seconds
const OFFLINE_THRESHOLD_MS = 90_000 // 90 seconds

export interface NodeHealthDeps {
  redis: ConnectionOptions
  prisma: PrismaClient
  io?: SocketServer
}

export function createNodeHealthQueue(redis: ConnectionOptions): Queue {
  return new Queue(QUEUE_NAME, {
    connection: redis,
    defaultJobOptions: {
      removeOnComplete: 100,
      removeOnFail: 50,
    },
  })
}

export function createNodeHealthWorker(deps: NodeHealthDeps): Worker {
  const { redis, prisma, io } = deps

  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const now = new Date()
      const degradedThreshold = new Date(now.getTime() - DEGRADED_THRESHOLD_MS)
      const offlineThreshold = new Date(now.getTime() - OFFLINE_THRESHOLD_MS)

      const nodesToCheck = await prisma.node.findMany({
        where: {
          status: { in: ['ONLINE', 'DEGRADED'] },
        },
        select: {
          id: true,
          walletAddress: true,
          status: true,
          lastHeartbeat: true,
          missedBeats: true,
        },
      })

      let degradedCount = 0
      let offlineCount = 0

      for (const node of nodesToCheck) {
        let newStatus: NodeStatus | null = null

        if (node.lastHeartbeat < offlineThreshold) {
          if (node.status !== 'OFFLINE') {
            newStatus = 'OFFLINE'
            offlineCount++
          }
        } else if (node.lastHeartbeat < degradedThreshold) {
          if (node.status === 'ONLINE') {
            newStatus = 'DEGRADED'
            degradedCount++
          }
        }

        if (newStatus) {
          await prisma.node.update({
            where: { id: node.id },
            data: {
              status: newStatus,
              missedBeats: { increment: 1 },
            },
          })

          if (newStatus === 'OFFLINE') {
            io?.emit('node:offline', {
              id: node.id,
              walletAddress: node.walletAddress,
              reason: 'heartbeat_timeout',
              timestamp: now.toISOString(),
            })
          }
        }
      }

      console.log(`[node-health] Checked ${nodesToCheck.length} nodes: ${degradedCount} degraded, ${offlineCount} offline`)

      return {
        checked: nodesToCheck.length,
        degraded: degradedCount,
        offline: offlineCount,
      }
    },
    {
      connection: redis,
      concurrency: 1,
    }
  )

  worker.on('completed', (job: Job) => {
    // Silent completion - logged in job
  })

  worker.on('failed', (job: Job | undefined, err: Error) => {
    console.error(`[node-health] Job ${job?.id} failed:`, err.message)
  })

  return worker
}

export async function scheduleNodeHealthChecker(queue: Queue): Promise<void> {
  const checkIntervalMs = parseInt(process.env.HEARTBEAT_CHECK_INTERVAL_MS ?? '10000', 10)

  // Remove existing repeatable jobs
  const repeatableJobs = await queue.getRepeatableJobs()
  for (const job of repeatableJobs) {
    await queue.removeRepeatableByKey(job.key)
  }

  // Schedule new repeatable job
  await queue.add(
    'check-health',
    {},
    {
      repeat: {
        every: checkIntervalMs,
      },
    }
  )

  console.log(`[node-health] Scheduled to run every ${checkIntervalMs}ms`)
}
