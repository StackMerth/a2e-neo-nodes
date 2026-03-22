// Routing Engine Tests
// Tests for the A²E core routing logic

import { describe, it, expect, beforeEach } from 'vitest'
import { RoutingEngine, type RoutingEngineConfig, type RoutingContext } from '../routing-engine'
import { DefaultRateProvider, MockMarketAdapter } from '../rate-provider'
import { DefaultYieldFloorConfig } from '../yield-floor'
import type { GpuTier } from '@a2e/shared'

describe('RoutingEngine', () => {
  let routingEngine: RoutingEngine
  let rateProvider: DefaultRateProvider
  let yieldFloorConfig: DefaultYieldFloorConfig
  let akashAdapter: MockMarketAdapter
  let ionetAdapter: MockMarketAdapter

  beforeEach(() => {
    rateProvider = new DefaultRateProvider({ cacheTtlMs: 0 })
    yieldFloorConfig = new DefaultYieldFloorConfig()

    akashAdapter = new MockMarketAdapter('AKASH', { enabled: true, rateMultiplier: 0.65 })
    ionetAdapter = new MockMarketAdapter('IONET', { enabled: true, rateMultiplier: 0.70 })

    rateProvider.registerAdapter(akashAdapter)
    rateProvider.registerAdapter(ionetAdapter)

    routingEngine = new RoutingEngine({
      rateProvider,
      yieldFloorConfig,
    })
  })

  describe('Internal Demand Priority', () => {
    it('should route to INTERNAL when there is internal demand', async () => {
      const decision = await routingEngine.route({
        gpuTier: 'H100',
        hasInternalDemand: true,
      })

      expect(decision.market).toBe('INTERNAL')
      expect(decision.yieldFloorApplied).toBe(false)
      expect(decision.reason).toContain('Internal demand available')
    })

    it('should use premium retail rate for internal routing', async () => {
      const decision = await routingEngine.route({
        gpuTier: 'H100',
        hasInternalDemand: true,
      })

      // H100 retail rate: $140.15/day = $5.84/hr
      expect(decision.ratePerDay).toBeCloseTo(140.15, 1)
      expect(decision.ratePerHour).toBeCloseTo(140.15 / 24, 2)
    })
  })

  describe('External Market Routing', () => {
    it('should route to highest-paying external market when no internal demand', async () => {
      // IO.net has higher rate (0.70) than Akash (0.65)
      const decision = await routingEngine.route({
        gpuTier: 'H100',
        hasInternalDemand: false,
      })

      // Should pick IONET (higher rate)
      expect(decision.market).toBe('IONET')
      expect(decision.yieldFloorApplied).toBe(false)
    })

    it('should apply yield floor when external rate is below floor', async () => {
      // Set both adapters to very low rates (below cost floor)
      akashAdapter.setRateMultiplier(0.3) // 30% of retail = ~$42/day (below $83 floor for H100)
      ionetAdapter.setRateMultiplier(0.3)

      const decision = await routingEngine.route({
        gpuTier: 'H100',
        hasInternalDemand: false,
      })

      expect(decision.yieldFloorApplied).toBe(true)
      // Should be at least the cost floor ($83/day for H100)
      expect(decision.ratePerDay).toBeGreaterThanOrEqual(83)
    })

    it('should handle disabled external markets', async () => {
      akashAdapter.setEnabled(false)
      ionetAdapter.setEnabled(false)

      const decision = await routingEngine.route({
        gpuTier: 'H100',
        hasInternalDemand: false,
      })

      // With no external markets, should stay INTERNAL at floor rate
      expect(decision.market).toBe('INTERNAL')
      expect(decision.yieldFloorApplied).toBe(true)
      expect(decision.reason).toContain('No external markets available')
    })
  })

  describe('GPU Tier Support', () => {
    const gpuTiers: GpuTier[] = ['H100', 'H200', 'B200', 'B300', 'GB300']

    it.each(gpuTiers)('should route %s tier correctly', async (tier) => {
      const decision = await routingEngine.route({
        gpuTier: tier,
        hasInternalDemand: true,
      })

      expect(decision.market).toBe('INTERNAL')
      expect(decision.ratePerHour).toBeGreaterThan(0)
      expect(decision.ratePerDay).toBeGreaterThan(0)
    })

    it.each(gpuTiers)('should have correct rate ordering for %s', async (tier) => {
      const internalDecision = await routingEngine.route({
        gpuTier: tier,
        hasInternalDemand: true,
      })

      const externalDecision = await routingEngine.route({
        gpuTier: tier,
        hasInternalDemand: false,
      })

      // Internal (retail) rate should be higher than external
      expect(internalDecision.ratePerDay).toBeGreaterThan(externalDecision.ratePerDay)
    })
  })

  describe('Yield Floor Configuration', () => {
    it('should respect custom yield floor', async () => {
      // Set a custom floor higher than market rates
      yieldFloorConfig.setFloor('H100', 200) // $200/day (above all market rates)

      akashAdapter.setRateMultiplier(0.5) // $70/day
      ionetAdapter.setRateMultiplier(0.5)

      const decision = await routingEngine.route({
        gpuTier: 'H100',
        hasInternalDemand: false,
      })

      expect(decision.yieldFloorApplied).toBe(true)
      expect(decision.ratePerDay).toBe(200)
    })

    it('should use default floor when no custom floor set', async () => {
      yieldFloorConfig.clearAllOverrides()

      akashAdapter.setRateMultiplier(0.3) // Below floor
      ionetAdapter.setRateMultiplier(0.3)

      const decision = await routingEngine.route({
        gpuTier: 'H100',
        hasInternalDemand: false,
      })

      // Default floor for H100 is $83/day (cost floor)
      expect(decision.ratePerDay).toBeCloseTo(83, 0)
    })
  })

  describe('Decision Metadata', () => {
    it('should include timestamp in decision', async () => {
      const beforeTime = new Date()
      const decision = await routingEngine.route({
        gpuTier: 'H100',
        hasInternalDemand: true,
      })
      const afterTime = new Date()

      expect(decision.timestamp).toBeInstanceOf(Date)
      expect(decision.timestamp.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime())
      expect(decision.timestamp.getTime()).toBeLessThanOrEqual(afterTime.getTime())
    })

    it('should include reason in decision', async () => {
      const decision = await routingEngine.route({
        gpuTier: 'H100',
        hasInternalDemand: true,
      })

      expect(decision.reason).toBeTruthy()
      expect(typeof decision.reason).toBe('string')
      expect(decision.reason.length).toBeGreaterThan(0)
    })
  })
})
