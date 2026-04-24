// Currency Rate Oracle Tests (F4.2)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { CurrencyRateOracle, type RateQuote } from '../currency-rate-oracle'

function makeFetchResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as unknown as Response
}

describe('CurrencyRateOracle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-21T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('native currencies', () => {
    it('returns usdPerUnit=1 for USD without invoking fetch', async () => {
      const fetchImpl = vi.fn()
      const oracle = new CurrencyRateOracle({
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })

      const quote = await oracle.getUsdPerUnit('USD')

      expect(quote.currency).toBe('USD')
      expect(quote.usdPerUnit).toBe(1)
      expect(quote.stale).toBe(false)
      expect(quote.source).toBe('native')
      expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('returns usdPerUnit=1 for CREDITS without invoking fetch', async () => {
      const fetchImpl = vi.fn()
      const oracle = new CurrencyRateOracle({
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })

      const quote = await oracle.getUsdPerUnit('CREDITS')

      expect(quote.currency).toBe('CREDITS')
      expect(quote.usdPerUnit).toBe(1)
      expect(quote.stale).toBe(false)
      expect(quote.source).toBe('native')
      expect(fetchImpl).not.toHaveBeenCalled()
    })
  })

  describe('AKT fetching and caching', () => {
    it('fetches AKT from CoinGecko and reports source=coingecko', async () => {
      const fetchImpl = vi.fn(async (_url: string) =>
        makeFetchResponse({ 'akash-network': { usd: 2.85 } }),
      )
      const oracle = new CurrencyRateOracle({
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })

      const quote = await oracle.getUsdPerUnit('AKT')

      expect(fetchImpl).toHaveBeenCalledTimes(1)
      const firstCall = fetchImpl.mock.calls[0]
      expect(firstCall).toBeDefined()
      expect(firstCall?.[0]).toContain('ids=akash-network')
      expect(firstCall?.[0]).toContain('vs_currencies=usd')
      expect(quote.currency).toBe('AKT')
      expect(quote.usdPerUnit).toBe(2.85)
      expect(quote.stale).toBe(false)
      expect(quote.source).toBe('coingecko')
    })

    it('serves cached AKT within TTL and does not refetch', async () => {
      const fetchImpl = vi.fn(async () =>
        makeFetchResponse({ 'akash-network': { usd: 2.85 } }),
      )
      const oracle = new CurrencyRateOracle({
        cacheTtlMs: 5 * 60_000,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })

      const first = await oracle.getUsdPerUnit('AKT')
      expect(first.source).toBe('coingecko')

      // Advance 2 minutes — still within the 5 minute TTL.
      vi.advanceTimersByTime(2 * 60_000)

      const second = await oracle.getUsdPerUnit('AKT')

      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect(second.source).toBe('cache')
      expect(second.stale).toBe(false)
      expect(second.usdPerUnit).toBe(2.85)
    })

    it('refetches AKT after TTL expires', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(makeFetchResponse({ 'akash-network': { usd: 2.85 } }))
        .mockResolvedValueOnce(makeFetchResponse({ 'akash-network': { usd: 3.12 } }))

      const oracle = new CurrencyRateOracle({
        cacheTtlMs: 5 * 60_000,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })

      const first = await oracle.getUsdPerUnit('AKT')
      expect(first.source).toBe('coingecko')
      expect(first.usdPerUnit).toBe(2.85)

      // Advance past TTL.
      vi.advanceTimersByTime(6 * 60_000)

      const second = await oracle.getUsdPerUnit('AKT')

      expect(fetchImpl).toHaveBeenCalledTimes(2)
      expect(second.source).toBe('coingecko')
      expect(second.usdPerUnit).toBe(3.12)
    })

    it('returns fallback with stale=true when fetch throws, does not cache', async () => {
      const fetchImpl = vi
        .fn()
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValueOnce(makeFetchResponse({ 'akash-network': { usd: 2.85 } }))

      const oracle = new CurrencyRateOracle({
        fallbackAktUsd: 3.5,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })

      const first = await oracle.getUsdPerUnit('AKT')
      expect(first.source).toBe('fallback')
      expect(first.stale).toBe(true)
      expect(first.usdPerUnit).toBe(3.5)

      // Fallback should NOT be cached — next call must retry CoinGecko.
      const second = await oracle.getUsdPerUnit('AKT')
      expect(fetchImpl).toHaveBeenCalledTimes(2)
      expect(second.source).toBe('coingecko')
      expect(second.usdPerUnit).toBe(2.85)
    })

    it('returns fallback when CoinGecko responds with non-ok status', async () => {
      const fetchImpl = vi.fn(async () =>
        makeFetchResponse({ error: 'rate limited' }, false),
      )
      const oracle = new CurrencyRateOracle({
        fallbackAktUsd: 3.5,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })

      const quote = await oracle.getUsdPerUnit('AKT')

      expect(quote.source).toBe('fallback')
      expect(quote.stale).toBe(true)
      expect(quote.usdPerUnit).toBe(3.5)
    })

    it('returns fallback when CoinGecko payload is malformed', async () => {
      const fetchImpl = vi.fn(async () =>
        makeFetchResponse({ 'akash-network': { usd: 'not a number' } }),
      )
      const oracle = new CurrencyRateOracle({
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })

      const quote = await oracle.getUsdPerUnit('AKT')

      expect(quote.source).toBe('fallback')
      expect(quote.stale).toBe(true)
    })

    it('clearCache forces a refetch on the next AKT call', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(makeFetchResponse({ 'akash-network': { usd: 2.85 } }))

      const oracle = new CurrencyRateOracle({
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })

      await oracle.getUsdPerUnit('AKT')
      await oracle.getUsdPerUnit('AKT')
      expect(fetchImpl).toHaveBeenCalledTimes(1)

      oracle.clearCache()

      await oracle.getUsdPerUnit('AKT')
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    })
  })

  describe('shouldFlagForReview', () => {
    const base: Omit<RateQuote, 'source' | 'stale'> = {
      currency: 'AKT',
      usdPerUnit: 2.85,
      fetchedAt: new Date(),
    }

    it('flags fallback quotes', () => {
      const quote: RateQuote = { ...base, source: 'fallback', stale: true }
      expect(CurrencyRateOracle.shouldFlagForReview(quote)).toBe(true)
    })

    it('flags any stale quote regardless of source', () => {
      const quote: RateQuote = { ...base, source: 'cache', stale: true }
      expect(CurrencyRateOracle.shouldFlagForReview(quote)).toBe(true)
    })

    it('does not flag fresh coingecko quotes', () => {
      const quote: RateQuote = { ...base, source: 'coingecko', stale: false }
      expect(CurrencyRateOracle.shouldFlagForReview(quote)).toBe(false)
    })

    it('does not flag cache quotes within TTL', () => {
      const quote: RateQuote = { ...base, source: 'cache', stale: false }
      expect(CurrencyRateOracle.shouldFlagForReview(quote)).toBe(false)
    })

    it('does not flag native USD/CREDITS quotes', () => {
      const usd: RateQuote = { ...base, currency: 'USD', source: 'native', stale: false }
      const credits: RateQuote = { ...base, currency: 'CREDITS', source: 'native', stale: false }
      expect(CurrencyRateOracle.shouldFlagForReview(usd)).toBe(false)
      expect(CurrencyRateOracle.shouldFlagForReview(credits)).toBe(false)
    })
  })
})
