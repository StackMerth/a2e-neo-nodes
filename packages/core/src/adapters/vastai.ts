import { randomUUID } from 'node:crypto'
import type { GpuTier } from '@a2e/shared'
import { GPU_TIER_CONFIG, dailyToHourly } from '@a2e/shared'
import type {
  CreateDeploymentInput,
  CreateDeploymentResult,
  DeploymentCostResult,
  DeploymentStatusResult,
  ExternalMarketAdapter,
  MarketRateInfo,
} from '../rate-provider'
import { isSimulationMode } from '../external-simulation-config'
import { SimulationStore } from './simulation'

interface VastAiOffer {
  gpu_name?: string
  dph_total?: number
  num_gpus?: number
  verified?: boolean
  rentable?: boolean
}

interface VastAiBundlesResponse {
  offers?: VastAiOffer[]
}

const GPU_TIER_TO_VASTAI: Record<GpuTier, string[]> = {
  H100: ['H100', 'H100 SXM', 'H100 PCIE'],
  H200: ['H200'],
  B200: ['B200'],
  B300: ['B300'],
  GB300: ['GB300'],
  OTHER: [], // Custom GPUs - no direct Vast.ai mapping, use estimated rates
}

export class VastAiAdapter implements ExternalMarketAdapter {
  readonly market = 'VASTAI' as const
  private enabled: boolean
  private apiEndpoint: string
  private apiKey: string | undefined
  private readonly simulationMode: boolean
  private readonly store: SimulationStore | null

  constructor(
    options: {
      enabled?: boolean
      apiEndpoint?: string
      apiKey?: string
      simulationMode?: boolean
    } = {}
  ) {
    this.enabled = options.enabled ?? (process.env.VASTAI_ENABLED === 'true')
    this.apiEndpoint = options.apiEndpoint ?? process.env.VASTAI_API_ENDPOINT ?? 'https://console.vast.ai/api/v0'
    this.apiKey = options.apiKey ?? process.env.VASTAI_API_KEY
    this.simulationMode = options.simulationMode ?? isSimulationMode()
    this.store = this.simulationMode ? new SimulationStore() : null
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
      console.error('Vast.ai rate fetch failed:', error)
      return {
        ratePerHour: 0,
        ratePerDay: 0,
        available: false,
        fetchedAt: new Date(),
      }
    }
  }

  async createDeployment(input: CreateDeploymentInput): Promise<CreateDeploymentResult> {
    if (!this.simulationMode || !this.store) {
      throw new Error('Vast.ai live mode not implemented — credentials pending')
    }

    const rate = await this.getRate(input.gpuTier)
    if (!rate.available || rate.ratePerHour <= 0) {
      throw new Error(`Vast.ai: rate unavailable for tier ${input.gpuTier}`)
    }

    const externalId = `sim-vastai-${randomUUID()}`
    this.store.create({
      externalId,
      market: this.market,
      nodeId: input.nodeId,
      gpuTier: input.gpuTier,
      ratePerHour: rate.ratePerHour,
    })
    this.store.appendLog(externalId, `[sim] deployment created for ${input.nodeId}`)

    return {
      externalId,
      status: 'PENDING',
      estimatedRatePerHour: rate.ratePerHour,
      market: this.market,
    }
  }

  async getDeploymentStatus(externalId: string): Promise<DeploymentStatusResult> {
    if (!this.simulationMode || !this.store) {
      throw new Error('Vast.ai live mode not implemented — credentials pending')
    }

    const state = this.store.tick(externalId)
    if (!state) {
      throw new Error(`Vast.ai: unknown deployment ${externalId}`)
    }

    return {
      externalId,
      status: state.status,
      message: `simulation status: ${state.status.toLowerCase()}`,
    }
  }

  async terminateDeployment(externalId: string): Promise<void> {
    if (!this.simulationMode || !this.store) {
      throw new Error('Vast.ai live mode not implemented — credentials pending')
    }

    const existing = this.store.get(externalId)
    if (!existing) {
      return
    }
    this.store.terminate(externalId)
    this.store.appendLog(externalId, '[sim] terminated')
  }

  async getDeploymentLogs(externalId: string): Promise<string> {
    if (!this.simulationMode || !this.store) {
      throw new Error('Vast.ai live mode not implemented — credentials pending')
    }

    const state = this.store.get(externalId)
    if (!state) {
      throw new Error(`Vast.ai: unknown deployment ${externalId}`)
    }
    return state.logs.join('\n')
  }

  async getDeploymentCost(externalId: string): Promise<DeploymentCostResult> {
    if (!this.simulationMode || !this.store) {
      throw new Error('Vast.ai live mode not implemented — credentials pending')
    }

    const state = this.store.get(externalId)
    if (!state) {
      throw new Error(`Vast.ai: unknown deployment ${externalId}`)
    }

    const accumulatedUsd = this.store.computeAccumulatedUsd(externalId)
    return {
      accumulatedUsd,
      nativeAmount: accumulatedUsd,
      nativeCurrency: 'USD',
    }
  }

  private async fetchFromApi(gpuTier: GpuTier): Promise<{ pricePerHour: number; available: boolean } | null> {
    const targetModels = GPU_TIER_TO_VASTAI[gpuTier]

    if (targetModels.length === 0) {
      return null
    }

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }

      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`
      }

      // Use first target model as the search pattern (Vast.ai supports SQL-like LIKE)
      const searchPattern = `${targetModels[0]}%`

      const response = await fetch(`${this.apiEndpoint}/bundles/`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          q: {
            gpu_name: { like: searchPattern },
            verified: { eq: true },
            rentable: { eq: true },
          },
          limit: 10,
        }),
        signal: AbortSignal.timeout(5000),
      })

      if (!response.ok) {
        return null
      }

      const data = (await response.json()) as VastAiBundlesResponse
      return this.computeMedianRate(data, targetModels)
    } catch {
      return null
    }
  }

  private computeMedianRate(
    data: VastAiBundlesResponse,
    targetModels: string[]
  ): { pricePerHour: number; available: boolean } | null {
    if (!data.offers || !Array.isArray(data.offers) || data.offers.length === 0) {
      return null
    }

    const normalizedTargets = targetModels.map((m) => m.toLowerCase())
    const perGpuRates: number[] = []

    for (const offer of data.offers) {
      if (!offer.gpu_name || typeof offer.dph_total !== 'number') continue
      if (!offer.num_gpus || offer.num_gpus <= 0) continue

      const normalizedName = offer.gpu_name.toLowerCase()
      if (!normalizedTargets.some((t) => normalizedName.includes(t))) continue

      const perGpuRate = offer.dph_total / offer.num_gpus
      if (perGpuRate > 0) {
        perGpuRates.push(perGpuRate)
      }
    }

    if (perGpuRates.length === 0) {
      return null
    }

    perGpuRates.sort((a, b) => a - b)
    const mid = Math.floor(perGpuRates.length / 2)
    const median =
      perGpuRates.length % 2 === 0
        ? (perGpuRates[mid - 1]! + perGpuRates[mid]!) / 2
        : perGpuRates[mid]!

    return {
      pricePerHour: median,
      available: true,
    }
  }

  private getEstimatedRate(gpuTier: GpuTier): { pricePerHour: number; available: boolean } {
    // Vast.ai typically offers the cheapest rates (~55% of retail)
    const tierConfig = GPU_TIER_CONFIG[gpuTier]
    const estimatedRate = tierConfig.retailRate * 0.55

    return {
      pricePerHour: dailyToHourly(estimatedRate),
      available: true,
    }
  }
}
