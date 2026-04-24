// External Market Admin Handler Tests (M7 F5.1)
//
// These cover the pure handler functions exported from `../external-handlers`.
// The Fastify route file itself is a thin wrapper — its zod validation and
// status-code mapping are exercised here by driving the handlers directly with
// a fake Prisma + fake AdapterRegistry, which matches the pattern already in
// use under `services/overflow/__tests__/`.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PrismaClient, OverflowConfig, ExternalDeployment } from '@a2e/database'
import type { AdapterRegistry, AdapterHealth } from '@a2e/core'
import {
  adminDelistNode,
  adminListNode,
  getDeploymentDetail,
  getExternalEarnings,
  getExternalStatus,
  getOverflowConfigResponse,
  listDeployments,
  updateOverflowConfig,
} from '../external-handlers'

// --- Fixtures --------------------------------------------------------------

interface NodeRow {
  id: string
  gpuTier: 'H100' | 'H200' | 'B200' | 'B300' | 'GB300' | 'OTHER'
  customRatePerHour: number | null
  walletAddress: string
}

interface DeploymentRow extends ExternalDeployment {
  node?: { id: string; gpuTier: NodeRow['gpuTier']; walletAddress: string }
}

interface MarketRateRow {
  id: string
  market: 'AKASH' | 'IONET' | 'VASTAI' | 'INTERNAL'
  gpuTier: NodeRow['gpuTier']
  ratePerHour: number
  ratePerDay: number
  available: boolean
  fetchedAt: Date
}

interface EarningRow {
  id: string
  nodeId: string
  date: Date
  market: 'AKASH' | 'IONET' | 'VASTAI' | 'INTERNAL'
  earnings: number
  gpuSeconds: number
  jobCount: number
  node?: { walletAddress: string }
}

interface JobRow {
  id: string
  externalDeploymentId: string | null
  createdAt: Date
}

function makeConfig(overrides: Partial<OverflowConfig> = {}): OverflowConfig {
  return {
    id: 'singleton',
    enabled: false,
    simulationMode: true,
    idleThresholdMinutes: 10,
    demandThresholdPercent: 80,
    marginProtectionPercent: 15,
    gracePeriodSeconds: 300,
    preferredMarkets: '["AKASH","IONET","VASTAI"]',
    updatedAt: new Date(),
    ...overrides,
  } as OverflowConfig
}

function makeDeployment(overrides: Partial<DeploymentRow> = {}): DeploymentRow {
  const now = new Date()
  return {
    id: overrides.id ?? 'dep-1',
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
  rates: MarketRateRow[]
  earnings: EarningRow[]
  jobs: JobRow[]
  config: OverflowConfig | null
}

function makeFakePrisma(init: Partial<FakePrismaStore> = {}): {
  prisma: PrismaClient
  store: FakePrismaStore
} {
  const store: FakePrismaStore = {
    nodes: init.nodes ?? [],
    deployments: init.deployments ?? [],
    rates: init.rates ?? [],
    earnings: init.earnings ?? [],
    jobs: init.jobs ?? [],
    config: init.config ?? null,
  }

  let depCounter = store.deployments.length + 1

  function matchStatus(row: { status: string }, status: unknown): boolean {
    if (status === undefined) return true
    if (typeof status === 'string') return row.status === status
    if (status && typeof status === 'object' && 'in' in status) {
      return (status as { in: string[] }).in.includes(row.status)
    }
    return true
  }

  const prisma: Partial<PrismaClient> = {
    overflowConfig: {
      upsert: vi.fn(async () => {
        if (!store.config) store.config = makeConfig({})
        return store.config
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Partial<OverflowConfig> }) => {
        if (!store.config) store.config = makeConfig({})
        store.config = { ...store.config, ...args.data } as OverflowConfig
        return store.config
      }),
    } as unknown as PrismaClient['overflowConfig'],

    node: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        const n = store.nodes.find((x) => x.id === args.where.id)
        return n ?? null
      }),
    } as unknown as PrismaClient['node'],

    externalDeployment: {
      findUnique: vi.fn(
        async (args: { where: { id: string }; include?: unknown }) => {
          const dep = store.deployments.find((d) => d.id === args.where.id)
          if (!dep) return null
          if (args.include) {
            const node = store.nodes.find((n) => n.id === dep.nodeId)
            return { ...dep, node: node ? { id: node.id, gpuTier: node.gpuTier, walletAddress: node.walletAddress } : null }
          }
          return dep
        },
      ),
      findFirst: vi.fn(
        async (args: {
          where?: { nodeId?: string; status?: unknown }
          orderBy?: unknown
          select?: unknown
        }) => {
          const where = args.where ?? {}
          const match = store.deployments.find((d) => {
            if (where.nodeId && d.nodeId !== where.nodeId) return false
            if (!matchStatus(d, where.status)) return false
            return true
          })
          return match ?? null
        },
      ),
      findMany: vi.fn(
        async (args: { where?: { status?: unknown }; include?: unknown; orderBy?: unknown }) => {
          const where = args.where ?? {}
          const rows = store.deployments.filter((d) => matchStatus(d, where.status))
          if (args.include) {
            return rows.map((d) => {
              const node = store.nodes.find((n) => n.id === d.nodeId)
              return {
                ...d,
                node: node
                  ? { id: node.id, gpuTier: node.gpuTier, walletAddress: node.walletAddress }
                  : null,
              }
            })
          }
          return rows
        },
      ),
      groupBy: vi.fn(async () => {
        const counts = new Map<string, number>()
        for (const d of store.deployments) {
          counts.set(d.status, (counts.get(d.status) ?? 0) + 1)
        }
        return Array.from(counts.entries()).map(([status, count]) => ({
          status,
          _count: { _all: count },
        }))
      }),
      create: vi.fn(
        async (args: {
          data: {
            nodeId: string
            market: string
            externalId: string
            status: string
            ratePerHour: number
          }
        }) => {
          const row = makeDeployment({
            id: `dep-${depCounter++}`,
            nodeId: args.data.nodeId,
            market: args.data.market as DeploymentRow['market'],
            externalId: args.data.externalId,
            status: args.data.status as DeploymentRow['status'],
            ratePerHour: args.data.ratePerHour,
          })
          store.deployments.push(row)
          return row
        },
      ),
      update: vi.fn(
        async (args: { where: { id: string }; data: Partial<DeploymentRow> }) => {
          const row = store.deployments.find((d) => d.id === args.where.id)
          if (!row) throw new Error(`deployment ${args.where.id} missing`)
          Object.assign(row, args.data)
          return row
        },
      ),
    } as unknown as PrismaClient['externalDeployment'],

    marketRate: {
      findMany: vi.fn(
        async (args: {
          where?: {
            market?: string | { in?: string[] }
            gpuTier?: string
          }
        }) => {
          const where = args.where ?? {}
          return store.rates.filter((r) => {
            if (where.gpuTier && r.gpuTier !== where.gpuTier) return false
            const m = where.market
            if (typeof m === 'string' && r.market !== m) return false
            if (m && typeof m === 'object' && 'in' in m && m.in && !m.in.includes(r.market))
              return false
            return true
          })
        },
      ),
      findFirst: vi.fn(
        async (args: { where?: { market?: string; gpuTier?: string } }) => {
          const where = args.where ?? {}
          return (
            store.rates.find((r) => {
              if (where.market && r.market !== where.market) return false
              if (where.gpuTier && r.gpuTier !== where.gpuTier) return false
              return true
            }) ?? null
          )
        },
      ),
    } as unknown as PrismaClient['marketRate'],

    earning: {
      findMany: vi.fn(
        async (args: {
          where?: {
            nodeId?: string
            market?: { in?: string[] }
            date?: { gte?: Date; lte?: Date }
          }
          include?: unknown
        }) => {
          const where = args.where ?? {}
          const rows = store.earnings.filter((e) => {
            if (where.nodeId && e.nodeId !== where.nodeId) return false
            if (where.market?.in && !where.market.in.includes(e.market)) return false
            if (where.date?.gte && e.date.getTime() < where.date.gte.getTime()) return false
            if (where.date?.lte && e.date.getTime() > where.date.lte.getTime()) return false
            return true
          })
          if (args.include) {
            return rows.map((e) => {
              const n = store.nodes.find((x) => x.id === e.nodeId)
              return { ...e, node: n ? { walletAddress: n.walletAddress } : null }
            })
          }
          return rows
        },
      ),
    } as unknown as PrismaClient['earning'],

    job: {
      findMany: vi.fn(
        async (args: { where?: { externalDeploymentId?: string } }) => {
          const where = args.where ?? {}
          return store.jobs.filter((j) => {
            if (where.externalDeploymentId && j.externalDeploymentId !== where.externalDeploymentId) {
              return false
            }
            return true
          })
        },
      ),
    } as unknown as PrismaClient['job'],
  }

  return { prisma: prisma as PrismaClient, store }
}

interface FakeRegistryOptions {
  available?: Record<string, boolean>
  adapterEnabled?: Record<string, boolean>
  createResult?: { externalId: string; status: string }
  createError?: Error
  health?: Partial<Record<'AKASH' | 'IONET' | 'VASTAI', Partial<AdapterHealth>>>
}

interface FakeRegistry {
  registry: AdapterRegistry
  createCalls: unknown[]
  terminateCalls: string[]
}

function makeFakeRegistry(opts: FakeRegistryOptions = {}): FakeRegistry {
  const createCalls: unknown[] = []
  const terminateCalls: string[] = []

  const makeAdapter = (market: string) => ({
    market,
    isEnabled: () => opts.adapterEnabled?.[market] ?? true,
    setEnabled: vi.fn(),
    getRate: vi.fn(),
    createDeployment: vi.fn(async (input) => {
      createCalls.push({ market, input })
      if (opts.createError) throw opts.createError
      return (
        opts.createResult
          ? { ...opts.createResult, estimatedRatePerHour: 4.5, market }
          : {
              externalId: 'ext-new',
              status: 'PENDING',
              estimatedRatePerHour: 4.5,
              market,
            }
      )
    }),
    terminateDeployment: vi.fn(async (id: string) => {
      terminateCalls.push(id)
    }),
    getDeploymentStatus: vi.fn(async () => ({ externalId: 'x', status: 'ACTIVE' })),
    getDeploymentCost: vi.fn(async () => ({ accumulatedUsd: 0 })),
    getDeploymentLogs: vi.fn(async () => ''),
  })

  const adapters: Record<string, ReturnType<typeof makeAdapter>> = {
    AKASH: makeAdapter('AKASH'),
    IONET: makeAdapter('IONET'),
    VASTAI: makeAdapter('VASTAI'),
  }

  const allHealth: AdapterHealth[] = (['AKASH', 'IONET', 'VASTAI'] as const).map((m) => ({
    market: m,
    healthy: true,
    autoDisabled: false,
    failureCount: 0,
    lastSuccess: null,
    lastFailure: null,
    lastError: null,
    ...opts.health?.[m],
  }))

  const registry = {
    get: vi.fn((m: string) => adapters[m]),
    isAvailable: vi.fn((m: string) =>
      opts.available ? opts.available[m] === true : true,
    ),
    getAllHealth: vi.fn(() => allHealth),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  } as unknown as AdapterRegistry

  return { registry, createCalls, terminateCalls }
}

// --- getExternalStatus -----------------------------------------------------

describe('getExternalStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns overflow config, per-market health, and latest rates', async () => {
    const { prisma } = makeFakePrisma({
      config: makeConfig({ enabled: true, idleThresholdMinutes: 5 }),
      rates: [
        {
          id: 'r1',
          market: 'AKASH',
          gpuTier: 'H100',
          ratePerHour: 4.5,
          ratePerDay: 108,
          available: true,
          fetchedAt: new Date(),
        },
        {
          id: 'r2',
          market: 'IONET',
          gpuTier: 'H100',
          ratePerHour: 3.8,
          ratePerDay: 91.2,
          available: true,
          fetchedAt: new Date(),
        },
      ],
    })

    const { registry } = makeFakeRegistry({
      available: { AKASH: true, IONET: true, VASTAI: false },
      adapterEnabled: { AKASH: true, IONET: true, VASTAI: false },
      health: { VASTAI: { healthy: false, autoDisabled: true, failureCount: 5 } },
    })

    const result = await getExternalStatus(prisma, registry)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.status).toBe(200)
    expect(result.body.overflow.enabled).toBe(true)
    expect(result.body.overflow.idleThresholdMinutes).toBe(5)
    expect(result.body.markets).toHaveLength(3)

    const akash = result.body.markets.find((m) => m.market === 'AKASH')!
    expect(akash.enabled).toBe(true)
    expect(akash.healthy).toBe(true)
    expect(akash.latestRates.H100).toEqual({ ratePerHour: 4.5, available: true })
    expect(akash.latestRates.H200).toBeNull()

    const vastai = result.body.markets.find((m) => m.market === 'VASTAI')!
    expect(vastai.healthy).toBe(false)
    expect(vastai.autoDisabled).toBe(true)
    expect(vastai.failureCount).toBe(5)
  })
})

// --- listDeployments -------------------------------------------------------

describe('listDeployments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns active statuses by default and counts all statuses', async () => {
    const { prisma } = makeFakePrisma({
      nodes: [
        { id: 'node-1', gpuTier: 'H100', customRatePerHour: null, walletAddress: 'w1' },
      ],
      deployments: [
        makeDeployment({ id: 'dep-active', status: 'ACTIVE' }),
        makeDeployment({ id: 'dep-term', status: 'TERMINATED' }),
      ],
    })

    const result = await listDeployments(prisma, {})
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.body.deployments).toHaveLength(1)
    expect(result.body.deployments[0]!.id).toBe('dep-active')
    expect(result.body.deployments[0]!.node).toEqual({
      id: 'node-1',
      gpuTier: 'H100',
      walletAddress: 'w1',
    })
    expect(result.body.counts.ACTIVE).toBe(1)
    expect(result.body.counts.TERMINATED).toBe(1)
    expect(result.body.counts.PENDING).toBe(0)
  })

  it('respects comma-separated status filter', async () => {
    const { prisma } = makeFakePrisma({
      deployments: [
        makeDeployment({ id: 'dep-a', status: 'ACTIVE' }),
        makeDeployment({ id: 'dep-b', status: 'TERMINATED' }),
        makeDeployment({ id: 'dep-c', status: 'FAILED' }),
      ],
    })

    const result = await listDeployments(prisma, { status: 'terminated,failed' })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.body.deployments.map((d) => d.id).sort()).toEqual(['dep-b', 'dep-c'])
  })
})

// --- getDeploymentDetail ---------------------------------------------------

describe('getDeploymentDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 404 when deployment missing', async () => {
    const { prisma } = makeFakePrisma({})
    const result = await getDeploymentDetail(prisma, 'nope')
    expect(result.ok).toBe(false)
    expect(result.status).toBe(404)
  })

  it('includes node and jobs', async () => {
    const { prisma } = makeFakePrisma({
      nodes: [{ id: 'node-1', gpuTier: 'H100', customRatePerHour: null, walletAddress: 'w1' }],
      deployments: [makeDeployment({ id: 'dep-1', nodeId: 'node-1' })],
      jobs: [
        { id: 'job-1', externalDeploymentId: 'dep-1', createdAt: new Date() },
        { id: 'job-2', externalDeploymentId: 'dep-other', createdAt: new Date() },
      ],
    })

    const result = await getDeploymentDetail(prisma, 'dep-1')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.body.deployment.id).toBe('dep-1')
    expect(result.body.jobs).toHaveLength(1)
    expect(result.body.jobs[0]!.id).toBe('job-1')
  })
})

// --- adminListNode ---------------------------------------------------------

describe('adminListNode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 404 when node missing', async () => {
    const { prisma } = makeFakePrisma({})
    const { registry } = makeFakeRegistry()
    const result = await adminListNode(prisma, registry, { nodeId: 'missing' })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(404)
  })

  it('returns 409 when node already has an active deployment', async () => {
    const { prisma } = makeFakePrisma({
      nodes: [{ id: 'node-1', gpuTier: 'H100', customRatePerHour: null, walletAddress: 'w1' }],
      deployments: [makeDeployment({ id: 'dep-existing', nodeId: 'node-1', status: 'ACTIVE' })],
    })
    const { registry } = makeFakeRegistry()

    const result = await adminListNode(prisma, registry, {
      nodeId: 'node-1',
      market: 'AKASH',
    })

    expect(result.ok).toBe(false)
    expect(result.status).toBe(409)
    if (result.ok) return
    expect(result.body.extra).toMatchObject({ deploymentId: 'dep-existing' })
  })

  it('creates deployment using explicit market + MarketRate on happy path', async () => {
    const { prisma, store } = makeFakePrisma({
      nodes: [{ id: 'node-1', gpuTier: 'H100', customRatePerHour: null, walletAddress: 'w1' }],
      rates: [
        {
          id: 'r1',
          market: 'AKASH',
          gpuTier: 'H100',
          ratePerHour: 4.5,
          ratePerDay: 108,
          available: true,
          fetchedAt: new Date(),
        },
      ],
    })
    const { registry, createCalls } = makeFakeRegistry({
      available: { AKASH: true, IONET: true, VASTAI: true },
      createResult: { externalId: 'ext-new', status: 'PENDING' },
    })

    const result = await adminListNode(prisma, registry, {
      nodeId: 'node-1',
      market: 'AKASH',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.status).toBe(201)
    expect(result.body.market).toBe('AKASH')
    expect(result.body.ratePerHour).toBe(4.5)
    expect(result.body.externalId).toBe('ext-new')
    expect(createCalls).toHaveLength(1)
    expect(store.deployments).toHaveLength(1)
    expect(store.deployments[0]!.market).toBe('AKASH')
  })

  it('returns 400 when explicit market has no available rate', async () => {
    const { prisma } = makeFakePrisma({
      nodes: [{ id: 'node-1', gpuTier: 'H100', customRatePerHour: null, walletAddress: 'w1' }],
      rates: [],
    })
    const { registry } = makeFakeRegistry({
      available: { AKASH: true, IONET: true, VASTAI: true },
    })

    const result = await adminListNode(prisma, registry, {
      nodeId: 'node-1',
      market: 'AKASH',
    })

    expect(result.ok).toBe(false)
    expect(result.status).toBe(400)
  })

  it('returns 400 when explicit market is not registered/available', async () => {
    const { prisma } = makeFakePrisma({
      nodes: [{ id: 'node-1', gpuTier: 'H100', customRatePerHour: null, walletAddress: 'w1' }],
    })
    const { registry } = makeFakeRegistry({
      available: { AKASH: false, IONET: true, VASTAI: true },
    })

    const result = await adminListNode(prisma, registry, {
      nodeId: 'node-1',
      market: 'AKASH',
    })

    expect(result.ok).toBe(false)
    expect(result.status).toBe(400)
  })
})

// --- adminDelistNode -------------------------------------------------------

describe('adminDelistNode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 404 when no active deployment', async () => {
    const { prisma } = makeFakePrisma({})
    const { registry } = makeFakeRegistry()
    const result = await adminDelistNode(prisma, registry, {
      nodeId: 'node-1',
      mode: 'safe',
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(404)
  })

  it('SAFE delist flips ACTIVE deployment to TERMINATING without adapter call', async () => {
    const { prisma, store } = makeFakePrisma({
      deployments: [makeDeployment({ id: 'dep-1', nodeId: 'node-1', status: 'ACTIVE' })],
    })
    const { registry, terminateCalls } = makeFakeRegistry()

    const result = await adminDelistNode(prisma, registry, {
      nodeId: 'node-1',
      mode: 'safe',
      reason: 'admin',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.body.status).toBe('TERMINATING')
    expect(result.body.terminated).toBe(false)
    expect(result.body.deploymentId).toBe('dep-1')
    expect(terminateCalls).toHaveLength(0)
    expect(store.deployments[0]!.status).toBe('TERMINATING')
    expect(store.deployments[0]!.terminationMode).toBe('SAFE')
  })

  it('FORCE delist calls adapter and marks TERMINATED', async () => {
    const { prisma, store } = makeFakePrisma({
      deployments: [
        makeDeployment({
          id: 'dep-1',
          nodeId: 'node-1',
          status: 'ACTIVE',
          externalId: 'ext-force',
        }),
      ],
    })
    const { registry, terminateCalls } = makeFakeRegistry()

    const result = await adminDelistNode(prisma, registry, {
      nodeId: 'node-1',
      mode: 'force',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.body.status).toBe('TERMINATED')
    expect(result.body.terminated).toBe(true)
    expect(terminateCalls).toEqual(['ext-force'])
    expect(store.deployments[0]!.terminationMode).toBe('FORCE')
  })
})

// --- getExternalEarnings ---------------------------------------------------

describe('getExternalEarnings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sums earnings by market and by node, excluding INTERNAL', async () => {
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)

    const { prisma } = makeFakePrisma({
      nodes: [
        { id: 'node-1', gpuTier: 'H100', customRatePerHour: null, walletAddress: 'wallet-1' },
        { id: 'node-2', gpuTier: 'H100', customRatePerHour: null, walletAddress: 'wallet-2' },
      ],
      earnings: [
        {
          id: 'e1',
          nodeId: 'node-1',
          date: today,
          market: 'AKASH',
          earnings: 10,
          gpuSeconds: 3600,
          jobCount: 0,
        },
        {
          id: 'e2',
          nodeId: 'node-2',
          date: today,
          market: 'IONET',
          earnings: 4,
          gpuSeconds: 1800,
          jobCount: 0,
        },
        {
          id: 'e3',
          nodeId: 'node-1',
          date: today,
          market: 'VASTAI',
          earnings: 2,
          gpuSeconds: 900,
          jobCount: 0,
        },
      ],
    })

    const result = await getExternalEarnings(prisma, {})
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.body.totalUsd).toBe(16)
    expect(result.body.byMarket).toEqual({ AKASH: 10, IONET: 4, VASTAI: 2 })
    expect(result.body.byNode).toHaveLength(2)
    expect(result.body.byNode[0]).toEqual({
      nodeId: 'node-1',
      walletAddress: 'wallet-1',
      totalUsd: 12,
    })
    expect(result.body.byNode[1]).toEqual({
      nodeId: 'node-2',
      walletAddress: 'wallet-2',
      totalUsd: 4,
    })
  })

  it('filters by nodeId and market', async () => {
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)

    const { prisma } = makeFakePrisma({
      nodes: [
        { id: 'node-1', gpuTier: 'H100', customRatePerHour: null, walletAddress: 'wallet-1' },
        { id: 'node-2', gpuTier: 'H100', customRatePerHour: null, walletAddress: 'wallet-2' },
      ],
      earnings: [
        {
          id: 'e1',
          nodeId: 'node-1',
          date: today,
          market: 'AKASH',
          earnings: 10,
          gpuSeconds: 3600,
          jobCount: 0,
        },
        {
          id: 'e2',
          nodeId: 'node-2',
          date: today,
          market: 'AKASH',
          earnings: 5,
          gpuSeconds: 1800,
          jobCount: 0,
        },
        {
          id: 'e3',
          nodeId: 'node-1',
          date: today,
          market: 'IONET',
          earnings: 7,
          gpuSeconds: 900,
          jobCount: 0,
        },
      ],
    })

    const result = await getExternalEarnings(prisma, {
      nodeId: 'node-1',
      market: 'AKASH',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.body.totalUsd).toBe(10)
    expect(result.body.byMarket.AKASH).toBe(10)
    expect(result.body.byMarket.IONET).toBe(0)
  })

  it('returns 400 for invalid date range', async () => {
    const { prisma } = makeFakePrisma({})
    const result = await getExternalEarnings(prisma, {
      from: '2026-04-10',
      to: '2026-04-01',
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(400)
  })
})

// --- getOverflowConfigResponse ---------------------------------------------

describe('getOverflowConfigResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('parses preferredMarkets JSON', async () => {
    const { prisma } = makeFakePrisma({
      config: makeConfig({
        preferredMarkets: '["VASTAI","AKASH"]',
      }),
    })

    const result = await getOverflowConfigResponse(prisma)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.body.config.preferredMarkets).toEqual(['VASTAI', 'AKASH'])
  })
})

// --- updateOverflowConfig --------------------------------------------------

describe('updateOverflowConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('persists only provided fields and serializes preferredMarkets', async () => {
    const { prisma, store } = makeFakePrisma({
      config: makeConfig({}),
    })

    const result = await updateOverflowConfig(prisma, {
      enabled: true,
      marginProtectionPercent: 25,
      preferredMarkets: ['IONET', 'AKASH'],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.body.config.enabled).toBe(true)
    expect(result.body.config.marginProtectionPercent).toBe(25)
    expect(result.body.config.preferredMarkets).toEqual(['IONET', 'AKASH'])
    expect(store.config!.preferredMarkets).toBe('["IONET","AKASH"]')
    // Untouched field stays at default
    expect(result.body.config.idleThresholdMinutes).toBe(10)
  })
})
