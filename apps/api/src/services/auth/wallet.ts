import crypto from 'crypto';
import { PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { prisma } from '@a2e/database';

// In-memory nonce store with TTL (5 minutes)
const nonceStore = new Map<string, { nonce: string; expiresAt: number }>();
const NONCE_TTL_MS = 5 * 60 * 1000;

/**
 * Generate a nonce for wallet signature verification
 */
export function generateNonce(walletAddress: string): string {
  const nonce = crypto.randomBytes(32).toString('base64url');
  nonceStore.set(walletAddress, {
    nonce,
    expiresAt: Date.now() + NONCE_TTL_MS,
  });

  // Cleanup expired nonces periodically
  if (nonceStore.size > 1000) {
    const now = Date.now();
    for (const [key, val] of nonceStore) {
      if (val.expiresAt < now) nonceStore.delete(key);
    }
  }

  return nonce;
}

/**
 * Verify a Solana wallet signature against a nonce
 */
export function verifyWalletSignature(
  walletAddress: string,
  signature: string,
  nonce: string
): boolean {
  // Check nonce validity
  const stored = nonceStore.get(walletAddress);
  if (!stored || stored.nonce !== nonce || stored.expiresAt < Date.now()) {
    return false;
  }

  // Consume the nonce (single-use)
  nonceStore.delete(walletAddress);

  try {
    // Build the message the wallet signed
    const message = new TextEncoder().encode(
      `Sign this message to authenticate with A²E Engine.\n\nNonce: ${nonce}`
    );

    // Decode the signature from base58 or base64
    let signatureBytes: Uint8Array;
    try {
      signatureBytes = Buffer.from(signature, 'base64');
    } catch {
      // Try base58 decode (Phantom sends base58)
      signatureBytes = bs58Decode(signature);
    }

    // Verify using the wallet's public key
    const publicKey = new PublicKey(walletAddress);
    return nacl.sign.detached.verify(message, signatureBytes, publicKey.toBytes());
  } catch {
    return false;
  }
}

/**
 * Find or create a User by wallet address.
 * Also auto-links to existing NodeRunner if one exists with the same wallet.
 */
export async function findOrCreateUserByWallet(walletAddress: string) {
  // Check if user already exists
  let user = await prisma.user.findUnique({
    where: { walletAddress },
    include: { nodeRunner: true },
  });

  if (user) {
    return user;
  }

  // Check if a NodeRunner exists with this wallet (created via admin dashboard)
  const existingNodeRunner = await prisma.nodeRunner.findUnique({
    where: { walletAddress },
  });

  // Create user + link to NodeRunner in a transaction
  user = await prisma.user.create({
    data: {
      walletAddress,
      role: 'NODE_RUNNER',
      nodeRunner: existingNodeRunner
        ? { connect: { id: existingNodeRunner.id } }
        : undefined,
    },
    include: { nodeRunner: true },
  });

  return user;
}

/**
 * Link a User to an existing NodeRunner profile by wallet address
 */
export async function linkWalletToNodeRunner(userId: string, walletAddress: string) {
  const nodeRunner = await prisma.nodeRunner.findUnique({
    where: { walletAddress },
  });

  if (!nodeRunner) {
    return null;
  }

  if (nodeRunner.userId && nodeRunner.userId !== userId) {
    throw new Error('NodeRunner already linked to another user');
  }

  return prisma.nodeRunner.update({
    where: { id: nodeRunner.id },
    data: { userId },
  });
}

/**
 * Simple base58 decoder (for Phantom wallet signatures)
 */
function bs58Decode(str: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const BASE = BigInt(58);

  let result = BigInt(0);
  for (const char of str) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Invalid base58 character: ${char}`);
    result = result * BASE + BigInt(index);
  }

  const bytes: number[] = [];
  while (result > 0n) {
    bytes.unshift(Number(result % 256n));
    result = result / 256n;
  }

  // Handle leading zeros
  for (const char of str) {
    if (char === '1') bytes.unshift(0);
    else break;
  }

  return new Uint8Array(bytes);
}
