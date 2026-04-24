// Overflow Scheduler Tests (F3.2)
//
// These tests exercise `runOverflowTick` in isolation. The engine and listing-
// manager functions are injected via the `overrides` parameter so we do not
// have to touch the module graph or stand up a real BullMQ worker.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Queue } from 'bullmq'
import type { PrismaClient, OverflowConfig } from '@a2e/database'
import type { AdapterRegistry, RateProvider } from '@a2e/core'
import { runOverflowTick, type OverflowTickOverrides } from '../overflow-scheduler'

type ExternalMarket = 'AKASH' | 'IONET' | 'VASTAI'

interface DeploymentRow {
  id: string
  nodeId: string
  market: string
  status: 'PENDING' | 'ACTIVE' | 'TERMINATING' | 'TERMINATED' | 'FAILED'
}

function makeConfig(overrides: Partial<OverflowConfig> = {}): OverflowConfig {
  return {
    id: 'singleton',
    enabled: true,
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

function makeFakePrisma(deployments: DeploymentRow[] = []): PrismaClient {
  return {
    externalDeployment: {
      findMany: vi.fn(
        async (args: {
          where?: { status?: { in?: string[] } }
          select?: Record<string, boolean>
        }) => {
          const statuses = args.where?.status?.in
          const rows = statuses
            ? deployments.filter((d) => statuses.includes(d.status))
            : deployments
          return rows.map((d) => ({ id: d.id, nodeId: d.nodeId, market: d.market }))
        },
      ),
    },
  } as unknown as PrismaClient
}

function makeFakeRegistry(): AdapterRegistry {
  return {
    isAvailable: vi.fn(() => true),
    get: vi.fn(() => null),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  } as unknown as AdapterRegistry
}

function makeFakeRateProvider(): RateProvider {
  return {
    getRates: vi.fn(),
  } as unknown as RateProvider
}

function makeFakeTerminationQueue(): Queue {
  return { add: vi.fn() } as unknown as Queue
}

interface Harness {
  prisma: PrismaClient
  registry: AdapterRegistry
  rateProvider: RateProvider
  terminationQueue: Queue
  io: { emit: ReturnType<typeof vi.fn> }
}

function makeHarness(deployments: DeploymentRow[] = []): Harness {
  return {
    prisma: makeFakePrisma(deployments),
    registry: makeFakeRegistry(),
    rateProvider: makeFakeRateProvider(),
    terminationQueue: makeFakeTerminationQueue(),
    io: { emit: vi.fn() },
  }
}

// Build an overrides bundle with sensible defaults so individual tests only
// have to override the parts they care about.
function makeOverrides(partial: OverflowTickOverrides = {}): OverflowTickOverrides {
  return {
    getOrCreateOverflowConfig: vi.fn(async () => makeConfig()),
    detectIdleNodes: vi.fn(async () => []),
    shouldListExternally: vi.fn(async () => ({ shouldList: false, reason: 'default' })),
    shouldDelistExternally: vi.fn(async () => ({
      shouldDelist: false,
      reason: 'default',
      mode: 'SAFE' as const,
    })),
    selectBestMarket: vi.fn(async () => ({
      market: null,
      ratePerHour: 0,
      reason: 'no market',
      candidatesConsidered: [],
    })),
    listNodeExternally: vi.fn(async () => ({
      deploymentId: 'dep-new',
      externalId: 'ext-new',
      status: 'PENDING' as const,
    })),
    delistNode: vi.fn(async () => ({ status: 'TERMINATING' as const, terminated: false })),
    ...partial,
  }
}

describe('runOverflowTick', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns zero counts when overflow is disabled without touching the DB', async () => {
    const harness = makeHarness()
    const getConfig = vi.fn(async () => makeConfig({ enabled: false }))
    const detectIdleNodes = vi.fn(async () => [])

    const findMany = harness.prisma.externalDeployment.findMany as unknown as ReturnType<
      typeof vi.fn
    >

    const summary = await runOverflowTick({
      prisma: harness.prisma,
      registry: harness.registry,
      rateProvider: harness.rateProvider,
      terminationQueue: harness.terminationQueue,
      overrides: makeOverrides({
        getOrCreateOverflowConfig: getConfig,
        detectIdleNodes,
      }),
    })

    expect(summary).toEqual({
      listed: 0,
      delisted: 0,
      skipped: 0,
      errors: 0,
      enabled: false,
    })
    expect(getConfig).toHaveBeenCalledOnce()
    expect(detectIdleNodes).not.toHaveBeenCalled()
    expect(findMany).not.toHaveBeenCalled()
  })

  it('lists every eligible idle node and emits external:listed', async () => {
    const harness = makeHarness()

    const detectIdleNodes = vi.fn(async () => [
      { id: 'node-a', gpuTier: 'H100' as const, customRatePerHour: null, walletAddress: 'w-a' },
      { id: 'node-b', gpuTier: 'H200' as const, customRatePerHour: null, walletAddress: 'w-b' },
    ])
    const shouldListExternally = vi.fn(async () => ({
      shouldList: true,
      reason: 'idle, demand low',
    }))
    const selectBestMarket = vi.fn(async (_ctx, gpuTier: string) => ({
      market: 'AKASH' as ExternalMarket,
      ratePerHour: gpuTier === 'H100' ? 4.5 : 6.0,
      reason: 'selected AKASH',
      candidatesConsidered: [],
    }))
    const listNodeExternally = vi.fn(async (_prisma, _registry, input) => ({
      deploymentId: `dep-${input.nodeId}`,
      externalId: `ext-${input.nodeId}`,
      status: 'PENDING' as const,
    }))

    const summary = await runOverflowTick({
      prisma: harness.prisma,
      registry: harness.registry,
      rateProvider: harness.rateProvider,
      terminationQueue: harness.terminationQueue,
      io: harness.io as unknown as Parameters<typeof runOverflowTick>[0]['io'],
      overrides: makeOverrides({
        detectIdleNodes,
        shouldListExternally,
        selectBestMarket,
        listNodeExternally,
      }),
    })

    expect(summary).toMatchObject({ listed: 2, delisted: 0, errors: 0, enabled: true })
    expect(listNodeExternally).toHaveBeenCalledTimes(2)
    expect(harness.io.emit).toHaveBeenCalledTimes(2)
    expect(harness.io.emit).toHaveBeenNthCalledWith(
      1,
      'external:listed',
      expect.objectContaining({
        nodeId: 'node-a',
        deploymentId: 'dep-node-a',
        market: 'AKASH',
        ratePerHour: 4.5,
      }),
    )
  })

  it('skips the node when shouldListExternally returns false', async () => {
    const harness = makeHarness()

    const detectIdleNodes = vi.fn(async () => [
      { id: 'node-a', gpuTier: 'H100' as const, customRatePerHour: null, walletAddress: 'w-a' },
    ])
    const shouldListExternally = vi.fn(async () => ({
      shouldList: false,
      reason: 'internal demand high',
    }))
    const listNodeExternally = vi.fn()

    const summary = await runOverflowTick({
      prisma: harness.prisma,
      registry: harness.registry,
      rateProvider: harness.rateProvider,
      terminationQueue: harness.terminationQueue,
      overrides: makeOverrides({
        detectIdleNodes,
        shouldListExternally,
        listNodeExternally: listNodeExternally as unknown as OverflowTickOverrides['listNodeExternally'],
      }),
    })

    expect(summary).toMatchObject({ listed: 0, skipped: 1, errors: 0 })
    expect(listNodeExternally).not.toHaveBeenCalled()
  })

  it('skips the node when no market meets the margin floor', async () => {
    const harness = makeHarness()

    const detectIdleNodes = vi.fn(async () => [
      { id: 'node-a', gpuTier: 'H100' as const, customRatePerHour: null, walletAddress: 'w-a' },
    ])
    const shouldListExternally = vi.fn(async () => ({
      shouldList: true,
      reason: 'idle',
    }))
    const selectBestMarket = vi.fn(async () => ({
      market: null,
      ratePerHour: 0,
      reason: 'no market meets margin protection',
      candidatesConsidered: [],
    }))
    const listNodeExternally = vi.fn()

    const summary = await runOverflowTick({
      prisma: harness.prisma,
      registry: harness.registry,
      rateProvider: harness.rateProvider,
      terminationQueue: harness.terminationQueue,
      overrides: makeOverrides({
        detectIdleNodes,
        shouldListExternally,
        selectBestMarket,
        listNodeExternally: listNodeExternally as unknown as OverflowTickOverrides['listNodeExternally'],
      }),
    })

    expect(summary).toMatchObject({ listed: 0, skipped: 1, errors: 0 })
    expect(listNodeExternally).not.toHaveBeenCalled()
  })

  it('delists an active deployment SAFE when the policy says so', async () => {
    const harness = makeHarness([
      { id: 'dep-1', nodeId: 'node-a', market: 'AKASH', status: 'ACTIVE' },
    ])

    const shouldDelistExternally = vi.fn(async () => ({
      shouldDelist: true,
      reason: 'internal demand high',
      mode: 'SAFE' as const,
    }))
    const delistNode = vi.fn(async () => ({
      status: 'TERMINATING' as const,
      terminated: false,
    }))

    const summary = await runOverflowTick({
      prisma: harness.prisma,
      registry: harness.registry,
      rateProvider: harness.rateProvider,
      terminationQueue: harness.terminationQueue,
      io: harness.io as unknown as Parameters<typeof runOverflowTick>[0]['io'],
      overrides: makeOverrides({
        shouldDelistExternally,
        delistNode,
      }),
    })

    expect(summary).toMatchObject({ listed: 0, delisted: 1, errors: 0 })
    expect(delistNode).toHaveBeenCalledWith(
      harness.prisma,
      harness.registry,
      expect.objectContaining({
        deploymentId: 'dep-1',
        mode: 'SAFE',
        reason: 'internal demand high',
        terminationQueue: harness.terminationQueue,
      }),
    )
    expect(harness.io.emit).toHaveBeenCalledWith(
      'external:delisting',
      expect.objectContaining({
        nodeId: 'node-a',
        deploymentId: 'dep-1',
        market: 'AKASH',
        mode: 'SAFE',
      }),
    )
  })

  it('delists SAFE under rising demand without listing anything new', async () => {
    const harness = makeHarness([
      { id: 'dep-1', nodeId: 'node-a', market: 'AKASH', status: 'ACTIVE' },
    ])

    // High demand means detectIdleNodes returns nothing (engine filters those
    // out in real code); we model that by returning an empty list here.
    const detectIdleNodes = vi.fn(async () => [])
    const shouldDelistExternally = vi.fn(async () => ({
      shouldDelist: true,
      reason: 'internal demand high',
      mode: 'SAFE' as const,
    }))
    const delistNode = vi.fn(async () => ({
      status: 'TERMINATING' as const,
      terminated: false,
    }))

    const summary = await runOverflowTick({
      prisma: harness.prisma,
      registry: harness.registry,
      rateProvider: harness.rateProvider,
      terminationQueue: harness.terminationQueue,
      overrides: makeOverrides({
        detectIdleNodes,
        shouldDelistExternally,
        delistNode,
      }),
    })

    expect(summary).toMatchObject({ listed: 0, delisted: 1, errors: 0 })
  })

  it('counts an error from listNodeExternally and keeps going', async () => {
    const harness = makeHarness()

    const detectIdleNodes = vi.fn(async () => [
      { id: 'node-a', gpuTier: 'H100' as const, customRatePerHour: null, walletAddress: 'w-a' },
      { id: 'node-b', gpuTier: 'H100' as const, customRatePerHour: null, walletAddress: 'w-b' },
    ])
    const shouldListExternally = vi.fn(async () => ({
      shouldList: true,
      reason: 'idle',
    }))
    const selectBestMarket = vi.fn(async () => ({
      market: 'AKASH' as ExternalMarket,
      ratePerHour: 4.5,
      reason: 'selected AKASH',
      candidatesConsidered: [],
    }))
    const listNodeExternally = vi
      .fn()
      .mockRejectedValueOnce(new Error('node already has an active external deployment'))
      .mockResolvedValueOnce({
        deploymentId: 'dep-node-b',
        externalId: 'ext-node-b',
        status: 'PENDING' as const,
      })

    const summary = await runOverflowTick({
      prisma: harness.prisma,
      registry: harness.registry,
      rateProvider: harness.rateProvider,
      terminationQueue: harness.terminationQueue,
      overrides: makeOverrides({
        detectIdleNodes,
        shouldListExternally,
        selectBestMarket,
        listNodeExternally: listNodeExternally as unknown as OverflowTickOverrides['listNodeExternally'],
      }),
    })

    expect(summary).toMatchObject({ listed: 1, errors: 1, enabled: true })
    expect(listNodeExternally).toHaveBeenCalledTimes(2)
  })

  it('counts an error from delistNode and keeps going', async () => {
    const harness = makeHarness([
      { id: 'dep-1', nodeId: 'node-a', market: 'AKASH', status: 'ACTIVE' },
      { id: 'dep-2', nodeId: 'node-b', market: 'IONET', status: 'ACTIVE' },
    ])

    const shouldDelistExternally = vi.fn(async () => ({
      shouldDelist: true,
      reason: 'demand',
      mode: 'SAFE' as const,
    }))
    const delistNode = vi
      .fn()
      .mockRejectedValueOnce(new Error('adapter unreachable'))
      .mockResolvedValueOnce({ status: 'TERMINATING' as const, terminated: false })

    const summary = await runOverflowTick({
      prisma: harness.prisma,
      registry: harness.registry,
      rateProvider: harness.rateProvider,
      terminationQueue: harness.terminationQueue,
      overrides: makeOverrides({
        shouldDelistExternally,
        delistNode: delistNode as unknown as OverflowTickOverrides['delistNode'],
      }),
    })

    expect(summary).toMatchObject({ delisted: 1, errors: 1, enabled: true })
    expect(delistNode).toHaveBeenCalledTimes(2)
  })

  it('queries active and pending deployments only', async () => {
    const harness = makeHarness([
      { id: 'dep-1', nodeId: 'node-a', market: 'AKASH', status: 'ACTIVE' },
      { id: 'dep-2', nodeId: 'node-b', market: 'IONET', status: 'PENDING' },
      { id: 'dep-3', nodeId: 'node-c', market: 'VASTAI', status: 'TERMINATED' },
      { id: 'dep-4', nodeId: 'node-d', market: 'AKASH', status: 'FAILED' },
    ])

    const shouldDelistExternally = vi.fn(async () => ({
      shouldDelist: false,
      reason: 'still productive',
      mode: 'SAFE' as const,
    }))

    const summary = await runOverflowTick({
      prisma: harness.prisma,
      registry: harness.registry,
      rateProvider: harness.rateProvider,
      terminationQueue: harness.terminationQueue,
      overrides: makeOverrides({
        shouldDelistExternally,
      }),
    })

    expect(shouldDelistExternally).toHaveBeenCalledTimes(2)
    expect(summary).toMatchObject({ listed: 0, delisted: 0, skipped: 2, errors: 0 })
  })
})
