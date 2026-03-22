// Yield Floor Configuration
// Minimum guaranteed earnings per GPU tier

import type { GpuTier } from '@a2e/shared'
import { GPU_TIER_CONFIG, dailyToHourly } from '@a2e/shared'

export interface YieldFloorRate {
  ratePerHour: number
  ratePerDay: number
}

export interface YieldFloorConfig {
  getFloor(gpuTier: GpuTier): YieldFloorRate
  setFloor(gpuTier: GpuTier, ratePerDay: number): void
}

/**
 * Default yield floor configuration
 * Uses cost floor from GPU tier config as the minimum
 */
export class DefaultYieldFloorConfig implements YieldFloorConfig {
  private overrides: Map<GpuTier, number> = new Map()

  getFloor(gpuTier: GpuTier): YieldFloorRate {
    // Check for override first
    const override = this.overrides.get(gpuTier)
    if (override !== undefined) {
      return {
        ratePerHour: dailyToHourly(override),
        ratePerDay: override,
      }
    }

    // Use cost floor from config
    const tierConfig = GPU_TIER_CONFIG[gpuTier]
    return {
      ratePerHour: dailyToHourly(tierConfig.costFloor),
      ratePerDay: tierConfig.costFloor,
    }
  }

  setFloor(gpuTier: GpuTier, ratePerDay: number): void {
    this.overrides.set(gpuTier, ratePerDay)
  }

  clearOverride(gpuTier: GpuTier): void {
    this.overrides.delete(gpuTier)
  }

  clearAllOverrides(): void {
    this.overrides.clear()
  }

  /**
   * Get all current floors (including overrides)
   */
  getAllFloors(): Record<GpuTier, YieldFloorRate> {
    const tiers: GpuTier[] = ['H100', 'H200', 'B200', 'B300', 'GB300']
    const result: Record<string, YieldFloorRate> = {}

    for (const tier of tiers) {
      result[tier] = this.getFloor(tier)
    }

    return result as Record<GpuTier, YieldFloorRate>
  }
}
