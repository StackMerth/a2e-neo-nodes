/**
 * Vast.ai live-mode adapter tests
 *
 * These exercise the live-mode code paths with a mocked global fetch so we
 * cover the lifecycle (create, status mapping, terminate, cost) without making
 * real API calls. Real-API verification happens out-of-band as a free preflight.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VastAiAdapter } from '../adapters/vastai'

const ENDPOINT = 'https://console.vast.ai/api/v0'
const API_KEY = 'test-api-key-vastai-1234'

interface FetchCall {
  url: string
  init?: RequestInit
}

function makeFetchMock(responder: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = []
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), init }
    calls.push(call)
    return responder(call)
  })
  return { fn, calls }
}

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
}

describe('VastAiAdapter — live mode lifecycle', () => {
  const realFetch = globalThis.fetch

  beforeEach(() => {
    // Live mode runs only when simulation is off and apiKey is set.
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    vi.restoreAllMocks()
  })

  it('createDeployment: searches for offer, picks cheapest verified rentable, PUTs to /asks/{id}/', async () => {
    const offer = { id: 4242, gpu_name: 'H100 SXM', dph_total: 2.5, num_gpus: 1, verified: true, rentable: true, reliability2: 0.99 }
    const offerExpensive = { id: 9999, gpu_name: 'H100 SXM', dph_total: 4.0, num_gpus: 1, verified: true, rentable: true, reliability2: 0.95 }

    const { fn, calls } = makeFetchMock((call) => {
      if (call.url.startsWith(`${ENDPOINT}/bundles/?q=`)) {
        return jsonResponse({ offers: [offerExpensive, offer] })
      }
      if (call.url.endsWith(`/asks/${offer.id}/`)) {
        return jsonResponse({ success: true, new_contract: 555_001 })
      }
      throw new Error(`Unexpected fetch: ${call.url}`)
    })
    globalThis.fetch = fn as unknown as typeof fetch

    const adapter = new VastAiAdapter({ enabled: true, simulationMode: false, apiKey: API_KEY })
    const result = await adapter.createDeployment({ nodeId: 'node-1', gpuTier: 'H100' })

    expect(result.externalId).toBe('555001')
    expect(result.status).toBe('PENDING')
    expect(result.market).toBe('VASTAI')
    expect(result.estimatedRatePerHour).toBeCloseTo(2.5)

    expect(calls).toHaveLength(2)
    expect(calls[0]!.url).toContain(`${ENDPOINT}/bundles/?q=`)
    expect(calls[0]!.init?.method).toBe('GET')
    expect(calls[0]!.init?.headers).toMatchObject({ Authorization: `Bearer ${API_KEY}` })
    expect(calls[1]!.url).toBe(`${ENDPOINT}/asks/${offer.id}/`)
    expect(calls[1]!.init?.method).toBe('PUT')
    const createBody = JSON.parse(String(calls[1]!.init?.body))
    expect(createBody).toMatchObject({ client_id: 'me', runtype: 'ssh', label: 'a2e-node-1' })
  })

  it('createDeployment: throws when offer search returns no rentable matches', async () => {
    const { fn } = makeFetchMock(() => jsonResponse({ offers: [] }))
    globalThis.fetch = fn as unknown as typeof fetch

    const adapter = new VastAiAdapter({ enabled: true, simulationMode: false, apiKey: API_KEY })
    await expect(adapter.createDeployment({ nodeId: 'node-1', gpuTier: 'H100' })).rejects.toThrow(/no rentable offers/)
  })

  it('createDeployment: surfaces Vast.ai error responses from the create call', async () => {
    const { fn } = makeFetchMock((call) => {
      if (call.url.startsWith(`${ENDPOINT}/bundles/?q=`)) {
        return jsonResponse({ offers: [{ id: 1, gpu_name: 'H100', dph_total: 3, num_gpus: 1, verified: true, rentable: true }] })
      }
      return new Response('insufficient credit', { status: 402 })
    })
    globalThis.fetch = fn as unknown as typeof fetch

    const adapter = new VastAiAdapter({ enabled: true, simulationMode: false, apiKey: API_KEY })
    await expect(adapter.createDeployment({ nodeId: 'node-1', gpuTier: 'H100' })).rejects.toThrow(/instance create failed: 402/)
  })

  it('getDeploymentStatus: maps Vast.ai actual_status to internal DeploymentStatus', async () => {
    const cases: Array<{ actual: string; intended: string; expected: string }> = [
      { actual: 'created', intended: 'running', expected: 'PENDING' },
      { actual: 'loading', intended: 'running', expected: 'PENDING' },
      { actual: 'running', intended: 'running', expected: 'ACTIVE' },
      { actual: 'stopping', intended: 'stopped', expected: 'TERMINATING' },
      { actual: 'exited', intended: 'stopped', expected: 'TERMINATED' },
      { actual: 'error', intended: 'running', expected: 'FAILED' },
    ]

    for (const c of cases) {
      const { fn } = makeFetchMock(() =>
        jsonResponse({ instances: { id: 1, actual_status: c.actual, intended_status: c.intended } })
      )
      globalThis.fetch = fn as unknown as typeof fetch
      const adapter = new VastAiAdapter({ enabled: true, simulationMode: false, apiKey: API_KEY })
      const status = await adapter.getDeploymentStatus('1')
      expect(status.status).toBe(c.expected)
    }
  })

  it('getDeploymentStatus: returns TERMINATED on 404', async () => {
    const { fn } = makeFetchMock(() => new Response('not found', { status: 404 }))
    globalThis.fetch = fn as unknown as typeof fetch

    const adapter = new VastAiAdapter({ enabled: true, simulationMode: false, apiKey: API_KEY })
    const result = await adapter.getDeploymentStatus('999')
    expect(result.status).toBe('TERMINATED')
  })

  it('terminateDeployment: DELETEs /instances/{id}/ and is idempotent on 404', async () => {
    const { fn, calls } = makeFetchMock((call) => {
      if (call.init?.method === 'DELETE') return jsonResponse({ success: true })
      throw new Error(`Unexpected: ${call.url}`)
    })
    globalThis.fetch = fn as unknown as typeof fetch

    const adapter = new VastAiAdapter({ enabled: true, simulationMode: false, apiKey: API_KEY })
    await adapter.terminateDeployment('555001')
    expect(calls[0]!.url).toBe(`${ENDPOINT}/instances/555001/`)
    expect(calls[0]!.init?.method).toBe('DELETE')

    // 404 is non-throwing.
    const { fn: fn404 } = makeFetchMock(() => new Response('gone', { status: 404 }))
    globalThis.fetch = fn404 as unknown as typeof fetch
    const adapter2 = new VastAiAdapter({ enabled: true, simulationMode: false, apiKey: API_KEY })
    await expect(adapter2.terminateDeployment('555001')).resolves.toBeUndefined()
  })

  it('getDeploymentCost: computes accumulated USD when actual_status=running', async () => {
    const startDate = Math.floor(Date.now() / 1000) - 1800 // 30 minutes ago
    const { fn } = makeFetchMock(() =>
      jsonResponse({
        instances: {
          id: 1,
          dph_total: 2.4,
          start_date: startDate,
          actual_status: 'running',
          intended_status: 'running',
        },
      })
    )
    globalThis.fetch = fn as unknown as typeof fetch

    const adapter = new VastAiAdapter({ enabled: true, simulationMode: false, apiKey: API_KEY })
    const cost = await adapter.getDeploymentCost('1')

    // 0.5 hours × $2.40/hr = $1.20 (with small drift tolerance).
    expect(cost.accumulatedUsd).toBeGreaterThan(1.15)
    expect(cost.accumulatedUsd).toBeLessThan(1.25)
    expect(cost.nativeCurrency).toBe('USD')
  })

  it('getDeploymentCost: returns $0 when actual_status is null (loading/queued instance)', async () => {
    // Vast.ai sets start_date to the reservation time (days earlier than
    // actual run start) and end_date to a future max-lease ceiling. Both
    // signals are misleading — only actual_status === "running" means the
    // workload is billable.
    const startDate = Math.floor(Date.now() / 1000) - 86_400 * 10
    const endDate = Math.floor(Date.now() / 1000) + 86_400 * 10
    const { fn } = makeFetchMock(() =>
      jsonResponse({
        instances: {
          id: 1,
          dph_total: 2.4,
          start_date: startDate,
          end_date: endDate,
          cur_state: 'running',
          actual_status: null,
          intended_status: 'running',
        },
      })
    )
    globalThis.fetch = fn as unknown as typeof fetch

    const adapter = new VastAiAdapter({ enabled: true, simulationMode: false, apiKey: API_KEY })
    const cost = await adapter.getDeploymentCost('1')
    expect(cost.accumulatedUsd).toBe(0)
  })

  it('getDeploymentCost: returns $0 when end_date is set but actual_status is not running (regression for $356 bug)', async () => {
    // Production canary observed Vast.ai returning end_date set to a future
    // max-lease ceiling immediately after create, even though actual_status
    // was null. Earlier code treated end_date as proof the instance ran and
    // produced an inflated cost. Now end_date is irrelevant for billability.
    const startDate = Math.floor(Date.now() / 1000) - 86_400 * 10
    const endDate = Math.floor(Date.now() / 1000) + 86_400 * 10
    const { fn } = makeFetchMock(() =>
      jsonResponse({
        instances: {
          id: 1,
          dph_total: 1.5,
          start_date: startDate,
          end_date: endDate,
          actual_status: null,
        },
      })
    )
    globalThis.fetch = fn as unknown as typeof fetch

    const adapter = new VastAiAdapter({ enabled: true, simulationMode: false, apiKey: API_KEY })
    const cost = await adapter.getDeploymentCost('1')
    expect(cost.accumulatedUsd).toBe(0)
  })

  it('getDeploymentCost: caps elapsed time at create-call timestamp even if API reports older start_date', async () => {
    // Stage a successful create so liveDeployments has a recent record.
    let createdAt = 0
    const { fn } = makeFetchMock((call) => {
      if (call.url.startsWith(`${ENDPOINT}/bundles/?q=`)) {
        return jsonResponse({
          offers: [{ id: 7, gpu_name: 'H100 SXM', dph_total: 1.5, num_gpus: 1, verified: true, rentable: true }],
        })
      }
      if (call.url.endsWith('/asks/7/')) {
        createdAt = Date.now()
        return jsonResponse({ success: true, new_contract: 7777 })
      }
      // Cost lookup returns a stale start_date (1 hour ago) but instance is running.
      const oldStart = Math.floor(Date.now() / 1000) - 3600
      return jsonResponse({
        instances: {
          id: 7777,
          dph_total: 1.5,
          start_date: oldStart,
          actual_status: 'running',
        },
      })
    })
    globalThis.fetch = fn as unknown as typeof fetch

    const adapter = new VastAiAdapter({ enabled: true, simulationMode: false, apiKey: API_KEY })
    await adapter.createDeployment({ nodeId: 'n', gpuTier: 'H100' })

    // Wait a tiny bit so elapsed > 0.
    await new Promise((r) => setTimeout(r, 50))

    const cost = await adapter.getDeploymentCost('7777')
    // Should be capped at ~50ms × $1.5/hr ≈ $0.0000208, NOT 1 hour × $1.5 = $1.50.
    expect(cost.accumulatedUsd).toBeLessThan(0.01)
    expect(createdAt).toBeGreaterThan(0)
  })
})
