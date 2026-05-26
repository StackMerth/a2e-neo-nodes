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
import { constructWebhookEvent, isStripeConfigured, type StripeWebhookEvent } from '../services/payment/stripe.js'
import { creditBalance, DuplicateTransactionError } from '../services/balance/balance-service.js'

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
  // Only handle our buyer-balance topup sessions. Other future
  // checkout types (subscriptions, marketplace fees, etc.) get
  // a different kind tag and are skipped here.
  const meta = session.metadata ?? {}
  if (meta.kind !== 'buyer_balance_topup') {
    // eslint-disable-next-line no-console
    console.log(`[stripe-webhook] checkout.session.completed with unknown kind=${meta.kind ?? '(none)'} — ignored.`)
    return
  }

  const userId = meta.userId
  const amountUsdStr = meta.amountUsd
  if (!userId || !amountUsdStr) {
    // eslint-disable-next-line no-console
    console.warn(`[stripe-webhook] missing userId or amountUsd in session metadata. session=${session.id}`)
    return
  }
  const amountUsd = Number(amountUsdStr)
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    // eslint-disable-next-line no-console
    console.warn(`[stripe-webhook] bad amountUsd in session metadata: ${amountUsdStr}`)
    return
  }

  // Defensive: only credit if the session actually paid. Stripe sends
  // checkout.session.completed for both `paid` and `unpaid` (e.g.
  // bank-transfer pending) sessions; we want the former only.
  if (session.payment_status !== 'paid') {
    // eslint-disable-next-line no-console
    console.log(`[stripe-webhook] session ${session.id} status=${session.payment_status} — skipping credit until paid.`)
    return
  }

  try {
    await creditBalance(fastify.prisma, {
      userId,
      amountUsd,
      type: 'TOPUP_STRIPE',
      description: `Card topup via Stripe`,
      referenceId: session.id,
    })
    // eslint-disable-next-line no-console
    console.log(`[stripe-webhook] credited $${amountUsd} to user=${userId} via session=${session.id}`)
  } catch (err) {
    if (err instanceof DuplicateTransactionError) {
      // eslint-disable-next-line no-console
      console.log(`[stripe-webhook] session ${session.id} was already credited — no-op (idempotent retry).`)
      return
    }
    throw err
  }
}
