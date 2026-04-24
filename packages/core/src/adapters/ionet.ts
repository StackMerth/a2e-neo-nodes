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

export class IONetAdapter implements ExternalMarketAdapter {
  readonly market = 'IONET' as const
  private enabled: boolean
  private apiEndpoint: string
  private readonly simulationMode: boolean
  private readonly store: SimulationStore | null

  constructor(
    options: { enabled?: boolean; apiEndpoint?: string; simulationMode?: boolean } = {}
  ) {
    this.enabled = options.enabled ?? (process.env.IONET_ENABLED === 'true')
    this.apiEndpoint = options.apiEndpoint ?? process.env.IONET_API_ENDPOINT ?? ''
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
      console.error('IO.net rate fetch failed:', error)
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
      throw new Error('IO.net live mode not implemented — credentials pending')
    }

    const rate = await this.getRate(input.gpuTier)
    if (!rate.available || rate.ratePerHour <= 0) {
      throw new Error(`IO.net: rate unavailable for tier ${input.gpuTier}`)
    }

    const externalId = `sim-ionet-${randomUUID()}`
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
      throw new Error('IO.net live mode not implemented — credentials pending')
    }

    const state = this.store.tick(externalId)
    if (!state) {
      throw new Error(`IO.net: unknown deployment ${externalId}`)
    }

    return {
      externalId,
      status: state.status,
      message: `simulation status: ${state.status.toLowerCase()}`,
    }
  }

  async terminateDeployment(externalId: string): Promise<void> {
    if (!this.simulationMode || !this.store) {
      throw new Error('IO.net live mode not implemented — credentials pending')
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
      throw new Error('IO.net live mode not implemented — credentials pending')
    }

    const state = this.store.get(externalId)
    if (!state) {
      throw new Error(`IO.net: unknown deployment ${externalId}`)
    }
    return state.logs.join('\n')
  }

  async getDeploymentCost(externalId: string): Promise<DeploymentCostResult> {
    if (!this.simulationMode || !this.store) {
      throw new Error('IO.net live mode not implemented — credentials pending')
    }

    const state = this.store.get(externalId)
    if (!state) {
      throw new Error(`IO.net: unknown deployment ${externalId}`)
    }

    const accumulatedUsd = this.store.computeAccumulatedUsd(externalId)
    return {
      accumulatedUsd,
      nativeAmount: accumulatedUsd,
      nativeCurrency: 'CREDITS',
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
