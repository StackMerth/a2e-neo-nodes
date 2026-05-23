// Rate Provider Tests
// Tests for market rate fetching and caching

import { describe, it, expect, beforeEach } from 'vitest'
import { DefaultRateProvider, MockMarketAdapter } from '../rate-provider'
import type { GpuTier } from '@a2e/shared'

describe('DefaultRateProvider', () => {
  let rateProvider: DefaultRateProvider
  let akashAdapter: MockMarketAdapter
  let ionetAdapter: MockMarketAdapter
  let vastaiAdapter: MockMarketAdapter

  beforeEach(() => {
    rateProvider = new DefaultRateProvider({ cacheTtlMs: 1000 })
    akashAdapter = new MockMarketAdapter('AKASH', { enabled: true, rateMultiplier: 0.65 })
    ionetAdapter = new MockMarketAdapter('IONET', { enabled: true, rateMultiplier: 0.70 })
    vastaiAdapter = new MockMarketAdapter('VASTAI', { enabled: true, rateMultiplier: 0.55 })
    rateProvider.registerAdapter(akashAdapter)
    rateProvider.registerAdapter(ionetAdapter)
    rateProvider.registerAdapter(vastaiAdapter)
  })

  describe('Internal Rates', () => {
    it('should always return internal rate from config', async () => {
      const rates = await rateProvider.getRates('H100')

      expect(rates.internal.available).toBe(true)
      // H100 retail: $140.15/day
      expect(rates.internal.ratePerDay).toBeCloseTo(140.15, 1)
      expect(rates.internal.ratePerHour).toBeCloseTo(140.15 / 24, 2)
    })

    it('should return correct rates for all GPU tiers', async () => {
      const expectedRates: Record<GpuTier, number> = {
        H100: 140.15,
        H200: 179.85,
        L40S: 21,
        B200: 321.1,
        B300: 431.75,
        GB300: 499.35,
        OTHER: 0, // Custom tier - rate from node config
        // C2 wave 2: consumer tier retail rates from GPU_TIER_CONFIG.
        RTX_4090: 14,
        RTX_3090: 9,
        CONSUMER: 7,
      }

      for (const [tier, expectedRate] of Object.entries(expectedRates)) {
        const rates = await rateProvider.getRates(tier as GpuTier)
        expect(rates.internal.ratePerDay).toBeCloseTo(expectedRate, 1)
      }
    })
  })

  describe('External Market Rates', () => {
    it('should fetch rates from enabled adapters', async () => {
      const rates = await rateProvider.getRates('H100')

      expect(rates.akash.available).toBe(true)
      expect(rates.ionet.available).toBe(true)
      expect(rates.vastai.available).toBe(true)
      expect(rates.akash.ratePerHour).toBeGreaterThan(0)
      expect(rates.ionet.ratePerHour).toBeGreaterThan(0)
      expect(rates.vastai.ratePerHour).toBeGreaterThan(0)
    })

    it('should not fetch rates from disabled adapters', async () => {
      akashAdapter.setEnabled(false)
      rateProvider.refreshRates() // Clear cache

      const rates = await rateProvider.getRates('H100')

      expect(rates.akash.available).toBe(false)
      expect(rates.akash.ratePerHour).toBe(0)
      expect(rates.ionet.available).toBe(true)
      expect(rates.vastai.available).toBe(true)
    })

    it('should return unavailable when all adapters disabled', async () => {
      akashAdapter.setEnabled(false)
      ionetAdapter.setEnabled(false)
      vastaiAdapter.setEnabled(false)
      rateProvider.refreshRates()

      const rates = await rateProvider.getRates('H100')

      expect(rates.akash.available).toBe(false)
      expect(rates.ionet.available).toBe(false)
      expect(rates.vastai.available).toBe(false)
    })
  })

  describe('Caching', () => {
    it('should cache rates for the TTL duration', async () => {
      const rates1 = await rateProvider.getRates('H100')
      const rates2 = await rateProvider.getRates('H100')

      // Both should have the same fetchedAt (from cache)
      expect(rates1.internal.fetchedAt.getTime()).toBe(rates2.internal.fetchedAt.getTime())
    })

    it('should refresh cache after calling refreshRates', async () => {
      const rates1 = await rateProvider.getRates('H100')
      await rateProvider.refreshRates()

      // Small delay to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 10))

      const rates2 = await rateProvider.getRates('H100')

      expect(rates1.internal.fetchedAt.getTime()).toBeLessThan(rates2.internal.fetchedAt.getTime())
    })
  })
})

describe('MockMarketAdapter', () => {
  it('should return rate based on multiplier with variance', async () => {
    const adapter = new MockMarketAdapter('AKASH', { rateMultiplier: 0.5 })

    const rate = await adapter.getRate('H100')

    // 50% of $140.15 = ~$70, but with ±5% variance
    const base = 140.15 * 0.5
    expect(rate.ratePerDay).toBeGreaterThanOrEqual(base * 0.95)
    expect(rate.ratePerDay).toBeLessThanOrEqual(base * 1.05)
    expect(rate.available).toBe(true)
  })

  it('should apply variance to rates', async () => {
    const adapter = new MockMarketAdapter('AKASH', { rateMultiplier: 0.5 })

    const rates: number[] = []
    for (let i = 0; i < 10; i++) {
      const rate = await adapter.getRate('H100')
      rates.push(rate.ratePerDay)
    }

    // Rates should vary within ±5% of base
    const base = 140.15 * 0.5
    const minAllowed = base * 0.95
    const maxAllowed = base * 1.05

    for (const rate of rates) {
      expect(rate).toBeGreaterThanOrEqual(minAllowed)
      expect(rate).toBeLessThanOrEqual(maxAllowed)
    }
  })

  it('should allow enabling/disabling', async () => {
    const adapter = new MockMarketAdapter('AKASH', { enabled: false })

    expect(adapter.isEnabled()).toBe(false)

    adapter.setEnabled(true)
    expect(adapter.isEnabled()).toBe(true)
  })
})
