// Overflow Listing Manager Tests (F3.3)

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type {
  PrismaClient,
  ExternalDeployment,
  ExternalDeploymentStatus,
  ExternalTerminationMode,
} from '@a2e/database'
import type { AdapterRegistry, DeploymentStatus } from '@a2e/core'
import {
  delistNode,
  listNodeExternally,
  recordExternalEarnings,
  syncDeploymentStatus,
} from '../listing-manager'

// --- Types mirroring a minimal DB shape for the fake Prisma ---------------

interface NodeRow {
  id: string
  gpuTier: 'H100' | 'H200' | 'B200' | 'B300' | 'GB300' | 'OTHER'
}

type DeploymentRow = ExternalDeployment

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

interface FakePrismaStore {
  nodes: NodeRow[]
  deployments: DeploymentRow[]
  earnings: EarningRow[]
  createCalls: unknown[]
  updateCalls: unknown[]
  upsertCalls: unknown[]
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
    earnings: init.earnings ?? [],
    createCalls: [],
    updateCalls: [],
    upsertCalls: [],
  }

  let deploymentIdCounter = store.deployments.length + 1
  let earningIdCounter = store.earnings.length + 1

  const prisma: Partial<PrismaClient> = {
    node: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        const node = store.nodes.find((n) => n.id === args.where.id)
        if (!node) return null
        return { gpuTier: node.gpuTier }
      }),
    } as unknown as PrismaClient['node'],

    externalDeployment: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        return store.deployments.find((d) => d.id === args.where.id) ?? null
      }),
      findFirst: vi.fn(
        async (args: {
          where: {
            nodeId?: string
            status?: { in?: string[] } | string
          }
        }) => {
          const where = args.where ?? {}
          return (
            store.deployments.find((d) => {
              if (where.nodeId && d.nodeId !== where.nodeId) return false
              if (typeof where.status === 'string' && d.status !== where.status) return false
              if (
                where.status &&
                typeof where.status === 'object' &&
                'in' in where.status &&
                where.status.in &&
                !where.status.in.includes(d.status)
              ) {
                return false
              }
              return true
            }) ?? null
          )
        },
      ),
      create: vi.fn(
        async (args: {
          data: {
            nodeId: string
            market: string
            externalId: string
            status: ExternalDeploymentStatus
            ratePerHour: number
          }
        }) => {
          store.createCalls.push(args)
          const row = makeDeployment({
            id: `dep-${deploymentIdCounter++}`,
            nodeId: args.data.nodeId,
            market: args.data.market as DeploymentRow['market'],
            externalId: args.data.externalId,
            status: args.data.status,
            ratePerHour: args.data.ratePerHour,
          })
          store.deployments.push(row)
          return row
        },
      ),
      update: vi.fn(
        async (args: {
          where: { id: string }
          data: Partial<DeploymentRow> & {
            costAccumulated?: number
            earningsAccumulated?: number
          }
        }) => {
          store.updateCalls.push(args)
          const row = store.deployments.find((d) => d.id === args.where.id)
          if (!row) throw new Error(`deployment ${args.where.id} not in fake store`)
          Object.assign(row, args.data)
          return row
        },
      ),
    } as unknown as PrismaClient['externalDeployment'],

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
          store.upsertCalls.push(args)
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
  available?: Record<string, boolean>
  createResult?: {
    externalId: string
    status: DeploymentStatus
    estimatedRatePerHour: number
  }
  createError?: Error
  statusResult?: { externalId: string; status: DeploymentStatus }
  statusError?: Error
  costResult?: { accumulatedUsd: number }
  costError?: Error
  terminateError?: Error
  adapterPresent?: boolean
}

interface FakeRegistry {
  registry: AdapterRegistry
  successCalls: string[]
  failureCalls: Array<{ market: string; error: string }>
  createCalls: unknown[]
  statusCalls: string[]
  costCalls: string[]
  terminateCalls: string[]
}

function makeFakeRegistry(opts: FakeRegistryOptions = {}): FakeRegistry {
  const successCalls: string[] = []
  const failureCalls: Array<{ market: string; error: string }> = []
  const createCalls: unknown[] = []
  const statusCalls: string[] = []
  const costCalls: string[] = []
  const terminateCalls: string[] = []

  const adapter = opts.adapterPresent === false
    ? undefined
    : {
        market: 'AKASH',
        createDeployment: vi.fn(async (input) => {
          createCalls.push(input)
          if (opts.createError) throw opts.createError
          return (
            opts.createResult ?? {
              externalId: 'ext-new',
              status: 'PENDING' as DeploymentStatus,
              estimatedRatePerHour: 4.5,
              market: 'AKASH',
            }
          )
        }),
        getDeploymentStatus: vi.fn(async (id: string) => {
          statusCalls.push(id)
          if (opts.statusError) throw opts.statusError
          return opts.statusResult ?? { externalId: id, status: 'ACTIVE' as DeploymentStatus }
        }),
        getDeploymentCost: vi.fn(async (id: string) => {
          costCalls.push(id)
          if (opts.costError) throw opts.costError
          return opts.costResult ?? { accumulatedUsd: 0 }
        }),
        terminateDeployment: vi.fn(async (id: string) => {
          terminateCalls.push(id)
          if (opts.terminateError) throw opts.terminateError
        }),
      }

  const registry = {
    get: vi.fn(() => adapter),
    isAvailable: vi.fn((market: string) =>
      opts.available ? opts.available[market] === true : true,
    ),
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

  return {
    registry,
    successCalls,
    failureCalls,
    createCalls,
    statusCalls,
    costCalls,
    terminateCalls,
  }
}

// --- listNodeExternally ---------------------------------------------------

describe('listNodeExternally', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates ExternalDeployment row on happy path', async () => {
    const { prisma, store } = makeFakePrisma({
      nodes: [{ id: 'node-1', gpuTier: 'H100' }],
    })
    const fake = makeFakeRegistry({
      createResult: {
        externalId: 'ext-happy',
        status: 'PENDING',
        estimatedRatePerHour: 4.5,
      },
    })

    const result = await listNodeExternally(prisma, fake.registry, {
      nodeId: 'node-1',
      market: 'AKASH',
      ratePerHour: 4.5,
    })

    expect(result.externalId).toBe('ext-happy')
    expect(result.status).toBe('PENDING')
    expect(store.deployments).toHaveLength(1)
    expect(store.deployments[0]!.status).toBe('PENDING')
    expect(store.deployments[0]!.ratePerHour).toBe(4.5)
    expect(fake.successCalls).toEqual(['AKASH'])
    expect(fake.failureCalls).toEqual([])
  })

  it('throws and skips DB write when market is unavailable', async () => {
    const { prisma, store } = makeFakePrisma({
      nodes: [{ id: 'node-1', gpuTier: 'H100' }],
    })
    const fake = makeFakeRegistry({ available: { AKASH: false } })

    await expect(
      listNodeExternally(prisma, fake.registry, {
        nodeId: 'node-1',
        market: 'AKASH',
        ratePerHour: 4.5,
      }),
    ).rejects.toThrow('market AKASH not available')

    expect(store.deployments).toHaveLength(0)
    expect(fake.createCalls).toHaveLength(0)
  })

  it('throws when node is not found', async () => {
    const { prisma, store } = makeFakePrisma({ nodes: [] })
    const fake = makeFakeRegistry({})

    await expect(
      listNodeExternally(prisma, fake.registry, {
        nodeId: 'missing',
        market: 'AKASH',
        ratePerHour: 4.5,
      }),
    ).rejects.toThrow('node missing not found')

    expect(store.deployments).toHaveLength(0)
    expect(fake.createCalls).toHaveLength(0)
  })

  it('throws when node already has a live deployment', async () => {
    const existing = makeDeployment({ nodeId: 'node-1', status: 'ACTIVE' })
    const { prisma, store } = makeFakePrisma({
      nodes: [{ id: 'node-1', gpuTier: 'H100' }],
      deployments: [existing],
    })
    const fake = makeFakeRegistry({})

    await expect(
      listNodeExternally(prisma, fake.registry, {
        nodeId: 'node-1',
        market: 'AKASH',
        ratePerHour: 4.5,
      }),
    ).rejects.toThrow('node already has an active external deployment')

    expect(store.deployments).toHaveLength(1)
    expect(fake.createCalls).toHaveLength(0)
  })

  it('records adapter failure and rethrows without DB write', async () => {
    const { prisma, store } = makeFakePrisma({
      nodes: [{ id: 'node-1', gpuTier: 'H100' }],
    })
    const fake = makeFakeRegistry({ createError: new Error('akash boom') })

    await expect(
      listNodeExternally(prisma, fake.registry, {
        nodeId: 'node-1',
        market: 'AKASH',
        ratePerHour: 4.5,
      }),
    ).rejects.toThrow('akash boom')

    expect(store.deployments).toHaveLength(0)
    expect(fake.failureCalls).toEqual([{ market: 'AKASH', error: 'akash boom' }])
    expect(fake.successCalls).toEqual([])
  })
})

// --- delistNode -----------------------------------------------------------

describe('delistNode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('throws when deployment is not found', async () => {
    const { prisma } = makeFakePrisma({})
    const fake = makeFakeRegistry({})

    await expect(
      delistNode(prisma, fake.registry, {
        deploymentId: 'missing',
        mode: 'SAFE' as ExternalTerminationMode,
        reason: 'n/a',
      }),
    ).rejects.toThrow('deployment missing not found')
  })

  it('no-ops on already TERMINATED deployment', async () => {
    const dep = makeDeployment({ status: 'TERMINATED' })
    const { prisma, store } = makeFakePrisma({ deployments: [dep] })
    const fake = makeFakeRegistry({})

    const result = await delistNode(prisma, fake.registry, {
      deploymentId: dep.id,
      mode: 'FORCE' as ExternalTerminationMode,
      reason: 'test',
    })

    expect(result).toEqual({ status: 'TERMINATED', terminated: false })
    expect(store.updateCalls).toHaveLength(0)
    expect(fake.terminateCalls).toHaveLength(0)
  })

  it('SAFE mode flips ACTIVE deployment to TERMINATING without adapter call', async () => {
    const dep = makeDeployment({ status: 'ACTIVE' })
    const { prisma, store } = makeFakePrisma({ deployments: [dep] })
    const fake = makeFakeRegistry({})

    const result = await delistNode(prisma, fake.registry, {
      deploymentId: dep.id,
      mode: 'SAFE' as ExternalTerminationMode,
      reason: 'draining',
    })

    expect(result).toEqual({ status: 'TERMINATING', terminated: false })
    expect(dep.status).toBe('TERMINATING')
    expect(dep.terminationMode).toBe('SAFE')
    expect(dep.terminationReason).toBe('draining')
    expect(fake.terminateCalls).toHaveLength(0)
    expect(store.updateCalls).toHaveLength(1)
  })

  it('SAFE mode schedules termination-policy job when terminationQueue is provided', async () => {
    const dep = makeDeployment({ status: 'ACTIVE' })
    const { prisma } = makeFakePrisma({ deployments: [dep] })
    const fake = makeFakeRegistry({})

    // Extend fake prisma with an overflowConfig upsert — the SAFE+queue
    // path reads gracePeriodSeconds from the singleton config row.
    const upsertSpy = vi.fn(async () => ({
      id: 'singleton',
      enabled: false,
      simulationMode: true,
      idleThresholdMinutes: 10,
      demandThresholdPercent: 80,
      marginProtectionPercent: 15,
      gracePeriodSeconds: 180,
      preferredMarkets: '["AKASH","IONET","VASTAI"]',
      updatedAt: new Date(),
    }))
    ;(prisma as unknown as { overflowConfig: { upsert: typeof upsertSpy } }).overflowConfig = {
      upsert: upsertSpy,
    }

    const queueAdd = vi.fn().mockResolvedValue({ id: 'bull-1' })
    const terminationQueue = { add: queueAdd } as unknown as import('bullmq').Queue

    const result = await delistNode(prisma, fake.registry, {
      deploymentId: dep.id,
      mode: 'SAFE' as ExternalTerminationMode,
      reason: 'draining',
      terminationQueue,
    })

    expect(result).toEqual({ status: 'TERMINATING', terminated: false })
    expect(upsertSpy).toHaveBeenCalledTimes(1)
    expect(queueAdd).toHaveBeenCalledTimes(1)
    const [name, data, opts] = queueAdd.mock.calls[0]!
    expect(name).toBe('safe-termination-poll')
    expect(data).toMatchObject({
      deploymentId: dep.id,
      reason: 'draining',
      mode: 'SAFE',
      gracePeriodSeconds: 180,
    })
    expect(opts.delay).toBe(30_000) // default poll interval
  })

  it('SAFE mode does not touch queue when terminationQueue is omitted', async () => {
    const dep = makeDeployment({ status: 'ACTIVE' })
    const { prisma } = makeFakePrisma({ deployments: [dep] })
    const fake = makeFakeRegistry({})

    // Attach an overflowConfig mock that would throw if called — proves
    // the SAFE path without a queue never reads the config.
    const upsertSpy = vi.fn(async () => {
      throw new Error('should not be called')
    })
    ;(prisma as unknown as { overflowConfig: { upsert: typeof upsertSpy } }).overflowConfig = {
      upsert: upsertSpy,
    }

    const result = await delistNode(prisma, fake.registry, {
      deploymentId: dep.id,
      mode: 'SAFE' as ExternalTerminationMode,
      reason: 'draining',
    })

    expect(result).toEqual({ status: 'TERMINATING', terminated: false })
    expect(upsertSpy).not.toHaveBeenCalled()
  })

  it('SAFE mode is a no-op on already TERMINATING deployment', async () => {
    const dep = makeDeployment({
      status: 'TERMINATING',
      terminationMode: 'SAFE',
      terminationReason: 'earlier',
    })
    const { prisma, store } = makeFakePrisma({ deployments: [dep] })
    const fake = makeFakeRegistry({})

    const result = await delistNode(prisma, fake.registry, {
      deploymentId: dep.id,
      mode: 'SAFE' as ExternalTerminationMode,
      reason: 'again',
    })

    expect(result).toEqual({ status: 'TERMINATING', terminated: false })
    expect(dep.terminationReason).toBe('earlier')
    expect(store.updateCalls).toHaveLength(0)
    expect(fake.terminateCalls).toHaveLength(0)
  })

  it('FORCE mode calls adapter and marks TERMINATED', async () => {
    const dep = makeDeployment({ status: 'ACTIVE', externalId: 'ext-force' })
    const { prisma, store } = makeFakePrisma({ deployments: [dep] })
    const fake = makeFakeRegistry({})

    const result = await delistNode(prisma, fake.registry, {
      deploymentId: dep.id,
      mode: 'FORCE' as ExternalTerminationMode,
      reason: 'force kill',
    })

    expect(result).toEqual({ status: 'TERMINATED', terminated: true })
    expect(fake.terminateCalls).toEqual(['ext-force'])
    expect(dep.status).toBe('TERMINATED')
    expect(dep.terminatedAt).toBeInstanceOf(Date)
    expect(dep.terminationMode).toBe('FORCE')
    expect(dep.terminationReason).toBe('force kill')
    expect(fake.successCalls).toEqual(['AKASH'])
    expect(store.updateCalls).toHaveLength(1)
  })

  it('FORCE mode with adapter failure still marks TERMINATED with augmented reason', async () => {
    const dep = makeDeployment({ status: 'ACTIVE', externalId: 'ext-broken' })
    const { prisma } = makeFakePrisma({ deployments: [dep] })
    const fake = makeFakeRegistry({ terminateError: new Error('401 unauthorized') })

    const result = await delistNode(prisma, fake.registry, {
      deploymentId: dep.id,
      mode: 'FORCE' as ExternalTerminationMode,
      reason: 'force kill',
    })

    expect(result).toEqual({ status: 'TERMINATED', terminated: true })
    expect(dep.status).toBe('TERMINATED')
    expect(dep.terminationMode).toBe('FORCE')
    expect(dep.terminationReason).toBe(
      'force kill (adapter terminate failed: 401 unauthorized)',
    )
    expect(fake.failureCalls).toEqual([{ market: 'AKASH', error: '401 unauthorized' }])
  })
})

// --- syncDeploymentStatus --------------------------------------------------

describe('syncDeploymentStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('updates status and cost on happy path', async () => {
    const dep = makeDeployment({
      status: 'PENDING',
      costAccumulated: 0,
      lastCheckedAt: new Date(0),
    })
    const { prisma } = makeFakePrisma({ deployments: [dep] })
    const fake = makeFakeRegistry({
      statusResult: { externalId: dep.externalId, status: 'ACTIVE' },
      costResult: { accumulatedUsd: 2.5 },
    })

    const updated = await syncDeploymentStatus(prisma, fake.registry, dep.id)

    expect(updated.status).toBe('ACTIVE')
    expect(updated.costAccumulated).toBe(2.5)
    expect(updated.lastCheckedAt.getTime()).toBeGreaterThan(0)
    expect(fake.successCalls.filter((m) => m === 'AKASH').length).toBe(2)
  })

  it('records failure and updates only lastCheckedAt when status fetch fails', async () => {
    const dep = makeDeployment({
      status: 'ACTIVE',
      costAccumulated: 1.0,
      lastCheckedAt: new Date(0),
    })
    const { prisma, store } = makeFakePrisma({ deployments: [dep] })
    const fake = makeFakeRegistry({ statusError: new Error('rpc down') })

    const updated = await syncDeploymentStatus(prisma, fake.registry, dep.id)

    expect(updated.status).toBe('ACTIVE')
    expect(updated.costAccumulated).toBe(1.0)
    expect(updated.lastCheckedAt.getTime()).toBeGreaterThan(0)
    expect(fake.failureCalls).toEqual([{ market: 'AKASH', error: 'rpc down' }])
    expect(fake.costCalls).toHaveLength(0)
    expect(store.updateCalls).toHaveLength(1)
  })

  it('updates status when cost fetch fails but status succeeds', async () => {
    const dep = makeDeployment({
      status: 'PENDING',
      costAccumulated: 0,
      lastCheckedAt: new Date(0),
    })
    const { prisma } = makeFakePrisma({ deployments: [dep] })
    const fake = makeFakeRegistry({
      statusResult: { externalId: dep.externalId, status: 'ACTIVE' },
      costError: new Error('cost endpoint 500'),
    })

    const updated = await syncDeploymentStatus(prisma, fake.registry, dep.id)

    expect(updated.status).toBe('ACTIVE')
    expect(updated.costAccumulated).toBe(0)
    expect(fake.failureCalls).toEqual([
      { market: 'AKASH', error: 'cost endpoint 500' },
    ])
    // recordSuccess for status, recordFailure for cost
    expect(fake.successCalls).toEqual(['AKASH'])
  })

  it('sets terminatedAt on transition to TERMINATED', async () => {
    const dep = makeDeployment({ status: 'ACTIVE', terminatedAt: null })
    const { prisma } = makeFakePrisma({ deployments: [dep] })
    const fake = makeFakeRegistry({
      statusResult: { externalId: dep.externalId, status: 'TERMINATED' },
      costResult: { accumulatedUsd: 12 },
    })

    const updated = await syncDeploymentStatus(prisma, fake.registry, dep.id)

    expect(updated.status).toBe('TERMINATED')
    expect(updated.terminatedAt).toBeInstanceOf(Date)
    expect(updated.costAccumulated).toBe(12)
  })

  it('no-ops on already TERMINATED deployment', async () => {
    const dep = makeDeployment({ status: 'TERMINATED' })
    const { prisma, store } = makeFakePrisma({ deployments: [dep] })
    const fake = makeFakeRegistry({})

    const result = await syncDeploymentStatus(prisma, fake.registry, dep.id)

    expect(result).toBe(dep)
    expect(store.updateCalls).toHaveLength(0)
    expect(fake.statusCalls).toHaveLength(0)
    expect(fake.costCalls).toHaveLength(0)
  })
})

// --- recordExternalEarnings -----------------------------------------------

describe('recordExternalEarnings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('writes Earning row on first positive delta', async () => {
    const dep = makeDeployment({ earningsAccumulated: 3, ratePerHour: 4.5 })
    const { prisma, store } = makeFakePrisma({ deployments: [dep] })
    const fake = makeFakeRegistry({ costResult: { accumulatedUsd: 5 } })

    const result = await recordExternalEarnings(prisma, fake.registry, dep.id)

    expect(result.deltaUsd).toBe(2)
    expect(result.totalUsd).toBe(5)
    expect(store.earnings).toHaveLength(1)
    expect(store.earnings[0]!.earnings).toBeCloseTo(2)
    expect(store.earnings[0]!.market).toBe('AKASH')
    expect(store.earnings[0]!.gpuSeconds).toBeGreaterThan(0)
    expect(dep.earningsAccumulated).toBe(5)
  })

  it('no-ops when delta is zero', async () => {
    const dep = makeDeployment({ earningsAccumulated: 5 })
    const { prisma, store } = makeFakePrisma({ deployments: [dep] })
    const fake = makeFakeRegistry({ costResult: { accumulatedUsd: 5 } })

    const result = await recordExternalEarnings(prisma, fake.registry, dep.id)

    expect(result).toEqual({ deltaUsd: 0, totalUsd: 5 })
    expect(store.earnings).toHaveLength(0)
    expect(store.upsertCalls).toHaveLength(0)
    expect(dep.earningsAccumulated).toBe(5)
  })

  it('increments existing Earning row on subsequent delta', async () => {
    const dep = makeDeployment({ earningsAccumulated: 5, ratePerHour: 4.5 })
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)

    const { prisma, store } = makeFakePrisma({
      deployments: [dep],
      earnings: [
        {
          id: 'earn-existing',
          nodeId: dep.nodeId,
          date: today,
          market: 'AKASH',
          earnings: 2,
          gpuSeconds: 1600,
          jobCount: 0,
        },
      ],
    })
    const fake = makeFakeRegistry({ costResult: { accumulatedUsd: 10 } })

    const result = await recordExternalEarnings(prisma, fake.registry, dep.id)

    expect(result.deltaUsd).toBe(5)
    expect(result.totalUsd).toBe(10)
    expect(store.earnings).toHaveLength(1)
    expect(store.earnings[0]!.id).toBe('earn-existing')
    expect(store.earnings[0]!.earnings).toBeCloseTo(7)
    expect(dep.earningsAccumulated).toBe(10)
  })

  it('returns zero delta and records failure when adapter cost call fails', async () => {
    const dep = makeDeployment({ earningsAccumulated: 3 })
    const { prisma, store } = makeFakePrisma({ deployments: [dep] })
    const fake = makeFakeRegistry({ costError: new Error('cost rpc failed') })

    const result = await recordExternalEarnings(prisma, fake.registry, dep.id)

    expect(result).toEqual({ deltaUsd: 0, totalUsd: 3 })
    expect(store.earnings).toHaveLength(0)
    expect(store.upsertCalls).toHaveLength(0)
    expect(fake.failureCalls).toEqual([
      { market: 'AKASH', error: 'cost rpc failed' },
    ])
    expect(dep.earningsAccumulated).toBe(3)
  })
})
