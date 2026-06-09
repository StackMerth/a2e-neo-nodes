import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { prisma } from '@a2e/database';
import type { UserRole } from '@a2e/database';

/**
 * Resolve the JWT signing secret.
 *
 * SECURITY (pen-test 2026-06-09 defense-in-depth): the previous
 * inline `process.env.JWT_SECRET || 'a2e-dev-secret-change-in-production'`
 * fallback meant that if Render env's JWT_SECRET ever disappeared
 * (config wipe, typo on another var, service migration), the API
 * would silently boot and sign tokens with a string that is public
 * in the repo. Anyone could then forge an ADMIN JWT. This getter
 * shifts the failure mode: in production the boot crashes with a
 * loud error; the bad config cannot ship.
 *
 * Exported so apps/api/src/routes/auth.ts uses the same resolution
 * and there is one source of truth.
 */
export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[auth] JWT_SECRET env var is REQUIRED in production. ' +
        'Refusing to boot with a fallback secret because that would let ' +
        'anyone with source access forge JWTs (the fallback string would ' +
        'be public in the repo). Set JWT_SECRET in Render env and redeploy.',
    );
  }
  // Dev only: log a one-time warning and use a stable hardcoded value
  // so tokens survive across reloads. Not a security risk; dev tokens
  // are useless against prod which has a different secret.
  console.warn(
    '[auth] JWT_SECRET not set in non-production env; using a local dev fallback. ' +
      'Do not ship this to a production-like environment.',
  );
  return 'a2e-dev-only-fallback-do-not-deploy';
}

const JWT_SECRET = getJwtSecret();
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY_DAYS = 7;

export interface AccessTokenPayload {
  userId: string;
  role: UserRole;
  type: 'access';
}

export interface RefreshTokenPayload {
  userId: string;
  tokenId: string;
  type: 'refresh';
}

/**
 * Generate a short-lived access token (15 minutes)
 */
export function generateAccessToken(userId: string, role: UserRole): string {
  const payload: AccessTokenPayload = { userId, role, type: 'access' };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
}

/**
 * Generate a long-lived refresh token (7 days) and persist it
 */
export async function generateRefreshToken(userId: string): Promise<string> {
  const token = crypto.randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  await prisma.refreshToken.create({
    data: {
      userId,
      token,
      expiresAt,
    },
  });

  return token;
}

/**
 * Verify an access token and return the decoded payload
 */
export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, JWT_SECRET) as AccessTokenPayload;

  if (decoded.type !== 'access') {
    throw new Error('Invalid token type');
  }

  return decoded;
}

/**
 * Revoke a refresh token by setting revokedAt
 */
export async function revokeRefreshToken(token: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { token, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Revoke all refresh tokens for a user (logout everywhere)
 */
export async function revokeAllUserTokens(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Rotate a refresh token — revoke the old one, generate a new pair
 * Returns new access token + refresh token
 */
export async function rotateRefreshToken(oldToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
} | null> {
  // Find the existing token
  const existing = await prisma.refreshToken.findUnique({
    where: { token: oldToken },
    include: { user: true },
  });

  if (!existing || existing.revokedAt || existing.expiresAt < new Date()) {
    return null;
  }

  // Revoke the old token
  await prisma.refreshToken.update({
    where: { id: existing.id },
    data: { revokedAt: new Date() },
  });

  // Generate new tokens
  const accessToken = generateAccessToken(existing.userId, existing.user.role);
  const refreshToken = await generateRefreshToken(existing.userId);

  return { accessToken, refreshToken };
}

/**
 * Clean up expired refresh tokens (run periodically)
 */
export async function cleanupExpiredTokens(): Promise<number> {
  const result = await prisma.refreshToken.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date() } },
        { revokedAt: { not: null } },
      ],
    },
  });
  return result.count;
}
