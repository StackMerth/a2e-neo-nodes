// SimulationStore tests
// Covers create, PENDING -> ACTIVE transition, terminate, cost accrual,
// log append, and clear.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SimulationStore } from '../adapters/simulation'

describe('SimulationStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('create', () => {
    it('should create a deployment in PENDING status with clean state', () => {
      const store = new SimulationStore()
      const state = store.create({
        externalId: 'sim-test-1',
        market: 'AKASH',
        nodeId: 'node-1',
        gpuTier: 'H100',
        ratePerHour: 3.46,
      })

      expect(state.externalId).toBe('sim-test-1')
      expect(state.status).toBe('PENDING')
      expect(state.activatedAt).toBeNull()
      expect(state.terminatedAt).toBeNull()
      expect(state.logs).toEqual([])
      expect(state.ratePerHour).toBe(3.46)
      expect(state.nodeId).toBe('node-1')
      expect(state.market).toBe('AKASH')
    })

    it('should allow retrieval via get', () => {
      const store = new SimulationStore()
      store.create({
        externalId: 'sim-test-2',
        market: 'IONET',
        nodeId: 'node-2',
        gpuTier: 'H200',
        ratePerHour: 5,
      })

      expect(store.get('sim-test-2')?.market).toBe('IONET')
      expect(store.get('unknown')).toBeUndefined()
    })
  })

  describe('tick and PENDING -> ACTIVE transition', () => {
    it('should stay PENDING before the activation delay elapses', () => {
      const store = new SimulationStore({ activationDelayMs: 3000 })
      store.create({
        externalId: 'sim-a',
        market: 'AKASH',
        nodeId: 'n',
        gpuTier: 'H100',
        ratePerHour: 1,
      })

      vi.advanceTimersByTime(2999)
      const ticked = store.tick('sim-a')
      expect(ticked?.status).toBe('PENDING')
      expect(ticked?.activatedAt).toBeNull()
    })

    it('should transition to ACTIVE once the activation delay elapses', () => {
      const store = new SimulationStore({ activationDelayMs: 3000 })
      store.create({
        externalId: 'sim-b',
        market: 'AKASH',
        nodeId: 'n',
        gpuTier: 'H100',
        ratePerHour: 1,
      })

      vi.advanceTimersByTime(3000)
      const ticked = store.tick('sim-b')
      expect(ticked?.status).toBe('ACTIVE')
      expect(ticked?.activatedAt).toBeInstanceOf(Date)
    })

    it('should return undefined for unknown ids', () => {
      const store = new SimulationStore()
      expect(store.tick('nope')).toBeUndefined()
    })
  })

  describe('terminate', () => {
    it('should set status TERMINATED and timestamp', () => {
      const store = new SimulationStore({ activationDelayMs: 0 })
      store.create({
        externalId: 'sim-c',
        market: 'AKASH',
        nodeId: 'n',
        gpuTier: 'H100',
        ratePerHour: 1,
      })

      store.tick('sim-c')
      store.terminate('sim-c')

      const state = store.get('sim-c')
      expect(state?.status).toBe('TERMINATED')
      expect(state?.terminatedAt).toBeInstanceOf(Date)
    })

    it('should be idempotent and a no-op on unknown ids', () => {
      const store = new SimulationStore()
      expect(() => store.terminate('unknown')).not.toThrow()

      store.create({
        externalId: 'sim-d',
        market: 'AKASH',
        nodeId: 'n',
        gpuTier: 'H100',
        ratePerHour: 1,
      })

      store.terminate('sim-d')
      const firstTerminatedAt = store.get('sim-d')?.terminatedAt
      vi.advanceTimersByTime(1000)
      store.terminate('sim-d')
      expect(store.get('sim-d')?.terminatedAt).toBe(firstTerminatedAt)
    })
  })

  describe('computeAccumulatedUsd', () => {
    it('should be zero while still PENDING', () => {
      const store = new SimulationStore({ activationDelayMs: 3000 })
      store.create({
        externalId: 'sim-e',
        market: 'AKASH',
        nodeId: 'n',
        gpuTier: 'H100',
        ratePerHour: 10,
      })

      vi.advanceTimersByTime(1000)
      expect(store.computeAccumulatedUsd('sim-e')).toBe(0)
    })

    it('should accrue cost after activation', () => {
      const store = new SimulationStore({ activationDelayMs: 1000 })
      store.create({
        externalId: 'sim-f',
        market: 'AKASH',
        nodeId: 'n',
        gpuTier: 'H100',
        ratePerHour: 10,
      })

      // 1000ms brings us to ACTIVE; then 3600s (1h) after activation = $10
      vi.advanceTimersByTime(1000)
      store.tick('sim-f')
      vi.advanceTimersByTime(60 * 60 * 1000)

      expect(store.computeAccumulatedUsd('sim-f')).toBeCloseTo(10, 5)
    })

    it('should stop accruing once terminated', () => {
      const store = new SimulationStore({ activationDelayMs: 0 })
      store.create({
        externalId: 'sim-g',
        market: 'IONET',
        nodeId: 'n',
        gpuTier: 'H100',
        ratePerHour: 10,
      })
      store.tick('sim-g')

      vi.advanceTimersByTime(30 * 60 * 1000) // 0.5h
      store.terminate('sim-g')
      const costAtTermination = store.computeAccumulatedUsd('sim-g')

      vi.advanceTimersByTime(60 * 60 * 1000) // advance another hour
      const costLater = store.computeAccumulatedUsd('sim-g')

      expect(costAtTermination).toBeCloseTo(5, 5)
      expect(costLater).toBe(costAtTermination)
    })

    it('should return 0 for unknown ids', () => {
      const store = new SimulationStore()
      expect(store.computeAccumulatedUsd('nope')).toBe(0)
    })
  })

  describe('appendLog', () => {
    it('should append log lines in order', () => {
      const store = new SimulationStore()
      store.create({
        externalId: 'sim-h',
        market: 'VASTAI',
        nodeId: 'n',
        gpuTier: 'H100',
        ratePerHour: 1,
      })

      store.appendLog('sim-h', 'first')
      store.appendLog('sim-h', 'second')

      expect(store.get('sim-h')?.logs).toEqual(['first', 'second'])
    })

    it('should silently ignore unknown ids', () => {
      const store = new SimulationStore()
      expect(() => store.appendLog('nope', 'line')).not.toThrow()
    })
  })

  describe('clear', () => {
    it('should drop all stored deployments', () => {
      const store = new SimulationStore()
      store.create({
        externalId: 'sim-i',
        market: 'AKASH',
        nodeId: 'n',
        gpuTier: 'H100',
        ratePerHour: 1,
      })
      store.create({
        externalId: 'sim-j',
        market: 'IONET',
        nodeId: 'n',
        gpuTier: 'H100',
        ratePerHour: 1,
      })

      expect(store.get('sim-i')).toBeDefined()
      expect(store.get('sim-j')).toBeDefined()

      store.clear()

      expect(store.get('sim-i')).toBeUndefined()
      expect(store.get('sim-j')).toBeUndefined()
    })
  })
})
