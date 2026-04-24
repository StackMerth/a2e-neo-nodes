// External Earnings Calculator Tests (F4.2)
//
// These tests exercise `runExternalEarningsTick` in isolation.
// `recordExternalEarnings` is injected via the `overrides` parameter so we do
// not touch the module graph or stand up a real BullMQ worker.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PrismaClient } from '@a2e/database'
import type { AdapterRegistry } from '@a2e/core'
import {
  runExternalEarningsTick,
  type ExternalEarningsTickOverrides,
} from '../external-earnings-calculator'

type DeploymentStatus = 'PENDING' | 'ACTIVE' | 'TERMINATING' | 'TERMINATED' | 'FAILED'

interface DeploymentRow {
  id: string
  nodeId: string
  market: string
  status: DeploymentStatus
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
          return rows.map((d) => ({
            id: d.id,
            nodeId: d.nodeId,
            market: d.market,
          }))
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

interface Harness {
  prisma: PrismaClient
  registry: AdapterRegistry
  io: { emit: ReturnType<typeof vi.fn> }
}

function makeHarness(deployments: DeploymentRow[] = []): Harness {
  return {
    prisma: makeFakePrisma(deployments),
    registry: makeFakeRegistry(),
    io: { emit: vi.fn() },
  }
}

function makeOverrides(
  recordExternalEarnings: ExternalEarningsTickOverrides['recordExternalEarnings'],
): ExternalEarningsTickOverrides {
  return { recordExternalEarnings }
}

describe('runExternalEarningsTick', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns zero counts when no deployments are eligible and does not emit', async () => {
    const harness = makeHarness()
    const record = vi.fn()

    const summary = await runExternalEarningsTick({
      prisma: harness.prisma,
      registry: harness.registry,
      io: harness.io as unknown as Parameters<typeof runExternalEarningsTick>[0]['io'],
      overrides: makeOverrides(
        record as unknown as ExternalEarningsTickOverrides['recordExternalEarnings'],
      ),
    })

    expect(summary).toEqual({ processed: 0, recorded: 0, flagged: 0, errors: 0 })
    expect(record).not.toHaveBeenCalled()
    expect(harness.io.emit).not.toHaveBeenCalled()
  })

  it('records and emits for every deployment with a non-zero delta', async () => {
    const rows: DeploymentRow[] = [
      { id: 'dep-1', nodeId: 'node-a', market: 'AKASH', status: 'ACTIVE' },
      { id: 'dep-2', nodeId: 'node-b', market: 'IONET', status: 'ACTIVE' },
      { id: 'dep-3', nodeId: 'node-c', market: 'VASTAI', status: 'TERMINATING' },
    ]
    const harness = makeHarness(rows)

    const record = vi.fn(async (_prisma, _registry, id: string) => {
      const totals: Record<string, number> = {
        'dep-1': 1.25,
        'dep-2': 2.5,
        'dep-3': 0.75,
      }
      return { deltaUsd: totals[id] ?? 0, totalUsd: (totals[id] ?? 0) + 10 }
    }) as unknown as ExternalEarningsTickOverrides['recordExternalEarnings']

    const summary = await runExternalEarningsTick({
      prisma: harness.prisma,
      registry: harness.registry,
      io: harness.io as unknown as Parameters<typeof runExternalEarningsTick>[0]['io'],
      overrides: makeOverrides(record),
    })

    expect(summary).toEqual({ processed: 3, recorded: 3, flagged: 0, errors: 0 })
    expect(harness.io.emit).toHaveBeenCalledTimes(3)
    expect(harness.io.emit).toHaveBeenCalledWith(
      'external:earnings',
      expect.objectContaining({
        deploymentId: 'dep-1',
        nodeId: 'node-a',
        market: 'AKASH',
        deltaUsd: 1.25,
      }),
    )
    expect(harness.io.emit).toHaveBeenCalledWith(
      'external:earnings',
      expect.objectContaining({
        deploymentId: 'dep-3',
        market: 'VASTAI',
        deltaUsd: 0.75,
      }),
    )
  })

  it('skips the emit when the delta is zero but still counts the deployment as processed', async () => {
    const rows: DeploymentRow[] = [
      { id: 'dep-1', nodeId: 'node-a', market: 'AKASH', status: 'ACTIVE' },
      { id: 'dep-2', nodeId: 'node-b', market: 'IONET', status: 'ACTIVE' },
      { id: 'dep-3', nodeId: 'node-c', market: 'VASTAI', status: 'ACTIVE' },
    ]
    const harness = makeHarness(rows)

    const record = vi.fn(async (_prisma, _registry, id: string) => {
      if (id === 'dep-2') return { deltaUsd: 0, totalUsd: 5 }
      return { deltaUsd: 1.1, totalUsd: 11 }
    }) as unknown as ExternalEarningsTickOverrides['recordExternalEarnings']

    const summary = await runExternalEarningsTick({
      prisma: harness.prisma,
      registry: harness.registry,
      io: harness.io as unknown as Parameters<typeof runExternalEarningsTick>[0]['io'],
      overrides: makeOverrides(record),
    })

    expect(summary).toEqual({ processed: 3, recorded: 2, flagged: 0, errors: 0 })
    expect(harness.io.emit).toHaveBeenCalledTimes(2)
    expect(harness.io.emit).not.toHaveBeenCalledWith(
      'external:earnings',
      expect.objectContaining({ deploymentId: 'dep-2' }),
    )
  })

  it('counts a thrown error and keeps processing the remaining deployments', async () => {
    const rows: DeploymentRow[] = [
      { id: 'dep-1', nodeId: 'node-a', market: 'AKASH', status: 'ACTIVE' },
      { id: 'dep-2', nodeId: 'node-b', market: 'IONET', status: 'ACTIVE' },
      { id: 'dep-3', nodeId: 'node-c', market: 'VASTAI', status: 'ACTIVE' },
    ]
    const harness = makeHarness(rows)

    const record = vi
      .fn()
      .mockResolvedValueOnce({ deltaUsd: 1.5, totalUsd: 10 })
      .mockRejectedValueOnce(new Error('adapter unreachable'))
      .mockResolvedValueOnce({
        deltaUsd: 2.1,
        totalUsd: 12,
      }) as unknown as ExternalEarningsTickOverrides['recordExternalEarnings']

    const summary = await runExternalEarningsTick({
      prisma: harness.prisma,
      registry: harness.registry,
      io: harness.io as unknown as Parameters<typeof runExternalEarningsTick>[0]['io'],
      overrides: makeOverrides(record),
    })

    expect(summary).toEqual({ processed: 2, recorded: 2, flagged: 0, errors: 1 })
    expect(harness.io.emit).toHaveBeenCalledTimes(2)
    const recordMock = record as unknown as ReturnType<typeof vi.fn>
    expect(recordMock).toHaveBeenCalledTimes(3)
  })

  it('queries only ACTIVE and TERMINATING (ignores PENDING, TERMINATED, FAILED)', async () => {
    const harness = makeHarness([
      { id: 'dep-1', nodeId: 'node-a', market: 'AKASH', status: 'PENDING' },
      { id: 'dep-2', nodeId: 'node-b', market: 'IONET', status: 'ACTIVE' },
      { id: 'dep-3', nodeId: 'node-c', market: 'VASTAI', status: 'TERMINATING' },
      { id: 'dep-4', nodeId: 'node-d', market: 'AKASH', status: 'TERMINATED' },
      { id: 'dep-5', nodeId: 'node-e', market: 'IONET', status: 'FAILED' },
    ])

    const seenIds: string[] = []
    const record = vi.fn(async (_prisma, _registry, id: string) => {
      seenIds.push(id)
      return { deltaUsd: 0, totalUsd: 0 }
    }) as unknown as ExternalEarningsTickOverrides['recordExternalEarnings']

    const summary = await runExternalEarningsTick({
      prisma: harness.prisma,
      registry: harness.registry,
      io: harness.io as unknown as Parameters<typeof runExternalEarningsTick>[0]['io'],
      overrides: makeOverrides(record),
    })

    expect(summary.processed).toBe(2)
    expect(seenIds.sort()).toEqual(['dep-2', 'dep-3'])
    const findMany = harness.prisma.externalDeployment.findMany as unknown as ReturnType<
      typeof vi.fn
    >
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: { in: ['ACTIVE', 'TERMINATING'] } },
      }),
    )
  })
})
