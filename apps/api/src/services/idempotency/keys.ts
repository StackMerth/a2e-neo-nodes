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
 * Check if an idempotency key exists and return cached response if valid
 */
export async function checkIdempotencyKey(
  prisma: PrismaClient,
  idempotencyKey: string,
  endpoint: string,
  requestBody: unknown
): Promise<IdempotencyResult> {
  const requestHash = hashRequestBody(requestBody)

  // Clean up expired keys (async, don't wait)
  cleanupExpiredKeys(prisma).catch(() => {})

  const existing = await prisma.idempotencyKey.findUnique({
    where: { id: idempotencyKey },
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
  responseBody: unknown
): Promise<void> {
  const requestHash = hashRequestBody(requestBody)
  const expiresAt = new Date()
  expiresAt.setHours(expiresAt.getHours() + IDEMPOTENCY_TTL_HOURS)

  await prisma.idempotencyKey.upsert({
    where: { id: idempotencyKey },
    create: {
      id: idempotencyKey,
      endpoint,
      requestHash,
      statusCode,
      responseBody: JSON.stringify(responseBody),
      expiresAt,
    },
    update: {
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
