// Type augmentations for Fastify
import type { Queue } from 'bullmq'
import type { GpuTier } from '@a2e/database'
import type { ProvisionJobData } from './jobs/provision-processor'

interface JobPayload {
  jobId: string
  deploymentId: string
  gpuTier: GpuTier
  hasInternalDemand: boolean
  preferredNodeId?: string
}

declare module 'fastify' {
  interface FastifyInstance {
    jobQueue: Queue<JobPayload>
    provisionQueue: Queue<ProvisionJobData>
  }
}
