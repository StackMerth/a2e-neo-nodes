import { Queue, Worker, Job } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { PrismaClient, GpuTier } from '@a2e/database'
import { NodeProvisioner, ProvisionConfig } from '../services/provisioning'
import type { Server as SocketServer } from 'socket.io'

const QUEUE_NAME = 'a2e-provision'

export interface ProvisionJobData {
  provisionId: string
  config: ProvisionConfig
}

export function createProvisionQueue(connection: ConnectionOptions): Queue<ProvisionJobData> {
  return new Queue<ProvisionJobData>(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1, // No retries for provisioning
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    },
  })
}

export function createProvisionWorker(options: {
  redis: ConnectionOptions
  prisma: PrismaClient
  io?: SocketServer
}): Worker<ProvisionJobData> {
  const { redis, prisma, io } = options

  const worker = new Worker<ProvisionJobData>(
    QUEUE_NAME,
    async (job: Job<ProvisionJobData>) => {
      const { provisionId, config } = job.data

      console.log(`[Provision] Starting job ${provisionId} for ${config.host}`)

      const provisioner = new NodeProvisioner(prisma, provisionId)

      // Forward events to WebSocket
      provisioner.on('status', (data) => {
        io?.emit('provision:status', { provisionId, ...data })
      })

      provisioner.on('log', (entry) => {
        io?.emit('provision:log', { provisionId, ...entry })
      })

      provisioner.on('completed', (nodeId) => {
        io?.emit('provision:complete', { provisionId, nodeId })
      })

      provisioner.on('failed', (error) => {
        io?.emit('provision:failed', { provisionId, error })
      })

      try {
        await provisioner.provision(config)
        console.log(`[Provision] Job ${provisionId} completed successfully`)
      } catch (error) {
        console.error(`[Provision] Job ${provisionId} failed:`, error)
        throw error
      }
    },
    {
      connection: redis,
      concurrency: 3, // Max 3 concurrent provisions
    }
  )

  worker.on('completed', (job) => {
    console.log(`[Provision] Worker completed job ${job.id}`)
  })

  worker.on('failed', (job, error) => {
    console.error(`[Provision] Worker failed job ${job?.id}:`, error.message)
  })

  return worker
}

export async function submitProvisionJob(
  queue: Queue<ProvisionJobData>,
  prisma: PrismaClient,
  config: ProvisionConfig
): Promise<string> {
  // Create provision job record
  const provisionJob = await prisma.provisionJob.create({
    data: {
      host: config.host,
      port: config.port,
      username: config.username,
      gpuTier: config.gpuTier,
      nodeName: config.nodeName,
      region: config.region,
      customGpuModel: config.customGpuModel,
      customRatePerHour: config.customRatePerDay ? config.customRatePerDay / 24 : undefined,
      customRatePerDay: config.customRatePerDay,
      status: 'PENDING',
      totalSteps: 7,
    },
  })

  // Queue the job
  await queue.add('provision', {
    provisionId: provisionJob.id,
    config,
  }, {
    jobId: provisionJob.id,
  })

  return provisionJob.id
}
