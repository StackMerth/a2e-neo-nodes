import bcrypt from 'bcryptjs';
import { prisma } from '@a2e/database';
import type { UserRole } from '@a2e/database';

const SALT_ROUNDS = 12;

/**
 * Hash a password with bcrypt
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Verify a password against a hash
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Register a new user with email/password
 */
export async function registerUser(
  email: string,
  password: string,
  role: UserRole = 'NODE_RUNNER',
  signupIp: string | null = null,
) {
  // Check if email is already taken
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new Error('Email already registered');
  }

  const passwordHash = await hashPassword(password);

  // Dual-identity: flip the boolean flag that matches the chosen role.
  // role stays as the primary identity (the one shown in admin lists)
  // but day-to-day capability checks now read these booleans, and the
  // user can opt in to the other role later via Settings.
  const isBuyer = role === 'COMPUTE_BUYER' || role === 'CUSTOMER';
  const isNodeRunner = role === 'NODE_RUNNER';
  const isAdmin = role === 'ADMIN';

  return prisma.user.create({
    data: {
      email,
      passwordHash,
      role,
      isBuyer,
      isNodeRunner,
      isAdmin,
      // M5.7 anti-abuse: pinned so the referral attribution path can
      // compare the referee's signup IP against the referrer's.
      signupIp,
    },
  });
}

/**
 * Authenticate a user with email/password
 * Returns the user if credentials are valid, null otherwise
 */
export async function authenticateUser(email: string, password: string) {
  const user = await prisma.user.findUnique({
    where: { email },
    include: { nodeRunner: true },
  });

  if (!user || !user.passwordHash) {
    return null;
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return null;
  }

  return user;
}
