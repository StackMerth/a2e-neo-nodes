// Simulation store shared by Akash, IO.net, and Vast.ai adapters.
//
// F1.2 ships the deployment lifecycle methods in "simulation mode" — no real
// market calls. SimulationStore is the in-memory engine that models a
// deployment's state transitions purely as a function of wall-clock time, so
// adapters stay thin and tests can drive time deterministically with fake
// timers.

import type { GpuTier } from '@a2e/shared'
import type { DeploymentStatus } from '../rate-provider'

export interface SimulatedDeploymentState {
  externalId: string
  market: 'AKASH' | 'IONET' | 'VASTAI'
  nodeId: string
  gpuTier: GpuTier
  ratePerHour: number
  status: DeploymentStatus
  createdAt: Date
  activatedAt: Date | null
  terminatedAt: Date | null
  lastCostCheckedAt: Date
  logs: string[]
}

export interface SimulationStoreOptions {
  activationDelayMs?: number
}

type CreateInput = Omit<
  SimulatedDeploymentState,
  'status' | 'createdAt' | 'activatedAt' | 'terminatedAt' | 'lastCostCheckedAt' | 'logs'
>

const DEFAULT_ACTIVATION_DELAY_MS = 3000
const MS_PER_HOUR = 1000 * 60 * 60

export class SimulationStore {
  private readonly deployments: Map<string, SimulatedDeploymentState> = new Map()
  private readonly activationDelayMs: number

  constructor(opts: SimulationStoreOptions = {}) {
    this.activationDelayMs = opts.activationDelayMs ?? DEFAULT_ACTIVATION_DELAY_MS
  }

  create(input: CreateInput): SimulatedDeploymentState {
    const now = new Date()
    const state: SimulatedDeploymentState = {
      externalId: input.externalId,
      market: input.market,
      nodeId: input.nodeId,
      gpuTier: input.gpuTier,
      ratePerHour: input.ratePerHour,
      status: 'PENDING',
      createdAt: now,
      activatedAt: null,
      terminatedAt: null,
      lastCostCheckedAt: now,
      logs: [],
    }
    this.deployments.set(input.externalId, state)
    return state
  }

  get(externalId: string): SimulatedDeploymentState | undefined {
    return this.deployments.get(externalId)
  }

  terminate(externalId: string): void {
    const state = this.deployments.get(externalId)
    if (!state) return
    if (state.status === 'TERMINATED') return

    state.status = 'TERMINATED'
    state.terminatedAt = new Date()
  }

  appendLog(externalId: string, line: string): void {
    const state = this.deployments.get(externalId)
    if (!state) return
    state.logs.push(line)
  }

  /**
   * Returns the deployment with its status advanced if enough time has passed.
   * Pure function of the clock — no background timers. PENDING deployments
   * flip to ACTIVE once (now - createdAt) >= activationDelayMs.
   */
  tick(externalId: string): SimulatedDeploymentState | undefined {
    const state = this.deployments.get(externalId)
    if (!state) return undefined

    if (state.status === 'PENDING') {
      const elapsed = Date.now() - state.createdAt.getTime()
      if (elapsed >= this.activationDelayMs) {
        state.status = 'ACTIVE'
        state.activatedAt = new Date(state.createdAt.getTime() + this.activationDelayMs)
        state.logs.push('[sim] deployment active')
      }
    }

    return state
  }

  /**
   * Accumulated USD cost since activation. PENDING deployments accrue nothing.
   * For terminated deployments, accrual stops at terminatedAt.
   */
  computeAccumulatedUsd(externalId: string): number {
    const state = this.deployments.get(externalId)
    if (!state) return 0
    if (!state.activatedAt) {
      // Opportunistically advance status — cost readers often query without
      // having called getDeploymentStatus first.
      this.tick(externalId)
    }
    if (!state.activatedAt) return 0

    const endTime = state.terminatedAt ?? new Date()
    const elapsedMs = Math.max(0, endTime.getTime() - state.activatedAt.getTime())
    const hours = elapsedMs / MS_PER_HOUR

    state.lastCostCheckedAt = new Date()
    return hours * state.ratePerHour
  }

  clear(): void {
    this.deployments.clear()
  }
}
