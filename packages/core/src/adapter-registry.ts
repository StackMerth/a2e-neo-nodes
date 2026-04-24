// Adapter Registry
// Tracks health of external market adapters (Akash, IO.net, Vast.ai) and
// auto-disables ones that repeatedly fail. Used by the overflow engine and
// status-checker worker to decide which markets are viable for listing.

import type { ExternalMarketAdapter } from './rate-provider'

export type AdapterMarket = 'AKASH' | 'IONET' | 'VASTAI'

export interface AdapterHealth {
  market: AdapterMarket
  healthy: boolean
  autoDisabled: boolean
  failureCount: number
  lastSuccess: Date | null
  lastFailure: Date | null
  lastError: string | null
}

export interface AdapterRegistryOptions {
  failureThreshold?: number
  probeIntervalMs?: number
  onAutoDisable?: (market: AdapterMarket, health: AdapterHealth) => void
  onAutoEnable?: (market: AdapterMarket, health: AdapterHealth) => void
}

interface HealthState {
  market: AdapterMarket
  autoDisabled: boolean
  failureCount: number
  lastSuccess: Date | null
  lastFailure: Date | null
  lastError: string | null
}

const DEFAULT_FAILURE_THRESHOLD = 5
const DEFAULT_PROBE_INTERVAL_MS = 5 * 60_000

function cloneHealth(state: HealthState): AdapterHealth {
  return {
    market: state.market,
    healthy: !state.autoDisabled && state.failureCount === 0,
    autoDisabled: state.autoDisabled,
    failureCount: state.failureCount,
    lastSuccess: state.lastSuccess ? new Date(state.lastSuccess.getTime()) : null,
    lastFailure: state.lastFailure ? new Date(state.lastFailure.getTime()) : null,
    lastError: state.lastError,
  }
}

function createInitialState(market: AdapterMarket): HealthState {
  return {
    market,
    autoDisabled: false,
    failureCount: 0,
    lastSuccess: null,
    lastFailure: null,
    lastError: null,
  }
}

export class AdapterRegistry {
  private readonly adapters: Map<AdapterMarket, ExternalMarketAdapter> = new Map()
  private readonly health: Map<AdapterMarket, HealthState> = new Map()
  private readonly failureThreshold: number
  private readonly probeIntervalMs: number
  private readonly onAutoDisable?: (market: AdapterMarket, health: AdapterHealth) => void
  private readonly onAutoEnable?: (market: AdapterMarket, health: AdapterHealth) => void
  private probeTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: AdapterRegistryOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD
    this.probeIntervalMs = options.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS
    this.onAutoDisable = options.onAutoDisable
    this.onAutoEnable = options.onAutoEnable
  }

  register(adapter: ExternalMarketAdapter): void {
    const market = adapter.market
    this.adapters.set(market, adapter)
    this.health.set(market, createInitialState(market))
  }

  get(market: AdapterMarket): ExternalMarketAdapter | undefined {
    return this.adapters.get(market)
  }

  list(): ExternalMarketAdapter[] {
    return Array.from(this.adapters.values())
  }

  recordSuccess(market: AdapterMarket): void {
    const state = this.health.get(market)
    if (!state) return

    const wasAutoDisabled = state.autoDisabled

    state.lastSuccess = new Date()
    state.failureCount = 0
    state.lastError = null

    if (wasAutoDisabled) {
      state.autoDisabled = false
      const adapter = this.adapters.get(market)
      if (adapter) {
        adapter.setEnabled(true)
      }
      if (this.onAutoEnable) {
        this.onAutoEnable(market, cloneHealth(state))
      }
    }
  }

  recordFailure(market: AdapterMarket, error: Error | string): void {
    const state = this.health.get(market)
    if (!state) return

    const message = error instanceof Error ? error.message : String(error)

    state.lastFailure = new Date()
    state.lastError = message

    if (state.autoDisabled) {
      // Already auto-disabled - update timestamps but don't increment past
      // threshold or re-fire the disable callback.
      return
    }

    state.failureCount += 1

    if (state.failureCount >= this.failureThreshold) {
      state.autoDisabled = true
      const adapter = this.adapters.get(market)
      if (adapter) {
        adapter.setEnabled(false)
      }
      if (this.onAutoDisable) {
        this.onAutoDisable(market, cloneHealth(state))
      }
    }
  }

  getHealth(market: AdapterMarket): AdapterHealth | undefined {
    const state = this.health.get(market)
    if (!state) return undefined
    return cloneHealth(state)
  }

  getAllHealth(): AdapterHealth[] {
    return Array.from(this.health.values()).map(cloneHealth)
  }

  isAvailable(market: AdapterMarket): boolean {
    const adapter = this.adapters.get(market)
    if (!adapter) return false

    const state = this.health.get(market)
    if (!state) return false

    if (state.autoDisabled) return false
    if (!adapter.isEnabled()) return false

    return true
  }

  start(): void {
    if (this.probeTimer !== null) return

    this.probeTimer = setInterval(() => {
      void this.runProbes()
    }, this.probeIntervalMs)
  }

  stop(): void {
    if (this.probeTimer === null) return
    clearInterval(this.probeTimer)
    this.probeTimer = null
  }

  private async runProbes(): Promise<void> {
    const disabledMarkets: AdapterMarket[] = []
    for (const [market, state] of this.health.entries()) {
      if (state.autoDisabled) {
        disabledMarkets.push(market)
      }
    }

    for (const market of disabledMarkets) {
      const adapter = this.adapters.get(market)
      if (!adapter) continue

      try {
        await adapter.getRate('H100')
        this.recordSuccess(market)
      } catch (error) {
        this.recordFailure(market, error instanceof Error ? error : String(error))
      }
    }
  }
}
