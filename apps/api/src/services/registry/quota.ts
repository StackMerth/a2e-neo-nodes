/**
 * E6 / M3.10: Per-buyer Docker registry quota.
 *
 * Single source of truth for "is this user over their storage limit?".
 * Used by:
 *   - registry-token.ts pre-push check: denies push scope if the user
 *     is already at-or-near quota at the moment they request a token.
 *     Best-effort because Docker doesn't tell us the size up-front;
 *     a buyer right at the edge can still push one more image.
 *   - registry-webhook.ts post-push enforcement: after the upsert, if
 *     the user is now over quota, soft-delete the just-pushed image
 *     and notify them. The blobs stay in R2 (registry GC removes them
 *     on a schedule) but pulls fail and the row is hidden from listings.
 *
 * The quota is per-user and read from User.maxRegistryGb (Int, gigabytes).
 * Default 5 GB per the schema. Admin can tune via the dashboard or
 * direct SQL update.
 *
 * sizeBytes lives as BigInt on DockerImage because individual layers
 * can exceed 2 GB and the sum across an active workspace can hit TB
 * scale. Always carry the value as BigInt and convert to Number at
 * the very last moment for JSON serialisation; intermediate Number
 * conversions silently truncate above 2^53.
 */

import type { PrismaClient } from '@a2e/database'

const ONE_GB_BYTES = 1024n * 1024n * 1024n

/**
 * Headroom in bytes that the pre-push gate accepts. A buyer who is
 * within HEADROOM_BYTES of their quota gets denied; we'd rather over-
 * reject by a sliver than let a push start that we'll soft-delete
 * seconds later. 100 MB is one typical layer of a small container.
 */
const PRE_PUSH_HEADROOM_BYTES = 100n * 1024n * 1024n

export interface QuotaSnapshot {
  userId: string
  /** Per-user quota in bytes, derived from User.maxRegistryGb. */
  limitBytes: bigint
  /** Sum of sizeBytes across non-deleted DockerImage rows. */
  usedBytes: bigint
  /** Bytes still available before exceeding the quota. Never negative. */
  remainingBytes: bigint
  /** True when usedBytes >= limitBytes (no headroom check applied). */
  over: boolean
  /** Same as `over` but with the PRE_PUSH_HEADROOM_BYTES safety buffer. */
  shouldBlockPush: boolean
}

/**
 * Read the quota state for a given user. One DB query (the User row)
 * plus one aggregate over their non-deleted DockerImage rows. Both
 * indexed and cheap.
 */
export async function getQuotaSnapshot(
  prisma: PrismaClient,
  userId: string,
): Promise<QuotaSnapshot> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { maxRegistryGb: true },
  })
  // If the user row is missing the caller has bigger problems than
  // quota — return a snapshot that blocks everything so we fail safe.
  const gigabytes = user?.maxRegistryGb ?? 0
  const limitBytes = BigInt(gigabytes) * ONE_GB_BYTES

  const agg = await prisma.dockerImage.aggregate({
    where: { userId, deletedAt: null },
    _sum: { sizeBytes: true },
  })
  const usedBytes = (agg._sum.sizeBytes ?? 0n)

  // BigInt subtraction can go negative; clamp to zero so callers can
  // safely compare without sign tricks.
  const remainingBytes = usedBytes >= limitBytes ? 0n : limitBytes - usedBytes
  const over = usedBytes >= limitBytes
  const shouldBlockPush =
    usedBytes + PRE_PUSH_HEADROOM_BYTES >= limitBytes

  return { userId, limitBytes, usedBytes, remainingBytes, over, shouldBlockPush }
}

/**
 * JSON-safe view of a quota snapshot. BigInts are converted to Number
 * here; for any realistic quota (single-digit TB) this fits in a
 * Number losslessly. We also carry the GB-rounded view for buyer-
 * friendly display.
 */
export function quotaSnapshotToJson(snapshot: QuotaSnapshot) {
  return {
    userId: snapshot.userId,
    limitBytes: Number(snapshot.limitBytes),
    usedBytes: Number(snapshot.usedBytes),
    remainingBytes: Number(snapshot.remainingBytes),
    over: snapshot.over,
    // Buyer-friendly: usage as a fraction so the portal can render a
    // progress bar without doing the division.
    fractionUsed: snapshot.limitBytes === 0n
      ? 1
      : Number(snapshot.usedBytes * 1000n / snapshot.limitBytes) / 1000,
  }
}
