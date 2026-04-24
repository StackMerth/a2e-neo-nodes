// External Orphan Reconciler Tests (F4.3)
//
// These tests exercise `runExternalOrphanTick` in isolation. Prisma, the
// adapter registry, and the per-market adapters are all faked so we do not
// need BullMQ, Redis, or a live database.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PrismaClient } from '@a2e/database'
import type { AdapterRegistry } from '@a2e/core'
import { runExternalOrphanTick } from '../external-orphan-reconciler'

type DeploymentStatus = 'PENDING' | 'ACTIVE' | 'TERMINATING' | 'TERMINATED' | 'FAILED'
type AdapterMarket = 'AKASH' | 'IONET' | 'VASTAI'

interface DeploymentRow {
  id: string
  nodeId: string
  externalId: string
  market: AdapterMarket
  status: DeploymentStatus
  terminatedAt?: Date | null
}

interface UpdateCall {
  where: { id: string }
  data: Record<string, unknown>
}

interface FakePrismaHandle {
  client: PrismaClient
  findManyMock: ReturnType<typeof vi.fn>
  updateMock: ReturnType<typeof vi.fn>
  updates: UpdateCall[]
}

type FindManyArgs = {
  where?: {
    status?: DeploymentStatus | { in?: DeploymentStatus[] }
    terminatedAt?: { gte?: Date }
  }
}

function makeFakePrisma(deployments: DeploymentRow[]): FakePrismaHandle {
  const updates: UpdateCall[] = []

  const findManyMock = vi.fn(async (args: FindManyArgs) => {
    const statusFilter = args.where?.status
    let rows = deployments

    if (statusFilter) {
      if (typeof statusFilter === 'object' && 'in' in statusFilter) {
        const allowed = statusFilter.in ?? []
        rows = rows.filter((d) => allowed.includes(d.status))
      } else if (typeof statusFilter === 'string') {
        rows = rows.filter((d) => d.status === statusFilter)
      }
    }

    const gte = args.where?.terminatedAt?.gte
    if (gte) {
      rows = rows.filter(
        (d) => d.terminatedAt != null && d.terminatedAt.getTime() >= gte.getTime(),
      )
    }

    return rows.map((d) => ({
      id: d.id,
      externalId: d.externalId,
      market: d.market,
      nodeId: d.nodeId,
      status: d.status,
    }))
  }) as unknown as ReturnType<typeof vi.fn>

  const updateMock = vi.fn(async (args: UpdateCall) => {
    updates.push(args)
    return { id: args.where.id }
  }) as unknown as ReturnType<typeof vi.fn>

  const client = {
    externalDeployment: {
      findMany: findManyMock,
      update: updateMock,
    },
  } as unknown as PrismaClient

  return { client, findManyMock, updateMock, updates }
}

interface FakeAdapter {
  market: AdapterMarket
  getDeploymentStatus: ReturnType<typeof vi.fn>
  terminateDeployment: ReturnType<typeof vi.fn>
}

function makeFakeAdapter(
  market: AdapterMarket,
  getStatus: (externalId: string) => Promise<{ externalId: string; status: DeploymentStatus }>,
  terminate: (externalId: string) => Promise<void> = async () => undefined,
): FakeAdapter {
  return {
    market,
    getDeploymentStatus: vi.fn(getStatus) as unknown as ReturnType<typeof vi.fn>,
    terminateDeployment: vi.fn(terminate) as unknown as ReturnType<typeof vi.fn>,
  }
}

interface FakeRegistryHandle {
  registry: AdapterRegistry
  recordSuccess: ReturnType<typeof vi.fn>
  recordFailure: ReturnType<typeof vi.fn>
}

function makeFakeRegistry(adapters: Partial<Record<AdapterMarket, FakeAdapter>>): FakeRegistryHandle {
  const recordSuccess = vi.fn()
  const recordFailure = vi.fn()

  const registry = {
    isAvailable: vi.fn(() => true),
    get: vi.fn((market: AdapterMarket) => adapters[market] ?? null),
    recordSuccess,
    recordFailure,
  } as unknown as AdapterRegistry

  return { registry, recordSuccess, recordFailure }
}

interface Harness {
  prismaHandle: FakePrismaHandle
  registryHandle: FakeRegistryHandle
  io: { emit: ReturnType<typeof vi.fn> }
}

function makeHarness(
  deployments: DeploymentRow[],
  adapters: Partial<Record<AdapterMarket, FakeAdapter>>,
): Harness {
  return {
    prismaHandle: makeFakePrisma(deployments),
    registryHandle: makeFakeRegistry(adapters),
    io: { emit: vi.fn() },
  }
}

function runTick(harness: Harness) {
  return runExternalOrphanTick({
    redis: {} as unknown as Parameters<typeof runExternalOrphanTick>[0]['redis'],
    prisma: harness.prismaHandle.client,
    registry: harness.registryHandle.registry,
    io: harness.io as unknown as Parameters<typeof runExternalOrphanTick>[0]['io'],
  })
}

describe('runExternalOrphanTick', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns zero counts when no deployments exist and does not emit', async () => {
    const harness = makeHarness([], {})

    const summary = await runTick(harness)

    expect(summary).toEqual({ inspected: 0, reconciled: 0, errors: 0, actions: [] })
    expect(harness.io.emit).not.toHaveBeenCalled()
  })

  it('reports no drift when every active deployment matches the market', async () => {
    const akash = makeFakeAdapter('AKASH', async (externalId) => ({
      externalId,
      status: 'ACTIVE',
    }))
    const ionet = makeFakeAdapter('IONET', async (externalId) => ({
      externalId,
      status: 'ACTIVE',
    }))

    const harness = makeHarness(
      [
        {
          id: 'dep-1',
          nodeId: 'node-a',
          externalId: 'ext-1',
          market: 'AKASH',
          status: 'ACTIVE',
        },
        {
          id: 'dep-2',
          nodeId: 'node-b',
          externalId: 'ext-2',
          market: 'IONET',
          status: 'ACTIVE',
        },
      ],
      { AKASH: akash, IONET: ionet },
    )

    const summary = await runTick(harness)

    expect(summary.inspected).toBe(2)
    expect(summary.reconciled).toBe(0)
    expect(summary.errors).toBe(0)
    expect(summary.actions.map((a) => a.kind)).toEqual(['NONE', 'NONE'])
    expect(harness.io.emit).not.toHaveBeenCalled()
    expect(harness.prismaHandle.updateMock).not.toHaveBeenCalled()
    expect(harness.registryHandle.recordSuccess).toHaveBeenCalledTimes(2)
  })

  it('marks a DB-ACTIVE deployment as TERMINATED when the market reports it terminated', async () => {
    const akash = makeFakeAdapter('AKASH', async (externalId) => ({
      externalId,
      status: 'TERMINATED',
    }))

    const harness = makeHarness(
      [
        {
          id: 'dep-1',
          nodeId: 'node-a',
          externalId: 'ext-1',
          market: 'AKASH',
          status: 'ACTIVE',
        },
      ],
      { AKASH: akash },
    )

    const summary = await runTick(harness)

    expect(summary.inspected).toBe(1)
    expect(summary.reconciled).toBe(1)
    expect(summary.errors).toBe(0)
    expect(summary.actions[0]).toMatchObject({
      deploymentId: 'dep-1',
      externalId: 'ext-1',
      market: 'AKASH',
      kind: 'MARKED_TERMINATED',
    })
    expect(harness.prismaHandle.updateMock).toHaveBeenCalledTimes(1)
    expect(harness.prismaHandle.updates[0]).toMatchObject({
      where: { id: 'dep-1' },
      data: expect.objectContaining({
        status: 'TERMINATED',
        terminationReason: expect.stringContaining('TERMINATED'),
      }),
    })
    const firstUpdate = harness.prismaHandle.updates[0]
    expect(firstUpdate).toBeDefined()
    expect(firstUpdate?.data.terminatedAt).toBeInstanceOf(Date)
    expect(harness.io.emit).toHaveBeenCalledWith(
      'external:orphan:reconciled',
      expect.objectContaining({
        deploymentId: 'dep-1',
        nodeId: 'node-a',
        newStatus: 'TERMINATED',
      }),
    )
  })

  it('marks a DB-ACTIVE deployment as FAILED when the adapter throws "unknown deployment"', async () => {
    const akash = makeFakeAdapter('AKASH', async () => {
      throw new Error('Akash: unknown deployment ext-1')
    })

    const harness = makeHarness(
      [
        {
          id: 'dep-1',
          nodeId: 'node-a',
          externalId: 'ext-1',
          market: 'AKASH',
          status: 'ACTIVE',
        },
      ],
      { AKASH: akash },
    )

    const summary = await runTick(harness)

    expect(summary.inspected).toBe(1)
    expect(summary.reconciled).toBe(1)
    expect(summary.errors).toBe(0)
    expect(summary.actions[0]).toMatchObject({
      deploymentId: 'dep-1',
      kind: 'MARKED_FAILED',
      reason: expect.stringContaining('unknown'),
    })
    expect(harness.prismaHandle.updateMock).toHaveBeenCalledTimes(1)
    expect(harness.prismaHandle.updates[0]).toMatchObject({
      where: { id: 'dep-1' },
      data: expect.objectContaining({
        status: 'FAILED',
        terminationReason: 'Reconciler: unknown to market',
      }),
    })
    expect(harness.io.emit).toHaveBeenCalledWith(
      'external:orphan:failed',
      expect.objectContaining({ deploymentId: 'dep-1', nodeId: 'node-a' }),
    )
    // Unknown-deployment is a domain signal, not an adapter failure, so we do
    // NOT record a failure against the registry.
    expect(harness.registryHandle.recordFailure).not.toHaveBeenCalled()
  })

  it('increments errors and records a registry failure when the adapter throws a non-unknown error', async () => {
    const boom = new Error('ECONNRESET')
    const akash = makeFakeAdapter('AKASH', async () => {
      throw boom
    })

    const harness = makeHarness(
      [
        {
          id: 'dep-1',
          nodeId: 'node-a',
          externalId: 'ext-1',
          market: 'AKASH',
          status: 'ACTIVE',
        },
      ],
      { AKASH: akash },
    )

    const summary = await runTick(harness)

    expect(summary.inspected).toBe(1)
    expect(summary.reconciled).toBe(0)
    expect(summary.errors).toBe(1)
    expect(summary.actions).toHaveLength(0)
    expect(harness.prismaHandle.updateMock).not.toHaveBeenCalled()
    expect(harness.io.emit).not.toHaveBeenCalled()
    expect(harness.registryHandle.recordFailure).toHaveBeenCalledWith('AKASH', boom)
  })

  it('force-terminates a TERMINATED row that the market still shows as ACTIVE', async () => {
    const recentlyTerminatedAt = new Date(Date.now() - 60_000)
    const akash = makeFakeAdapter(
      'AKASH',
      async (externalId) => ({ externalId, status: 'ACTIVE' }),
      async () => undefined,
    )

    const harness = makeHarness(
      [
        {
          id: 'dep-1',
          nodeId: 'node-a',
          externalId: 'ext-1',
          market: 'AKASH',
          status: 'TERMINATED',
          terminatedAt: recentlyTerminatedAt,
        },
      ],
      { AKASH: akash },
    )

    const summary = await runTick(harness)

    expect(summary.inspected).toBe(1)
    expect(summary.reconciled).toBe(1)
    expect(summary.errors).toBe(0)
    expect(akash.terminateDeployment).toHaveBeenCalledWith('ext-1')
    expect(summary.actions[0]).toMatchObject({
      deploymentId: 'dep-1',
      kind: 'FORCED_TERMINATED',
      reason: expect.stringContaining('still running'),
    })
    expect(harness.io.emit).toHaveBeenCalledWith(
      'external:orphan:force-terminated',
      expect.objectContaining({ deploymentId: 'dep-1', nodeId: 'node-a' }),
    )
  })

  it('silently skips a TERMINATED row when the market has already forgotten it', async () => {
    const recentlyTerminatedAt = new Date(Date.now() - 60_000)
    const akash = makeFakeAdapter('AKASH', async () => {
      throw new Error('Akash: unknown deployment ext-1')
    })

    const harness = makeHarness(
      [
        {
          id: 'dep-1',
          nodeId: 'node-a',
          externalId: 'ext-1',
          market: 'AKASH',
          status: 'TERMINATED',
          terminatedAt: recentlyTerminatedAt,
        },
      ],
      { AKASH: akash },
    )

    const summary = await runTick(harness)

    expect(summary.inspected).toBe(1)
    expect(summary.reconciled).toBe(0)
    expect(summary.errors).toBe(0)
    expect(summary.actions).toHaveLength(0)
    expect(akash.terminateDeployment).not.toHaveBeenCalled()
    expect(harness.io.emit).not.toHaveBeenCalled()
    expect(harness.registryHandle.recordFailure).not.toHaveBeenCalled()
  })

  it('does not inspect TERMINATED rows older than the 24h lookback', async () => {
    const ancient = new Date(Date.now() - 48 * 60 * 60_000)
    const akash = makeFakeAdapter('AKASH', async (externalId) => ({
      externalId,
      status: 'ACTIVE',
    }))

    const harness = makeHarness(
      [
        {
          id: 'dep-old',
          nodeId: 'node-a',
          externalId: 'ext-old',
          market: 'AKASH',
          status: 'TERMINATED',
          terminatedAt: ancient,
        },
      ],
      { AKASH: akash },
    )

    const summary = await runTick(harness)

    expect(summary.inspected).toBe(0)
    expect(summary.reconciled).toBe(0)
    expect(summary.errors).toBe(0)
    expect(akash.getDeploymentStatus).not.toHaveBeenCalled()
    expect(akash.terminateDeployment).not.toHaveBeenCalled()

    // Verify the phantom-pass query actually constrains by terminatedAt.gte.
    const findManyCalls = harness.prismaHandle.findManyMock.mock.calls
    const phantomCall = findManyCalls.find(
      (call: unknown[]) =>
        (call[0] as { where?: { status?: unknown } }).where?.status === 'TERMINATED',
    )
    expect(phantomCall).toBeDefined()
    if (!phantomCall) return
    const phantomArgs = phantomCall[0] as {
      where?: { status?: string; terminatedAt?: { gte?: Date } }
    }
    expect(phantomArgs.where?.terminatedAt?.gte).toBeInstanceOf(Date)
  })
})
