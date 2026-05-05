// Adapter deployment lifecycle tests (F1.2)
// Exercises the simulation-mode behaviour shared by Akash, IO.net, Vast.ai.
//
// These tests avoid network I/O entirely by passing simulationMode: true and
// letting the adapter's getRate fallback to its estimated-rate path.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AkashAdapter } from '../adapters/akash'
import { IONetAdapter } from '../adapters/ionet'
import { VastAiAdapter } from '../adapters/vastai'
import type { ExternalMarketAdapter } from '../rate-provider'

// Avoid live-network calls during getRate fallback — return a stable shape so
// each adapter sees its estimated rate deterministically.
function stubOfflineFetch(): void {
  globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof globalThis.fetch
}

type AdapterCase = {
  name: string
  make: () => ExternalMarketAdapter
  expectedMarket: 'AKASH' | 'IONET' | 'VASTAI'
  expectedNativeCurrency: 'AKT' | 'CREDITS' | 'USD'
}

const CASES: AdapterCase[] = [
  {
    name: 'AkashAdapter',
    make: () => new AkashAdapter({ enabled: true, simulationMode: true }),
    expectedMarket: 'AKASH',
    expectedNativeCurrency: 'AKT',
  },
  {
    name: 'IONetAdapter',
    make: () => new IONetAdapter({ enabled: true, simulationMode: true }),
    expectedMarket: 'IONET',
    expectedNativeCurrency: 'CREDITS',
  },
  {
    name: 'VastAiAdapter',
    make: () => new VastAiAdapter({ enabled: true, simulationMode: true }),
    expectedMarket: 'VASTAI',
    expectedNativeCurrency: 'USD',
  },
]

describe.each(CASES)('$name deployment methods (simulation)', ({ make, expectedMarket, expectedNativeCurrency }) => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    stubOfflineFetch()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('createDeployment returns PENDING with a market-prefixed externalId', async () => {
    const adapter = make()
    const result = await adapter.createDeployment({ nodeId: 'node-abc', gpuTier: 'H100' })

    expect(result.status).toBe('PENDING')
    expect(result.market).toBe(expectedMarket)
    expect(result.estimatedRatePerHour).toBeGreaterThan(0)
    expect(result.externalId).toMatch(new RegExp(`^sim-${expectedMarket.toLowerCase()}-`))
  })

  it('status transitions PENDING -> ACTIVE after the activation delay', async () => {
    const adapter = make()
    const created = await adapter.createDeployment({ nodeId: 'node-abc', gpuTier: 'H100' })

    const first = await adapter.getDeploymentStatus(created.externalId)
    expect(first.status).toBe('PENDING')

    vi.advanceTimersByTime(3000)
    const second = await adapter.getDeploymentStatus(created.externalId)
    expect(second.status).toBe('ACTIVE')
  })

  it('cost accrues over time once ACTIVE and stops after termination', async () => {
    const adapter = make()
    const created = await adapter.createDeployment({ nodeId: 'node-abc', gpuTier: 'H100' })

    // Advance past activation + 1h
    vi.advanceTimersByTime(3000)
    await adapter.getDeploymentStatus(created.externalId)
    vi.advanceTimersByTime(60 * 60 * 1000)

    const costHour1 = await adapter.getDeploymentCost(created.externalId)
    expect(costHour1.accumulatedUsd).toBeGreaterThan(0)
    expect(costHour1.accumulatedUsd).toBeCloseTo(created.estimatedRatePerHour, 4)
    expect(costHour1.nativeCurrency).toBe(expectedNativeCurrency)
    expect(costHour1.nativeAmount).toBeGreaterThan(0)

    await adapter.terminateDeployment(created.externalId)
    const costAtTerm = await adapter.getDeploymentCost(created.externalId)

    vi.advanceTimersByTime(60 * 60 * 1000)
    const costLater = await adapter.getDeploymentCost(created.externalId)

    expect(costLater.accumulatedUsd).toBeCloseTo(costAtTerm.accumulatedUsd, 4)
  })

  it('terminateDeployment is idempotent and ignores unknown ids', async () => {
    const adapter = make()
    await expect(adapter.terminateDeployment('sim-unknown-xyz')).resolves.toBeUndefined()

    const created = await adapter.createDeployment({ nodeId: 'n', gpuTier: 'H100' })
    await adapter.terminateDeployment(created.externalId)
    await expect(adapter.terminateDeployment(created.externalId)).resolves.toBeUndefined()

    const status = await adapter.getDeploymentStatus(created.externalId)
    expect(status.status).toBe('TERMINATED')
  })

  it('getDeploymentLogs concatenates appended lines', async () => {
    const adapter = make()
    const created = await adapter.createDeployment({ nodeId: 'node-logs', gpuTier: 'H100' })

    const initialLogs = await adapter.getDeploymentLogs(created.externalId)
    expect(initialLogs).toContain('deployment created for node-logs')

    await adapter.terminateDeployment(created.externalId)
    const logs = await adapter.getDeploymentLogs(created.externalId)

    expect(logs.split('\n').length).toBeGreaterThanOrEqual(2)
    expect(logs).toContain('[sim] terminated')
  })

  it('unknown deployment ids cause status/logs/cost to throw', async () => {
    const adapter = make()
    await expect(adapter.getDeploymentStatus('sim-unknown')).rejects.toThrow()
    await expect(adapter.getDeploymentLogs('sim-unknown')).rejects.toThrow()
    await expect(adapter.getDeploymentCost('sim-unknown')).rejects.toThrow()
  })
})

describe('live mode (simulation disabled)', () => {
  it('Akash and IO.net still throw the credentials-pending placeholder', async () => {
    const stillStubbed: ExternalMarketAdapter[] = [
      new AkashAdapter({ enabled: true, simulationMode: false }),
      new IONetAdapter({ enabled: true, simulationMode: false }),
    ]

    for (const adapter of stillStubbed) {
      await expect(adapter.createDeployment({ nodeId: 'n', gpuTier: 'H100' })).rejects.toThrow(/live mode not implemented/)
      await expect(adapter.getDeploymentStatus('any')).rejects.toThrow(/live mode not implemented/)
      await expect(adapter.terminateDeployment('any')).rejects.toThrow(/live mode not implemented/)
      await expect(adapter.getDeploymentLogs('any')).rejects.toThrow(/live mode not implemented/)
      await expect(adapter.getDeploymentCost('any')).rejects.toThrow(/live mode not implemented/)
    }
  })

  it('Vast.ai live mode requires an API key and routes through the API path', async () => {
    const adapter = new VastAiAdapter({ enabled: true, simulationMode: false })

    // No api key configured → required-credentials guard kicks in for every
    // method that would otherwise hit the live API.
    await expect(adapter.createDeployment({ nodeId: 'n', gpuTier: 'H100' })).rejects.toThrow(/VASTAI_API_KEY/)
    await expect(adapter.getDeploymentStatus('any')).rejects.toThrow(/VASTAI_API_KEY/)
    await expect(adapter.terminateDeployment('any')).rejects.toThrow(/VASTAI_API_KEY/)
    await expect(adapter.getDeploymentLogs('any')).rejects.toThrow(/VASTAI_API_KEY/)
    await expect(adapter.getDeploymentCost('any')).rejects.toThrow(/VASTAI_API_KEY/)
  })
})
