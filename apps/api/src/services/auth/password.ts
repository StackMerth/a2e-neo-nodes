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
  role: UserRole = 'NODE_RUNNER'
) {
  // Check if email is already taken
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new Error('Email already registered');
  }

  const passwordHash = await hashPassword(password);

  return prisma.user.create({
    data: {
      email,
      passwordHash,
      role,
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
