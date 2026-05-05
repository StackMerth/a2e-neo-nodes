import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isSimulationMode } from '../external-simulation-config'

describe('isSimulationMode', () => {
  const SAVE = {
    global: process.env.A2E_EXTERNAL_SIMULATION,
    akash: process.env.A2E_AKASH_SIMULATION,
    ionet: process.env.A2E_IONET_SIMULATION,
    vastai: process.env.A2E_VASTAI_SIMULATION,
  }

  beforeEach(() => {
    delete process.env.A2E_EXTERNAL_SIMULATION
    delete process.env.A2E_AKASH_SIMULATION
    delete process.env.A2E_IONET_SIMULATION
    delete process.env.A2E_VASTAI_SIMULATION
  })

  afterEach(() => {
    if (SAVE.global !== undefined) process.env.A2E_EXTERNAL_SIMULATION = SAVE.global
    if (SAVE.akash !== undefined) process.env.A2E_AKASH_SIMULATION = SAVE.akash
    if (SAVE.ionet !== undefined) process.env.A2E_IONET_SIMULATION = SAVE.ionet
    if (SAVE.vastai !== undefined) process.env.A2E_VASTAI_SIMULATION = SAVE.vastai
  })

  it('defaults to simulation=true when no env vars are set', () => {
    expect(isSimulationMode()).toBe(true)
    expect(isSimulationMode('VASTAI')).toBe(true)
    expect(isSimulationMode('AKASH')).toBe(true)
    expect(isSimulationMode('IONET')).toBe(true)
  })

  it('respects the global A2E_EXTERNAL_SIMULATION=false override for all markets', () => {
    process.env.A2E_EXTERNAL_SIMULATION = 'false'
    expect(isSimulationMode()).toBe(false)
    expect(isSimulationMode('VASTAI')).toBe(false)
    expect(isSimulationMode('AKASH')).toBe(false)
  })

  it('per-market override takes precedence over the global flag (live one, simulate others)', () => {
    process.env.A2E_EXTERNAL_SIMULATION = 'true'
    process.env.A2E_VASTAI_SIMULATION = 'false'
    expect(isSimulationMode('VASTAI')).toBe(false)
    expect(isSimulationMode('AKASH')).toBe(true)
    expect(isSimulationMode('IONET')).toBe(true)
  })

  it('per-market override can force a market into simulation while global is live', () => {
    process.env.A2E_EXTERNAL_SIMULATION = 'false'
    process.env.A2E_AKASH_SIMULATION = 'true'
    expect(isSimulationMode('AKASH')).toBe(true)
    expect(isSimulationMode('VASTAI')).toBe(false)
    expect(isSimulationMode('IONET')).toBe(false)
  })

  it('ignores junk values in per-market overrides and falls back to global', () => {
    process.env.A2E_EXTERNAL_SIMULATION = 'false'
    process.env.A2E_VASTAI_SIMULATION = 'maybe'
    expect(isSimulationMode('VASTAI')).toBe(false)
  })
})
