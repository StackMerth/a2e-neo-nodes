import crypto from 'crypto'
import { prisma } from '@a2e/database'

const KEY_PREFIX = 'a2e-buyer-'

/**
 * Generate a new API key for a user
 */
export async function generateApiKey(
  userId: string,
  name: string,
  permissions: string[] = ['compute:read', 'compute:write'],
  expiresAt?: Date,
) {
  const rawKey = crypto.randomBytes(32).toString('base64url')
  const key = `${KEY_PREFIX}${rawKey}`

  const apiKey = await prisma.apiKey.create({
    data: {
      key,
      name,
      userId,
      permissions,
      expiresAt,
    },
  })

  // Return the full key only once — it's not stored in readable form after this
  return { id: apiKey.id, key, name: apiKey.name, permissions: apiKey.permissions, createdAt: apiKey.createdAt, expiresAt: apiKey.expiresAt }
}

/**
 * Verify an API key and return the associated user
 */
export async function verifyApiKey(key: string) {
  const apiKey = await prisma.apiKey.findUnique({
    where: { key },
    include: { user: { select: { id: true, role: true, email: true } } },
  })

  if (!apiKey) return null
  if (apiKey.revokedAt) return null
  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) return null

  // Update last used
  await prisma.apiKey.update({
    where: { id: apiKey.id },
    data: { lastUsedAt: new Date() },
  }).catch(() => {}) // Non-blocking

  return { userId: apiKey.userId, role: apiKey.user.role, keyId: apiKey.id, permissions: apiKey.permissions }
}

/**
 * Revoke an API key
 */
export async function revokeApiKey(keyId: string, userId: string) {
  const apiKey = await prisma.apiKey.findFirst({
    where: { id: keyId, userId },
  })

  if (!apiKey) return null

  return prisma.apiKey.update({
    where: { id: keyId },
    data: { revokedAt: new Date() },
  })
}

/**
 * List active API keys for a user (masked)
 */
export async function listApiKeys(userId: string) {
  const keys = await prisma.apiKey.findMany({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, name: true, permissions: true,
      lastUsedAt: true, expiresAt: true, createdAt: true,
      key: true,
    },
  })

  // Mask the key — show only last 8 characters
  return keys.map(k => ({
    ...k,
    key: `${'•'.repeat(20)}${k.key.slice(-8)}`,
  }))
}

/**
 * Check if a string looks like a buyer API key
 */
export function isBuyerApiKey(key: string): boolean {
  return key.startsWith(KEY_PREFIX)
}
