// External Status Checker Tests (F4.1)
//
// These tests exercise `runExternalStatusTick` in isolation. `syncDeployment
// Status` is injected via the `overrides` parameter so we do not have to touch
// the module graph or stand up a real BullMQ worker.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PrismaClient, ExternalDeployment } from '@a2e/database'
import type { AdapterRegistry } from '@a2e/core'
import {
  runExternalStatusTick,
  type ExternalStatusTickOverrides,
} from '../external-status-checker'

type DeploymentStatus = 'PENDING' | 'ACTIVE' | 'TERMINATING' | 'TERMINATED' | 'FAILED'

interface DeploymentRow {
  id: string
  nodeId: string
  market: string
  status: DeploymentStatus
  costAccumulated?: number
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
          return rows.map((d) => ({ id: d.id, status: d.status }))
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

function makeUpdatedDeployment(row: DeploymentRow, nextStatus: DeploymentStatus): ExternalDeployment {
  return {
    id: row.id,
    nodeId: row.nodeId,
    market: row.market,
    externalId: `ext-${row.id}`,
    status: nextStatus,
    ratePerHour: 4.5,
    costAccumulated: row.costAccumulated ?? 0,
    earningsAccumulated: 0,
    createdAt: new Date(),
    terminatedAt: null,
    lastCheckedAt: new Date(),
    terminationMode: null,
    terminationReason: null,
  } as unknown as ExternalDeployment
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
  syncDeploymentStatus?: ExternalStatusTickOverrides['syncDeploymentStatus'],
): ExternalStatusTickOverrides {
  return {
    syncDeploymentStatus:
      syncDeploymentStatus ??
      (vi.fn(async (_prisma, _registry, id: string) =>
        makeUpdatedDeployment(
          { id, nodeId: `node-${id}`, market: 'AKASH', status: 'ACTIVE' },
          'ACTIVE',
        ),
      ) as unknown as ExternalStatusTickOverrides['syncDeploymentStatus']),
  }
}

describe('runExternalStatusTick', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns zero counts when no deployments are active and does not emit', async () => {
    const harness = makeHarness()
    const sync = vi.fn()

    const summary = await runExternalStatusTick({
      prisma: harness.prisma,
      registry: harness.registry,
      io: harness.io as unknown as Parameters<typeof runExternalStatusTick>[0]['io'],
      overrides: makeOverrides(sync as unknown as ExternalStatusTickOverrides['syncDeploymentStatus']),
    })

    expect(summary).toEqual({ checked: 0, transitioned: 0, errors: 0 })
    expect(sync).not.toHaveBeenCalled()
    expect(harness.io.emit).not.toHaveBeenCalled()
  })

  it('processes every active deployment and reports zero transitions when status is unchanged', async () => {
    const rows: DeploymentRow[] = [
      { id: 'dep-1', nodeId: 'node-a', market: 'AKASH', status: 'ACTIVE' },
      { id: 'dep-2', nodeId: 'node-b', market: 'IONET', status: 'ACTIVE' },
      { id: 'dep-3', nodeId: 'node-c', market: 'VASTAI', status: 'PENDING' },
    ]
    const harness = makeHarness(rows)

    const sync = vi.fn(async (_prisma, _registry, id: string) => {
      const row = rows.find((r) => r.id === id)!
      return makeUpdatedDeployment(row, row.status)
    }) as unknown as ExternalStatusTickOverrides['syncDeploymentStatus']

    const summary = await runExternalStatusTick({
      prisma: harness.prisma,
      registry: harness.registry,
      io: harness.io as unknown as Parameters<typeof runExternalStatusTick>[0]['io'],
      overrides: makeOverrides(sync),
    })

    expect(summary).toEqual({ checked: 3, transitioned: 0, errors: 0 })
    expect(harness.io.emit).not.toHaveBeenCalled()
  })

  it('emits external:status once when a deployment transitions PENDING -> ACTIVE', async () => {
    const rows: DeploymentRow[] = [
      { id: 'dep-1', nodeId: 'node-a', market: 'AKASH', status: 'PENDING' },
      { id: 'dep-2', nodeId: 'node-b', market: 'IONET', status: 'ACTIVE' },
      { id: 'dep-3', nodeId: 'node-c', market: 'VASTAI', status: 'ACTIVE' },
    ]
    const harness = makeHarness(rows)

    const sync = vi.fn(async (_prisma, _registry, id: string) => {
      const row = rows.find((r) => r.id === id)!
      const nextStatus: DeploymentStatus = row.id === 'dep-1' ? 'ACTIVE' : row.status
      return makeUpdatedDeployment({ ...row, costAccumulated: 1.23 }, nextStatus)
    }) as unknown as ExternalStatusTickOverrides['syncDeploymentStatus']

    const summary = await runExternalStatusTick({
      prisma: harness.prisma,
      registry: harness.registry,
      io: harness.io as unknown as Parameters<typeof runExternalStatusTick>[0]['io'],
      overrides: makeOverrides(sync),
    })

    expect(summary).toEqual({ checked: 3, transitioned: 1, errors: 0 })
    expect(harness.io.emit).toHaveBeenCalledTimes(1)
    expect(harness.io.emit).toHaveBeenCalledWith(
      'external:status',
      expect.objectContaining({
        deploymentId: 'dep-1',
        status: 'ACTIVE',
        previousStatus: 'PENDING',
      }),
    )
  })

  it('counts a failing sync and keeps processing the remaining deployments', async () => {
    const rows: DeploymentRow[] = [
      { id: 'dep-1', nodeId: 'node-a', market: 'AKASH', status: 'ACTIVE' },
      { id: 'dep-2', nodeId: 'node-b', market: 'IONET', status: 'ACTIVE' },
      { id: 'dep-3', nodeId: 'node-c', market: 'VASTAI', status: 'ACTIVE' },
    ]
    const harness = makeHarness(rows)

    const sync = vi
      .fn()
      .mockImplementationOnce(async (_prisma, _registry, id: string) =>
        makeUpdatedDeployment(
          { id, nodeId: 'node-a', market: 'AKASH', status: 'ACTIVE' },
          'ACTIVE',
        ),
      )
      .mockImplementationOnce(async () => {
        throw new Error('adapter unreachable')
      })
      .mockImplementationOnce(async (_prisma, _registry, id: string) =>
        makeUpdatedDeployment(
          { id, nodeId: 'node-c', market: 'VASTAI', status: 'ACTIVE' },
          'ACTIVE',
        ),
      ) as unknown as ExternalStatusTickOverrides['syncDeploymentStatus']

    const summary = await runExternalStatusTick({
      prisma: harness.prisma,
      registry: harness.registry,
      io: harness.io as unknown as Parameters<typeof runExternalStatusTick>[0]['io'],
      overrides: makeOverrides(sync),
    })

    expect(summary).toEqual({ checked: 2, transitioned: 0, errors: 1 })
    expect(sync).toHaveBeenCalledTimes(3)
  })

  it('queries only PENDING, ACTIVE, and TERMINATING (ignores TERMINATED and FAILED)', async () => {
    const harness = makeHarness([
      { id: 'dep-1', nodeId: 'node-a', market: 'AKASH', status: 'PENDING' },
      { id: 'dep-2', nodeId: 'node-b', market: 'IONET', status: 'ACTIVE' },
      { id: 'dep-3', nodeId: 'node-c', market: 'VASTAI', status: 'TERMINATING' },
      { id: 'dep-4', nodeId: 'node-d', market: 'AKASH', status: 'TERMINATED' },
      { id: 'dep-5', nodeId: 'node-e', market: 'IONET', status: 'FAILED' },
    ])

    const seenIds: string[] = []
    const sync = vi.fn(async (_prisma, _registry, id: string) => {
      seenIds.push(id)
      return makeUpdatedDeployment(
        { id, nodeId: `node-${id}`, market: 'AKASH', status: 'ACTIVE' },
        'ACTIVE',
      )
    }) as unknown as ExternalStatusTickOverrides['syncDeploymentStatus']

    const summary = await runExternalStatusTick({
      prisma: harness.prisma,
      registry: harness.registry,
      io: harness.io as unknown as Parameters<typeof runExternalStatusTick>[0]['io'],
      overrides: makeOverrides(sync),
    })

    expect(summary.checked).toBe(3)
    expect(seenIds.sort()).toEqual(['dep-1', 'dep-2', 'dep-3'])
    const findMany = harness.prisma.externalDeployment.findMany as unknown as ReturnType<
      typeof vi.fn
    >
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: { in: ['PENDING', 'ACTIVE', 'TERMINATING'] } },
      }),
    )
  })
})
