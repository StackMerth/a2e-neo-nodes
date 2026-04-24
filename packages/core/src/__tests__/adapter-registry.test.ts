// Adapter Registry Tests
// Tests for health tracking and auto-disable behaviour

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AdapterRegistry } from '../adapter-registry'
import { MockMarketAdapter } from '../rate-provider'
import type { AdapterMarket } from '../adapter-registry'
import type { ExternalMarketAdapter, MarketRateInfo } from '../rate-provider'
import type { GpuTier } from '@a2e/shared'

/**
 * Controllable adapter that lets tests decide exactly when getRate succeeds
 * or fails. Useful for probe-loop tests that need to flip the outcome mid-run.
 */
class ControllableAdapter implements ExternalMarketAdapter {
  readonly market: AdapterMarket
  private enabled: boolean
  private shouldFail: boolean
  private failureError: Error

  constructor(market: AdapterMarket, options: { enabled?: boolean; shouldFail?: boolean } = {}) {
    this.market = market
    this.enabled = options.enabled ?? true
    this.shouldFail = options.shouldFail ?? false
    this.failureError = new Error('probe failed')
  }

  isEnabled(): boolean {
    return this.enabled
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  setShouldFail(shouldFail: boolean): void {
    this.shouldFail = shouldFail
  }

  async getRate(_gpuTier: GpuTier): Promise<MarketRateInfo> {
    if (this.shouldFail) {
      throw this.failureError
    }
    return {
      ratePerHour: 1,
      ratePerDay: 24,
      available: true,
      fetchedAt: new Date(),
    }
  }
}

describe('AdapterRegistry', () => {
  describe('Registration', () => {
    it('should register, get, and list adapters', () => {
      const registry = new AdapterRegistry()
      const akash = new MockMarketAdapter('AKASH')
      const ionet = new MockMarketAdapter('IONET')

      registry.register(akash)
      registry.register(ionet)

      expect(registry.get('AKASH')).toBe(akash)
      expect(registry.get('IONET')).toBe(ionet)
      expect(registry.get('VASTAI')).toBeUndefined()

      const list = registry.list()
      expect(list).toHaveLength(2)
      expect(list).toContain(akash)
      expect(list).toContain(ionet)
    })

    it('should replace adapter and reset health when re-registering the same market', () => {
      const registry = new AdapterRegistry({ failureThreshold: 2 })
      const first = new MockMarketAdapter('AKASH')
      registry.register(first)

      registry.recordFailure('AKASH', 'boom')
      expect(registry.getHealth('AKASH')?.failureCount).toBe(1)

      const second = new MockMarketAdapter('AKASH')
      registry.register(second)

      expect(registry.get('AKASH')).toBe(second)
      const health = registry.getHealth('AKASH')
      expect(health?.failureCount).toBe(0)
      expect(health?.lastFailure).toBeNull()
      expect(health?.lastError).toBeNull()
      expect(health?.autoDisabled).toBe(false)
    })

    it('should initialize health with clean state on register', () => {
      const registry = new AdapterRegistry()
      registry.register(new MockMarketAdapter('AKASH'))

      const health = registry.getHealth('AKASH')
      expect(health).toEqual({
        market: 'AKASH',
        healthy: true,
        autoDisabled: false,
        failureCount: 0,
        lastSuccess: null,
        lastFailure: null,
        lastError: null,
      })
    })
  })

  describe('recordSuccess', () => {
    it('should reset failure count and clear lastError', () => {
      const registry = new AdapterRegistry({ failureThreshold: 10 })
      registry.register(new MockMarketAdapter('AKASH'))

      registry.recordFailure('AKASH', new Error('first'))
      registry.recordFailure('AKASH', new Error('second'))
      expect(registry.getHealth('AKASH')?.failureCount).toBe(2)

      registry.recordSuccess('AKASH')

      const health = registry.getHealth('AKASH')
      expect(health?.failureCount).toBe(0)
      expect(health?.lastError).toBeNull()
      expect(health?.lastSuccess).toBeInstanceOf(Date)
    })

    it('should be a no-op for an unregistered market', () => {
      const registry = new AdapterRegistry()
      expect(() => registry.recordSuccess('AKASH')).not.toThrow()
      expect(registry.getHealth('AKASH')).toBeUndefined()
    })
  })

  describe('recordFailure', () => {
    it('should increment count, track timestamp and message', () => {
      const registry = new AdapterRegistry({ failureThreshold: 5 })
      registry.register(new MockMarketAdapter('AKASH'))

      registry.recordFailure('AKASH', new Error('network down'))

      const health = registry.getHealth('AKASH')
      expect(health?.failureCount).toBe(1)
      expect(health?.lastError).toBe('network down')
      expect(health?.lastFailure).toBeInstanceOf(Date)
      expect(health?.autoDisabled).toBe(false)
    })

    it('should accept string errors as well as Error instances', () => {
      const registry = new AdapterRegistry()
      registry.register(new MockMarketAdapter('AKASH'))

      registry.recordFailure('AKASH', 'raw string error')

      expect(registry.getHealth('AKASH')?.lastError).toBe('raw string error')
    })

    it('should auto-disable after failureThreshold consecutive failures', () => {
      const onAutoDisable = vi.fn()
      const registry = new AdapterRegistry({ failureThreshold: 3, onAutoDisable })
      const adapter = new MockMarketAdapter('AKASH')
      registry.register(adapter)

      registry.recordFailure('AKASH', 'one')
      registry.recordFailure('AKASH', 'two')
      expect(onAutoDisable).not.toHaveBeenCalled()
      expect(adapter.isEnabled()).toBe(true)

      registry.recordFailure('AKASH', 'three')

      expect(onAutoDisable).toHaveBeenCalledTimes(1)
      expect(onAutoDisable).toHaveBeenCalledWith(
        'AKASH',
        expect.objectContaining({ market: 'AKASH', autoDisabled: true, failureCount: 3 }),
      )
      expect(adapter.isEnabled()).toBe(false)
      expect(registry.getHealth('AKASH')?.autoDisabled).toBe(true)
    })

    it('should not fire onAutoDisable again after subsequent failures', () => {
      const onAutoDisable = vi.fn()
      const registry = new AdapterRegistry({ failureThreshold: 2, onAutoDisable })
      registry.register(new MockMarketAdapter('AKASH'))

      registry.recordFailure('AKASH', 'one')
      registry.recordFailure('AKASH', 'two')
      expect(onAutoDisable).toHaveBeenCalledTimes(1)

      registry.recordFailure('AKASH', 'three')
      registry.recordFailure('AKASH', 'four')

      expect(onAutoDisable).toHaveBeenCalledTimes(1)
      // failure count should stay at threshold, not climb
      expect(registry.getHealth('AKASH')?.failureCount).toBe(2)
    })

    it('should update lastFailure/lastError even while already auto-disabled', () => {
      const registry = new AdapterRegistry({ failureThreshold: 1 })
      registry.register(new MockMarketAdapter('AKASH'))

      registry.recordFailure('AKASH', 'initial')
      const firstFailureAt = registry.getHealth('AKASH')?.lastFailure

      // Wait a tick so the timestamp differs
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          registry.recordFailure('AKASH', 'later')
          const health = registry.getHealth('AKASH')
          expect(health?.lastError).toBe('later')
          expect(health?.lastFailure).toBeInstanceOf(Date)
          if (firstFailureAt) {
            expect(health!.lastFailure!.getTime()).toBeGreaterThanOrEqual(firstFailureAt.getTime())
          }
          resolve()
        }, 5)
      })
    })

    it('should be a no-op for an unregistered market', () => {
      const registry = new AdapterRegistry()
      expect(() => registry.recordFailure('AKASH', 'oops')).not.toThrow()
    })
  })

  describe('auto-enable on recovery', () => {
    it('should call onAutoEnable exactly once and re-enable adapter on first success after auto-disable', () => {
      const onAutoEnable = vi.fn()
      const registry = new AdapterRegistry({ failureThreshold: 2, onAutoEnable })
      const adapter = new MockMarketAdapter('AKASH')
      registry.register(adapter)

      registry.recordFailure('AKASH', 'one')
      registry.recordFailure('AKASH', 'two')
      expect(adapter.isEnabled()).toBe(false)
      expect(registry.getHealth('AKASH')?.autoDisabled).toBe(true)

      registry.recordSuccess('AKASH')

      expect(onAutoEnable).toHaveBeenCalledTimes(1)
      expect(onAutoEnable).toHaveBeenCalledWith(
        'AKASH',
        expect.objectContaining({ market: 'AKASH', autoDisabled: false, failureCount: 0 }),
      )
      expect(adapter.isEnabled()).toBe(true)
      expect(registry.getHealth('AKASH')?.autoDisabled).toBe(false)

      // Subsequent successes should not fire onAutoEnable again.
      registry.recordSuccess('AKASH')
      expect(onAutoEnable).toHaveBeenCalledTimes(1)
    })

    it('should not fire onAutoEnable on success when not previously auto-disabled', () => {
      const onAutoEnable = vi.fn()
      const registry = new AdapterRegistry({ onAutoEnable })
      registry.register(new MockMarketAdapter('AKASH'))

      registry.recordSuccess('AKASH')

      expect(onAutoEnable).not.toHaveBeenCalled()
    })
  })

  describe('isAvailable', () => {
    it('should return false for an unregistered market', () => {
      const registry = new AdapterRegistry()
      expect(registry.isAvailable('AKASH')).toBe(false)
    })

    it('should return false when adapter is disabled', () => {
      const registry = new AdapterRegistry()
      const adapter = new MockMarketAdapter('AKASH', { enabled: false })
      registry.register(adapter)

      expect(registry.isAvailable('AKASH')).toBe(false)
    })

    it('should return false when auto-disabled', () => {
      const registry = new AdapterRegistry({ failureThreshold: 1 })
      registry.register(new MockMarketAdapter('AKASH'))

      registry.recordFailure('AKASH', 'boom')

      expect(registry.isAvailable('AKASH')).toBe(false)
    })

    it('should return true when registered, enabled, and not auto-disabled', () => {
      const registry = new AdapterRegistry()
      registry.register(new MockMarketAdapter('AKASH', { enabled: true }))

      expect(registry.isAvailable('AKASH')).toBe(true)
    })
  })

  describe('probe loop', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('should re-enable a recovering adapter on the next probe tick', async () => {
      const onAutoEnable = vi.fn()
      const registry = new AdapterRegistry({
        failureThreshold: 1,
        probeIntervalMs: 60_000,
        onAutoEnable,
      })
      const adapter = new ControllableAdapter('AKASH', { enabled: true, shouldFail: true })
      registry.register(adapter)

      // Trip auto-disable
      registry.recordFailure('AKASH', 'initial outage')
      expect(registry.getHealth('AKASH')?.autoDisabled).toBe(true)
      expect(adapter.isEnabled()).toBe(false)

      registry.start()

      // Adapter recovers
      adapter.setShouldFail(false)

      await vi.advanceTimersByTimeAsync(60_000)

      expect(onAutoEnable).toHaveBeenCalledTimes(1)
      expect(registry.getHealth('AKASH')?.autoDisabled).toBe(false)
      expect(adapter.isEnabled()).toBe(true)

      registry.stop()
    })

    it('should keep adapter auto-disabled and not fire onAutoEnable while probe still fails', async () => {
      const onAutoEnable = vi.fn()
      const registry = new AdapterRegistry({
        failureThreshold: 1,
        probeIntervalMs: 30_000,
        onAutoEnable,
      })
      const adapter = new ControllableAdapter('AKASH', { enabled: true, shouldFail: true })
      registry.register(adapter)

      registry.recordFailure('AKASH', 'outage')
      registry.start()

      await vi.advanceTimersByTimeAsync(30_000)
      await vi.advanceTimersByTimeAsync(30_000)

      expect(onAutoEnable).not.toHaveBeenCalled()
      expect(registry.getHealth('AKASH')?.autoDisabled).toBe(true)
      // Still clamped at threshold
      expect(registry.getHealth('AKASH')?.failureCount).toBe(1)

      registry.stop()
    })

    it('stop() should clear the timer so no further probes fire', async () => {
      const registry = new AdapterRegistry({
        failureThreshold: 1,
        probeIntervalMs: 10_000,
      })
      const adapter = new ControllableAdapter('AKASH', { enabled: true, shouldFail: true })
      const probeSpy = vi.spyOn(adapter, 'getRate')
      registry.register(adapter)

      registry.recordFailure('AKASH', 'outage')
      registry.start()

      await vi.advanceTimersByTimeAsync(10_000)
      const callsAfterFirstTick = probeSpy.mock.calls.length
      expect(callsAfterFirstTick).toBeGreaterThan(0)

      registry.stop()

      await vi.advanceTimersByTimeAsync(60_000)

      expect(probeSpy.mock.calls.length).toBe(callsAfterFirstTick)
    })

    it('start() should be idempotent - calling twice does not double the probe rate', async () => {
      const registry = new AdapterRegistry({
        failureThreshold: 1,
        probeIntervalMs: 10_000,
      })
      const adapter = new ControllableAdapter('AKASH', { enabled: true, shouldFail: true })
      const probeSpy = vi.spyOn(adapter, 'getRate')
      registry.register(adapter)

      registry.recordFailure('AKASH', 'outage')
      registry.start()
      registry.start() // second call should be a no-op

      await vi.advanceTimersByTimeAsync(10_000)

      expect(probeSpy.mock.calls.length).toBe(1)

      registry.stop()
    })

    it('stop() should be a no-op when never started', () => {
      const registry = new AdapterRegistry()
      expect(() => registry.stop()).not.toThrow()
    })
  })

  describe('getAllHealth', () => {
    it('should return health for every registered adapter', () => {
      const registry = new AdapterRegistry()
      registry.register(new MockMarketAdapter('AKASH'))
      registry.register(new MockMarketAdapter('IONET'))
      registry.register(new MockMarketAdapter('VASTAI'))

      const all = registry.getAllHealth()

      expect(all).toHaveLength(3)
      const markets = all.map((h) => h.market).sort()
      expect(markets).toEqual(['AKASH', 'IONET', 'VASTAI'])
    })

    it('should return an empty array when nothing is registered', () => {
      const registry = new AdapterRegistry()
      expect(registry.getAllHealth()).toEqual([])
    })
  })

  describe('health object immutability', () => {
    it('getHealth should return a cloned object that cannot mutate internal state', () => {
      const registry = new AdapterRegistry({ failureThreshold: 5 })
      registry.register(new MockMarketAdapter('AKASH'))
      registry.recordFailure('AKASH', 'boom')

      const snapshot = registry.getHealth('AKASH')
      expect(snapshot).toBeDefined()

      // Mutate the returned object
      snapshot!.failureCount = 999
      snapshot!.autoDisabled = true
      snapshot!.lastError = 'mutated'
      if (snapshot!.lastFailure) {
        snapshot!.lastFailure.setTime(0)
      }

      // Internal state must be unaffected
      const fresh = registry.getHealth('AKASH')
      expect(fresh?.failureCount).toBe(1)
      expect(fresh?.autoDisabled).toBe(false)
      expect(fresh?.lastError).toBe('boom')
      expect(fresh?.lastFailure?.getTime()).not.toBe(0)
    })

    it('getAllHealth should return independently cloned objects', () => {
      const registry = new AdapterRegistry()
      registry.register(new MockMarketAdapter('AKASH'))
      registry.recordSuccess('AKASH')

      const all = registry.getAllHealth()
      const snapshot = all[0]!
      snapshot.failureCount = 42
      if (snapshot.lastSuccess) {
        snapshot.lastSuccess.setTime(0)
      }

      const fresh = registry.getHealth('AKASH')
      expect(fresh?.failureCount).toBe(0)
      expect(fresh?.lastSuccess?.getTime()).not.toBe(0)
    })
  })
})
