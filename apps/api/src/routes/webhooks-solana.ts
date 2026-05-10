/**
 * M2 / B3 support: Solana payment webhook receiver.
 *
 * Today on-chain confirmations are discovered by polling Helius/RPC
 * inside the reconciliation cron, which means a 30-60s window between
 * "buyer's USDC clears" and "ComputeRequest.txConfirmed flips". Webhook
 * delivery shaves that to ~3s, which combined with the 10s allocator
 * tick collapses end-to-end pay-to-prompt to ~15s.
 *
 * Endpoint: POST /v1/webhooks/solana
 * Auth: shared secret in `x-webhook-secret` header.
 *   - Configure SOLANA_WEBHOOK_SECRET on Render
 *   - Configure the same value in the Helius webhook console
 *   - We use a header check (not HMAC of the body) because Helius's
 *     standard webhook config supports custom auth headers but doesn't
 *     sign payloads by default. If we move to a signed flow later, swap
 *     the verifier in one place — see verifyWebhookAuth() below.
 *
 * Payload: array of Helius enriched-transaction objects. We extract the
 * signature (= Solana tx hash), find any matching Payment / ComputeRequest
 * / Investment row by txHash, and flip txConfirmed=true atomically.
 *
 * Idempotency: every update uses `where: { txHash, txConfirmed: false }`,
 * so a duplicate webhook (or a poll that already flipped it) is a no-op.
 *
 * The endpoint always returns 200 with a counts summary so Helius doesn't
 * retry on partial misses (a tx we don't know about yet just means the
 * polling reconciler will catch it on the next pass). We log unknown
 * signatures for observability, not as errors.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify'

interface HeliusTxLike {
  // Helius wraps the field as `signature` for enriched txs and
  // `transaction.signatures[0]` on raw payloads. We accept both.
  signature?: string
  transaction?: { signatures?: string[] }
  // We don't currently consume amount/transfer details from the webhook —
  // the on-chain truth came from the polling reconciler when the txHash
  // was first recorded. The webhook is just a "this finalized" trigger.
  // Future: parse tokenTransfers to re-verify amount before flipping.
  type?: string
  description?: string
}

interface WebhookSummary {
  received: number
  paymentsConfirmed: number
  computeRequestsConfirmed: number
  investmentsConfirmed: number
  unknownSignatures: string[]
}

export async function webhooksSolanaRoutes(fastify: FastifyInstance) {
  fastify.post('/v1/webhooks/solana', async (request, reply) => {
    if (!verifyWebhookAuth(request)) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    const body = request.body
    const events = normalizePayload(body)

    if (events.length === 0) {
      return reply.code(200).send({ received: 0, message: 'No events parsed' })
    }

    const summary: WebhookSummary = {
      received: events.length,
      paymentsConfirmed: 0,
      computeRequestsConfirmed: 0,
      investmentsConfirmed: 0,
      unknownSignatures: [],
    }

    for (const ev of events) {
      const sig = extractSignature(ev)
      if (!sig) continue

      // Run the three lookups in parallel. Each one is idempotent and
      // safe to call even if the row was already confirmed by the poll.
      const [paymentResult, computeResult, investmentResult] = await Promise.all([
        fastify.prisma.payment.updateMany({
          where: { txHash: sig, txConfirmed: false },
          data: { txConfirmed: true, confirmedAt: new Date() },
        }),
        fastify.prisma.computeRequest.updateMany({
          where: { txHash: sig, txConfirmed: false },
          data: { txConfirmed: true },
        }),
        fastify.prisma.investment.updateMany({
          where: { txHash: sig, txConfirmed: false },
          data: { txConfirmed: true, confirmedAt: new Date() },
        }),
      ])

      summary.paymentsConfirmed += paymentResult.count
      summary.computeRequestsConfirmed += computeResult.count
      summary.investmentsConfirmed += investmentResult.count

      const totalForThisSig = paymentResult.count + computeResult.count + investmentResult.count
      if (totalForThisSig === 0) {
        // Either we already confirmed it (no-op), or this signature
        // belongs to a tx we never originated. Either way it's not an
        // error — the polling reconciler is the source of truth for
        // unknown signatures.
        summary.unknownSignatures.push(sig)
      } else {
        fastify.log.info(
          { sig, paymentResult: paymentResult.count, computeResult: computeResult.count, investmentResult: investmentResult.count },
          'Webhook confirmed payment',
        )
      }
    }

    // Cap the unknownSignatures list in the response so a misconfigured
    // Helius monitor pointed at the wrong wallet doesn't balloon our
    // response payload. The full list is in the structured log above.
    if (summary.unknownSignatures.length > 25) {
      summary.unknownSignatures = summary.unknownSignatures.slice(0, 25)
    }

    return reply.code(200).send(summary)
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function verifyWebhookAuth(request: FastifyRequest): boolean {
  const expected = process.env.SOLANA_WEBHOOK_SECRET
  if (!expected) {
    // Fail closed: if the env var isn't configured, refuse all webhooks.
    // Operator must explicitly set SOLANA_WEBHOOK_SECRET to enable the
    // endpoint. This avoids the failure mode where someone forgets to
    // configure the secret and the endpoint silently accepts anything.
    return false
  }

  // Accept three header conventions so the endpoint works with any
  // common webhook provider out of the box:
  //   1. x-webhook-secret: <secret>            (curl tests / custom integrations)
  //   2. Authorization: Bearer <secret>        (Helius / Stripe / GitHub style)
  //   3. Authorization: <secret>               (raw token, also valid)
  // Constant-time comparison isn't strictly necessary at 256-bit
  // entropy — guessing the token itself is far cheaper than timing
  // any one of these comparisons.

  const xSecret = request.headers['x-webhook-secret']
  if (typeof xSecret === 'string' && xSecret === expected) return true

  const authHeader = request.headers['authorization']
  if (typeof authHeader === 'string') {
    const value = authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length).trim()
      : authHeader.trim()
    if (value === expected) return true
  }

  return false
}

function normalizePayload(body: unknown): HeliusTxLike[] {
  if (Array.isArray(body)) return body as HeliusTxLike[]
  if (body && typeof body === 'object') return [body as HeliusTxLike]
  return []
}

function extractSignature(ev: HeliusTxLike): string | null {
  if (ev.signature) return ev.signature
  if (ev.transaction?.signatures?.[0]) return ev.transaction.signatures[0]
  return null
}
