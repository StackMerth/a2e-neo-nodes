// Yield Floor Tests
// Tests for yield floor configuration

import { describe, it, expect, beforeEach } from 'vitest'
import { DefaultYieldFloorConfig } from '../yield-floor'
import type { GpuTier } from '@a2e/shared'
import { GPU_TIER_CONFIG } from '@a2e/shared'

describe('DefaultYieldFloorConfig', () => {
  let config: DefaultYieldFloorConfig

  beforeEach(() => {
    config = new DefaultYieldFloorConfig()
  })

  describe('Default Floors', () => {
    it('should return cost floor for each GPU tier by default', () => {
      const expectedFloors: Record<GpuTier, number> = {
        H100: 83,
        H200: 105,
        B200: 170,
        B300: 250,
        GB300: 300,
      }

      for (const [tier, expectedFloor] of Object.entries(expectedFloors)) {
        const floor = config.getFloor(tier as GpuTier)
        expect(floor.ratePerDay).toBeCloseTo(expectedFloor, 0)
      }
    })

    it('should return hourly rate as daily / 24', () => {
      const floor = config.getFloor('H100')

      expect(floor.ratePerHour).toBeCloseTo(floor.ratePerDay / 24, 4)
    })
  })

  describe('Custom Overrides', () => {
    it('should allow setting custom floor', () => {
      config.setFloor('H100', 100)

      const floor = config.getFloor('H100')
      expect(floor.ratePerDay).toBe(100)
      expect(floor.ratePerHour).toBeCloseTo(100 / 24, 4)
    })

    it('should preserve override after multiple gets', () => {
      config.setFloor('H100', 150)

      const floor1 = config.getFloor('H100')
      const floor2 = config.getFloor('H100')

      expect(floor1.ratePerDay).toBe(150)
      expect(floor2.ratePerDay).toBe(150)
    })

    it('should allow clearing a single override', () => {
      config.setFloor('H100', 150)
      config.setFloor('H200', 200)

      config.clearOverride('H100')

      // H100 should be back to default
      expect(config.getFloor('H100').ratePerDay).toBeCloseTo(83, 0)
      // H200 should still be overridden
      expect(config.getFloor('H200').ratePerDay).toBe(200)
    })

    it('should allow clearing all overrides', () => {
      config.setFloor('H100', 150)
      config.setFloor('H200', 200)

      config.clearAllOverrides()

      expect(config.getFloor('H100').ratePerDay).toBeCloseTo(83, 0)
      expect(config.getFloor('H200').ratePerDay).toBeCloseTo(105, 0)
    })
  })

  describe('getAllFloors', () => {
    it('should return floors for all tiers', () => {
      const floors = config.getAllFloors()

      const tiers: GpuTier[] = ['H100', 'H200', 'B200', 'B300', 'GB300']
      for (const tier of tiers) {
        expect(floors[tier]).toBeDefined()
        expect(floors[tier].ratePerDay).toBeGreaterThan(0)
        expect(floors[tier].ratePerHour).toBeGreaterThan(0)
      }
    })

    it('should reflect overrides in getAllFloors', () => {
      config.setFloor('H100', 999)

      const floors = config.getAllFloors()

      expect(floors.H100.ratePerDay).toBe(999)
      expect(floors.H200.ratePerDay).toBeCloseTo(105, 0) // Default
    })
  })

  describe('GPU Tier Config Integration', () => {
    it('should use cost floor from GPU_TIER_CONFIG', () => {
      const tiers: GpuTier[] = ['H100', 'H200', 'B200', 'B300', 'GB300']

      for (const tier of tiers) {
        const floor = config.getFloor(tier)
        const tierConfig = GPU_TIER_CONFIG[tier]

        expect(floor.ratePerDay).toBeCloseTo(tierConfig.costFloor, 0)
      }
    })
  })
})
