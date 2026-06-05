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
  debitBalance,
  getTransactions,
  DuplicateTransactionError,
  InsufficientBalanceError,
} from '../services/balance/balance-service'
import { getSolanaConfig, processPayment, verifyTransaction } from '../services/payment/solana'
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
          : `Topup of $${amountUsd.toFixed(2)} confirmed. Balance: $${snapshot.balanceUsd.toFixed(2)}.`,
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

  /**
   * POST /v1/buyer/balance/withdraw
   *
   * Withdraw unused balance back to the buyer's own Solana wallet as
   * USDC. v1 ships SOLANA method only (per scope A — fast path). Flow:
   *
   *   1. Validate the request:
   *      - amountUsd > 0 and <= current balance
   *      - user.walletAddress is set (Settings page must have linked)
   *      - The address passed validation (not a mint pubkey) when saved
   *   2. Create BuyerWithdrawal row status=PENDING
   *   3. debitBalance with WITHDRAW_USDC, referenceId = withdrawal.id
   *   4. Mark PROCESSING and call processPayment for the on-chain send
   *   5. On success -> COMPLETED + txHash + processedAt
   *   6. On send failure -> FAILED + error, AND issue a compensating
   *      REFUND_FAILED credit so the user's balance isn't lost in the
   *      failure mode. The compensating credit references the same
   *      withdrawal id so reconciliation can pair them.
   */
  fastify.post('/v1/buyer/balance/withdraw', async (request, reply) => {
    const userId = request.user!.userId

    const schema = z.object({
      amountUsd: z.number().positive().max(100000),
    })
    const parsed = schema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: parsed.error.issues[0]?.message ?? 'Invalid amountUsd',
      })
    }
    const { amountUsd } = parsed.data

    const user = await fastify.prisma.user.findUnique({
      where: { id: userId },
      select: { walletAddress: true },
    })
    if (!user?.walletAddress) {
      return reply.code(400).send({
        error: 'no_wallet',
        message:
          'Link a Solana wallet in Settings before withdrawing. We send USDC ' +
          'directly to that address.',
      })
    }

    const snapshot = await getOrCreateBalance(fastify.prisma, userId)
    if (amountUsd > snapshot.balanceUsd) {
      return reply.code(400).send({
        error: 'insufficient_balance',
        message: `Requested $${amountUsd.toFixed(2)} but available balance is only $${snapshot.balanceUsd.toFixed(2)}.`,
      })
    }

    // Step 1: create the withdrawal row + debit balance in a single tx
    // so we can't end up with one without the other if the route
    // crashes between the two writes. The on-chain send is async; we
    // mark PROCESSING and let the result update the row outside the
    // tx.
    let withdrawal: { id: string } | null = null
    try {
      withdrawal = await fastify.prisma.$transaction(async (tx) => {
        const w = await tx.buyerWithdrawal.create({
          data: {
            userId,
            amountUsd,
            method: 'SOLANA',
            status: 'PENDING',
            walletAddress: user.walletAddress as string,
          },
          select: { id: true },
        })
        // Debit using debitBalance's own transaction would nest; we
        // inline the upsert + update + tx-row here instead. The
        // BalanceTransaction unique on (type, referenceId) prevents
        // a retried request from double-debiting via this same
        // withdrawal id.
        const bb = await tx.buyerBalance.upsert({
          where: { userId },
          create: { userId },
          update: {},
        })
        if (bb.balanceUsd < amountUsd) {
          // Possible if a concurrent rental drained the balance between
          // our pre-check and now. Throw to abort the tx; the user
          // gets a 400.
          throw new InsufficientBalanceError(amountUsd, bb.balanceUsd)
        }
        const updated = await tx.buyerBalance.update({
          where: { userId },
          data: {
            balanceUsd: { decrement: amountUsd },
            totalWithdrawn: { increment: amountUsd },
          },
        })
        await tx.balanceTransaction.create({
          data: {
            balanceId: updated.id,
            type: 'WITHDRAW_USDC',
            amountUsd: -amountUsd,
            description: `Withdraw $${amountUsd.toFixed(2)} to wallet ${user.walletAddress?.slice(0, 6)}…${user.walletAddress?.slice(-4)}`,
            referenceId: w.id,
            balanceAfter: updated.balanceUsd,
          },
        })
        return w
      })
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        return reply.code(400).send({
          error: 'insufficient_balance',
          message: err.message,
        })
      }
      fastify.log.error({ err, userId, amountUsd }, 'Withdraw debit failed')
      return reply.code(500).send({
        error: 'withdraw_failed',
        message: 'Could not record the withdrawal. No funds were moved.',
      })
    }

    // Step 2: on-chain send. Wrapped in try/catch so a send failure
    // refunds the user's balance via a compensating credit, keeping
    // them whole even if Solana rejects the tx.
    await fastify.prisma.buyerWithdrawal.update({
      where: { id: withdrawal.id },
      data: { status: 'PROCESSING' },
    })

    try {
      const solanaConfig = await getSolanaConfig(fastify.prisma)
      const result = await processPayment(solanaConfig, user.walletAddress, amountUsd, 'USDC')

      if (result.success && result.txHash) {
        await fastify.prisma.buyerWithdrawal.update({
          where: { id: withdrawal.id },
          data: {
            status: 'COMPLETED',
            txHash: result.txHash,
            processedAt: new Date(),
          },
        })
        // Fire-and-forget notification.
        void createNotification(
          userId,
          'BALANCE_TOPUP',
          'Withdrawal sent',
          `$${amountUsd.toFixed(2)} sent to your wallet. Tx: ${result.txHash.slice(0, 12)}…`,
          `/buyer/balance`,
        )
        return reply.send({
          id: withdrawal.id,
          status: 'COMPLETED',
          txHash: result.txHash,
          amountUsd,
        })
      }

      // processPayment returned success: false
      const errMsg = result.error ?? 'On-chain send failed'
      await fastify.prisma.buyerWithdrawal.update({
        where: { id: withdrawal.id },
        data: { status: 'FAILED', error: errMsg, processedAt: new Date() },
      })
      // Refund the debited amount via REFUND_FAILED so the buyer's
      // balance isn't lost when our send fails. Same referenceId as
      // the debit so reconciliation can pair them.
      await creditBalance(fastify.prisma, {
        userId,
        amountUsd,
        type: 'REFUND_FAILED',
        description: `Refund: withdrawal ${withdrawal.id.slice(0, 8)} failed (${errMsg})`,
        referenceId: `withdraw-fail:${withdrawal.id}`,
      })
      return reply.code(502).send({
        error: 'send_failed',
        message: `On-chain send failed: ${errMsg}. Your balance has been restored.`,
      })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown send error'
      fastify.log.error({ err, withdrawalId: withdrawal.id }, 'Withdraw send threw')
      await fastify.prisma.buyerWithdrawal
        .update({
          where: { id: withdrawal.id },
          data: { status: 'FAILED', error: errMsg, processedAt: new Date() },
        })
        .catch(() => undefined)
      // Compensating credit (best-effort).
      await creditBalance(fastify.prisma, {
        userId,
        amountUsd,
        type: 'REFUND_FAILED',
        description: `Refund: withdrawal ${withdrawal.id.slice(0, 8)} threw (${errMsg})`,
        referenceId: `withdraw-fail:${withdrawal.id}`,
      }).catch((creditErr) => {
        fastify.log.error(
          { err: creditErr, withdrawalId: withdrawal!.id },
          'Compensating credit failed after withdraw send error',
        )
      })
      return reply.code(502).send({
        error: 'send_failed',
        message: `On-chain send error: ${errMsg}. Your balance has been restored.`,
      })
    }
  })

  /**
   * GET /v1/buyer/balance/withdrawals
   * Past withdrawals for the signed-in buyer, newest first.
   */
  fastify.get('/v1/buyer/balance/withdrawals', async (request, reply) => {
    const userId = request.user!.userId
    const withdrawals = await fastify.prisma.buyerWithdrawal.findMany({
      where: { userId },
      orderBy: { requestedAt: 'desc' },
      take: 50,
      select: {
        id: true,
        amountUsd: true,
        method: true,
        status: true,
        walletAddress: true,
        txHash: true,
        error: true,
        requestedAt: true,
        processedAt: true,
      },
    })
    reply.send({ withdrawals })
  })
}
