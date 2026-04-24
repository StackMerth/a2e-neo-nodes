// Overflow Decision Engine Tests (F3.1)

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PrismaClient, OverflowConfig } from '@a2e/database'
import type { GpuTier } from '@a2e/shared'
import type {
  AdapterRegistry,
  RateProvider,
  MarketRates,
  MarketRateInfo,
} from '@a2e/core'
import {
  calculateMargin,
  detectHighDemand,
  detectIdleNodes,
  getOrCreateOverflowConfig,
  selectBestMarket,
  shouldDelistExternally,
  shouldListExternally,
  type OverflowDecisionContext,
} from '../engine'

// --- Test fixtures ---------------------------------------------------------

interface NodeRow {
  id: string
  status: string
  pendingDeletion: boolean
  lastHeartbeat: Date
  gpuTier: GpuTier
  customRatePerHour: number | null
  walletAddress: string
  createdAt: Date
  assignedComputeRequestId: string | null
  jobs: Array<{ id?: string; status?: string; completedAt: Date | null }>
  externalDeployments: Array<{ id: string; status: string; market: string }>
}

interface ExternalDeploymentRow {
  id: string
  nodeId: string
  market: string
  status: string
  createdAt: Date
}

interface JobRow {
  id: string
  nodeId: string | null
  status: string
  completedAt: Date | null
}

type PrismaNodeWhere = {
  status?: string
  pendingDeletion?: boolean
  lastHeartbeat?: { gte?: Date }
  jobs?: { none?: { status?: { in?: string[] } } }
  externalDeployments?: { none?: { status?: { in?: string[] } } }
}

function makeFakePrisma(options: {
  nodes?: NodeRow[]
  jobs?: JobRow[]
  deployments?: ExternalDeploymentRow[]
  overflowConfig?: OverflowConfig | null
}): PrismaClient {
  const nodes = options.nodes ?? []
  const jobs = options.jobs ?? []
  const deployments = options.deployments ?? []
  let config: OverflowConfig | null = options.overflowConfig ?? null

  const prisma: Partial<PrismaClient> = {
    overflowConfig: {
      upsert: vi.fn(async (_args: unknown) => {
        if (!config) {
          config = makeConfig({})
        }
        return config
      }),
    } as unknown as PrismaClient['overflowConfig'],
    node: {
      findMany: vi.fn(async (args: { where?: PrismaNodeWhere }) => {
        const where = args.where ?? {}
        return nodes
          .filter((n) => {
            if (where.status && n.status !== where.status) return false
            if (where.pendingDeletion !== undefined && n.pendingDeletion !== where.pendingDeletion)
              return false
            if (
              where.lastHeartbeat?.gte &&
              n.lastHeartbeat.getTime() < where.lastHeartbeat.gte.getTime()
            )
              return false
            if (where.jobs?.none?.status?.in) {
              const blocked = where.jobs.none.status.in
              if (n.jobs.some((j) => j.status && blocked.includes(j.status))) return false
            }
            if (where.externalDeployments?.none?.status?.in) {
              const blocked = where.externalDeployments.none.status.in
              if (n.externalDeployments.some((d) => blocked.includes(d.status))) return false
            }
            return true
          })
          .map((n) => ({
            id: n.id,
            gpuTier: n.gpuTier,
            customRatePerHour: n.customRatePerHour,
            walletAddress: n.walletAddress,
            status: n.status,
            pendingDeletion: n.pendingDeletion,
            createdAt: n.createdAt,
            assignedComputeRequestId: n.assignedComputeRequestId,
            jobs: [...n.jobs]
              .filter((j) => !where.jobs?.none?.status?.in || true)
              .sort((a, b) => {
                const at = a.completedAt?.getTime() ?? 0
                const bt = b.completedAt?.getTime() ?? 0
                return bt - at
              })
              .slice(0, 1)
              .map((j) => ({ completedAt: j.completedAt })),
          }))
      }),
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        const node = nodes.find((n) => n.id === args.where.id)
        if (!node) return null
        return {
          id: node.id,
          status: node.status,
          pendingDeletion: node.pendingDeletion,
          gpuTier: node.gpuTier,
          customRatePerHour: node.customRatePerHour,
        }
      }),
    } as unknown as PrismaClient['node'],
    job: {
      findFirst: vi.fn(async (args: { where: { nodeId: string; status: { in: string[] } } }) => {
        const match = jobs.find(
          (j) => j.nodeId === args.where.nodeId && args.where.status.in.includes(j.status),
        )
        return match ? { id: match.id } : null
      }),
    } as unknown as PrismaClient['job'],
    externalDeployment: {
      findFirst: vi.fn(
        async (args: {
          where: { nodeId: string; status?: string | { in: string[] } }
        }) => {
          const match = deployments.find((d) => {
            if (d.nodeId !== args.where.nodeId) return false
            if (typeof args.where.status === 'string') return d.status === args.where.status
            if (args.where.status && 'in' in args.where.status)
              return args.where.status.in.includes(d.status)
            return true
          })
          return match
            ? { id: match.id, market: match.market, status: match.status }
            : null
        },
      ),
    } as unknown as PrismaClient['externalDeployment'],
  }

  return prisma as PrismaClient
}

// Schema defaults: enabled=false, simulationMode=true, idleThresholdMinutes=10,
// demandThresholdPercent=80, marginProtectionPercent=15, gracePeriodSeconds=300.
function makeConfig(overrides: Partial<OverflowConfig>): OverflowConfig {
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

function makeRateInfo(ratePerHour: number, available = true): MarketRateInfo {
  return {
    ratePerHour,
    ratePerDay: ratePerHour * 24,
    available,
    fetchedAt: new Date(),
  }
}

function makeRateProvider(rates: MarketRates): RateProvider {
  return {
    getRates: vi.fn(async () => rates),
    refreshRates: vi.fn(async () => {}),
  }
}

function makeRegistry(available: Record<string, boolean>): AdapterRegistry {
  return {
    isAvailable: vi.fn((market: string) => available[market] === true),
  } as unknown as AdapterRegistry
}

function buildRates(overrides: Partial<{
  akash: MarketRateInfo
  ionet: MarketRateInfo
  vastai: MarketRateInfo
  internal: MarketRateInfo
}>): MarketRates {
  return {
    internal: overrides.internal ?? makeRateInfo(5.84),
    akash: overrides.akash ?? makeRateInfo(4.5),
    ionet: overrides.ionet ?? makeRateInfo(4.2),
    vastai: overrides.vastai ?? makeRateInfo(4.0),
  }
}

// --- Tests ----------------------------------------------------------------

describe('getOrCreateOverflowConfig', () => {
  it('returns config with defaults when none exists', async () => {
    const prisma = makeFakePrisma({})
    const cfg = await getOrCreateOverflowConfig(prisma)
    expect(cfg.id).toBe('singleton')
    expect(cfg.enabled).toBe(false)
    expect(cfg.idleThresholdMinutes).toBe(10)
    expect(cfg.demandThresholdPercent).toBe(80)
    expect(cfg.marginProtectionPercent).toBe(15)
  })

  it('returns existing config when present', async () => {
    const existing = makeConfig({ enabled: true, marginProtectionPercent: 25 })
    const prisma = makeFakePrisma({ overflowConfig: existing })
    const cfg = await getOrCreateOverflowConfig(prisma)
    expect(cfg.enabled).toBe(true)
    expect(cfg.marginProtectionPercent).toBe(25)
  })
})

describe('detectIdleNodes', () => {
  const now = Date.now()
  const recent = new Date(now - 60_000)
  const stale = new Date(now - 10 * 60 * 1000)

  function node(overrides: Partial<NodeRow>): NodeRow {
    return {
      id: 'n1',
      status: 'ONLINE',
      pendingDeletion: false,
      lastHeartbeat: recent,
      gpuTier: 'H100',
      customRatePerHour: null,
      walletAddress: 'wallet1',
      createdAt: new Date(now - 60 * 60 * 1000),
      assignedComputeRequestId: null,
      jobs: [],
      externalDeployments: [],
      ...overrides,
    }
  }

  it('includes online node with no jobs and old creation', async () => {
    const prisma = makeFakePrisma({ nodes: [node({})] })
    const idle = await detectIdleNodes(prisma, 10)
    expect(idle).toHaveLength(1)
    expect(idle[0]!.id).toBe('n1')
  })

  it('excludes node with stale heartbeat', async () => {
    const prisma = makeFakePrisma({ nodes: [node({ lastHeartbeat: stale })] })
    const idle = await detectIdleNodes(prisma, 10)
    expect(idle).toHaveLength(0)
  })

  it('excludes node with active job', async () => {
    const prisma = makeFakePrisma({
      nodes: [node({ jobs: [{ status: 'RUNNING', completedAt: null }] })],
    })
    const idle = await detectIdleNodes(prisma, 10)
    expect(idle).toHaveLength(0)
  })

  it('excludes node with active external deployment', async () => {
    const prisma = makeFakePrisma({
      nodes: [
        node({
          externalDeployments: [{ id: 'd1', status: 'ACTIVE', market: 'AKASH' }],
        }),
      ],
    })
    const idle = await detectIdleNodes(prisma, 10)
    expect(idle).toHaveLength(0)
  })

  it('excludes node whose last job completed too recently', async () => {
    const prisma = makeFakePrisma({
      nodes: [
        node({
          jobs: [
            { status: 'COMPLETED', completedAt: new Date(now - 2 * 60 * 1000) },
          ],
        }),
      ],
    })
    const idle = await detectIdleNodes(prisma, 10)
    expect(idle).toHaveLength(0)
  })

  it('includes node whose last job completed beyond idle threshold', async () => {
    const prisma = makeFakePrisma({
      nodes: [
        node({
          jobs: [
            { status: 'COMPLETED', completedAt: new Date(now - 30 * 60 * 1000) },
          ],
        }),
      ],
    })
    const idle = await detectIdleNodes(prisma, 10)
    expect(idle).toHaveLength(1)
  })

  it('excludes newly-created node without jobs', async () => {
    const prisma = makeFakePrisma({
      nodes: [node({ createdAt: new Date(now - 2 * 60 * 1000), jobs: [] })],
    })
    const idle = await detectIdleNodes(prisma, 10)
    expect(idle).toHaveLength(0)
  })

  it('excludes pendingDeletion node', async () => {
    const prisma = makeFakePrisma({ nodes: [node({ pendingDeletion: true })] })
    const idle = await detectIdleNodes(prisma, 10)
    expect(idle).toHaveLength(0)
  })
})

describe('detectHighDemand', () => {
  const now = Date.now()
  const recent = new Date(now - 60_000)

  function node(overrides: Partial<NodeRow>): NodeRow {
    return {
      id: 'n',
      status: 'ONLINE',
      pendingDeletion: false,
      lastHeartbeat: recent,
      gpuTier: 'H100',
      customRatePerHour: null,
      walletAddress: 'w',
      createdAt: new Date(now - 60 * 60 * 1000),
      assignedComputeRequestId: null,
      jobs: [],
      externalDeployments: [],
      ...overrides,
    }
  }

  it('returns false when there are no online nodes', async () => {
    const prisma = makeFakePrisma({ nodes: [] })
    expect(await detectHighDemand(prisma, 80)).toBe(false)
  })

  it('returns true at exactly the threshold', async () => {
    // 4 of 5 nodes busy = 80%, at threshold
    const nodes: NodeRow[] = [
      node({ id: 'a', jobs: [{ status: 'RUNNING', completedAt: null }] }),
      node({ id: 'b', jobs: [{ status: 'RUNNING', completedAt: null }] }),
      node({ id: 'c', jobs: [{ status: 'RUNNING', completedAt: null }] }),
      node({ id: 'd', assignedComputeRequestId: 'cr1' }),
      node({ id: 'e' }),
    ]
    const prisma = makeFakePrisma({ nodes })
    expect(await detectHighDemand(prisma, 80)).toBe(true)
  })

  it('returns false below the threshold', async () => {
    // 2 of 5 busy = 40%
    const nodes: NodeRow[] = [
      node({ id: 'a', jobs: [{ status: 'RUNNING', completedAt: null }] }),
      node({ id: 'b', assignedComputeRequestId: 'cr1' }),
      node({ id: 'c' }),
      node({ id: 'd' }),
      node({ id: 'e' }),
    ]
    const prisma = makeFakePrisma({ nodes })
    expect(await detectHighDemand(prisma, 80)).toBe(false)
  })

  it('excludes externally-deployed nodes from the denominator', async () => {
    // 1 busy + 1 external listed + 0 idle → 1/1 = 100% busy (external excluded)
    const nodes: NodeRow[] = [
      node({ id: 'busy', jobs: [{ status: 'RUNNING', completedAt: null }] }),
      node({
        id: 'external',
        externalDeployments: [{ id: 'd', status: 'ACTIVE', market: 'AKASH' }],
      }),
    ]
    const prisma = makeFakePrisma({ nodes })
    expect(await detectHighDemand(prisma, 80)).toBe(true)
  })
})

describe('shouldListExternally', () => {
  const now = Date.now()
  const recent = new Date(now - 60_000)

  const baseRates = buildRates({})
  const baseRegistry = makeRegistry({ AKASH: true, IONET: true, VASTAI: true })

  function baseCtx(overrides: Partial<OverflowDecisionContext> = {}): OverflowDecisionContext {
    return {
      config: overrides.config ?? makeConfig({ enabled: true }),
      registry: overrides.registry ?? baseRegistry,
      rateProvider: overrides.rateProvider ?? makeRateProvider(baseRates),
    }
  }

  function idleNode(overrides: Partial<NodeRow> = {}): NodeRow {
    return {
      id: 'n1',
      status: 'ONLINE',
      pendingDeletion: false,
      lastHeartbeat: recent,
      gpuTier: 'H100',
      customRatePerHour: null,
      walletAddress: 'w',
      createdAt: new Date(now - 60 * 60 * 1000),
      assignedComputeRequestId: null,
      jobs: [],
      externalDeployments: [],
      ...overrides,
    }
  }

  it('refuses when overflow is disabled', async () => {
    const prisma = makeFakePrisma({ nodes: [idleNode()] })
    const result = await shouldListExternally(
      prisma,
      baseCtx({ config: makeConfig({ enabled: false }) }),
      'n1',
    )
    expect(result.shouldList).toBe(false)
    expect(result.reason).toBe('overflow disabled')
  })

  it('refuses when node is not found', async () => {
    const prisma = makeFakePrisma({ nodes: [] })
    const result = await shouldListExternally(prisma, baseCtx(), 'missing')
    expect(result.shouldList).toBe(false)
    expect(result.reason).toBe('node not found')
  })

  it('refuses when node has an active job', async () => {
    const prisma = makeFakePrisma({
      nodes: [idleNode()],
      jobs: [
        { id: 'j1', nodeId: 'n1', status: 'RUNNING', completedAt: null },
      ],
    })
    const result = await shouldListExternally(prisma, baseCtx(), 'n1')
    expect(result.shouldList).toBe(false)
    expect(result.reason).toBe('node has active job')
  })

  it('refuses when node already has an active external deployment', async () => {
    const prisma = makeFakePrisma({
      nodes: [idleNode()],
      deployments: [
        {
          id: 'd1',
          nodeId: 'n1',
          market: 'AKASH',
          status: 'ACTIVE',
          createdAt: new Date(),
        },
      ],
    })
    const result = await shouldListExternally(prisma, baseCtx(), 'n1')
    expect(result.shouldList).toBe(false)
    expect(result.reason).toBe('node already externally deployed')
  })

  it('refuses when internal demand is high', async () => {
    // All nodes busy → high demand
    const nodes = [
      idleNode(),
      idleNode({
        id: 'n2',
        jobs: [{ status: 'RUNNING', completedAt: null }],
      }),
    ]
    const prisma = makeFakePrisma({ nodes })
    const result = await shouldListExternally(
      prisma,
      baseCtx({ config: makeConfig({ enabled: true, demandThresholdPercent: 50 }) }),
      'n1',
    )
    expect(result.shouldList).toBe(false)
    expect(result.reason).toBe('internal demand high')
  })

  it('refuses when no market meets margin protection', async () => {
    // H100 cost floor is $83/day = $3.46/hr. Rates below this fail margin.
    const lowRates = buildRates({
      akash: makeRateInfo(2.0),
      ionet: makeRateInfo(2.0),
      vastai: makeRateInfo(2.0),
    })
    const prisma = makeFakePrisma({ nodes: [idleNode()] })
    const result = await shouldListExternally(
      prisma,
      baseCtx({ rateProvider: makeRateProvider(lowRates) }),
      'n1',
    )
    expect(result.shouldList).toBe(false)
    expect(result.reason).toContain('margin')
  })

  it('returns shouldList=true on happy path', async () => {
    const prisma = makeFakePrisma({ nodes: [idleNode()] })
    const result = await shouldListExternally(prisma, baseCtx(), 'n1')
    expect(result.shouldList).toBe(true)
    expect(result.reason).toMatch(/AKASH|IONET|VASTAI/)
  })
})

describe('shouldDelistExternally', () => {
  const now = Date.now()
  const recent = new Date(now - 60_000)

  function idleNode(overrides: Partial<NodeRow> = {}): NodeRow {
    return {
      id: 'n1',
      status: 'ONLINE',
      pendingDeletion: false,
      lastHeartbeat: recent,
      gpuTier: 'H100',
      customRatePerHour: null,
      walletAddress: 'w',
      createdAt: new Date(now - 60 * 60 * 1000),
      assignedComputeRequestId: null,
      jobs: [],
      externalDeployments: [{ id: 'd1', status: 'ACTIVE', market: 'AKASH' }],
      ...overrides,
    }
  }

  const activeDeployment: ExternalDeploymentRow = {
    id: 'd1',
    nodeId: 'n1',
    market: 'AKASH',
    status: 'ACTIVE',
    createdAt: new Date(),
  }

  function ctx(overrides: Partial<OverflowDecisionContext> = {}): OverflowDecisionContext {
    return {
      config: overrides.config ?? makeConfig({ enabled: true }),
      registry:
        overrides.registry ?? makeRegistry({ AKASH: true, IONET: true, VASTAI: true }),
      rateProvider: overrides.rateProvider ?? makeRateProvider(buildRates({})),
    }
  }

  it('returns shouldDelist=false when not externally deployed', async () => {
    const prisma = makeFakePrisma({ nodes: [idleNode({ externalDeployments: [] })] })
    const result = await shouldDelistExternally(prisma, ctx(), 'n1')
    expect(result.shouldDelist).toBe(false)
    expect(result.reason).toBe('not externally deployed')
    expect(result.mode).toBe('SAFE')
  })

  it('returns SAFE delist when overflow disabled', async () => {
    const prisma = makeFakePrisma({
      nodes: [idleNode()],
      deployments: [activeDeployment],
    })
    const result = await shouldDelistExternally(
      prisma,
      ctx({ config: makeConfig({ enabled: false }) }),
      'n1',
    )
    expect(result.shouldDelist).toBe(true)
    expect(result.mode).toBe('SAFE')
    expect(result.reason).toBe('overflow disabled')
  })

  it('returns SAFE delist when internal demand is high', async () => {
    const nodes = [
      idleNode(),
      idleNode({
        id: 'n2',
        externalDeployments: [],
        jobs: [{ status: 'RUNNING', completedAt: null }],
      }),
      idleNode({
        id: 'n3',
        externalDeployments: [],
        jobs: [{ status: 'RUNNING', completedAt: null }],
      }),
    ]
    const prisma = makeFakePrisma({
      nodes,
      deployments: [activeDeployment],
    })
    const result = await shouldDelistExternally(
      prisma,
      ctx({ config: makeConfig({ enabled: true, demandThresholdPercent: 50 }) }),
      'n1',
    )
    expect(result.shouldDelist).toBe(true)
    expect(result.mode).toBe('SAFE')
    expect(result.reason).toBe('internal demand high')
  })

  it('returns FORCE delist when market is unavailable', async () => {
    const prisma = makeFakePrisma({
      nodes: [idleNode()],
      deployments: [activeDeployment],
    })
    const result = await shouldDelistExternally(
      prisma,
      ctx({ registry: makeRegistry({ AKASH: false, IONET: true, VASTAI: true }) }),
      'n1',
    )
    expect(result.shouldDelist).toBe(true)
    expect(result.mode).toBe('FORCE')
    expect(result.reason).toContain('AKASH unavailable')
  })

  it('returns shouldDelist=false when still productive', async () => {
    const prisma = makeFakePrisma({
      nodes: [idleNode()],
      deployments: [activeDeployment],
    })
    const result = await shouldDelistExternally(prisma, ctx(), 'n1')
    expect(result.shouldDelist).toBe(false)
    expect(result.mode).toBe('SAFE')
    expect(result.reason).toBe('still productive')
  })
})

describe('selectBestMarket', () => {
  const baseRegistry = makeRegistry({ AKASH: true, IONET: true, VASTAI: true })

  function ctx(
    rates: MarketRates,
    overrides: Partial<OverflowDecisionContext> = {},
  ): OverflowDecisionContext {
    return {
      config: overrides.config ?? makeConfig({ enabled: true, marginProtectionPercent: 15 }),
      registry: overrides.registry ?? baseRegistry,
      rateProvider: makeRateProvider(rates),
    }
  }

  it('picks the highest-paying market that meets margin', async () => {
    // H100 cost floor $3.46/hr. 15% margin → rate must be ≥ ~$3.98/hr.
    const rates = buildRates({
      akash: makeRateInfo(4.5),
      ionet: makeRateInfo(5.5),
      vastai: makeRateInfo(3.0),
    })
    const result = await selectBestMarket(ctx(rates), 'H100', null)
    expect(result.market).toBe('IONET')
    expect(result.ratePerHour).toBeCloseTo(5.5)
    expect(result.candidatesConsidered).toHaveLength(3)
  })

  it('returns null when no market meets the margin requirement', async () => {
    const rates = buildRates({
      akash: makeRateInfo(2.0),
      ionet: makeRateInfo(2.5),
      vastai: makeRateInfo(3.0),
    })
    const result = await selectBestMarket(ctx(rates), 'H100', null)
    expect(result.market).toBeNull()
    expect(result.ratePerHour).toBe(0)
    expect(result.reason).toContain('no market')
    // audit trail retained
    expect(result.candidatesConsidered).toHaveLength(3)
    for (const c of result.candidatesConsidered) {
      expect(c.excludedReason).toBeDefined()
    }
  })

  it('excludes markets where the adapter is unavailable', async () => {
    const rates = buildRates({
      akash: makeRateInfo(10.0),
      ionet: makeRateInfo(5.5),
      vastai: makeRateInfo(4.5),
    })
    const result = await selectBestMarket(
      ctx(rates, {
        registry: makeRegistry({ AKASH: false, IONET: true, VASTAI: true }),
      }),
      'H100',
      null,
    )
    // Akash would have won, but adapter unavailable → IONET wins
    expect(result.market).toBe('IONET')
    const akashCandidate = result.candidatesConsidered.find((c) => c.market === 'AKASH')
    expect(akashCandidate?.available).toBe(false)
  })

  it('excludes markets where the rate feed reports unavailable', async () => {
    const rates = buildRates({
      akash: makeRateInfo(10.0, false),
      ionet: makeRateInfo(5.5),
      vastai: makeRateInfo(4.5),
    })
    const result = await selectBestMarket(ctx(rates), 'H100', null)
    expect(result.market).toBe('IONET')
  })
})

describe('calculateMargin', () => {
  it('computes standard margin correctly', () => {
    expect(calculateMargin(1.2, 1.0)).toBeCloseTo(20)
    expect(calculateMargin(5.0, 4.0)).toBeCloseTo(25)
  })

  it('returns -Infinity when floor is zero', () => {
    expect(calculateMargin(5.0, 0)).toBe(Number.NEGATIVE_INFINITY)
  })

  it('returns -Infinity when floor is negative', () => {
    expect(calculateMargin(5.0, -1)).toBe(Number.NEGATIVE_INFINITY)
  })

  it('can be negative when rate is below floor', () => {
    expect(calculateMargin(0.8, 1.0)).toBeCloseTo(-20)
  })
})
