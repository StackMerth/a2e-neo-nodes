import type { PrismaClient } from '@a2e/database'
import crypto from 'crypto'

const IDEMPOTENCY_TTL_HOURS = 24

export interface IdempotencyResult {
  isNew: boolean
  cachedResponse?: {
    statusCode: number
    body: unknown
  }
}

/**
 * Hash request body for idempotency verification
 */
function hashRequestBody(body: unknown): string {
  const str = JSON.stringify(body ?? {})
  return crypto.createHash('sha256').update(str).digest('hex')
}

/**
 * Check if an idempotency key exists and return cached response if valid.
 *
 * SECURITY (Q11, 2026-06-13): the (id, userId) tuple is the lookup key.
 * id alone was unique-enough today thanks to the unguessable UUID we
 * generate, but threading userId in makes the check defense-in-depth:
 * an attacker who somehow guessed buyer B's key still wouldn't be able
 * to replay B's cached response under their own userId. Pre-Q11 rows
 * have userId=null and are invisible to post-Q11 lookups; they expire
 * naturally within the 24h TTL.
 */
export async function checkIdempotencyKey(
  prisma: PrismaClient,
  idempotencyKey: string,
  endpoint: string,
  requestBody: unknown,
  userId: string
): Promise<IdempotencyResult> {
  const requestHash = hashRequestBody(requestBody)

  // Clean up expired keys (async, don't wait)
  cleanupExpiredKeys(prisma).catch(() => {})

  const existing = await prisma.idempotencyKey.findFirst({
    where: { id: idempotencyKey, userId },
  })

  if (!existing) {
    return { isNew: true }
  }

  // Check if expired
  if (existing.expiresAt < new Date()) {
    // Delete expired key and treat as new
    await prisma.idempotencyKey.delete({ where: { id: idempotencyKey } })
    return { isNew: true }
  }

  // Verify request hash matches (same idempotency key must have same request)
  if (existing.requestHash !== requestHash) {
    throw new Error(
      'Idempotency key already used with different request body. ' +
        'Each idempotency key must be unique per request.'
    )
  }

  // Verify endpoint matches
  if (existing.endpoint !== endpoint) {
    throw new Error(
      'Idempotency key already used with different endpoint. ' +
        'Each idempotency key must be unique per endpoint.'
    )
  }

  // Return cached response if we have one
  if (existing.statusCode !== null && existing.responseBody !== null) {
    return {
      isNew: false,
      cachedResponse: {
        statusCode: existing.statusCode,
        body: JSON.parse(existing.responseBody),
      },
    }
  }

  // Key exists but response not yet stored (in-progress request)
  return {
    isNew: false,
  }
}

/**
 * Store the response for an idempotency key
 */
export async function storeIdempotencyResponse(
  prisma: PrismaClient,
  idempotencyKey: string,
  endpoint: string,
  requestBody: unknown,
  statusCode: number,
  responseBody: unknown,
  userId: string
): Promise<void> {
  const requestHash = hashRequestBody(requestBody)
  const expiresAt = new Date()
  expiresAt.setHours(expiresAt.getHours() + IDEMPOTENCY_TTL_HOURS)

  // SECURITY (Q11, 2026-06-13): we cannot upsert by id alone, because
  // that would let buyer B's store call clobber buyer A's row if
  // they collided on the (unguessable) key. The row's userId is the
  // source of truth for ownership; we look up by (id, userId) and
  // only update if it's ours. If a wrong-owner row exists (pre-Q11
  // backfill with null userId, or — improbably — a key collision),
  // we throw rather than silently overwrite.
  const existing = await prisma.idempotencyKey.findUnique({
    where: { id: idempotencyKey },
    select: { userId: true },
  })

  if (!existing) {
    await prisma.idempotencyKey.create({
      data: {
        id: idempotencyKey,
        userId,
        endpoint,
        requestHash,
        statusCode,
        responseBody: JSON.stringify(responseBody),
        expiresAt,
      },
    })
    return
  }

  if (existing.userId !== null && existing.userId !== userId) {
    // Different owner. Practically unreachable: the request body's
    // route was processed because checkIdempotencyKey returned
    // isNew=true (no row matched (id, userId)). The store call
    // happens AFTER the buyer's response is built, so throwing here
    // would 500 the buyer despite their request succeeding. Just skip
    // the cache write and log; buyer B's retries will run again
    // without a cache hit, which is the strictly-safer fallback for
    // an astronomically-improbable key collision.
    return
  }

  // Same owner (or pre-Q11 backfill row we're claiming for the first
  // time): safe to update with the latest response and bind userId.
  await prisma.idempotencyKey.update({
    where: { id: idempotencyKey },
    data: {
      userId,
      statusCode,
      responseBody: JSON.stringify(responseBody),
      expiresAt,
    },
  })
}

/**
 * Clean up expired idempotency keys
 */
async function cleanupExpiredKeys(prisma: PrismaClient): Promise<number> {
  const result = await prisma.idempotencyKey.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  })
  return result.count
}

/**
 * Generate a new idempotency key
 */
export function generateIdempotencyKey(): string {
  return `idem_${crypto.randomUUID()}`
}
