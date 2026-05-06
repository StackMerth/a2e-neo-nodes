import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetAktUsdCacheForTests, convertUaktToUsd, getAktUsdRate } from '../adapters/akash-rate'

const realFetch = globalThis.fetch

describe('getAktUsdRate', () => {
  beforeEach(() => {
    _resetAktUsdCacheForTests()
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    vi.restoreAllMocks()
    _resetAktUsdCacheForTests()
  })

  it('returns the spot price reported by CoinGecko', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ 'akash-network': { usd: 4.21 } }), { status: 200 })
    ) as unknown as typeof fetch
    const rate = await getAktUsdRate()
    expect(rate).toBe(4.21)
  })

  it('caches the rate and avoids a second network call within 5 minutes', async () => {
    const spy = vi.fn(async () =>
      new Response(JSON.stringify({ 'akash-network': { usd: 3.7 } }), { status: 200 })
    )
    globalThis.fetch = spy as unknown as typeof fetch

    const a = await getAktUsdRate()
    const b = await getAktUsdRate()
    expect(a).toBe(3.7)
    expect(b).toBe(3.7)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('returns the fallback when CoinGecko returns a non-2xx response', async () => {
    globalThis.fetch = vi.fn(async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch
    const rate = await getAktUsdRate()
    expect(rate).toBe(3.5)
  })

  it('returns the fallback when the network throws', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('connection refused')
    }) as unknown as typeof fetch
    const rate = await getAktUsdRate()
    expect(rate).toBe(3.5)
  })

  it('returns the fallback when the response shape is malformed', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ unrelated: 'garbage' }), { status: 200 })
    ) as unknown as typeof fetch
    const rate = await getAktUsdRate()
    expect(rate).toBe(3.5)
  })
})

describe('convertUaktToUsd', () => {
  beforeEach(() => {
    _resetAktUsdCacheForTests()
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    _resetAktUsdCacheForTests()
  })

  it('converts uakt to USD using the live AKT rate', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ 'akash-network': { usd: 4 } }), { status: 200 })
    ) as unknown as typeof fetch
    // 5 AKT = 5_000_000 uakt → @ $4/AKT = $20
    const usd = await convertUaktToUsd(5_000_000)
    expect(usd).toBe(20)
  })
})
