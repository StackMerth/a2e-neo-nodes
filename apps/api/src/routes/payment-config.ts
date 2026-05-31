/**
 * Open-to-any-authenticated-user payment-config endpoints.
 *
 * Why a separate file: the legacy /v1/buyer/balance/topup-destination
 * endpoint sits behind requireRole('COMPUTE_BUYER', 'ADMIN'), so a
 * pure NODE_RUNNER trying to fund a deploy with USDC gets 403 and the
 * UI shows "Topup destination not configured" even when the wallet is
 * fully set. The destination is the platform's custodial wallet; it's
 * the same address for every user and isn't sensitive (it's printed
 * in plaintext on the buyer balance page already). So we expose it
 * here under a role-agnostic route any logged-in user can call.
 *
 * The legacy buyer-side endpoint stays in place for backward compat;
 * both endpoints return the exact same shape.
 */

import type { FastifyInstance } from 'fastify'
import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import { getSolanaConfig } from '../services/payment/solana.js'

async function resolveTopupDestination(
  prisma: import('@a2e/database').PrismaClient,
): Promise<string | null> {
  const envWallet = process.env.SOLANA_TOPUP_WALLET?.trim()
  if (envWallet) return envWallet

  const config = await getSolanaConfig(prisma)
  if (!config.payerPrivateKey) return null

  try {
    const trimmed = config.payerPrivateKey.trim()
    let bytes: Uint8Array | null = null
    if (trimmed.startsWith('[')) {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed) && parsed.length === 64) bytes = Uint8Array.from(parsed)
    }
    if (!bytes && /^[1-9A-HJ-NP-Za-km-z]+$/.test(trimmed)) {
      try {
        const decoded = bs58.decode(trimmed)
        if (decoded.length === 64) bytes = Uint8Array.from(decoded)
      } catch {
        // fall through
      }
    }
    if (!bytes) {
      const buf = Buffer.from(trimmed, 'base64')
      if (buf.length === 64) bytes = Uint8Array.from(buf)
    }
    if (!bytes) return null
    return Keypair.fromSecretKey(bytes).publicKey.toBase58()
  } catch {
    return null
  }
}

export async function paymentConfigRoutes(fastify: FastifyInstance) {
  // Only authentication, no role gate. Any logged-in user (buyer,
  // operator, admin) can read the platform's topup destination.
  fastify.addHook('preHandler', fastify.authenticate)

  fastify.get('/v1/payment-config/topup-destination', async (_request, reply) => {
    const wallet = await resolveTopupDestination(fastify.prisma)
    const config = await getSolanaConfig(fastify.prisma)
    if (!wallet) {
      return reply.send({
        wallet: null,
        currency: 'USDC',
        network: config.devMode ? 'devnet' : 'mainnet',
        configured: false,
        message: 'Topup destination not configured. Contact support.',
      })
    }
    return reply.send({
      wallet,
      currency: 'USDC',
      network: config.devMode ? 'devnet' : 'mainnet',
      configured: true,
    })
  })
}
