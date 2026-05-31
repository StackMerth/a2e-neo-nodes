/**
 * Buyer credit-balance endpoints. Lets a buyer pre-load USD-denominated
 * credit by sending USDC (or SOL) to the platform's custodial wallet,
 * then drain that balance as they create compute rentals. Replaces the
 * "fresh txHash per rental" friction with a one-time topup flow.
 *
 * Endpoints:
 *   GET  /v1/buyer/balance                — current balance snapshot
 *   GET  /v1/buyer/balance/transactions   — paginated ledger
 *   GET  /v1/buyer/balance/topup-destination — admin wallet address to send to
 *   POST /v1/buyer/balance/topup-solana   — submit txHash, verify, credit
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import {
  getOrCreateBalance,
  creditBalance,
  getTransactions,
  DuplicateTransactionError,
} from '../services/balance/balance-service'
import { getSolanaConfig, verifyTransaction } from '../services/payment/solana'
import { createTopupCheckoutSession, isStripeConfigured } from '../services/payment/stripe'
import { createNotification } from '../services/notification/service.js'

const PORTAL_URL = process.env.PORTAL_URL ?? 'https://user.tokenos.ai'

/**
 * Derive the topup destination wallet. Preference order:
 *   1. SOLANA_TOPUP_WALLET env var (explicit override)
 *   2. Public key derived from the payer private key (custodial setup
 *      where the same wallet receives topups and sends payouts)
 *   3. null — signals "topup not yet configured" to the UI
 */
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

const topupSchema = z.object({
  // Real Solana signatures are 87-88 chars base58. The 10-char floor
  // is intentionally low so dev mocks like `DEV_test_topup_001` pass
  // validation (verifyTransaction auto-verifies anything starting
  // with DEV_ when PAYMENT_MODE != live).
  txHash: z.string().trim().min(10).max(200),
  amountUsd: z.number().positive().max(100000),
  note: z.string().trim().max(500).optional(),
})

const txQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
})

export async function buyerBalanceRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate)
  fastify.addHook('preHandler', fastify.requireRole('COMPUTE_BUYER', 'ADMIN'))

  /**
   * GET /v1/buyer/balance — current balance snapshot
   */
  fastify.get('/v1/buyer/balance', async (request, reply) => {
    const userId = request.user!.userId
    const snapshot = await getOrCreateBalance(fastify.prisma, userId)
    reply.send({
      balanceUsd: snapshot.balanceUsd,
      totalToppedUp: snapshot.totalToppedUp,
      totalSpent: snapshot.totalSpent,
      totalRefunded: snapshot.totalRefunded,
      currency: 'USD',
    })
  })

  /**
   * GET /v1/buyer/balance/transactions — paginated ledger
   */
  fastify.get('/v1/buyer/balance/transactions', async (request, reply) => {
    const parse = txQuerySchema.safeParse(request.query)
    if (!parse.success) {
      reply.status(400).send({ error: 'invalid_query', detail: parse.error.format() })
      return
    }
    const userId = request.user!.userId
    const rows = await getTransactions(fastify.prisma, userId, parse.data)
    reply.send({ transactions: rows })
  })

  /**
   * GET /v1/buyer/balance/topup-destination — wallet to send USDC to
   */
  fastify.get('/v1/buyer/balance/topup-destination', async (_request, reply) => {
    const wallet = await resolveTopupDestination(fastify.prisma)
    const config = await getSolanaConfig(fastify.prisma)
    if (!wallet) {
      reply.send({
        wallet: null,
        currency: 'USDC',
        network: config.devMode ? 'devnet' : 'mainnet',
        configured: false,
        message: 'Topup destination not configured. Contact support.',
      })
      return
    }
    reply.send({
      wallet,
      currency: 'USDC',
      network: config.devMode ? 'devnet' : 'mainnet',
      configured: true,
      // Memo / instruction: in dev mode any txHash starting with DEV_
      // auto-verifies. In live mode the verification step checks the
      // signature exists on-chain; deeper recipient/amount validation
      // is on the roadmap (the current single-rental txhash flow has
      // the same limitation).
    })
  })

  /**
   * POST /v1/buyer/balance/topup-solana — submit txHash, verify, credit
   *
   * Returns the new balance on success. Idempotent: re-submitting the
   * same txHash returns the already-recorded balance instead of
   * double-crediting (uses the (type, referenceId) unique constraint
   * on BalanceTransaction).
   */
  fastify.post('/v1/buyer/balance/topup-solana', async (request, reply) => {
    const parse = topupSchema.safeParse(request.body)
    if (!parse.success) {
      reply.status(400).send({ error: 'invalid_body', detail: parse.error.format() })
      return
    }
    const { txHash, amountUsd, note } = parse.data
    const userId = request.user!.userId

    // Verify the tx exists on-chain (or is a DEV_ mock in dev mode).
    const config = await getSolanaConfig(fastify.prisma)
    const verification = await verifyTransaction(config, txHash)
    if (!verification.verified) {
      reply.status(400).send({
        error: 'tx_unverified',
        message: verification.error ?? 'Transaction could not be verified on chain. Wait a few seconds and try again.',
      })
      return
    }

    // Credit the balance. DuplicateTransactionError = same txHash was
    // already credited; treat as success and return the current state
    // (idempotent retry).
    const description = note
      ? `Solana topup (${note})`
      : `Solana topup`

    try {
      const snapshot = await creditBalance(fastify.prisma, {
        userId,
        amountUsd,
        type: 'TOPUP_SOLANA',
        description,
        referenceId: txHash,
      })
      // T2.1: fire BALANCE_TOPUP notification + web push + email so the
      // buyer sees the credit land in real time. Non-blocking — failure
      // here never breaks the topup response.
      // T8b: pass structured templateData so the receipt email
      // renders the proper layout instead of the generic body.
      void createNotification(
        userId,
        'BALANCE_TOPUP',
        `+$${amountUsd.toFixed(2)} USDC credited`,
        verification.isDevMode
          ? `Dev-mode topup of $${amountUsd.toFixed(2)} confirmed. Balance: $${snapshot.balanceUsd.toFixed(2)}.`
          : `Solana mainnet topup of $${amountUsd.toFixed(2)} confirmed. Balance: $${snapshot.balanceUsd.toFixed(2)}.`,
        '/buyer/balance',
        {
          kind: 'BALANCE_TOPUP',
          amountUsd,
          source: verification.isDevMode ? 'Solana dev-mode' : 'Solana mainnet (USDC)',
          newBalanceUsd: snapshot.balanceUsd,
          referenceId: txHash,
        },
      )
      reply.send({
        success: true,
        creditedUsd: amountUsd,
        balance: snapshot,
        devMode: verification.isDevMode,
      })
    } catch (err) {
      if (err instanceof DuplicateTransactionError) {
        const snapshot = await getOrCreateBalance(fastify.prisma, userId)
        reply.send({
          success: true,
          alreadyCredited: true,
          balance: snapshot,
          devMode: verification.isDevMode,
        })
        return
      }
      throw err
    }
  })

  /**
   * POST /v1/buyer/balance/topup-stripe/checkout — create a Stripe
   * Hosted Checkout Session for a card-funded topup. Returns the
   * session URL; the frontend redirects the buyer to it. The actual
   * balance credit happens via the /v1/webhooks/stripe handler once
   * Stripe confirms payment server-side.
   */
  fastify.post('/v1/buyer/balance/topup-stripe/checkout', async (request, reply) => {
    if (!isStripeConfigured()) {
      reply.status(503).send({ error: 'stripe_not_configured', message: 'Card topup is not enabled on this deploy.' })
      return
    }

    const schema = z.object({
      amountUsd: z.number().positive().min(1).max(10000),
    })
    const parse = schema.safeParse(request.body)
    if (!parse.success) {
      reply.status(400).send({ error: 'invalid_body', detail: parse.error.format() })
      return
    }

    const userId = request.user!.userId
    const user = await fastify.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    })

    try {
      const session = await createTopupCheckoutSession({
        userId,
        email: user?.email ?? null,
        amountUsd: parse.data.amountUsd,
        // Stripe redirects the buyer back to /buyer/balance regardless
        // of outcome. The balance page re-fetches state on mount, so
        // a successful topup will be visible once the webhook lands
        // (typically within a second of payment).
        successUrl: `${PORTAL_URL}/buyer/balance?topup=success`,
        cancelUrl: `${PORTAL_URL}/buyer/balance?topup=cancelled`,
      })
      reply.send({ id: session.id, url: session.url })
    } catch (e) {
      reply.status(500).send({
        error: 'checkout_failed',
        message: e instanceof Error ? e.message : 'Failed to create checkout session',
      })
    }
  })
}
