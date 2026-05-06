import { describe, expect, it } from 'vitest'
import yaml from 'js-yaml'
import { buildSdl } from '../adapters/akash-sdl'

describe('buildSdl', () => {
  it('produces a v2.0 SDL with all required top-level sections', () => {
    const result = buildSdl({ nodeId: 'node-abc-123', gpuTier: 'H100' })
    expect(result.document.version).toBe('2.0')
    expect(result.document.services).toBeDefined()
    expect(result.document.profiles.compute).toBeDefined()
    expect(result.document.profiles.placement).toBeDefined()
    expect(result.document.deployment).toBeDefined()
  })

  it('round-trips through YAML cleanly (parse and compare)', () => {
    const result = buildSdl({ nodeId: 'node-abc', gpuTier: 'H100' })
    const reparsed = yaml.load(result.yaml)
    expect(reparsed).toEqual(result.document)
  })

  it('maps each GPU tier to the correct Akash model attribute', () => {
    const cases: Array<['H100' | 'H200' | 'B200' | 'B300' | 'GB300' | 'OTHER', string]> = [
      ['H100', 'h100'],
      ['H200', 'h200'],
      ['B200', 'b200'],
      ['B300', 'b300'],
      ['GB300', 'gb300'],
      ['OTHER', 'rtx'],
    ]
    for (const [tier, model] of cases) {
      const sdl = buildSdl({ nodeId: 'n', gpuTier: tier })
      const compute = sdl.document.profiles.compute as Record<string, { resources: { gpu: { attributes: { vendor: { nvidia: Array<{ model: string }> } } } } }>
      const svc = compute['n']!
      expect(svc.resources.gpu.attributes.vendor.nvidia[0]?.model).toBe(model)
    }
  })

  it('uses the per-tier default max bid in uakt/block when none is supplied', () => {
    const sdl = buildSdl({ nodeId: 'n', gpuTier: 'H100' })
    const placement = sdl.document.profiles.placement as Record<string, { pricing: Record<string, { denom: string; amount: number }> }>
    expect(placement.akash!.pricing['n']!.denom).toBe('uakt')
    expect(placement.akash!.pricing['n']!.amount).toBe(5000)
  })

  it('accepts a custom max bid override', () => {
    const sdl = buildSdl({ nodeId: 'n', gpuTier: 'H100', maxBidUaktPerBlock: 1234 })
    const placement = sdl.document.profiles.placement as Record<string, { pricing: Record<string, { denom: string; amount: number }> }>
    expect(placement.akash!.pricing['n']!.amount).toBe(1234)
  })

  it('sanitises non-DNS characters in nodeId for use as service name', () => {
    const sdl = buildSdl({ nodeId: 'Node_With_Underscores!', gpuTier: 'H100' })
    const services = sdl.document.services as Record<string, unknown>
    const name = Object.keys(services)[0]
    expect(name).toMatch(/^[a-z][a-z0-9-]*$/)
    expect(name).not.toContain('_')
    expect(name).not.toContain('!')
  })

  it('prefixes nodeIds that start with a digit so the service name is a valid identifier', () => {
    const sdl = buildSdl({ nodeId: '123abc', gpuTier: 'H100' })
    const services = sdl.document.services as Record<string, unknown>
    const name = Object.keys(services)[0]!
    expect(name.startsWith('n-')).toBe(true)
  })

  it('exposes port 22 globally for SSH access', () => {
    const sdl = buildSdl({ nodeId: 'node-1', gpuTier: 'H100' })
    const services = sdl.document.services as Record<string, { expose: Array<{ port: number; as: number; to: Array<{ global: boolean }> }> }>
    const expose = services['node-1']!.expose
    expect(expose).toEqual([
      { port: 22, as: 22, to: [{ global: true }] },
    ])
  })

  it('uses the supplied image name when provided', () => {
    const sdl = buildSdl({ nodeId: 'n', gpuTier: 'H100', image: 'tensorflow/tensorflow:latest-gpu' })
    const services = sdl.document.services as Record<string, { image: string }>
    expect(services['n']!.image).toBe('tensorflow/tensorflow:latest-gpu')
  })

  it('respects custom CPU/memory/storage parameters', () => {
    const sdl = buildSdl({
      nodeId: 'n',
      gpuTier: 'H100',
      cpuUnits: 16,
      memorySize: '64Gi',
      storageSize: '500Gi',
    })
    const compute = sdl.document.profiles.compute as Record<string, { resources: { cpu: { units: number }; memory: { size: string }; storage: { size: string } } }>
    expect(compute['n']!.resources.cpu.units).toBe(16)
    expect(compute['n']!.resources.memory.size).toBe('64Gi')
    expect(compute['n']!.resources.storage.size).toBe('500Gi')
  })
})
