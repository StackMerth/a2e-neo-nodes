import { Queue, Worker, Job } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { PrismaClient, GpuTier } from '@a2e/database'
import { NodeProvisioner, ProvisionConfig } from '../services/provisioning'
import { createNotification } from '../services/notification/service.js'
import type { Server as SocketServer } from 'socket.io'
import crypto from 'crypto'

const QUEUE_NAME = 'a2e-provision'

export interface ProvisionJobData {
  provisionId: string
  config: ProvisionConfig
  apiKey: string // Pre-generated API key for the node
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
      const { provisionId, config, apiKey } = job.data

      console.log(`[Provision] Starting job ${provisionId} for ${config.host}`)

      const provisioner = new NodeProvisioner(prisma, provisionId, apiKey)

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

        // Auto-complete any Investment/deployment that triggered this provisioning
        const provisionJob = await prisma.provisionJob.findUnique({
          where: { id: provisionId },
          select: { nodeId: true },
        })
        if (provisionJob?.nodeId) {
          const investment = await prisma.investment.findFirst({
            where: { provisionJobId: provisionId, status: 'DEPLOYING' },
            include: { nodeRunner: { select: { id: true, userId: true, name: true } } },
          })
          if (investment) {
            await prisma.$transaction([
              prisma.node.update({
                where: { id: provisionJob.nodeId },
                data: { nodeRunnerId: investment.nodeRunnerId },
              }),
              prisma.investment.update({
                where: { id: investment.id },
                data: {
                  status: 'PROVISIONED',
                  nodeId: provisionJob.nodeId,
                  provisionedAt: new Date(),
                },
              }),
            ])
            console.log(`[Provision] Auto-completed deployment ${investment.id} → node ${provisionJob.nodeId}`)

            // Notify node runner
            if (investment.nodeRunner?.userId) {
              void createNotification(
                investment.nodeRunner.userId,
                'DEPLOYMENT_COMPLETED',
                'Node Deployed!',
                `Your ${investment.gpuTier} node is now live and earning.`,
              )
            }

            io?.emit('deployment:statusChange', {
              investmentId: investment.id,
              oldStatus: 'DEPLOYING',
              newStatus: 'PROVISIONED',
              nodeRunnerId: investment.nodeRunnerId,
              timestamp: new Date().toISOString(),
            })
          }
        }
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

function generateNodeApiKey(): string {
  return `a2e-node-${crypto.randomBytes(16).toString('hex')}`
}

export async function submitProvisionJob(
  queue: Queue<ProvisionJobData>,
  prisma: PrismaClient,
  config: ProvisionConfig
): Promise<string> {
  // Generate unique API key for this node
  const apiKey = generateNodeApiKey()

  // Create provision job record with the API key
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
      apiKey, // Store the API key for auth validation
      status: 'PENDING',
      totalSteps: 7,
    },
  })

  // Queue the job with the API key
  await queue.add('provision', {
    provisionId: provisionJob.id,
    config,
    apiKey,
  }, {
    jobId: provisionJob.id,
  })

  return provisionJob.id
}
