/**
 * Shared resolver for the "where do capacity alerts go" recipient.
 *
 * Lets every capacity worker (cascade watcher, per-provider watchers,
 * cascade snapshot digest) share one master env var instead of each
 * provider carrying its own. Recipient precedence:
 *
 *   1. CAPACITY_WATCH_EMAIL          (new master, provider-agnostic)
 *   2. LAMBDA_CAPACITY_WATCH_EMAIL   (legacy fallback; existing deploys
 *                                     that already set this keep working)
 *
 * Provider-specific overrides (IONET_CAPACITY_WATCH_EMAIL,
 * VASTAI_CAPACITY_WATCH_EMAIL, RUNPOD_CAPACITY_WATCH_EMAIL,
 * CASCADE_SNAPSHOT_EMAIL) are still honored by the watchers that
 * read them — they short-circuit before reaching this helper. The
 * helper is for the COMMON case: one email covers all networks.
 */

export function resolveCapacityWatchRecipient(): string | null {
  const masterRaw = process.env.CAPACITY_WATCH_EMAIL?.trim()
  if (masterRaw) return masterRaw
  const legacyRaw = process.env.LAMBDA_CAPACITY_WATCH_EMAIL?.trim()
  if (legacyRaw) return legacyRaw
  return null
}
