/**
 * Stripe Checkout integration for fiat (card) topups to the buyer
 * credit balance. Uses Stripe Hosted Checkout — buyer is redirected
 * to a Stripe-hosted page to enter card details, returns to the
 * portal on success or cancel, and our webhook handler credits the
 * balance after Stripe confirms the payment server-side.
 *
 * Env vars (set on the Render API service):
 *   STRIPE_SECRET_KEY      — sk_test_... in test mode, sk_live_... in production
 *   STRIPE_WEBHOOK_SECRET  — whsec_... from `stripe listen` or the dashboard
 *
 * Both must be set for fiat topup to be available; the endpoints
 * gracefully 503 when they are missing so the UI can fall back to
 * the Solana topup paths.
 */

// Stripe v22 ships a CJS-style export where the default import is the
// constructor; the namespace types (Event, Checkout.Session, etc.) are
// merged but only reachable as untyped values at our tsconfig settings.
// We avoid the namespace-type juggling by using the SDK's *instance*
// types (StripeClient) for the client and `unknown` for webhook
// payloads, narrowing where needed at the call site.
import StripeLib from 'stripe'

type StripeClient = InstanceType<typeof StripeLib>

let cachedClient: StripeClient | null = null

export function isStripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY?.trim()
}

export function getStripeClient(): StripeClient | null {
  if (cachedClient) return cachedClient
  const key = process.env.STRIPE_SECRET_KEY?.trim()
  if (!key) return null
  cachedClient = new StripeLib(key, {
    // Pin the API version so a Stripe-side dashboard change does not
    // surprise the integration with a new payload shape. Bump
    // intentionally when we upgrade. Cast through any to avoid the
    // LatestApiVersion type alias dance (not directly reachable from
    // the CJS default export shape in this tsconfig setup).
    apiVersion: '2024-12-18.acacia' as unknown as never,
    typescript: true,
    appInfo: {
      name: 'TokenOS_DeAI',
      version: '1.0.0',
    },
  } as Record<string, unknown>)
  return cachedClient
}

export function getWebhookSecret(): string | null {
  return process.env.STRIPE_WEBHOOK_SECRET?.trim() || null
}

export interface CreateCheckoutArgs {
  userId: string
  email: string | null
  amountUsd: number
  successUrl: string
  cancelUrl: string
}

/**
 * Create a Stripe Checkout Session for a fiat topup. Returns the
 * Session ID + URL the frontend redirects to. The session carries
 * userId in its metadata so the webhook can credit the right
 * balance later, and uses the Session ID itself as the
 * client_reference_id for traceability.
 */
export async function createTopupCheckoutSession(args: CreateCheckoutArgs): Promise<{ id: string; url: string }> {
  const stripe = getStripeClient()
  if (!stripe) throw new Error('Stripe not configured')

  // Stripe amounts are in the smallest currency unit (cents for USD).
  const amountCents = Math.round(args.amountUsd * 100)
  if (amountCents < 100) {
    throw new Error('Minimum topup is $1.00')
  }
  if (amountCents > 1_000_000) {
    throw new Error('Maximum single topup via card is $10,000.00')
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: amountCents,
          product_data: {
            name: 'TokenOS_DeAI compute credit',
            description: `Pre-loaded balance for renting GPU compute on TokenOS_DeAI.`,
          },
        },
      },
    ],
    // metadata travels with the Session into the webhook event, where
    // we read it to know which user to credit.
    metadata: {
      userId: args.userId,
      amountUsd: args.amountUsd.toString(),
      kind: 'buyer_balance_topup',
    },
    payment_intent_data: {
      // Also stamp the PI for downstream audit / refund flows.
      metadata: {
        userId: args.userId,
        amountUsd: args.amountUsd.toString(),
        kind: 'buyer_balance_topup',
      },
    },
    customer_email: args.email ?? undefined,
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
  })

  if (!session.url) {
    throw new Error('Stripe did not return a checkout URL')
  }

  return { id: session.id, url: session.url }
}

/**
 * Verify a webhook payload against the configured signing secret.
 * Returns the parsed event; throws on signature mismatch so the
 * route can 400 the request.
 */
// Stripe event shape — narrowed manually because the namespace type
// is not directly importable from the CJS entrypoint (see header comment).
export interface StripeWebhookEvent {
  id: string
  type: string
  data: { object: Record<string, unknown> }
}

export function constructWebhookEvent(rawBody: Buffer, signatureHeader: string): StripeWebhookEvent {
  const stripe = getStripeClient()
  if (!stripe) throw new Error('Stripe not configured')
  const secret = getWebhookSecret()
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET not set')
  return stripe.webhooks.constructEvent(rawBody, signatureHeader, secret) as unknown as StripeWebhookEvent
}
