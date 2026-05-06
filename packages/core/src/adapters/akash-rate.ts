/**
 * AKT → USD spot price lookup.
 *
 * Used by the Akash adapter's getDeploymentCost to convert lease prices
 * (denominated in uakt per block) into the USD figures the rest of the
 * platform speaks. Source: CoinGecko's free public endpoint.
 *
 * Cache lifetime is 5 minutes — well below the price oscillation we'd want
 * to react to and well above CoinGecko's free-tier rate limit (50 req/min).
 * Falls back to a hardcoded estimate if the API is unreachable so a network
 * blip doesn't take down billing.
 */

const COINGECKO_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=akash-network&vs_currencies=usd'
const CACHE_TTL_MS = 5 * 60 * 1000
const FALLBACK_AKT_USD = 3.5

interface RateCacheEntry {
  usd: number
  fetchedAtMs: number
}

let cache: RateCacheEntry | null = null

interface CoingeckoResponse {
  'akash-network'?: { usd?: number }
}

/**
 * Returns the current AKT/USD price, in USD. Uses a 5-minute in-memory
 * cache. On CoinGecko failure, returns a hardcoded estimate ($3.50/AKT) so
 * the calling code can continue producing best-effort cost numbers.
 */
export async function getAktUsdRate(options: { signal?: AbortSignal } = {}): Promise<number> {
  if (cache && Date.now() - cache.fetchedAtMs < CACHE_TTL_MS) {
    return cache.usd
  }

  try {
    const response = await fetch(COINGECKO_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: options.signal ?? AbortSignal.timeout(5000),
    })
    if (!response.ok) {
      return cache?.usd ?? FALLBACK_AKT_USD
    }
    const data = (await response.json()) as CoingeckoResponse
    const usd = data['akash-network']?.usd
    if (typeof usd === 'number' && usd > 0 && Number.isFinite(usd)) {
      cache = { usd, fetchedAtMs: Date.now() }
      return usd
    }
    return cache?.usd ?? FALLBACK_AKT_USD
  } catch {
    return cache?.usd ?? FALLBACK_AKT_USD
  }
}

/**
 * Convert a uakt amount (1 AKT = 1,000,000 uakt) to USD using the cached
 * spot price. Useful for quoting deployment costs in the dashboard.
 */
export async function convertUaktToUsd(uakt: number): Promise<number> {
  const usdPerAkt = await getAktUsdRate()
  return (uakt / 1_000_000) * usdPerAkt
}

/**
 * Test-only — reset the in-memory cache between unit-test runs.
 */
export function _resetAktUsdCacheForTests(): void {
  cache = null
}
