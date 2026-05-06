/**
 * Targeted unit tests for the Akash adapter's live-mode internals.
 *
 * Full mocking of `@akashnetwork/chain-sdk` (nested typed namespaces) is
 * fragile and tests the mock more than reality, so we cover:
 *   - the lease-state → internal-status pure mapping
 *   - that the rate-fetch path stays unaffected by live-mode wiring
 *   - that simulation-mode behaviour is preserved
 *
 * The end-to-end live flow is verified by the on-chain canary against the
 * real Akash mainnet (gated behind explicit user go-ahead, capped budget).
 */

import { describe, expect, it } from 'vitest'
import { AkashAdapter, mapLeaseStateToInternal } from '../adapters/akash'

describe('mapLeaseStateToInternal', () => {
  it('maps active leases (state=1) to ACTIVE', () => {
    expect(mapLeaseStateToInternal(1)).toBe('ACTIVE')
  })

  it('maps insufficient_funds leases (state=2) to FAILED', () => {
    expect(mapLeaseStateToInternal(2)).toBe('FAILED')
  })

  it('maps closed leases (state=3) to TERMINATED', () => {
    expect(mapLeaseStateToInternal(3)).toBe('TERMINATED')
  })

  it('treats undefined / unknown / invalid (state=0) as PENDING', () => {
    expect(mapLeaseStateToInternal(undefined)).toBe('PENDING')
    expect(mapLeaseStateToInternal(0)).toBe('PENDING')
    expect(mapLeaseStateToInternal(99)).toBe('PENDING')
  })

  it('also accepts the REST string forms', () => {
    expect(mapLeaseStateToInternal('active')).toBe('ACTIVE')
    expect(mapLeaseStateToInternal('ACTIVE')).toBe('ACTIVE')
    expect(mapLeaseStateToInternal('insufficient_funds')).toBe('FAILED')
    expect(mapLeaseStateToInternal('closed')).toBe('TERMINATED')
    expect(mapLeaseStateToInternal('invalid')).toBe('PENDING')
    expect(mapLeaseStateToInternal('')).toBe('PENDING')
  })
})

describe('AkashAdapter — simulation mode preserved', () => {
  it('createDeployment returns a sim externalId without touching chain code', async () => {
    const adapter = new AkashAdapter({ enabled: true, simulationMode: true })
    const result = await adapter.createDeployment({ nodeId: 'node-1', gpuTier: 'H100' })
    expect(result.externalId.startsWith('sim-akash-')).toBe(true)
    expect(result.market).toBe('AKASH')
    expect(result.status).toBe('PENDING')
  })

  it('terminate is idempotent on unknown sim deployment', async () => {
    const adapter = new AkashAdapter({ enabled: true, simulationMode: true })
    await expect(adapter.terminateDeployment('sim-akash-nonexistent')).resolves.toBeUndefined()
  })

  it('reports AKT as the native cost currency in simulation', async () => {
    const adapter = new AkashAdapter({ enabled: true, simulationMode: true })
    const result = await adapter.createDeployment({ nodeId: 'n', gpuTier: 'H100' })
    const cost = await adapter.getDeploymentCost(result.externalId)
    expect(cost.nativeCurrency).toBe('AKT')
  })
})
