// Rate Provider
// Fetches and caches rates from internal config and external markets

import type { GpuTier } from '@a2e/shared'
import { GPU_TIER_CONFIG, dailyToHourly } from '@a2e/shared'

export interface MarketRateInfo {
  ratePerHour: number
  ratePerDay: number
  available: boolean
  fetchedAt: Date
}

export interface MarketRates {
  internal: MarketRateInfo
  akash: MarketRateInfo
  ionet: MarketRateInfo
}

export interface RateProvider {
  getRates(gpuTier: GpuTier): Promise<MarketRates>
  refreshRates(): Promise<void>
}

export interface ExternalMarketAdapter {
  market: 'AKASH' | 'IONET'
  getRate(gpuTier: GpuTier): Promise<MarketRateInfo>
  isEnabled(): boolean
}

/**
 * Default rate provider implementation
 * Uses internal config for retail rates and adapters for external markets
 */
export class DefaultRateProvider implements RateProvider {
  private adapters: Map<string, ExternalMarketAdapter> = new Map()
  private cache: Map<string, { rates: MarketRates; expiresAt: Date }> = new Map()
  private cacheTtlMs: number

  constructor(options: { cacheTtlMs?: number } = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? 60_000 // Default 60 second cache
  }

  registerAdapter(adapter: ExternalMarketAdapter): void {
    this.adapters.set(adapter.market, adapter)
  }

  async getRates(gpuTier: GpuTier): Promise<MarketRates> {
    const cacheKey = gpuTier
    const cached = this.cache.get(cacheKey)

    if (cached && cached.expiresAt > new Date()) {
      return cached.rates
    }

    const rates = await this.fetchRates(gpuTier)

    this.cache.set(cacheKey, {
      rates,
      expiresAt: new Date(Date.now() + this.cacheTtlMs),
    })

    return rates
  }

  async refreshRates(): Promise<void> {
    this.cache.clear()
  }

  private async fetchRates(gpuTier: GpuTier): Promise<MarketRates> {
    const tierConfig = GPU_TIER_CONFIG[gpuTier]
    const now = new Date()

    // Internal rate is always the retail rate from config
    const internal: MarketRateInfo = {
      ratePerHour: dailyToHourly(tierConfig.retailRate),
      ratePerDay: tierConfig.retailRate,
      available: true,
      fetchedAt: now,
    }

    // Fetch external rates from adapters
    const akashAdapter = this.adapters.get('AKASH')
    const ionetAdapter = this.adapters.get('IONET')

    let akash: MarketRateInfo = {
      ratePerHour: 0,
      ratePerDay: 0,
      available: false,
      fetchedAt: now,
    }

    let ionet: MarketRateInfo = {
      ratePerHour: 0,
      ratePerDay: 0,
      available: false,
      fetchedAt: now,
    }

    if (akashAdapter?.isEnabled()) {
      try {
        akash = await akashAdapter.getRate(gpuTier)
      } catch (error) {
        console.error('Failed to fetch Akash rates:', error)
      }
    }

    if (ionetAdapter?.isEnabled()) {
      try {
        ionet = await ionetAdapter.getRate(gpuTier)
      } catch (error) {
        console.error('Failed to fetch IO.net rates:', error)
      }
    }

    return { internal, akash, ionet }
  }
}

/**
 * Mock adapter for testing
 */
export class MockMarketAdapter implements ExternalMarketAdapter {
  market: 'AKASH' | 'IONET'
  private enabled: boolean
  private rateMultiplier: number

  constructor(market: 'AKASH' | 'IONET', options: { enabled?: boolean; rateMultiplier?: number } = {}) {
    this.market = market
    this.enabled = options.enabled ?? true
    this.rateMultiplier = options.rateMultiplier ?? 0.7 // Default to 70% of retail
  }

  isEnabled(): boolean {
    return this.enabled
  }

  async getRate(gpuTier: GpuTier): Promise<MarketRateInfo> {
    const tierConfig = GPU_TIER_CONFIG[gpuTier]
    const ratePerDay = tierConfig.retailRate * this.rateMultiplier

    // Add some randomness for realistic simulation
    const variance = (Math.random() - 0.5) * 0.1 // ±5% variance
    const adjustedRate = ratePerDay * (1 + variance)

    return {
      ratePerHour: dailyToHourly(adjustedRate),
      ratePerDay: adjustedRate,
      available: true,
      fetchedAt: new Date(),
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  setRateMultiplier(multiplier: number): void {
    this.rateMultiplier = multiplier
  }
}
