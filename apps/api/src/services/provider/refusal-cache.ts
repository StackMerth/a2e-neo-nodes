/**
 * Provider refusal cache.
 *
 * Lightweight Redis-backed memory of "this provider refused to supply
 * this GPU tier recently." Powers two improvements:
 *
 *   1. Reroute ladder (apps/api/src/jobs/provisioning-reroute.ts) reads
 *      the cache BEFORE attempting each rung and skips known-empty
 *      providers. Saves the broker round-trip on every reroute that
 *      would otherwise re-discover the same refusal.
 *
 *   2. Compute allocator (apps/api/src/jobs/compute-allocator.ts) uses
 *      the cache to deprioritize providers we know are out of supply
 *      for the requested tier. The initial routing decision benefits
 *      from the same intelligence the reroute already gathered.
 *
 * Key shape:
 *   provider-refusal:<PROVIDER>:<TIER>
 *
 * Value semantics:
 *   Presence-only. Existence of the key means "refused within the
 *   last TTL window." Value is a JSON snapshot { ts, reason } for
 *   ops visibility but the cache is read as a boolean.
 *
 * TTL:
 *   PROVIDER_REFUSAL_TTL_SECONDS (default 600 = 10 min). Short enough
 *   that real supply rotation re-opens the provider quickly; long
 *   enough that we don't waste round-trips on every tick during a
 *   genuine outage. Self-clearing via Redis EXPIRE.
 *
 * Failure mode:
 *   All operations swallow Redis errors. A failed cache write means
 *   the next request will re-discover the refusal (one wasted round-
 *   trip). A failed cache read means we treat the provider as not
 *   refused (best-case assumption). Cache is an optimization layer,
 *   never a correctness gate.
 *
 * Manual override:
 *   clearRefusal(provider, tier) lets ops force a re-try. Useful when
 *   a provider has come back up before the TTL expired.
 */

import type { Redis } from 'ioredis'

const REFUSAL_TTL_SECONDS = parseInt(
  process.env.PROVIDER_REFUSAL_TTL_SECONDS ?? '600',
  10,
)

const KEY_PREFIX = 'provider-refusal'

function key(provider: string, tier: string): string {
  return `${KEY_PREFIX}:${provider}:${tier}`
}

interface RefusalSnapshot {
  ts: string
  reason: string
}

/**
 * Record that a provider just refused to supply a given tier. Idempotent
 * (re-writing extends the TTL window). Errors are swallowed; the cache
 * is an optimization, not a correctness guarantee.
 */
export async function recordRefusal(
  redis: Redis,
  provider: string,
  tier: string,
  reason: string,
): Promise<void> {
  try {
    const snapshot: RefusalSnapshot = {
      ts: new Date().toISOString(),
      reason: reason.slice(0, 500),
    }
    await redis.set(
      key(provider, tier),
      JSON.stringify(snapshot),
      'EX',
      REFUSAL_TTL_SECONDS,
    )
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[refusal-cache] failed to record ${provider}/${tier}:`,
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * Check whether a provider+tier was refused within the TTL window.
 * Returns the snapshot when refused (for logging) or null when not.
 * On error, returns null (treat as not refused — best-case assumption).
 */
export async function getRefusal(
  redis: Redis,
  provider: string,
  tier: string,
): Promise<RefusalSnapshot | null> {
  try {
    const raw = await redis.get(key(provider, tier))
    if (!raw) return null
    return JSON.parse(raw) as RefusalSnapshot
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[refusal-cache] failed to read ${provider}/${tier}:`,
      err instanceof Error ? err.message : err,
    )
    return null
  }
}

/**
 * Convenience: boolean check. Equivalent to (await getRefusal()) !== null.
 */
export async function isRefused(
  redis: Redis,
  provider: string,
  tier: string,
): Promise<boolean> {
  return (await getRefusal(redis, provider, tier)) !== null
}

/**
 * Manual override — drops the refusal entry so the next request will
 * retry the provider. Exposed for admin tooling; not used by workers.
 */
export async function clearRefusal(
  redis: Redis,
  provider: string,
  tier: string,
): Promise<void> {
  try {
    await redis.del(key(provider, tier))
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[refusal-cache] failed to clear ${provider}/${tier}:`,
      err instanceof Error ? err.message : err,
    )
  }
}
