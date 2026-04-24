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
  vastai: MarketRateInfo
}

export interface RateProvider {
  getRates(gpuTier: GpuTier): Promise<MarketRates>
  refreshRates(): Promise<void>
}

// Deployment lifecycle types (F1.2)

export type DeploymentStatus = 'PENDING' | 'ACTIVE' | 'TERMINATING' | 'TERMINATED' | 'FAILED'

export interface CreateDeploymentInput {
  nodeId: string
  gpuTier: GpuTier
  durationHours?: number
}

export interface CreateDeploymentResult {
  externalId: string
  status: DeploymentStatus
  estimatedRatePerHour: number
  market: 'AKASH' | 'IONET' | 'VASTAI'
}

export interface DeploymentStatusResult {
  externalId: string
  status: DeploymentStatus
  message?: string
}

export interface DeploymentCostResult {
  accumulatedUsd: number
  nativeAmount?: number
  nativeCurrency?: 'AKT' | 'CREDITS' | 'USD'
}

export interface ExternalMarketAdapter {
  market: 'AKASH' | 'IONET' | 'VASTAI'
  getRate(gpuTier: GpuTier): Promise<MarketRateInfo>
  isEnabled(): boolean
  setEnabled(enabled: boolean): void

  // Deployment lifecycle (F1.2)
  createDeployment(input: CreateDeploymentInput): Promise<CreateDeploymentResult>
  getDeploymentStatus(externalId: string): Promise<DeploymentStatusResult>
  terminateDeployment(externalId: string): Promise<void>
  getDeploymentLogs(externalId: string): Promise<string>
  getDeploymentCost(externalId: string): Promise<DeploymentCostResult>
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

    const akashAdapter = this.adapters.get('AKASH')
    const ionetAdapter = this.adapters.get('IONET')
    const vastaiAdapter = this.adapters.get('VASTAI')

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

    let vastai: MarketRateInfo = {
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

    if (vastaiAdapter?.isEnabled()) {
      try {
        vastai = await vastaiAdapter.getRate(gpuTier)
      } catch (error) {
        console.error('Failed to fetch Vast.ai rates:', error)
      }
    }

    return { internal, akash, ionet, vastai }
  }
}

/**
 * Mock adapter for testing
 *
 * Implements the deployment lifecycle with a trivial in-memory store so that
 * tests which register this adapter against code paths touching deployments
 * continue to work without wiring a real market integration.
 */
interface MockDeploymentState {
  externalId: string
  nodeId: string
  gpuTier: GpuTier
  ratePerHour: number
  status: DeploymentStatus
  createdAt: Date
  terminatedAt: Date | null
  logs: string[]
}

export class MockMarketAdapter implements ExternalMarketAdapter {
  market: 'AKASH' | 'IONET' | 'VASTAI'
  private enabled: boolean
  private rateMultiplier: number
  private deployments: Map<string, MockDeploymentState> = new Map()

  constructor(market: 'AKASH' | 'IONET' | 'VASTAI', options: { enabled?: boolean; rateMultiplier?: number } = {}) {
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

  async createDeployment(input: CreateDeploymentInput): Promise<CreateDeploymentResult> {
    const rate = await this.getRate(input.gpuTier)
    if (!rate.available) {
      throw new Error(`Mock adapter ${this.market}: rate unavailable for ${input.gpuTier}`)
    }

    const externalId = `mock-${this.market.toLowerCase()}-${Math.random().toString(36).slice(2, 10)}`
    this.deployments.set(externalId, {
      externalId,
      nodeId: input.nodeId,
      gpuTier: input.gpuTier,
      ratePerHour: rate.ratePerHour,
      status: 'ACTIVE',
      createdAt: new Date(),
      terminatedAt: null,
      logs: [`[mock] deployment created for ${input.nodeId}`],
    })

    return {
      externalId,
      status: 'ACTIVE',
      estimatedRatePerHour: rate.ratePerHour,
      market: this.market,
    }
  }

  async getDeploymentStatus(externalId: string): Promise<DeploymentStatusResult> {
    const state = this.deployments.get(externalId)
    if (!state) {
      throw new Error(`Mock adapter ${this.market}: unknown deployment ${externalId}`)
    }
    return { externalId, status: state.status, message: `mock ${state.status.toLowerCase()}` }
  }

  async terminateDeployment(externalId: string): Promise<void> {
    const state = this.deployments.get(externalId)
    if (!state) return
    state.status = 'TERMINATED'
    state.terminatedAt = new Date()
    state.logs.push('[mock] terminated')
  }

  async getDeploymentLogs(externalId: string): Promise<string> {
    const state = this.deployments.get(externalId)
    if (!state) {
      throw new Error(`Mock adapter ${this.market}: unknown deployment ${externalId}`)
    }
    return state.logs.join('\n')
  }

  async getDeploymentCost(externalId: string): Promise<DeploymentCostResult> {
    const state = this.deployments.get(externalId)
    if (!state) {
      throw new Error(`Mock adapter ${this.market}: unknown deployment ${externalId}`)
    }
    const endTime = state.terminatedAt ?? new Date()
    const hours = Math.max(0, (endTime.getTime() - state.createdAt.getTime()) / (1000 * 60 * 60))
    return { accumulatedUsd: hours * state.ratePerHour }
  }
}
