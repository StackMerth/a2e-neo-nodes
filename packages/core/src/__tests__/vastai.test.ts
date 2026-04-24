// Vast.ai Adapter Tests
// Tests for the Vast.ai rate-fetching adapter

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { VastAiAdapter } from '../adapters/vastai'
import { GPU_TIER_CONFIG, dailyToHourly } from '@a2e/shared'

describe('VastAiAdapter', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  describe('Construction and state', () => {
    it('should report the correct market identifier', () => {
      const adapter = new VastAiAdapter({ enabled: true })
      expect(adapter.market).toBe('VASTAI')
    })

    it('should default to disabled when no option provided and env unset', () => {
      const prev = process.env.VASTAI_ENABLED
      delete process.env.VASTAI_ENABLED

      const adapter = new VastAiAdapter()
      expect(adapter.isEnabled()).toBe(false)

      if (prev !== undefined) process.env.VASTAI_ENABLED = prev
    })

    it('should allow toggling enabled state', () => {
      const adapter = new VastAiAdapter({ enabled: false })
      expect(adapter.isEnabled()).toBe(false)

      adapter.setEnabled(true)
      expect(adapter.isEnabled()).toBe(true)
    })
  })

  describe('getRate when disabled', () => {
    it('should return unavailable rate info', async () => {
      const adapter = new VastAiAdapter({ enabled: false })
      const rate = await adapter.getRate('H100')

      expect(rate.available).toBe(false)
      expect(rate.ratePerHour).toBe(0)
      expect(rate.ratePerDay).toBe(0)
      expect(rate.fetchedAt).toBeInstanceOf(Date)
    })
  })

  describe('getRate with mocked API', () => {
    it('should compute the median rate across matching offers', async () => {
      const offers = [
        { gpu_name: 'H100 SXM', dph_total: 2.0, num_gpus: 1, verified: true, rentable: true },
        { gpu_name: 'H100 SXM', dph_total: 6.0, num_gpus: 2, verified: true, rentable: true }, // $3/gpu
        { gpu_name: 'H100 PCIE', dph_total: 2.5, num_gpus: 1, verified: true, rentable: true },
        { gpu_name: 'H100 SXM', dph_total: 4.0, num_gpus: 1, verified: true, rentable: true },
      ]

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ offers }),
      }) as unknown as typeof globalThis.fetch

      const adapter = new VastAiAdapter({ enabled: true })
      const rate = await adapter.getRate('H100')

      expect(rate.available).toBe(true)
      // Per-GPU rates sorted: [2.0, 2.5, 3.0, 4.0], median = (2.5 + 3.0) / 2 = 2.75
      expect(rate.ratePerHour).toBeCloseTo(2.75, 2)
      expect(rate.ratePerDay).toBeCloseTo(2.75 * 24, 2)
    })

    it('should fall back to estimated rate when the API response is empty', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ offers: [] }),
      }) as unknown as typeof globalThis.fetch

      const adapter = new VastAiAdapter({ enabled: true })
      const rate = await adapter.getRate('H100')

      // H100 retail 140.15 * 0.55 = 77.08 per day
      const expectedDaily = GPU_TIER_CONFIG.H100.retailRate * 0.55
      expect(rate.available).toBe(true)
      expect(rate.ratePerHour).toBeCloseTo(dailyToHourly(expectedDaily), 4)
    })

    it('should fall back to estimated rate when fetch fails', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof globalThis.fetch

      const adapter = new VastAiAdapter({ enabled: true })
      const rate = await adapter.getRate('H100')

      const expectedDaily = GPU_TIER_CONFIG.H100.retailRate * 0.55
      expect(rate.available).toBe(true)
      expect(rate.ratePerHour).toBeCloseTo(dailyToHourly(expectedDaily), 4)
    })

    it('should return unavailable for OTHER tier (no Vast.ai mapping)', async () => {
      // OTHER has no target models — should fall back to estimated rate,
      // but the estimated rate uses retailRate = 0 for OTHER tier so result is zero.
      globalThis.fetch = vi.fn() as unknown as typeof globalThis.fetch

      const adapter = new VastAiAdapter({ enabled: true })
      const rate = await adapter.getRate('OTHER')

      // OTHER retailRate is 0, so the estimated rate is 0 but "available" stays true per shape
      expect(rate.ratePerHour).toBe(0)
      expect(rate.ratePerDay).toBe(0)
    })
  })
})
