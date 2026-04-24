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
  OTHER: [], // Custom GPUs - no direct Akash mapping, use estimated rates
}

// Simulated AKT/USD price used to populate the native-currency breakdown when
// running in simulation mode. Real deployments will fetch this live.
const SIM_AKT_USD_PRICE = 3.5

export class AkashAdapter implements ExternalMarketAdapter {
  readonly market = 'AKASH' as const
  private enabled: boolean
  private apiEndpoint: string
  private readonly simulationMode: boolean
  private readonly store: SimulationStore | null

  constructor(
    options: { enabled?: boolean; apiEndpoint?: string; simulationMode?: boolean } = {}
  ) {
    this.enabled = options.enabled ?? (process.env.AKASH_ENABLED === 'true')
    this.apiEndpoint = options.apiEndpoint ?? process.env.AKASH_API_ENDPOINT ?? 'https://api.cloudmos.io'
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

  async createDeployment(input: CreateDeploymentInput): Promise<CreateDeploymentResult> {
    if (!this.simulationMode || !this.store) {
      throw new Error('Akash live mode not implemented — credentials pending')
    }

    const rate = await this.getRate(input.gpuTier)
    if (!rate.available || rate.ratePerHour <= 0) {
      throw new Error(`Akash: rate unavailable for tier ${input.gpuTier}`)
    }

    const externalId = `sim-akash-${randomUUID()}`
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
      throw new Error('Akash live mode not implemented — credentials pending')
    }

    const state = this.store.tick(externalId)
    if (!state) {
      throw new Error(`Akash: unknown deployment ${externalId}`)
    }

    return {
      externalId,
      status: state.status,
      message: `simulation status: ${state.status.toLowerCase()}`,
    }
  }

  async terminateDeployment(externalId: string): Promise<void> {
    if (!this.simulationMode || !this.store) {
      throw new Error('Akash live mode not implemented — credentials pending')
    }

    const existing = this.store.get(externalId)
    if (!existing) {
      // Idempotent — terminating an unknown deployment is a no-op, but still
      // log for observability.
      return
    }
    this.store.terminate(externalId)
    this.store.appendLog(externalId, '[sim] terminated')
  }

  async getDeploymentLogs(externalId: string): Promise<string> {
    if (!this.simulationMode || !this.store) {
      throw new Error('Akash live mode not implemented — credentials pending')
    }

    const state = this.store.get(externalId)
    if (!state) {
      throw new Error(`Akash: unknown deployment ${externalId}`)
    }
    return state.logs.join('\n')
  }

  async getDeploymentCost(externalId: string): Promise<DeploymentCostResult> {
    if (!this.simulationMode || !this.store) {
      throw new Error('Akash live mode not implemented — credentials pending')
    }

    const state = this.store.get(externalId)
    if (!state) {
      throw new Error(`Akash: unknown deployment ${externalId}`)
    }

    const accumulatedUsd = this.store.computeAccumulatedUsd(externalId)
    return {
      accumulatedUsd,
      nativeAmount: accumulatedUsd / SIM_AKT_USD_PRICE,
      nativeCurrency: 'AKT',
    }
  }

  private async fetchPricing(gpuTier: GpuTier): Promise<AkashGpuPricing | null> {
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
      // Fall back to estimated rates
    }

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
