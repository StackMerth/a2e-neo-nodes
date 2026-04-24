// Currency Rate Oracle (F4.2)
//
// Provides USD equivalents for the native currencies used by external compute
// markets. Today we sell to markets that report costs in mixed units:
//
//   AKASH  → AKT (Akash Network token, floating USD price)
//   IONET  → CREDITS (IO.net credits, 1:1 USD in the seller dashboard)
//   VASTAI → USD (already USD, handled natively)
//
// The earnings calculator (F4.2) writes to the Earning table in USD, so any
// cost/earning figures returned by adapters in native units must be converted.
// In simulation mode the adapters already compute `accumulatedUsd` directly, so
// this oracle is not hit on the hot path. It exists so that when live-mode
// adapters come online (post-M7), conversion has a single, cached, review-
// flaggable entry point rather than scattered fetches.
//
// Design notes:
//   - AKT is the only rate we actually fetch. USD and CREDITS are "native" in
//     our model and always return usdPerUnit = 1 without any I/O.
//   - Successful AKT fetches are cached for `cacheTtlMs` (default 5 minutes).
//     Fallback results are intentionally NOT cached — we want the next call to
//     retry CoinGecko rather than pin a stale fallback number.
//   - `shouldFlagForReview` exposes a boolean so downstream code (reconciler,
//     admin UI) can surface a "needs review" badge without re-inspecting the
//     source enum.

export type RateCurrency = 'AKT' | 'USD' | 'CREDITS'

export type RateSource = 'coingecko' | 'fallback' | 'cache' | 'native'

export interface RateQuote {
  currency: RateCurrency
  /** USD value per 1 unit of the currency. */
  usdPerUnit: number
  fetchedAt: Date
  /** True when the quote came from cache past TTL or from the hardcoded fallback. */
  stale: boolean
  source: RateSource
}

export interface CurrencyRateOracleOptions {
  /** How long a successful CoinGecko fetch is considered fresh. Default 5 minutes. */
  cacheTtlMs?: number
  /** USD/AKT rate used when CoinGecko is unreachable. Default 3.50. */
  fallbackAktUsd?: number
  /** Injectable fetch for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** CoinGecko simple-price endpoint (overridable for tests). */
  coingeckoEndpoint?: string
  /** Abort fetch after this many ms. Default 5000. */
  fetchTimeoutMs?: number
}

interface CachedEntry {
  usdPerUnit: number
  fetchedAt: Date
}

const DEFAULT_CACHE_TTL_MS = 5 * 60_000
const DEFAULT_FALLBACK_AKT_USD = 3.5
const DEFAULT_COINGECKO_ENDPOINT =
  'https://api.coingecko.com/api/v3/simple/price'
const DEFAULT_FETCH_TIMEOUT_MS = 5_000
const AKT_COINGECKO_ID = 'akash-network'

interface CoinGeckoResponse {
  [id: string]: { usd?: number } | undefined
}

export class CurrencyRateOracle {
  private readonly cacheTtlMs: number
  private readonly fallbackAktUsd: number
  private readonly fetchImpl: typeof fetch
  private readonly coingeckoEndpoint: string
  private readonly fetchTimeoutMs: number
  private readonly cache = new Map<RateCurrency, CachedEntry>()

  constructor(options: CurrencyRateOracleOptions = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.fallbackAktUsd = options.fallbackAktUsd ?? DEFAULT_FALLBACK_AKT_USD
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.coingeckoEndpoint =
      options.coingeckoEndpoint ?? DEFAULT_COINGECKO_ENDPOINT
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  }

  /**
   * Resolve a USD rate for the given currency. Never throws — on failure the
   * oracle returns a fallback quote with `stale: true` so callers can decide
   * whether to proceed or flag the record for manual review.
   */
  async getUsdPerUnit(currency: RateCurrency): Promise<RateQuote> {
    const now = new Date()

    if (currency === 'USD' || currency === 'CREDITS') {
      return {
        currency,
        usdPerUnit: 1,
        fetchedAt: now,
        stale: false,
        source: 'native',
      }
    }

    // AKT path.
    const cached = this.cache.get(currency)
    if (cached && now.getTime() - cached.fetchedAt.getTime() < this.cacheTtlMs) {
      return {
        currency,
        usdPerUnit: cached.usdPerUnit,
        fetchedAt: cached.fetchedAt,
        stale: false,
        source: 'cache',
      }
    }

    const fetched = await this.fetchAktUsd()
    if (fetched !== null) {
      const fetchedAt = new Date()
      this.cache.set(currency, { usdPerUnit: fetched, fetchedAt })
      return {
        currency,
        usdPerUnit: fetched,
        fetchedAt,
        stale: false,
        source: 'coingecko',
      }
    }

    return {
      currency,
      usdPerUnit: this.fallbackAktUsd,
      fetchedAt: new Date(),
      stale: true,
      source: 'fallback',
    }
  }

  /**
   * True when the quote is either explicitly stale (cache-past-TTL scenarios
   * we currently never return — left for future expansion) or derived from the
   * hardcoded fallback. Fresh CoinGecko and cached CoinGecko results, as well
   * as native USD/CREDITS quotes, are safe to use without review.
   */
  static shouldFlagForReview(quote: RateQuote): boolean {
    return quote.stale || quote.source === 'fallback'
  }

  /** Drop all cached quotes. Intended for tests. */
  clearCache(): void {
    this.cache.clear()
  }

  private async fetchAktUsd(): Promise<number | null> {
    const url = `${this.coingeckoEndpoint}?ids=${AKT_COINGECKO_ID}&vs_currencies=usd`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.fetchTimeoutMs)

    try {
      const response = await this.fetchImpl(url, { signal: controller.signal })
      if (!response.ok) {
        return null
      }
      const data = (await response.json()) as CoinGeckoResponse
      const entry = data[AKT_COINGECKO_ID]
      const usd = entry?.usd
      if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) {
        return null
      }
      return usd
    } catch {
      return null
    } finally {
      clearTimeout(timeout)
    }
  }
}
