// Akash Network Market Adapter
// Fetches GPU pricing from Akash marketplace

import type { GpuTier } from '@a2e/shared'
import { GPU_TIER_CONFIG, dailyToHourly } from '@a2e/shared'
import type { ExternalMarketAdapter, MarketRateInfo } from '../rate-provider'

interface AkashGpuPricing {
  model: string
  pricePerHour: number
  available: boolean
}

const GPU_TIER_TO_AKASH: Record<GpuTier, string[]> = {
  H100: ['h100', 'nvidia-h100', 'H100 80GB'],
  H200: ['h200', 'nvidia-h200', 'H200'],
  B200: ['b200', 'nvidia-b200', 'B200'],
  B300: ['b300', 'nvidia-b300', 'B300'],
  GB300: ['gb300', 'nvidia-gb300', 'GB300'],
}

export class AkashAdapter implements ExternalMarketAdapter {
  readonly market = 'AKASH' as const
  private enabled: boolean
  private apiEndpoint: string

  constructor(options: { enabled?: boolean; apiEndpoint?: string } = {}) {
    this.enabled = options.enabled ?? (process.env.AKASH_ENABLED === 'true')
    this.apiEndpoint = options.apiEndpoint ?? process.env.AKASH_API_ENDPOINT ?? 'https://api.cloudmos.io'
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
      const pricing = await this.fetchPricing(gpuTier)

      if (!pricing || !pricing.available) {
        return {
          ratePerHour: 0,
          ratePerDay: 0,
          available: false,
          fetchedAt: new Date(),
        }
      }

      return {
        ratePerHour: pricing.pricePerHour,
        ratePerDay: pricing.pricePerHour * 24,
        available: true,
        fetchedAt: new Date(),
      }
    } catch (error) {
      console.error('Akash rate fetch failed:', error)
      return {
        ratePerHour: 0,
        ratePerDay: 0,
        available: false,
        fetchedAt: new Date(),
      }
    }
  }

  private async fetchPricing(gpuTier: GpuTier): Promise<AkashGpuPricing | null> {
    // Try to fetch real rates from Akash/Cloudmos API
    try {
      const response = await fetch(`${this.apiEndpoint}/v1/gpu-prices`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(5000),
      })

      if (response.ok) {
        const data = await response.json()
        return this.findMatchingGpu(data, gpuTier)
      }
    } catch {
      // API not available, fall back to estimated rates
    }

    // Return estimated rates based on market research
    return this.getEstimatedRate(gpuTier)
  }

  private findMatchingGpu(apiData: unknown, gpuTier: GpuTier): AkashGpuPricing | null {
    const targetModels = GPU_TIER_TO_AKASH[gpuTier]

    if (!Array.isArray(apiData)) {
      return null
    }

    for (const item of apiData) {
      if (typeof item !== 'object' || item === null) continue

      const model = (item as Record<string, unknown>).model as string
      const price = (item as Record<string, unknown>).price as number
      const available = (item as Record<string, unknown>).available as boolean

      if (!model || typeof price !== 'number') continue

      const normalizedModel = model.toLowerCase()
      if (targetModels.some((t) => normalizedModel.includes(t.toLowerCase()))) {
        return {
          model,
          pricePerHour: price,
          available: available !== false,
        }
      }
    }

    return null
  }

  private getEstimatedRate(gpuTier: GpuTier): AkashGpuPricing {
    // Estimated Akash rates based on market research (typically 60-80% of retail)
    const tierConfig = GPU_TIER_CONFIG[gpuTier]
    const estimatedRate = tierConfig.retailRate * 0.65 // ~65% of retail

    return {
      model: gpuTier,
      pricePerHour: dailyToHourly(estimatedRate),
      available: true,
    }
  }
}
