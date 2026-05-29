/**
 * Stripe webhook handler. Stripe POSTs payment events here after
 * the buyer completes Hosted Checkout (or any other event we
 * subscribe to in the future).
 *
 * Signature verification requires the EXACT raw body bytes Stripe
 * sent — JSON.stringify of the parsed body would not match because
 * key order + whitespace might differ. Fastify defaults to parsing
 * application/json bodies into objects, so this file registers an
 * encapsulated content-type parser that captures the raw Buffer
 * alongside the parsed JSON. The override is scoped to the plugin
 * (fastify encapsulation) so other routes keep the default parser.
 *
 * Currently handles:
 *   - checkout.session.completed  -> credit BuyerBalance with
 *                                    TOPUP_STRIPE via the existing
 *                                    creditBalance ledger pipeline.
 *
 * Idempotency: balance ledger has a unique (type, referenceId)
 * constraint, so re-delivery of the same Stripe webhook (Stripe
 * retries on non-2xx for up to 3 days) is a no-op. The Stripe
 * Checkout Session ID is the referenceId.
 *
 * Endpoint: POST /v1/webhooks/stripe (NO auth, NO buyer-role guard;
 * this is server-to-server from Stripe).
 */

import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { GpuTier } from '@a2e/database'
import { constructWebhookEvent, isStripeConfigured, type StripeWebhookEvent } from '../services/payment/stripe.js'
import { creditBalance, DuplicateTransactionError } from '../services/balance/balance-service.js'
import { createNotification } from '../services/notification/service.js'
import { mintInstallTokenForRunner } from './byog.js'

// Subset of the Stripe Checkout Session shape we read in this file.
// Full typing lives on the Stripe SDK but isn't directly importable
// from our tsconfig — we narrow inline for the fields we touch.
interface CheckoutSessionLike {
  id: string
  payment_status?: string
  metadata?: Record<string, string> | null
}

// Augment the FastifyRequest type with the rawBody we attach
// inside the encapsulated content-type parser.
type RequestWithRawBody = FastifyRequest & { rawBody?: Buffer }

export async function webhooksStripeRoutes(fastify: FastifyInstance) {
  // Encapsulated content-type parser. Captures the raw bytes Stripe
  // sent in request.rawBody while ALSO providing a parsed JSON body
  // for handlers that prefer it. Scoped to this plugin's registration
  // tree (fastify encapsulation) so other routes are unaffected.
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    const buf = body as Buffer
    ;(req as RequestWithRawBody).rawBody = buf
    try {
      const text = buf.toString('utf8')
      const parsed = text.length === 0 ? null : JSON.parse(text)
      done(null, parsed)
    } catch (err) {
      done(err as Error, undefined)
    }
  })

  fastify.post('/v1/webhooks/stripe', async (request, reply) => {
    if (!isStripeConfigured()) {
      // Mostly defensive — Stripe shouldn't be POSTing here without
      // STRIPE_SECRET_KEY being set in the first place.
      reply.code(503).send({ error: 'stripe_not_configured' })
      return
    }

    const sig = request.headers['stripe-signature'] as string | undefined
    const rawBody = (request as RequestWithRawBody).rawBody

    if (!sig || !rawBody) {
      reply.code(400).send({ error: 'missing_signature' })
      return
    }

    let event: StripeWebhookEvent
    try {
      event = constructWebhookEvent(rawBody, sig)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[stripe-webhook] signature verification failed:', (err as Error).message)
      reply.code(400).send({ error: 'invalid_signature' })
      return
    }

    try {
      if (event.type === 'checkout.session.completed') {
        await handleCheckoutCompleted(fastify, event.data.object as unknown as CheckoutSessionLike)
      }
      // Other event types fall through as ACKed-but-ignored so Stripe
      // does not retry forever. Add new branches above as needed.
      reply.send({ received: true })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[stripe-webhook] handler error for event', event.type, ':', err)
      // 500 so Stripe retries — the unique-constraint idempotency
      // guard prevents double-credit on the eventual replay.
      reply.code(500).send({ error: 'handler_error' })
    }
  })
}

async function handleCheckoutCompleted(
  fastify: FastifyInstance,
  session: CheckoutSessionLike,
): Promise<void> {
  const meta = session.metadata ?? {}

  // Defensive: only act when the session actually paid. Stripe sends
  // checkout.session.completed for both `paid` and `unpaid` (e.g.
  // bank-transfer pending) sessions; we want the former only.
  if (session.payment_status !== 'paid') {
    // eslint-disable-next-line no-console
    console.log(`[stripe-webhook] session ${session.id} status=${session.payment_status} — skip.`)
    return
  }

  // Route by metadata.kind so each session type goes to its own
  // handler. Unknown kinds get logged + ACKed so Stripe stops retrying.
  if (meta.kind === 'buyer_balance_topup') {
    await handleBuyerBalanceTopup(fastify, session, meta)
    return
  }
  if (meta.kind === 'operator_deploy') {
    await handleOperatorDeploy(fastify, session, meta)
    return
  }

  // eslint-disable-next-line no-console
  console.log(`[stripe-webhook] checkout.session.completed unknown kind=${meta.kind ?? '(none)'} — ignored.`)
}

async function handleBuyerBalanceTopup(
  fastify: FastifyInstance,
  session: CheckoutSessionLike,
  meta: Record<string, string>,
): Promise<void> {
  const userId = meta.userId
  const amountUsdStr = meta.amountUsd
  if (!userId || !amountUsdStr) {
    // eslint-disable-next-line no-console
    console.warn(`[stripe-webhook] topup missing userId or amountUsd. session=${session.id}`)
    return
  }
  const amountUsd = Number(amountUsdStr)
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    // eslint-disable-next-line no-console
    console.warn(`[stripe-webhook] topup bad amountUsd: ${amountUsdStr}`)
    return
  }

  try {
    const snap = await creditBalance(fastify.prisma, {
      userId,
      amountUsd,
      type: 'TOPUP_STRIPE',
      description: `Card topup via Stripe`,
      referenceId: session.id,
    })
    // eslint-disable-next-line no-console
    console.log(`[stripe-webhook] credited $${amountUsd} to user=${userId} via session=${session.id}`)
    // T2.1: BALANCE_TOPUP receipt notification (bell + web push + email).
    void createNotification(
      userId,
      'BALANCE_TOPUP',
      `+$${amountUsd.toFixed(2)} card topup`,
      `Card topup of $${amountUsd.toFixed(2)} via Stripe confirmed. Balance: $${snap.balanceUsd.toFixed(2)}.`,
      '/buyer/balance',
    )
  } catch (err) {
    if (err instanceof DuplicateTransactionError) {
      // eslint-disable-next-line no-console
      console.log(`[stripe-webhook] session ${session.id} was already credited — no-op.`)
      return
    }
    throw err
  }
}

async function handleOperatorDeploy(
  fastify: FastifyInstance,
  session: CheckoutSessionLike,
  meta: Record<string, string>,
): Promise<void> {
  const nodeRunnerId = meta.nodeRunnerId
  const amountUsd = Number(meta.amountUsd)
  const nodeCount = parseInt(meta.nodeCount ?? '0', 10)
  const gpuTier = meta.gpuTier as GpuTier | undefined
  const deploymentNote = meta.deploymentNote

  if (!nodeRunnerId || !gpuTier || !Number.isFinite(amountUsd) || amountUsd <= 0 || nodeCount < 1) {
    // eslint-disable-next-line no-console
    console.warn(`[stripe-webhook] operator_deploy missing/bad metadata. session=${session.id}`, meta)
    return
  }

  // Idempotency: txHash 'STRIPE:<sessionId>' is unique per Stripe
  // session, so a retry that lands here a second time finds the row
  // and no-ops. There's no DB unique constraint on Investment.txHash,
  // hence the explicit pre-check.
  const txHash = `STRIPE:${session.id}`
  const existing = await fastify.prisma.investment.findFirst({
    where: { txHash },
    select: { id: true },
  })
  if (existing) {
    // eslint-disable-next-line no-console
    console.log(`[stripe-webhook] operator_deploy already recorded as Investment=${existing.id} — no-op.`)
    return
  }

  const investment = await fastify.prisma.investment.create({
    data: {
      nodeRunnerId,
      amount: amountUsd,
      currency: 'USD',
      nodeCount,
      gpuTier,
      txHash,
      txConfirmed: true,
      deploymentNote: deploymentNote ?? null,
      status: 'DEPLOYMENT_REQUESTED',
      confirmedAt: new Date(),
      deploymentRequestedAt: new Date(),
    },
  })

  // Auto-mint BYOG install token + persist on the Investment so the
  // operator sees the curl one-liner on their deployment detail page.
  // Best-effort: failure here doesn't roll back the payment.
  try {
    const minted = await mintInstallTokenForRunner(fastify.prisma, { nodeRunnerId })
    await fastify.prisma.investment.update({
      where: { id: investment.id },
      data: { installToken: minted.token },
    })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[stripe-webhook] auto-mint install token failed for investment', investment.id, err)
  }

  // Mirror the on-chain deploy path: notify all admins so they pick
  // it up in the same Needs Review queue.
  const adminUsers = await fastify.prisma.user.findMany({
    where: { role: 'ADMIN' },
    select: { id: true },
  })
  const nr = await fastify.prisma.nodeRunner.findUnique({
    where: { id: nodeRunnerId },
    select: { name: true },
  })
  for (const admin of adminUsers) {
    void createNotification(
      admin.id,
      'DEPLOYMENT_REQUESTED',
      'New Deployment Request',
      `${nr?.name ?? 'Operator'} requested ${nodeCount}x ${gpuTier} node deployment ($${amountUsd}, paid via card).`,
    )
  }

  // eslint-disable-next-line no-console
  console.log(`[stripe-webhook] created Investment=${investment.id} for nodeRunner=${nodeRunnerId} via session=${session.id}`)
}
