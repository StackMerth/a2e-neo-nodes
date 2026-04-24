// Overflow Safe Termination Policy Tests (F3.5)

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Job, Queue } from 'bullmq'
import type {
  PrismaClient,
  ExternalDeployment,
  ExternalDeploymentStatus,
} from '@a2e/database'
import type { AdapterRegistry } from '@a2e/core'
import {
  TERMINATION_QUEUE_NAME,
  decideTerminationAction,
  processTerminationJob,
  scheduleForceTermination,
  scheduleSafeTermination,
  type DelistNodeFn,
  type TerminationPolicyJobData,
} from '../termination-policy'

// --- decideTerminationAction -----------------------------------------------

describe('decideTerminationAction', () => {
  const base = {
    deploymentStatus: 'TERMINATING' as ExternalDeploymentStatus,
    safeInitiatedAtMs: 1_000_000,
    nowMs: 1_000_000,
    gracePeriodSeconds: 300,
    nodeHasActiveExternalJob: true,
  }

  it('returns SKIP when deployment is already TERMINATED', () => {
    expect(
      decideTerminationAction({ ...base, deploymentStatus: 'TERMINATED' }),
    ).toBe('SKIP')
  })

  it('returns SKIP when deployment is FAILED', () => {
    expect(
      decideTerminationAction({ ...base, deploymentStatus: 'FAILED' }),
    ).toBe('SKIP')
  })

  it('returns RESCHEDULE when TERMINATING, grace not expired, active job', () => {
    expect(
      decideTerminationAction({
        ...base,
        nowMs: base.safeInitiatedAtMs + 60_000, // 1min elapsed, grace 5min
      }),
    ).toBe('RESCHEDULE')
  })

  it('returns FORCE_NOW when TERMINATING, grace not expired, no active job', () => {
    expect(
      decideTerminationAction({
        ...base,
        nowMs: base.safeInitiatedAtMs + 60_000,
        nodeHasActiveExternalJob: false,
      }),
    ).toBe('FORCE_NOW')
  })

  it('returns FORCE_NOW when TERMINATING and grace expired even with active job', () => {
    expect(
      decideTerminationAction({
        ...base,
        nowMs: base.safeInitiatedAtMs + 301_000, // 301s, grace 300s
        nodeHasActiveExternalJob: true,
      }),
    ).toBe('FORCE_NOW')
  })

  it('grace expired at exact boundary (>=) returns FORCE_NOW', () => {
    expect(
      decideTerminationAction({
        ...base,
        nowMs: base.safeInitiatedAtMs + 300_000, // exactly 300s
        nodeHasActiveExternalJob: true,
      }),
    ).toBe('FORCE_NOW')
  })

  it('returns FORCE_NOW defensively for unexpected ACTIVE status', () => {
    expect(
      decideTerminationAction({ ...base, deploymentStatus: 'ACTIVE' }),
    ).toBe('FORCE_NOW')
  })

  it('returns FORCE_NOW defensively for unexpected PENDING status', () => {
    expect(
      decideTerminationAction({ ...base, deploymentStatus: 'PENDING' }),
    ).toBe('FORCE_NOW')
  })
})

// --- scheduleSafeTermination / scheduleForceTermination --------------------

function makeFakeQueue(): { queue: Queue; add: ReturnType<typeof vi.fn> } {
  const add = vi.fn().mockResolvedValue({ id: 'queued-job-1' })
  const queue = { add } as unknown as Queue
  return { queue, add }
}

describe('scheduleSafeTermination', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('enqueues a SAFE job with delay = pollIntervalSeconds * 1000', async () => {
    const { queue, add } = makeFakeQueue()
    const safeInitiatedAt = new Date('2026-04-21T10:00:00Z')

    await scheduleSafeTermination(queue, {
      deploymentId: 'dep-1',
      reason: 'draining',
      gracePeriodSeconds: 300,
      safeInitiatedAt,
      pollIntervalSeconds: 45,
    })

    expect(add).toHaveBeenCalledTimes(1)
    const [name, data, opts] = add.mock.calls[0]!
    expect(name).toBe('safe-termination-poll')
    expect(data).toMatchObject({
      deploymentId: 'dep-1',
      reason: 'draining',
      mode: 'SAFE',
      gracePeriodSeconds: 300,
      safeInitiatedAt: safeInitiatedAt.toISOString(),
      pollIntervalSeconds: 45,
    })
    expect(opts.delay).toBe(45 * 1000)
  })

  it('defaults pollIntervalSeconds to 30 when omitted', async () => {
    const { queue, add } = makeFakeQueue()

    await scheduleSafeTermination(queue, {
      deploymentId: 'dep-2',
      reason: 'r',
      gracePeriodSeconds: 120,
    })

    const [, data, opts] = add.mock.calls[0]!
    expect(data.pollIntervalSeconds).toBe(30)
    expect(opts.delay).toBe(30_000)
  })
})

describe('scheduleForceTermination', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('enqueues a FORCE job with delay 0', async () => {
    const { queue, add } = makeFakeQueue()

    await scheduleForceTermination(queue, {
      deploymentId: 'dep-3',
      reason: 'market gone',
    })

    const [name, data, opts] = add.mock.calls[0]!
    expect(name).toBe('force-termination')
    expect(data.mode).toBe('FORCE')
    expect(data.deploymentId).toBe('dep-3')
    expect(opts.delay).toBe(0)
  })
})

// --- processTerminationJob -------------------------------------------------

interface FakePrismaStore {
  deployments: ExternalDeployment[]
  activeJobCount: number
  auditLogs: Array<{
    entityType: string
    entityId: string
    action: string
    reason?: string | null
    actorType?: string
    metadata?: unknown
  }>
  auditError?: Error
}

function makeFakeDeployment(
  overrides: Partial<ExternalDeployment> = {},
): ExternalDeployment {
  const now = new Date()
  return {
    id: 'dep-1',
    nodeId: 'node-1',
    market: 'AKASH',
    externalId: 'ext-1',
    status: 'TERMINATING',
    ratePerHour: 4.5,
    costAccumulated: 0,
    earningsAccumulated: 0,
    createdAt: now,
    terminatedAt: null,
    lastCheckedAt: now,
    terminationMode: 'SAFE',
    terminationReason: 'draining',
    ...overrides,
  } as ExternalDeployment
}

function makeFakePrisma(init: Partial<FakePrismaStore>): {
  prisma: PrismaClient
  store: FakePrismaStore
} {
  const store: FakePrismaStore = {
    deployments: init.deployments ?? [],
    activeJobCount: init.activeJobCount ?? 0,
    auditLogs: [],
    auditError: init.auditError,
  }

  const prisma: Partial<PrismaClient> = {
    externalDeployment: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        return store.deployments.find((d) => d.id === args.where.id) ?? null
      }),
    } as unknown as PrismaClient['externalDeployment'],

    job: {
      count: vi.fn(async () => store.activeJobCount),
    } as unknown as PrismaClient['job'],

    auditLog: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        if (store.auditError) throw store.auditError
        store.auditLogs.push({
          entityType: args.data.entityType as string,
          entityId: args.data.entityId as string,
          action: args.data.action as string,
          reason: args.data.reason as string | null | undefined,
          actorType: args.data.actorType as string | undefined,
          metadata: args.data.metadata,
        })
        return { id: `audit-${store.auditLogs.length}` }
      }),
    } as unknown as PrismaClient['auditLog'],
  }

  return { prisma: prisma as PrismaClient, store }
}

function makeFakeRegistry(): AdapterRegistry {
  return {
    get: vi.fn(() => undefined),
    isAvailable: vi.fn(() => true),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  } as unknown as AdapterRegistry
}

function makeFakeJob(data: TerminationPolicyJobData): Job<TerminationPolicyJobData> {
  return { id: 'job-1', data } as unknown as Job<TerminationPolicyJobData>
}

describe('processTerminationJob', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('logs and returns when deployment is missing', async () => {
    const { prisma, store } = makeFakePrisma({ deployments: [] })
    const delistNodeFn = vi.fn<Parameters<DelistNodeFn>, ReturnType<DelistNodeFn>>()
    const { queue, add } = makeFakeQueue()

    const job = makeFakeJob({
      deploymentId: 'missing',
      reason: 'r',
      mode: 'SAFE',
      gracePeriodSeconds: 300,
      safeInitiatedAt: new Date().toISOString(),
    })

    await processTerminationJob(job, {
      prisma,
      registry: makeFakeRegistry(),
      queue,
      delistNodeFn,
      pollIntervalSeconds: 30,
    })

    expect(delistNodeFn).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()
    expect(store.auditLogs).toHaveLength(1)
    expect(store.auditLogs[0]!.action).toBe('TERMINATION_DEPLOYMENT_MISSING')
    expect(store.auditLogs[0]!.entityId).toBe('missing')
  })

  it('FORCE mode calls delistNodeFn with FORCE and writes audit', async () => {
    const dep = makeFakeDeployment({ status: 'ACTIVE' })
    const { prisma, store } = makeFakePrisma({ deployments: [dep] })
    const delistNodeFn = vi
      .fn<Parameters<DelistNodeFn>, ReturnType<DelistNodeFn>>()
      .mockResolvedValue({ status: 'TERMINATED', terminated: true })
    const { queue, add } = makeFakeQueue()

    const job = makeFakeJob({
      deploymentId: dep.id,
      reason: 'admin override',
      mode: 'FORCE',
      gracePeriodSeconds: 0,
      safeInitiatedAt: new Date().toISOString(),
    })

    await processTerminationJob(job, {
      prisma,
      registry: makeFakeRegistry(),
      queue,
      delistNodeFn,
      pollIntervalSeconds: 30,
    })

    expect(delistNodeFn).toHaveBeenCalledWith({
      deploymentId: dep.id,
      mode: 'FORCE',
      reason: 'admin override',
    })
    expect(add).not.toHaveBeenCalled()
    expect(store.auditLogs.map((l) => l.action)).toEqual(['FORCE_TERMINATED'])
    expect(store.auditLogs[0]!.reason).toBe('admin override')
  })

  it('SAFE with active job and grace not expired reschedules and audits RESCHEDULED', async () => {
    const safeInitiatedAt = new Date()
    const dep = makeFakeDeployment({ status: 'TERMINATING' })
    const { prisma, store } = makeFakePrisma({
      deployments: [dep],
      activeJobCount: 2,
    })
    const delistNodeFn = vi.fn<Parameters<DelistNodeFn>, ReturnType<DelistNodeFn>>()
    const { queue, add } = makeFakeQueue()

    const job = makeFakeJob({
      deploymentId: dep.id,
      reason: 'draining',
      mode: 'SAFE',
      gracePeriodSeconds: 600, // 10min, still plenty of time
      safeInitiatedAt: safeInitiatedAt.toISOString(),
      pollIntervalSeconds: 45,
    })

    await processTerminationJob(job, {
      prisma,
      registry: makeFakeRegistry(),
      queue,
      delistNodeFn,
      pollIntervalSeconds: 30,
    })

    expect(delistNodeFn).not.toHaveBeenCalled()
    expect(add).toHaveBeenCalledTimes(1)
    const [, reEnqueuedData, opts] = add.mock.calls[0]!
    expect(reEnqueuedData.mode).toBe('SAFE')
    expect(reEnqueuedData.deploymentId).toBe(dep.id)
    // Should use the job's own pollIntervalSeconds (45), not worker default (30)
    expect(opts.delay).toBe(45_000)
    expect(store.auditLogs.map((l) => l.action)).toEqual(['SAFE_RESCHEDULED'])
  })

  it('SAFE with grace expired calls delist FORCE and audits SAFE_ESCALATED_TO_FORCE', async () => {
    const safeInitiatedAt = new Date(Date.now() - 10 * 60 * 1000) // 10 min ago
    const dep = makeFakeDeployment({ status: 'TERMINATING' })
    const { prisma, store } = makeFakePrisma({
      deployments: [dep],
      activeJobCount: 3, // even with active job, grace takes precedence
    })
    const delistNodeFn = vi
      .fn<Parameters<DelistNodeFn>, ReturnType<DelistNodeFn>>()
      .mockResolvedValue({ status: 'TERMINATED', terminated: true })
    const { queue, add } = makeFakeQueue()

    const job = makeFakeJob({
      deploymentId: dep.id,
      reason: 'draining',
      mode: 'SAFE',
      gracePeriodSeconds: 300, // 5 min
      safeInitiatedAt: safeInitiatedAt.toISOString(),
    })

    await processTerminationJob(job, {
      prisma,
      registry: makeFakeRegistry(),
      queue,
      delistNodeFn,
      pollIntervalSeconds: 30,
    })

    expect(delistNodeFn).toHaveBeenCalledWith({
      deploymentId: dep.id,
      mode: 'FORCE',
      reason: 'draining',
    })
    expect(add).not.toHaveBeenCalled()
    expect(store.auditLogs.map((l) => l.action)).toEqual(['SAFE_ESCALATED_TO_FORCE'])
  })

  it('SAFE with no active job calls delist FORCE and audits SAFE_ESCALATED_TO_FORCE', async () => {
    const safeInitiatedAt = new Date()
    const dep = makeFakeDeployment({ status: 'TERMINATING' })
    const { prisma, store } = makeFakePrisma({
      deployments: [dep],
      activeJobCount: 0,
    })
    const delistNodeFn = vi
      .fn<Parameters<DelistNodeFn>, ReturnType<DelistNodeFn>>()
      .mockResolvedValue({ status: 'TERMINATED', terminated: true })
    const { queue, add } = makeFakeQueue()

    const job = makeFakeJob({
      deploymentId: dep.id,
      reason: 'draining',
      mode: 'SAFE',
      gracePeriodSeconds: 600,
      safeInitiatedAt: safeInitiatedAt.toISOString(),
    })

    await processTerminationJob(job, {
      prisma,
      registry: makeFakeRegistry(),
      queue,
      delistNodeFn,
      pollIntervalSeconds: 30,
    })

    expect(delistNodeFn).toHaveBeenCalledWith({
      deploymentId: dep.id,
      mode: 'FORCE',
      reason: 'draining',
    })
    expect(add).not.toHaveBeenCalled()
    expect(store.auditLogs.map((l) => l.action)).toEqual(['SAFE_ESCALATED_TO_FORCE'])
  })

  it('SAFE with already TERMINATED deployment audits SAFE_SKIPPED and does nothing', async () => {
    const dep = makeFakeDeployment({ status: 'TERMINATED' })
    const { prisma, store } = makeFakePrisma({
      deployments: [dep],
      activeJobCount: 0,
    })
    const delistNodeFn = vi.fn<Parameters<DelistNodeFn>, ReturnType<DelistNodeFn>>()
    const { queue, add } = makeFakeQueue()

    const job = makeFakeJob({
      deploymentId: dep.id,
      reason: 'draining',
      mode: 'SAFE',
      gracePeriodSeconds: 300,
      safeInitiatedAt: new Date().toISOString(),
    })

    await processTerminationJob(job, {
      prisma,
      registry: makeFakeRegistry(),
      queue,
      delistNodeFn,
      pollIntervalSeconds: 30,
    })

    expect(delistNodeFn).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()
    expect(store.auditLogs.map((l) => l.action)).toEqual(['SAFE_SKIPPED'])
  })

  it('audit log failure does not break the worker', async () => {
    const safeInitiatedAt = new Date()
    const dep = makeFakeDeployment({ status: 'TERMINATING' })
    const { prisma } = makeFakePrisma({
      deployments: [dep],
      activeJobCount: 0,
      auditError: new Error('db down'),
    })
    const delistNodeFn = vi
      .fn<Parameters<DelistNodeFn>, ReturnType<DelistNodeFn>>()
      .mockResolvedValue({ status: 'TERMINATED', terminated: true })
    const { queue } = makeFakeQueue()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const job = makeFakeJob({
      deploymentId: dep.id,
      reason: 'draining',
      mode: 'SAFE',
      gracePeriodSeconds: 600,
      safeInitiatedAt: safeInitiatedAt.toISOString(),
    })

    await expect(
      processTerminationJob(job, {
        prisma,
        registry: makeFakeRegistry(),
        queue,
        delistNodeFn,
        pollIntervalSeconds: 30,
      }),
    ).resolves.toBeUndefined()

    expect(delistNodeFn).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

// --- Queue name sanity ----------------------------------------------------

describe('TERMINATION_QUEUE_NAME', () => {
  it('has stable, documented value', () => {
    expect(TERMINATION_QUEUE_NAME).toBe('external-termination-policy')
  })
})
