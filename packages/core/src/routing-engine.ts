// A²E Routing Engine
// Core arbitrage logic for routing jobs to optimal markets

import type { GpuTier, Market, RoutingDecision } from '@a2e/shared'
import { GPU_TIER_CONFIG, dailyToHourly } from '@a2e/shared'
import type { RateProvider, MarketRates } from './rate-provider'
import type { YieldFloorConfig } from './yield-floor'

export interface RoutingEngineConfig {
  rateProvider: RateProvider
  yieldFloorConfig: YieldFloorConfig
}

export interface RoutingContext {
  gpuTier: GpuTier
  hasInternalDemand: boolean
  deploymentId?: string
}

export class RoutingEngine {
  private rateProvider: RateProvider
  private yieldFloorConfig: YieldFloorConfig

  constructor(config: RoutingEngineConfig) {
    this.rateProvider = config.rateProvider
    this.yieldFloorConfig = config.yieldFloorConfig
  }

  /**
   * Main routing decision logic
   *
   * Priority:
   * 1. If internal demand exists → route to INTERNAL (premium retail rate)
   * 2. If no internal demand → route to highest-paying external market
   * 3. Enforce yield floor as minimum rate
   */
  async route(context: RoutingContext): Promise<RoutingDecision> {
    const { gpuTier, hasInternalDemand } = context
    const rates = await this.rateProvider.getRates(gpuTier)
    const yieldFloor = this.yieldFloorConfig.getFloor(gpuTier)
    const tierConfig = GPU_TIER_CONFIG[gpuTier]

    // Case 1: Internal demand exists - use premium retail rate
    if (hasInternalDemand && rates.internal.available) {
      return {
        market: 'INTERNAL',
        ratePerHour: rates.internal.ratePerHour,
        ratePerDay: rates.internal.ratePerDay,
        reason: `Internal demand available — premium retail rate ($${rates.internal.ratePerDay.toFixed(2)}/day)`,
        timestamp: new Date(),
        yieldFloorApplied: false,
      }
    }

    // Case 2: No internal demand - find best external market
    const externalMarkets = this.rankExternalMarkets(rates, yieldFloor)

    if (externalMarkets.length > 0) {
      const best = externalMarkets[0]!
      const yieldFloorApplied = best.ratePerHour < yieldFloor.ratePerHour

      return {
        market: best.market,
        ratePerHour: yieldFloorApplied ? yieldFloor.ratePerHour : best.ratePerHour,
        ratePerDay: yieldFloorApplied ? yieldFloor.ratePerDay : best.ratePerDay,
        reason: yieldFloorApplied
          ? `${best.market} rate below floor — yield floor applied ($${yieldFloor.ratePerDay.toFixed(2)}/day)`
          : `No internal demand — routing to ${best.market} ($${best.ratePerDay.toFixed(2)}/day)`,
        timestamp: new Date(),
        yieldFloorApplied,
      }
    }

    // Case 3: No external markets available - keep for internal at floor rate
    return {
      market: 'INTERNAL',
      ratePerHour: yieldFloor.ratePerHour,
      ratePerDay: yieldFloor.ratePerDay,
      reason: `No external markets available — reserved for internal at floor rate ($${yieldFloor.ratePerDay.toFixed(2)}/day)`,
      timestamp: new Date(),
      yieldFloorApplied: true,
    }
  }

  /**
   * Rank external markets by rate (highest first)
   * Only include markets that are available
   */
  private rankExternalMarkets(
    rates: MarketRates,
    yieldFloor: { ratePerHour: number; ratePerDay: number }
  ): Array<{ market: Market; ratePerHour: number; ratePerDay: number }> {
    const markets: Array<{ market: Market; ratePerHour: number; ratePerDay: number }> = []

    if (rates.akash.available) {
      markets.push({
        market: 'AKASH',
        ratePerHour: rates.akash.ratePerHour,
        ratePerDay: rates.akash.ratePerDay,
      })
    }

    if (rates.ionet.available) {
      markets.push({
        market: 'IONET',
        ratePerHour: rates.ionet.ratePerHour,
        ratePerDay: rates.ionet.ratePerDay,
      })
    }

    // Sort by rate descending (highest first)
    return markets.sort((a, b) => b.ratePerHour - a.ratePerHour)
  }
}
