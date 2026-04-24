// External Job Execution Bridge Tests (F3.4)

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type {
  PrismaClient,
  ExternalDeployment,
  ExternalDeploymentStatus,
  Job,
  JobSource,
  JobStatus,
} from '@a2e/database'
import type { AdapterRegistry, DeploymentStatus } from '@a2e/core'
import {
  getExternalJobsForDeployment,
  onWorkloadCompleted,
  onWorkloadFailed,
  onWorkloadReceived,
} from '../execution-bridge'

// --- Types mirroring a minimal DB shape for the fake Prisma ---------------

interface NodeRow {
  id: string
  gpuTier: 'H100' | 'H200' | 'B200' | 'B300' | 'GB300' | 'OTHER'
}

type DeploymentRow = ExternalDeployment & { node?: NodeRow }

type JobRow = Job

interface EarningRow {
  id: string
  nodeId: string
  date: Date
  market: string
  gpuSeconds: number
  earnings: number
  jobCount: number
}

function makeDeployment(overrides: Partial<DeploymentRow> = {}): DeploymentRow {
  const now = new Date()
  return {
    id: 'dep-1',
    nodeId: 'node-1',
    market: 'AKASH',
    externalId: 'ext-1',
    status: 'ACTIVE',
    ratePerHour: 4.5,
    costAccumulated: 0,
    earningsAccumulated: 0,
    createdAt: now,
    terminatedAt: null,
    lastCheckedAt: now,
    terminationMode: null,
    terminationReason: null,
    ...overrides,
  } as DeploymentRow
}

function makeJob(overrides: Partial<JobRow> = {}): JobRow {
  const now = new Date()
  return {
    id: 'job-1',
    deploymentId: 'ext-workload-1',
    nodeId: 'node-1',
    market: 'AKASH',
    ratePerHour: 4.5,
    gpuTier: 'H100',
    status: 'ASSIGNED',
    source: 'EXTERNAL',
    externalDeploymentId: 'dep-1',
    requestedAt: now,
    routedAt: now,
    startedAt: null,
    completedAt: null,
    durationSeconds: 3600,
    earnings: null,
    cost: null,
    profit: null,
    errorMessage: null,
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as JobRow
}

interface FakePrismaStore {
  nodes: NodeRow[]
  deployments: DeploymentRow[]
  jobs: JobRow[]
  earnings: EarningRow[]
  jobCreateCalls: unknown[]
  jobUpdateCalls: unknown[]
  deploymentUpdateCalls: unknown[]
  earningUpsertCalls: unknown[]
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  )
}

function makeFakePrisma(init: Partial<FakePrismaStore>): {
  prisma: PrismaClient
  store: FakePrismaStore
} {
  const store: FakePrismaStore = {
    nodes: init.nodes ?? [],
    deployments: init.deployments ?? [],
    jobs: init.jobs ?? [],
    earnings: init.earnings ?? [],
    jobCreateCalls: [],
    jobUpdateCalls: [],
    deploymentUpdateCalls: [],
    earningUpsertCalls: [],
  }

  let jobIdCounter = store.jobs.length + 1
  let earningIdCounter = store.earnings.length + 1

  const prisma: Partial<PrismaClient> = {
    externalDeployment: {
      findUnique: vi.fn(
        async (args: {
          where: { id: string }
          include?: { node?: boolean }
        }) => {
          const dep = store.deployments.find((d) => d.id === args.where.id)
          if (!dep) return null
          if (args.include?.node) {
            const node = store.nodes.find((n) => n.id === dep.nodeId)
            return { ...dep, node }
          }
          return dep
        },
      ),
      update: vi.fn(
        async (args: {
          where: { id: string }
          data: Partial<DeploymentRow>
        }) => {
          store.deploymentUpdateCalls.push(args)
          const row = store.deployments.find((d) => d.id === args.where.id)
          if (!row) throw new Error(`deployment ${args.where.id} not in fake store`)
          Object.assign(row, args.data)
          return row
        },
      ),
    } as unknown as PrismaClient['externalDeployment'],

    job: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        return store.jobs.find((j) => j.id === args.where.id) ?? null
      }),
      findMany: vi.fn(
        async (args: {
          where: { externalDeploymentId?: string }
          orderBy?: { createdAt?: 'asc' | 'desc' }
        }) => {
          const filtered = store.jobs.filter(
            (j) => j.externalDeploymentId === args.where.externalDeploymentId,
          )
          const direction = args.orderBy?.createdAt ?? 'desc'
          return [...filtered].sort((a, b) => {
            const at = a.createdAt.getTime()
            const bt = b.createdAt.getTime()
            return direction === 'desc' ? bt - at : at - bt
          })
        },
      ),
      create: vi.fn(async (args: { data: Partial<JobRow> }) => {
        store.jobCreateCalls.push(args)
        const row = makeJob({
          id: `job-${jobIdCounter++}`,
          ...args.data,
        })
        store.jobs.push(row)
        return row
      }),
      update: vi.fn(
        async (args: {
          where: { id: string }
          data: Partial<JobRow>
        }) => {
          store.jobUpdateCalls.push(args)
          const row = store.jobs.find((j) => j.id === args.where.id)
          if (!row) throw new Error(`job ${args.where.id} not in fake store`)
          Object.assign(row, args.data)
          return row
        },
      ),
    } as unknown as PrismaClient['job'],

    earning: {
      upsert: vi.fn(
        async (args: {
          where: {
            nodeId_date_market: { nodeId: string; date: Date; market: string }
          }
          update: {
            earnings?: { increment: number }
            gpuSeconds?: { increment: number }
            jobCount?: { increment: number }
          }
          create: {
            nodeId: string
            date: Date
            market: string
            earnings: number
            gpuSeconds: number
            jobCount: number
          }
        }) => {
          store.earningUpsertCalls.push(args)
          const { nodeId, date, market } = args.where.nodeId_date_market
          const existing = store.earnings.find(
            (e) => e.nodeId === nodeId && sameDay(e.date, date) && e.market === market,
          )
          if (existing) {
            if (args.update.earnings?.increment) {
              existing.earnings += args.update.earnings.increment
            }
            if (args.update.gpuSeconds?.increment) {
              existing.gpuSeconds += args.update.gpuSeconds.increment
            }
            if (args.update.jobCount?.increment) {
              existing.jobCount += args.update.jobCount.increment
            }
            return existing
          }
          const row: EarningRow = {
            id: `earn-${earningIdCounter++}`,
            nodeId: args.create.nodeId,
            date: args.create.date,
            market: args.create.market,
            earnings: args.create.earnings,
            gpuSeconds: args.create.gpuSeconds,
            jobCount: args.create.jobCount,
          }
          store.earnings.push(row)
          return row
        },
      ),
    } as unknown as PrismaClient['earning'],
  }

  return { prisma: prisma as PrismaClient, store }
}

// --- Fake AdapterRegistry --------------------------------------------------

interface FakeRegistryOptions {
  costResult?: { accumulatedUsd: number }
  costError?: Error
  adapterPresent?: boolean
}

interface FakeRegistry {
  registry: AdapterRegistry
  successCalls: string[]
  failureCalls: Array<{ market: string; error: string }>
  costCalls: string[]
}

function makeFakeRegistry(opts: FakeRegistryOptions = {}): FakeRegistry {
  const successCalls: string[] = []
  const failureCalls: Array<{ market: string; error: string }> = []
  const costCalls: string[] = []

  const adapter = opts.adapterPresent === false
    ? undefined
    : {
        market: 'AKASH',
        getDeploymentCost: vi.fn(async (id: string) => {
          costCalls.push(id)
          if (opts.costError) throw opts.costError
          return opts.costResult ?? { accumulatedUsd: 0 }
        }),
      }

  const registry = {
    get: vi.fn(() => adapter),
    isAvailable: vi.fn(() => true),
    recordSuccess: vi.fn((market: string) => {
      successCalls.push(market)
    }),
    recordFailure: vi.fn((market: string, error: Error | string) => {
      failureCalls.push({
        market,
        error: error instanceof Error ? error.message : String(error),
      })
    }),
  } as unknown as AdapterRegistry

  return { registry, successCalls, failureCalls, costCalls }
}

// --- onWorkloadReceived ---------------------------------------------------

describe('onWorkloadReceived', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('throws when deployment is not found', async () => {
    const { prisma, store } = makeFakePrisma({})

    await expect(
      onWorkloadReceived(prisma, {
        deploymentId: 'missing',
        workload: {
          externalWorkloadId: 'bid-1',
          gpuTierRequired: 'H100',
          durationHours: 1,
        },
      }),
    ).rejects.toThrow('deployment not found')

    expect(store.jobCreateCalls).toHaveLength(0)
  })

  it('throws when deployment is not ACTIVE', async () => {
    const dep = makeDeployment({ status: 'TERMINATED' as ExternalDeploymentStatus })
    const { prisma, store } = makeFakePrisma({
      nodes: [{ id: 'node-1', gpuTier: 'H100' }],
      deployments: [dep],
    })

    await expect(
      onWorkloadReceived(prisma, {
        deploymentId: dep.id,
        workload: {
          externalWorkloadId: 'bid-1',
          gpuTierRequired: 'H100',
          durationHours: 1,
        },
      }),
    ).rejects.toThrow('deployment not active')

    expect(store.jobCreateCalls).toHaveLength(0)
  })

  it('creates Job with source=EXTERNAL and correct fields on happy path', async () => {
    const dep = makeDeployment({
      id: 'dep-happy',
      nodeId: 'node-42',
      market: 'AKASH',
      ratePerHour: 5.25,
    })
    const { prisma, store } = makeFakePrisma({
      nodes: [{ id: 'node-42', gpuTier: 'H200' }],
      deployments: [dep],
    })

    const job = await onWorkloadReceived(prisma, {
      deploymentId: dep.id,
      workload: {
        externalWorkloadId: 'akash-lease-xyz',
        gpuTierRequired: 'H200',
        durationHours: 2.5,
      },
    })

    expect(job.source).toBe('EXTERNAL')
    expect(job.status).toBe('ASSIGNED')
    expect(job.externalDeploymentId).toBe('dep-happy')
    expect(job.nodeId).toBe('node-42')
    expect(job.market).toBe('AKASH')
    expect(job.ratePerHour).toBe(5.25)
    expect(job.gpuTier).toBe('H200')
    expect(job.durationSeconds).toBe(9000) // 2.5h * 3600
    expect(job.deploymentId).toBe('akash-lease-xyz')
    expect(job.requestedAt).toBeInstanceOf(Date)
    expect(job.routedAt).toBeInstanceOf(Date)
    expect(store.jobCreateCalls).toHaveLength(1)
  })
})

// --- onWorkloadCompleted --------------------------------------------------

describe('onWorkloadCompleted', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('throws when job is not found', async () => {
    const { prisma } = makeFakePrisma({})
    const fake = makeFakeRegistry({})

    await expect(
      onWorkloadCompleted(prisma, fake.registry, {
        jobId: 'missing',
        result: { success: true },
      }),
    ).rejects.toThrow('job not found')
  })

  it('throws when job source is INTERNAL', async () => {
    const job = makeJob({ source: 'INTERNAL' as JobSource })
    const { prisma } = makeFakePrisma({ jobs: [job] })
    const fake = makeFakeRegistry({})

    await expect(
      onWorkloadCompleted(prisma, fake.registry, {
        jobId: job.id,
        result: { success: true },
      }),
    ).rejects.toThrow('not an external job')
  })

  it('is idempotent when job already COMPLETED', async () => {
    const job = makeJob({
      status: 'COMPLETED' as JobStatus,
      earnings: 4.5,
      completedAt: new Date(),
    })
    const { prisma, store } = makeFakePrisma({ jobs: [job] })
    const fake = makeFakeRegistry({})

    const result = await onWorkloadCompleted(prisma, fake.registry, {
      jobId: job.id,
      result: { success: true },
    })

    expect(result.earningsDelta).toBe(0)
    expect(result.job.status).toBe('COMPLETED')
    expect(store.jobUpdateCalls).toHaveLength(0)
    expect(fake.costCalls).toHaveLength(0)
  })

  it('updates to COMPLETED, computes earnings, and calls recordExternalEarnings', async () => {
    const dep = makeDeployment({
      id: 'dep-earn',
      ratePerHour: 4.0,
      earningsAccumulated: 0,
    })
    const job = makeJob({
      id: 'job-earn',
      externalDeploymentId: 'dep-earn',
      ratePerHour: 4.0,
      durationSeconds: 7200, // 2 hours
    })
    const { prisma, store } = makeFakePrisma({
      deployments: [dep],
      jobs: [job],
    })
    const fake = makeFakeRegistry({ costResult: { accumulatedUsd: 8.0 } })

    const result = await onWorkloadCompleted(prisma, fake.registry, {
      jobId: job.id,
      result: { success: true },
    })

    // 4.0/hr * (7200/3600) = 8.0
    expect(result.earningsDelta).toBeCloseTo(8.0)
    expect(result.job.status).toBe('COMPLETED')
    expect(result.job.earnings).toBeCloseTo(8.0)
    expect(result.job.completedAt).toBeInstanceOf(Date)
    expect(result.job.startedAt).toBeInstanceOf(Date)

    // recordExternalEarnings should have been invoked — proven by the cost
    // call and earning upsert it performs.
    expect(fake.costCalls).toEqual(['ext-1'])
    expect(store.earningUpsertCalls).toHaveLength(1)
    expect(store.earnings).toHaveLength(1)
    expect(store.earnings[0]!.earnings).toBeCloseTo(8.0)
  })

  it('zeroes earnings when result.success=false', async () => {
    const dep = makeDeployment({ id: 'dep-fail-earn' })
    const job = makeJob({
      id: 'job-fail-earn',
      externalDeploymentId: 'dep-fail-earn',
      ratePerHour: 4.0,
      durationSeconds: 3600,
    })
    const { prisma } = makeFakePrisma({ deployments: [dep], jobs: [job] })
    const fake = makeFakeRegistry({ costResult: { accumulatedUsd: 0 } })

    const result = await onWorkloadCompleted(prisma, fake.registry, {
      jobId: job.id,
      result: { success: false, exitCode: 1 },
    })

    expect(result.earningsDelta).toBe(0)
    expect(result.job.status).toBe('COMPLETED')
    expect(result.job.earnings).toBe(0)
  })

  it('preserves existing startedAt when set', async () => {
    const dep = makeDeployment({ id: 'dep-start' })
    const existingStart = new Date('2026-04-21T10:00:00Z')
    const job = makeJob({
      id: 'job-start',
      externalDeploymentId: 'dep-start',
      startedAt: existingStart,
      ratePerHour: 4.0,
      durationSeconds: 3600,
    })
    const { prisma } = makeFakePrisma({ deployments: [dep], jobs: [job] })
    const fake = makeFakeRegistry({ costResult: { accumulatedUsd: 4.0 } })

    const result = await onWorkloadCompleted(prisma, fake.registry, {
      jobId: job.id,
      result: { success: true },
    })

    expect(result.job.startedAt).toEqual(existingStart)
  })
})

// --- onWorkloadFailed -----------------------------------------------------

describe('onWorkloadFailed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('throws when job is not found', async () => {
    const { prisma } = makeFakePrisma({})

    await expect(
      onWorkloadFailed(prisma, {
        jobId: 'missing',
        failure: { errorMessage: 'boom' },
      }),
    ).rejects.toThrow('job not found')
  })

  it('throws when job source is INTERNAL', async () => {
    const job = makeJob({ source: 'INTERNAL' as JobSource })
    const { prisma } = makeFakePrisma({ jobs: [job] })

    await expect(
      onWorkloadFailed(prisma, {
        jobId: job.id,
        failure: { errorMessage: 'boom' },
      }),
    ).rejects.toThrow('not an external job')
  })

  it('increments retryCount without marking FAILED below threshold', async () => {
    const dep = makeDeployment({ id: 'dep-retry' })
    const job = makeJob({
      id: 'job-retry',
      externalDeploymentId: 'dep-retry',
      retryCount: 0,
    })
    const { prisma, store } = makeFakePrisma({
      deployments: [dep],
      jobs: [job],
    })

    const result = await onWorkloadFailed(prisma, {
      jobId: job.id,
      failure: { errorMessage: 'transient' },
      maxRetries: 2,
    })

    // nextRetryCount = 1, below maxRetries=2 → soft failure
    expect(result.deploymentFailed).toBe(false)
    expect(result.job.status).toBe('ASSIGNED')
    expect(result.job.retryCount).toBe(1)
    expect(result.job.errorMessage).toBe('transient')
    expect(store.deploymentUpdateCalls).toHaveLength(0)
    expect(dep.status).toBe('ACTIVE')
  })

  it('marks Job FAILED and Deployment FAILED at retry threshold', async () => {
    const dep = makeDeployment({ id: 'dep-dead' })
    const job = makeJob({
      id: 'job-dead',
      externalDeploymentId: 'dep-dead',
      retryCount: 1, // already retried once
    })
    const { prisma } = makeFakePrisma({
      deployments: [dep],
      jobs: [job],
    })

    const result = await onWorkloadFailed(prisma, {
      jobId: job.id,
      failure: { errorMessage: 'permanent failure', code: 'OOM' },
      maxRetries: 2,
    })

    expect(result.deploymentFailed).toBe(true)
    expect(result.job.status).toBe('FAILED')
    expect(result.job.retryCount).toBe(2)
    expect(result.job.errorMessage).toBe('permanent failure')

    expect(dep.status).toBe('FAILED')
    expect(dep.terminatedAt).toBeInstanceOf(Date)
    expect(dep.terminationReason).toBe('workload failed: permanent failure')
  })

  it('uses default maxRetries=2 when not provided', async () => {
    const dep = makeDeployment({ id: 'dep-default' })
    const job = makeJob({
      id: 'job-default',
      externalDeploymentId: 'dep-default',
      retryCount: 1,
    })
    const { prisma } = makeFakePrisma({ deployments: [dep], jobs: [job] })

    const result = await onWorkloadFailed(prisma, {
      jobId: job.id,
      failure: { errorMessage: 'final' },
    })

    // retryCount 1 + 1 = 2 >= default 2 → escalate
    expect(result.deploymentFailed).toBe(true)
    expect(result.job.status).toBe('FAILED')
    expect(dep.status).toBe('FAILED')
  })
})

// --- getExternalJobsForDeployment -----------------------------------------

describe('getExternalJobsForDeployment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns jobs filtered by externalDeploymentId, newest first', async () => {
    const older = makeJob({
      id: 'job-older',
      externalDeploymentId: 'dep-x',
      createdAt: new Date('2026-04-20T10:00:00Z'),
    })
    const newer = makeJob({
      id: 'job-newer',
      externalDeploymentId: 'dep-x',
      createdAt: new Date('2026-04-21T10:00:00Z'),
    })
    const other = makeJob({
      id: 'job-other',
      externalDeploymentId: 'dep-y',
      createdAt: new Date('2026-04-21T11:00:00Z'),
    })

    const { prisma } = makeFakePrisma({ jobs: [older, newer, other] })

    const result = await getExternalJobsForDeployment(prisma, 'dep-x')

    expect(result).toHaveLength(2)
    expect(result[0]!.id).toBe('job-newer')
    expect(result[1]!.id).toBe('job-older')
  })

  it('returns empty array when no jobs match', async () => {
    const { prisma } = makeFakePrisma({ jobs: [] })
    const result = await getExternalJobsForDeployment(prisma, 'dep-missing')
    expect(result).toEqual([])
  })
})
