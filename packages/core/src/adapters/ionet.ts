import type { GpuTier } from '@a2e/shared'
import { GPU_TIER_CONFIG, dailyToHourly } from '@a2e/shared'
import type { ExternalMarketAdapter, MarketRateInfo } from '../rate-provider'

export class IONetAdapter implements ExternalMarketAdapter {
  readonly market = 'IONET' as const
  private enabled: boolean
  private apiEndpoint: string

  constructor(options: { enabled?: boolean; apiEndpoint?: string } = {}) {
    this.enabled = options.enabled ?? (process.env.IONET_ENABLED === 'true')
    this.apiEndpoint = options.apiEndpoint ?? process.env.IONET_API_ENDPOINT ?? ''
  }

  isEnabled(): boolean {
    return this.enabled
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  async getRate(gpuTier: GpuTier): Promise<MarketRateInfo> {
    if (!this.enabled) {
      return {
        ratePerHour: 0,
        ratePerDay: 0,
        available: false,
        fetchedAt: new Date(),
      }
    }

    try {
      const apiPricing = await this.fetchFromApi(gpuTier)
      const pricing = apiPricing ?? this.getEstimatedRate(gpuTier)

      return {
        ratePerHour: pricing.pricePerHour,
        ratePerDay: pricing.pricePerHour * 24,
        available: pricing.available,
        fetchedAt: new Date(),
      }
    } catch (error) {
      console.error('IO.net rate fetch failed:', error)
      return {
        ratePerHour: 0,
        ratePerDay: 0,
        available: false,
        fetchedAt: new Date(),
      }
    }
  }

  private getEstimatedRate(gpuTier: GpuTier): { pricePerHour: number; available: boolean } {
    // IO.net typically offers competitive rates (60-75% of retail)
    const tierConfig = GPU_TIER_CONFIG[gpuTier]
    const estimatedRate = tierConfig.retailRate * 0.70 // ~70% of retail

    return {
      pricePerHour: dailyToHourly(estimatedRate),
      available: true,
    }
  }

  private async fetchFromApi(_gpuTier: GpuTier): Promise<{ pricePerHour: number; available: boolean } | null> {
    if (!this.apiEndpoint) {
      return null
    }

    try {
      const response = await fetch(`${this.apiEndpoint}/v1/gpu-prices`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(5000),
      })

      if (response.ok) {
        const data = await response.json() as { pricePerHour?: number; available?: boolean }
        if (typeof data.pricePerHour === 'number') {
          return {
            pricePerHour: data.pricePerHour,
            available: data.available !== false,
          }
        }
      }
    } catch {
      return null
    }

    return null
  }
}
